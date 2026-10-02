import { Injectable, Logger, Optional } from "@nestjs/common";

import { AppConfig } from "../config/app-config.js";
import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import { RequestBudgeterService, UNRANKED_BASE } from "../hyperliquid/request-budgeter.service.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { LeaderboardIngestService } from "../traders/leaderboard-ingest.service.js";
import { TradeAnalyticsService } from "../traders/trade-analytics.service.js";
import { portfolioFigures, tradeFigures } from "./discovery-figures.js";
import { DiscoveryRepository, type DiscoveryFigures, type PoolQueueRow } from "./discovery.repository.js";
import { DiscoveryService } from "./discovery.service.js";

/** Budgeter rank of the performance loop's calls: behind every page rank
 * (0–3), ahead of the ledger loop and of every unranked background call. */
export const DISCOVERY_RANK = UNRANKED_BASE - 1;
/** Budgeter rank of the ledger loop's calls: level with the oldest
 * unranked background work, so a build neither jumps ahead of fill
 * storage nor starves behind it; its own cap bounds its share. */
export const LEDGER_RANK = UNRANKED_BASE;
/** Rebuild the pool at least this often (KOL edits), and after every
 * leaderboard import. */
export const POOL_REBUILD_MS = 10 * 60_000;
/** A row attempted this recently (a failure) waits before its next try. */
export const RETRY_BACKOFF_MS = 15 * 60_000;
/** A tick spends at most this long refreshing, so ticks never overlap. */
export const TICK_WORK_MS = 50_000;
/** A loop may save up at most this many minutes of its allowance. */
const MAX_SAVED_MINUTES = 2;
const WEIGHT_PORTFOLIO = 20;
/** A visible row (boards, home rows, KOLs, followed traders) is refreshed
 * this many times as often as the rest of the pool. */
export const VISIBLE_WEIGHT = 4;
/** The visible set is recomputed at most this often. */
const VISIBLE_TTL_MS = 60_000;
/** A row's trade ledger is refreshed incrementally once this old (coin
 * boards and the stocks top 100 show ledger figures). */
export const LEDGER_REFRESH_MS = 60 * 60_000;
/** Share of the ledger loop's allowance kept for incremental refreshes
 * while cold builds are pending; the rest (and what refreshes don't use)
 * builds ledgers for rows that have none. */
const LEDGER_REFRESH_SHARE = 0.5;

/** One refresh's cost, kept for the admin/system view and the docs. */
export interface PoolRefreshLog {
  address: string;
  /** "portfolio" (performance), "cold" (first ledger read), "refresh"
   * (incremental) or "tracked". */
  kind: string;
  weight: number;
  calls: number;
  ms: number;
  ok: boolean;
  at: Date;
}

/** Freshness of the stored performance figures (`portfolioAt`), for
 * `/health`: the rows the site shows, and the whole pool. */
export interface PoolFreshness {
  visible: { rows: number; medianAgeSeconds: number | null; oldestAgeSeconds: number | null };
  pool: { rows: number; ready: number; medianAgeSeconds: number | null; oldestAgeSeconds: number | null };
  sampledAt: Date;
}

/**
 * The discovery pool (Stage 3 §1.7): the official leaderboard's top
 * `discovery.candidatePoolSize` by all-time PnL among non-vault accounts
 * that traded in 30 days, plus every KOL. Two loops, each on its own cron
 * tick, allowance and budgeter rank, so neither waits on the other:
 *
 * - **performance** (`discovery.poolPerformanceWeightPerMinute`): one
 *   `portfolio` read (20) per row for PnL, ROI, Sharpe, drawdown, account
 *   value, copy score and sparklines. Rows are taken by urgency, the age
 *   of their figures weighted `VISIBLE_WEIGHT`× for the rows the site
 *   shows (every board's top 100 in every sort and window, the home rows,
 *   KOLs, favorited and copied traders), so those stay fresh at the
 *   budget's pace and the rest of the pool follows behind. At 240/min
 *   (12 rows) with ≈ 480 visible rows of ≈ 1,140, a visible row is read
 *   every ≈ 54 min (median age ≈ 27 min), the rest every ≈ 3.6 h.
 * - **ledgers** (`discovery.poolWeightPerMinute`): the trade ledger (the
 *   trader page's own analytics, incremental after the first read,
 *   without the funding step) for style, coins, last trade and per-coin
 *   PnL. Visible rows whose ledger is older than `LEDGER_REFRESH_MS` are
 *   refreshed first (≈ 20–140 weight), then rows without a ledger are
 *   built (≈ 1,000 weight each, only while no page is waiting on the
 *   budget), then the rest.
 *
 * Both scale their allowance by the budgeter's `backgroundFactor`, so they
 * yield while page traffic is high. One refresh at a time per loop.
 */
