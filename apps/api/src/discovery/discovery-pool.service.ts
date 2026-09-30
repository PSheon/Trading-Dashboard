import { Injectable, Logger, Optional } from "@nestjs/common";

import { AppConfig } from "../config/app-config.js";
import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import { UNRANKED_BASE } from "../hyperliquid/request-budgeter.service.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { LeaderboardIngestService } from "../traders/leaderboard-ingest.service.js";
import { TradeAnalyticsService } from "../traders/trade-analytics.service.js";
import { portfolioFigures, tradeFigures } from "./discovery-figures.js";
import { DiscoveryRepository, type DiscoveryFigures } from "./discovery.repository.js";

/** Budgeter rank of the pool's calls: behind every page rank (0–3), level
 * with the oldest unranked background work, so the job neither jumps ahead
 * of fill storage nor starves behind it; its own cap bounds its share. */
export const DISCOVERY_RANK = UNRANKED_BASE;
/** Rebuild the pool at least this often (KOL edits), and after every
 * leaderboard import. */
export const POOL_REBUILD_MS = 10 * 60_000;
/** A row attempted this recently (a failure, or the quick first pass)
 * waits before its next full refresh. */
export const RETRY_BACKOFF_MS = 15 * 60_000;
/** A tick spends at most this long refreshing, so ticks never overlap. */
export const TICK_WORK_MS = 50_000;
/** The job may save up at most this many minutes of its allowance. */
const MAX_SAVED_MINUTES = 2;
const WEIGHT_PORTFOLIO = 20;

/** One refresh's cost, kept for the admin/system view and the docs. */
export interface PoolRefreshLog {
  address: string;
  /** "cold" (first ledger read), "refresh" (incremental) or "tracked". */
  kind: string;
  weight: number;
  calls: number;
  ms: number;
  ok: boolean;
  at: Date;
}

/**
 * The discovery pool (Stage 3 §1.7): the official leaderboard's top
 * `discovery.candidatePoolSize` by all-time PnL among non-vault accounts
 * that traded in 30 days, plus every KOL. Each minute it spends at most
 * `discovery.poolWeightPerMinute` Hyperliquid weight: first a quick pass
 * giving every new row its portfolio figures, then full refreshes (rows
 * without a trade ledger first, then the least recently refreshed): one
 * `portfolio` (20) for PnL, ROI, Sharpe,
 * drawdown, copy score and sparklines, and the trade ledger (the trader
 * page's own analytics, incremental after the first read, without the
 * funding step) for style, coins, last trade and per-coin PnL. Calls go at
 * `DISCOVERY_RANK`, so page loads always go first. One refresh at a time.
 */
@Injectable()
export class DiscoveryPoolService {
  private readonly logger = new Logger(DiscoveryPoolService.name);
  private running: Promise<void> | undefined;
  private builtAt = 0;
  private builtForImport: number | null = null;
  private tokens = 0;
  private tokensAt = Date.now();
  readonly log: PoolRefreshLog[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly repository: DiscoveryRepository,
    private readonly info: HyperliquidInfoClient,
    private readonly analytics: TradeAnalyticsService,
    private readonly ingest: LeaderboardIngestService,
    private readonly settings: SettingsService,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
  ) {}