@Injectable()
export class DiscoveryPoolService {
  private readonly logger = new Logger(DiscoveryPoolService.name);
  private performanceRunning: Promise<void> | undefined;
  private ledgerRunning: Promise<void> | undefined;
  private building: Promise<boolean> | undefined;
  private builtAt = 0;
  private builtForSize: number | null = null;
  private builtForImport: number | null = null;
  private performanceTokens = 0;
  private performanceTokensAt = Date.now();
  private ledgerTokens = 0;
  private ledgerTokensAt = Date.now();
  private visible: { addresses: Set<string>; at: number } | undefined;
  readonly log: PoolRefreshLog[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly repository: DiscoveryRepository,
    private readonly info: HyperliquidInfoClient,
    private readonly analytics: TradeAnalyticsService,
    private readonly ingest: LeaderboardIngestService,
    private readonly settings: SettingsService,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
    @Optional() private readonly boards?: DiscoveryService,
    @Optional() private readonly budgeter?: RequestBudgeterService,
  ) {}

  /** Cron entry points: one tick per loop at a time, never in tests. */
  onPerformanceTick(): Promise<void> {
    if (this.config.value.app.nodeEnv === "test" || this.jobs.stopping) return Promise.resolve();
    this.performanceRunning ??= this.jobs
      .run(() => this.performanceTick())
      .catch((error: Error) => this.logger.error(`Discovery performance tick failed: ${error.message}`))
      .finally(() => {
        this.performanceRunning = undefined;
      });
    return this.performanceRunning;
  }

  onLedgerTick(): Promise<void> {
    if (this.config.value.app.nodeEnv === "test" || this.jobs.stopping) return Promise.resolve();
    this.ledgerRunning ??= this.jobs
      .run(() => this.ledgerTick())
      .catch((error: Error) => this.logger.error(`Discovery ledger tick failed: ${error.message}`))
      .finally(() => {
        this.ledgerRunning = undefined;
      });
    return this.ledgerRunning;
  }

  /** Both loops in sequence (tests and the legacy entry point). */
  async tick(now = Date.now()): Promise<void> {
    await this.performanceTick(now);
    await this.ledgerTick(now);
  }

  /** Rebuilds the pool when due, then reads performance figures, most
   * urgent row first, within the minute's allowance. */
  async performanceTick(now = Date.now()): Promise<void> {
    const snapshot = await this.settings.getAll();
    const discovery = snapshot.discovery;
    await this.buildIfDue(discovery.candidatePoolSize, now);
    // A pool acknowledgement requires an actual membership decision. Empty
    // upstream data keeps the old pool and must not be reported as applied.
    if (this.builtForSize === discovery.candidatePoolSize) this.settings.acknowledgeDiscovery("pool", snapshot);
    const perMinute = discovery.poolPerformanceWeightPerMinute;
    if (perMinute <= 0) { this.performanceTokens = 0; this.performanceTokensAt = now; return; }
    this.performanceTokens = this.credit(this.performanceTokens, this.performanceTokensAt, perMinute, now);
    this.performanceTokensAt = now;
    if (this.performanceTokens < WEIGHT_PORTFOLIO) return;
    const visible = await this.visibleAddresses(now);
    const rows = await this.repository.queueRows();
    const queue = this.performanceQueue(rows, visible, now);
    const until = Date.now() + TICK_WORK_MS;
    for (const address of queue) {
      if (this.performanceTokens < WEIGHT_PORTFOLIO || Date.now() >= until || this.jobs.stopping) break;
      this.performanceTokens -= (await this.refreshPerformance(address)).weight;
    }
  }

  /**
   * The performance loop's order: rows never read first (best pool rank
   * first), then by the age of their figures, visible rows' ages weighted
   * `VISIBLE_WEIGHT`×. Rows that failed within `RETRY_BACKOFF_MS` wait.
   */
  performanceQueue(rows: PoolQueueRow[], visible: Set<string>, now = Date.now()): string[] {
    const backoff = now - RETRY_BACKOFF_MS;
    const urgency = (row: PoolQueueRow): number => {
      const age = row.portfolioAt === null ? Infinity : now - row.portfolioAt.getTime();
      return visible.has(row.address) ? age * VISIBLE_WEIGHT : age;
    };
    return rows
      .filter((row) => row.performanceAttemptedAt === null || row.performanceAttemptedAt.getTime() < backoff || (row.lastError === null && row.portfolioAt !== null))
      .map((row) => ({ row, urgency: urgency(row) }))
      .sort((a, b) => b.urgency - a.urgency || (a.row.poolRank ?? Infinity) - (b.row.poolRank ?? Infinity) || a.row.address.localeCompare(b.row.address))
      .map((e) => e.row.address);
  }

  /** Reads trade ledgers within the minute's allowance: visible rows with a
   * stale ledger first, then cold builds while no page waits on the
   * budget, then the rest. */
  async ledgerTick(now = Date.now()): Promise<void> {
    const discovery = await this.settings.get("discovery");
    const perMinute = discovery.poolWeightPerMinute;
    if (perMinute <= 0) { this.ledgerTokens = 0; this.ledgerTokensAt = now; return; }
    this.ledgerTokens = this.credit(this.ledgerTokens, this.ledgerTokensAt, perMinute, now);
    this.ledgerTokensAt = now;
    if (this.ledgerTokens <= 0) return;
    const visible = await this.visibleAddresses(now);
    const rows = await this.repository.queueRows();
    const { refresh, build } = this.ledgerQueues(rows, visible, now);
    const until = Date.now() + TICK_WORK_MS;
    const tickTokens = this.ledgerTokens;
    // Refreshes get at least their share of the tick; builds get the rest
    // and whatever the refreshes leave.
    let refreshTokens = build.length > 0 ? tickTokens * LEDGER_REFRESH_SHARE : tickTokens;
    for (const address of refresh) {
      if (refreshTokens <= 0 || this.ledgerTokens <= 0 || Date.now() >= until || this.jobs.stopping) break;
      const { weight } = await this.refreshLedger(address);
      refreshTokens -= weight;
      this.ledgerTokens -= weight;
    }
    for (const address of build) {
      if (this.ledgerTokens <= 0 || Date.now() >= until || this.jobs.stopping) break;
      // A build is a thousand weight of fill lists: not while a page is
      // waiting on the budget.
      if (this.budgeter?.pagePressure()) break;
      this.ledgerTokens -= (await this.refreshLedger(address)).weight;
    }
  }

  /** The ledger loop's queues (see `ledgerTick`). */
  ledgerQueues(rows: PoolQueueRow[], visible: Set<string>, now = Date.now()): { refresh: string[]; build: string[] } {
    const backoff = now - RETRY_BACKOFF_MS;
    const due = rows.filter((row) => row.attemptedAt === null || row.attemptedAt.getTime() < backoff);
    const stale = (row: PoolQueueRow) => row.tradesAt !== null && now - row.tradesAt.getTime() >= LEDGER_REFRESH_MS;
    const byAge = (a: PoolQueueRow, b: PoolQueueRow) => a.tradesAt!.getTime() - b.tradesAt!.getTime() || a.address.localeCompare(b.address);
    const byRank = (a: PoolQueueRow, b: PoolQueueRow) => (a.poolRank ?? Infinity) - (b.poolRank ?? Infinity) || a.address.localeCompare(b.address);
    const refresh = [
      ...due.filter((row) => stale(row) && visible.has(row.address)).sort(byAge),
      ...due.filter((row) => stale(row) && !visible.has(row.address)).sort(byAge),
    ].map((row) => row.address);
    const build = due.filter((row) => row.tradesAt === null).sort((a, b) => Number(visible.has(b.address)) - Number(visible.has(a.address)) || byRank(a, b)).map((row) => row.address);
    return { refresh, build };
  }

  /** Allowance saved up since `at`, at most `MAX_SAVED_MINUTES` of it,
   * scaled by how busy pages are. */
  private credit(tokens: number, at: number, perMinute: number, now: number): number {
    const elapsedMin = Math.max(0, (now - at) / 60_000);
    const factor = this.budgeter?.backgroundFactor() ?? 1;
    return Math.min(perMinute * MAX_SAVED_MINUTES, tokens + perMinute * factor * Math.min(elapsedMin, MAX_SAVED_MINUTES));
  }

  /**
   * The rows the site shows: every board's top 100 in every sort and
   * window, the home rows, every KOL, and traders someone favorited or
   * copies. Recomputed at most every `VISIBLE_TTL_MS`.
   */
  async visibleAddresses(now = Date.now()): Promise<Set<string>> {
    if (this.visible && now - this.visible.at < VISIBLE_TTL_MS) return this.visible.addresses;
    const [shown, followed, kols] = await Promise.all([
      this.boards?.visibleAddresses() ?? Promise.resolve(new Set<string>()),
      this.repository.followedAddresses(),
      this.repository.kolAddresses(),
    ]);
    const addresses = new Set([...shown, ...followed, ...kols]);
    this.visible = { addresses, at: now };
    return addresses;
  }