  /** Cron entry point: one tick at a time, never in tests. */
  onTick(): Promise<void> {
    if (this.config.value.app.nodeEnv === "test" || this.jobs.stopping) return Promise.resolve();
    this.running ??= this.jobs
      .run(() => this.tick())
      .catch((error: Error) => this.logger.error(`Discovery pool tick failed: ${error.message}`))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  /** Rebuilds the pool when due, then refreshes rows within the allowance. */
  async tick(now = Date.now()): Promise<void> {
    const discovery = await this.settings.get("discovery");
    const perMinute = discovery.poolWeightPerMinute;
    await this.buildIfDue(discovery.candidatePoolSize, now);
    if (perMinute <= 0) return;
    const elapsedMin = Math.max(0, (now - this.tokensAt) / 60_000);
    this.tokens = Math.min(perMinute * MAX_SAVED_MINUTES, this.tokens + perMinute * Math.min(elapsedMin, MAX_SAVED_MINUTES));
    this.tokensAt = now;
    const until = Date.now() + TICK_WORK_MS;
    while (this.tokens > 0 && Date.now() < until && !this.jobs.stopping) {
      // First pass: portfolio figures for every new row (20 weight each), so
      // the Top 100 / KOL boards fill within about an hour of a cold start.
      const [unseen] = await this.repository.nextUnseen(1);
      if (unseen) {
        this.tokens -= (await this.refreshOne(unseen, { trades: false })).weight;
        continue;
      }
      const [next] = await this.repository.nextBatch(1, RETRY_BACKOFF_MS);
      if (!next) break;
      this.tokens -= (await this.refreshOne(next.address)).weight;
    }
  }

  /** Rebuilds when never built, after a new leaderboard import, or every
   * `POOL_REBUILD_MS`. */
  async buildIfDue(size: number, now = Date.now()): Promise<boolean> {
    const imported = (await this.ingest.lastImportAt())?.getTime() ?? null;
    if (this.builtAt > 0 && imported === this.builtForImport && now - this.builtAt < POOL_REBUILD_MS) return false;
    await this.build(size);
    this.builtAt = now;
    this.builtForImport = imported;
    return true;
  }

  /** Makes the pool the current top `size` plus every KOL. An empty
   * leaderboard (before the first import) leaves the pool as it is. */
  async build(size: number): Promise<{ added: number; removed: number; total: number }> {
    const [top, kols] = await Promise.all([this.repository.candidates(size), this.repository.kolAddresses()]);
    if (top.length === 0) return { added: 0, removed: 0, total: 0 };
    const ranked = new Map(top.map((address, i) => [address, i + 1] as const));
    const entries = [...top.map((address) => ({ address, poolRank: ranked.get(address)! })),
      ...kols.filter((a) => !ranked.has(a)).map((address) => ({ address, poolRank: null }))];
    const result = await this.repository.transaction((tx) => this.repository.syncPool(tx, entries));
    if (result.added > 0 || result.removed > 0) {
      this.logger.log(`Discovery pool: ${entries.length} traders (${result.added} added, ${result.removed} removed)`);
    }
    return { ...result, total: entries.length };
  }

  /**
   * Refreshes one row and returns the Hyperliquid weight it spent: the
   * portfolio figures and, unless `trades` is false (the quick first pass),
   * the trade ledger. A failure keeps the previous figures and records the
   * error; the row waits `RETRY_BACKOFF_MS` either way.
   */
  async refreshOne(address: string, options: { trades?: boolean } = {}): Promise<{ weight: number; ok: boolean }> {
    const { trades = true } = options;
    const started = Date.now();
    await this.repository.save(address, { attemptedAt: new Date(started) });
    let weight = 0;
    let calls = 0;
    let kind = "portfolio";
    const figures: DiscoveryFigures = {};
    let error: Error | null = null;
    try {
      const accountValue = await this.repository.leaderboardAccountValue(address);
      const raw = await this.info.portfolio(address, "background", DISCOVERY_RANK);
      weight += WEIGHT_PORTFOLIO;
      calls += 1;
      Object.assign(figures, portfolioFigures(raw, accountValue));
      if (trades) {
        // The computation's own cost log (none if it joined one already running).
        const previous = this.analytics.lastLog.get(address)?.at(-1);
        await this.analytics.compute(address, false, { rank: DISCOVERY_RANK, funding: false });
        const entry = this.analytics.lastLog.get(address)?.at(-1);
        if (entry && entry !== previous) {
          weight += entry.weight;
          calls += entry.calls;
          kind = entry.kind;
        }
        const [coins, state, last] = await Promise.all([
          this.repository.coinAggregates(address),
          this.repository.analyticsState(address),
          this.repository.lastFillTime(address),
        ]);
        const style = typeof state?.classification.style === "string" ? state.classification.style : null;
        Object.assign(figures, tradeFigures(coins, style, state?.coverageFrom ?? null, last));
      }
    } catch (caught) {
      error = caught as Error;
    }
    await this.repository.save(address, { ...figures, lastError: error ? error.message.slice(0, 500) : null });
    const log: PoolRefreshLog = { address, kind, weight, calls, ms: Date.now() - started, ok: error === null, at: new Date() };
    this.log.push(log);
    if (this.log.length > 500) this.log.shift();
    if (error) this.logger.warn(`Discovery refresh ${address} failed after weight ${weight}: ${error.message}`);
    return { weight: Math.max(weight, WEIGHT_PORTFOLIO), ok: error === null };
  }
}