  /** Age of the stored figures, for `/health`. */
  async freshness(now = Date.now()): Promise<PoolFreshness> {
    const [rows, visible] = await Promise.all([this.repository.queueRows(), this.visibleAddresses(now)]);
    const ages = (set: PoolQueueRow[]) => set.filter((r) => r.portfolioAt !== null).map((r) => Math.max(0, now - r.portfolioAt!.getTime()) / 1000).sort((a, b) => a - b);
    const stats = (set: PoolQueueRow[]) => {
      const a = ages(set);
      return { medianAgeSeconds: a.length ? Math.round(a[Math.floor(a.length / 2)]) : null, oldestAgeSeconds: a.length ? Math.round(a[a.length - 1]) : null };
    };
    const shown = rows.filter((r) => visible.has(r.address));
    return {
      visible: { rows: shown.length, ...stats(shown) },
      pool: { rows: rows.length, ready: rows.filter((r) => r.portfolioAt !== null).length, ...stats(rows) },
      sampledAt: new Date(now),
    };
  }

  /** Rebuilds when never built, after a new leaderboard import, or every
   * `POOL_REBUILD_MS`. Concurrent callers (the two loops) share one build. */
  async buildIfDue(size: number, now = Date.now()): Promise<boolean> {
    const imported = (await this.ingest.lastImportAt())?.getTime() ?? null;
    if (this.builtForSize === size && this.builtAt > 0 && imported === this.builtForImport && now - this.builtAt < POOL_REBUILD_MS) return false;
    this.building ??= (async () => {
      const result = await this.build(size);
      if (!result.total) return false;
      this.builtForSize = size;
      this.builtAt = now;
      this.builtForImport = imported;
      this.visible = undefined;
      return true;
    })().finally(() => { this.building = undefined; });
    return this.building;
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
    // Membership changed: the visible set is recomputed on the next tick.
    this.visible = undefined;
    return { ...result, total: entries.length };
  }

  /**
   * One `portfolio` read: the performance figures, stamped with the time
   * of the Hyperliquid read. A failure keeps the previous figures and
   * records the error; the row then waits `RETRY_BACKOFF_MS`.
   */
  async refreshPerformance(address: string): Promise<{ weight: number; ok: boolean }> {
    const started = Date.now();
    await this.repository.save(address, { performanceAttemptedAt: new Date(started) });
    const figures: DiscoveryFigures = {};
    let error: Error | null = null;
    try {
      const accountValue = await this.repository.leaderboardAccountValue(address);
      const raw = await this.info.portfolio(address, "background", DISCOVERY_RANK);
      Object.assign(figures, portfolioFigures(raw, accountValue, Date.now()));
    } catch (caught) {
      error = caught as Error;
    }
    await this.repository.save(address, { ...figures, lastError: error ? error.message.slice(0, 500) : null });
    this.record({ address, kind: "portfolio", weight: WEIGHT_PORTFOLIO, calls: 1, ms: Date.now() - started, ok: error === null, at: new Date() });
    if (error) this.logger.warn(`Discovery performance refresh ${address} failed: ${error.message}`);
    return { weight: WEIGHT_PORTFOLIO, ok: error === null };
  }

  /**
   * The trade ledger (cold, incremental or tracked) and the figures drawn
   * from it, stamped with the ledger's own computation time. Returns the
   * Hyperliquid weight spent (the computation's own cost log; none if it
   * joined one already running).
   */
  async refreshLedger(address: string): Promise<{ weight: number; ok: boolean }> {
    const started = Date.now();
    await this.repository.save(address, { attemptedAt: new Date(started) });
    let weight = 0;
    let calls = 0;
    let kind = "refresh";
    const figures: DiscoveryFigures = {};
    let error: Error | null = null;
    try {
      const previous = this.analytics.lastLog.get(address)?.at(-1);
      await this.analytics.compute(address, false, { rank: LEDGER_RANK, funding: false });
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
      Object.assign(figures, tradeFigures(coins, style, state?.coverageFrom ?? null, last, state?.computedAt?.getTime() ?? Date.now()));
    } catch (caught) {
      error = caught as Error;
    }
    await this.repository.save(address, { ...figures, lastError: error ? error.message.slice(0, 500) : null });
    this.record({ address, kind, weight, calls, ms: Date.now() - started, ok: error === null, at: new Date() });
    if (error) this.logger.warn(`Discovery ledger refresh ${address} failed after weight ${weight}: ${error.message}`);
    // A joined or failed computation still costs the loop something, so a
    // broken row can't spin the tick.
    return { weight: Math.max(weight, WEIGHT_PORTFOLIO), ok: error === null };
  }

  /** Both figures of one row (tests, admin). `trades: false` reads the
   * portfolio only. */
  async refreshOne(address: string, options: { trades?: boolean } = {}): Promise<{ weight: number; ok: boolean }> {
    const performance = await this.refreshPerformance(address);
    if (options.trades === false) return performance;
    const ledger = await this.refreshLedger(address);
    return { weight: performance.weight + ledger.weight, ok: performance.ok && ledger.ok };
  }

  private record(entry: PoolRefreshLog): void {
    this.log.push(entry);
    if (this.log.length > 500) this.log.shift();
  }
}
