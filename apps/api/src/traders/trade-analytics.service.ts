import { Injectable, Logger, Optional } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import {
  CHAIN_DEFAULT,
  tradeSummarySchema,
  traderClassificationSchema,
  type TradeCoverage,
  type TradeSummary,
  type TradeWindow,
  type TraderAnalyticsResponse,
  type TraderClassification,
  type TraderTradesQuery,
  type TraderTradesResponse,
} from "@trading-dashboard/shared/contracts";

import { readForward, readRecentHistory, type FillSource } from "../analytics/fill-history.js";
import { pnlTier, sizeTier, summarize, tradingStyle } from "../analytics/trade-metrics.js";
import {
  applyFills,
  attributeFunding,
  isClosed,
  isPartial,
  reconstructTrades,
  toRoundTrip,
  type FundingEvent,
  type Trade,
} from "../analytics/trade-reconstruction.js";
import { ANALYTICS_CONSUMER, HyperliquidInfoClient, twapSliceToFill, USER_FUNDING_PAGE_SIZE } from "../hyperliquid/hyperliquid-info.client.js";
import { budgetConsumer, currentBudgetConsumer, PAGE_RANK, UNRANKED_BASE } from "../hyperliquid/request-budgeter.service.js";
import type { HlUserFill } from "../hyperliquid/types.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { BusyException } from "./busy.js";
import { AnalysisHistoryService } from "./analysis-history.service.js";
import type { HistoryCaller } from "./analysis-history.repository.js";
import type { HistorySnapshot } from "./analysis-history.repository.js";
import type { ArchiveSpan } from "../analytics/history-checkpoint.js";
import { positionBreaks } from "../analytics/fill-integrity.js";
import { lastMillisecondPerCoin } from "../watcher/stored-fill-pages.js";
import { TradeAnalyticsRepository, type AnalyticsInsert, type AnalyticsRow, type FillCoverage, type TradeAnalyticsTx } from "./trade-analytics.repository.js";
import { portfolioSeries } from "./traders.mappers.js";
import { FILLS_TTL_MS, TradersService } from "./traders.service.js";

/** Served from the store for this long; older answers are still served
 * while a refresh runs in the background. */
export const STALE_MS = 10 * 60_000;
/** A watched address's figures are the worker's to refresh (every minute,
 * once older than `STALE_MS`). Older than this, the worker is not doing it
 * (down, not deployed beside this api, or starved), and a page read
 * refreshes them itself, as for any other address. Three worker periods. */
export const TRACKED_FALLBACK_MS = 3 * STALE_MS;
/** A cold read keeps the newest this many fills and at least
 * `COLD_MIN_TRADES` closed trades, back to `LOOKBACK_MS` at most, within
 * `COLD_FILL_CALLS` fill calls (≈ 120 weight each when full). A burst of
 * fills (one position built from thousands) can hold few trades. */
export const COLD_TARGET_FILLS = 10_000;
export const COLD_MIN_TRADES = 30;
export const LOOKBACK_MS = 365 * 86_400_000;
/** `…ByTime` calls per cold read: fills, then TWAP slices. */
export const COLD_FILL_CALLS = 24;
export const COLD_TWAP_CALLS = 8;
/** Watched addresses one worker turn refreshes (one turn a minute: 60
 * watched addresses every `STALE_MS`). */
export const TRACKED_REFRESH_PER_TICK = 6;
/** A watched address whose refresh failed is left out of the worker's turns
 * for this long, doubling with each failure in a row up to
 * `TRACKED_BACKOFF_MAX_MS`; a success clears it. */
export const TRACKED_BACKOFF_BASE_MS = 2 * 60_000;
export const TRACKED_BACKOFF_MAX_MS = 60 * 60_000;
/** A worker refresh reads a watched address's funding at most this often. */
export const TRACKED_FUNDING_EVERY_MS = 60 * 60_000;
/** Pages per incremental refresh (a refresh every ~10 min rarely needs 2). */
export const REFRESH_PAGES = 6;
/** Funding is read from the start of coverage (at most the lookback), 40
 * pages per step; a long history completes over the next refreshes. */
export const FUNDING_LOOKBACK_MS = LOOKBACK_MS;
export const FUNDING_MAX_PAGES = 40;
/** Cold computations at once; more wait. Beyond `MAX_WAITING` a new cold
 * address is answered busy without queueing. */
export const MAX_CONCURRENT = 2;
export const MAX_WAITING = 20;
/** Every call of the computation is a trader-page call at the fills rank
 * (background lane, behind first paint and the chart, ahead of sweeps);
 * funding, the heavy tail, goes unranked, behind everything page-driven. */
const LANE = "background" as const;
/** A job a page started: after the pages' own calls (a cold trader's up to
 * 32 history reads used to queue level with the next page's profile and
 * fills), ahead of every periodic job. */
const RANK = PAGE_RANK.analytics;

const WINDOWS: TradeWindow[] = ["all", "30d", "7d", "1d"];

/** Weight and calls one computation spent (Hyperliquid's formula: 20 per
 * call, +1 per 20 items on list calls). */
export interface Cost {
  calls: number;
  weight: number;
  /** Budgeter rank of the computation's calls; default `PAGE_RANK.fills`.
   * The discovery pool passes an unranked value so pages go first. */
  rank?: number;
  /** Who asked: decides whether a durable history job may be created. */
  caller?: HistoryCaller;
  /** Set by the computation: the address has a durable history job, so
   * the fills it reads are kept. */
  keep?: boolean;
}
const listWeight = (items: number) => 20 + Math.ceil(items / 20);

/** The account now: positions (signed size per coin) and perp value. */
interface LiveAccount {
  /** When the state was read (epoch ms). */
  time: number;
  positions: Map<string, number>;
  perpAccountValue: number;
}

/** A computation's figures (logged; the last few kept per address).
 * `fills`: fills read (funding: payments read). */
export interface ComputeLog {
  /** "archive": a first build from the stored fills of the archive's span
   * plus REST's tail after it. */
  kind: "cold" | "archive" | "refresh" | "tracked" | "funding";
  ms: number;
  calls: number;
  weight: number;
  fills: number;
  trades: number;
}

type Stored = Pick<AnalyticsRow, "summary" | "classification" | "source" | "coverageFrom" | "truncated" | "fundingFrom" | "fundingCursor" | "fillsRead" | "computedAt" | "historyThrough">;

/**
 * Round-trip analytics for any address (the trader page's win rate, 表現 and
 * 交易 tabs, 分組 and 最佳與最差).
 *
 * - Tracked addresses: rebuilt from our `fills` table (no fill weight).
 * - Other addresses: Hyperliquid's fill and TWAP-slice history, newest
 *   first, up to `COLD_TARGET_FILLS`; later refreshes read only fills after
 *   the stored cursor and continue the open trades.
 * - Addresses the S3 archive covers: the first build reads the stored
 *   fills of the certified span and asks REST only for what follows it
 *   (and for TWAP slices, until the archive is trusted for those); what
 *   precedes the span arrives with the durable history job.
 * - Funding: a second, lower-priority step after the trades are stored.
 *
 * Everything is stored (`trader_trades`, `trader_analytics`) and served
 * from there; an answer older than `STALE_MS` is served while a refresh
 * runs. Work runs as background jobs, outside any request, so a 503 busy
 * answer doesn't cancel it: the retry finds it stored. Per address one
 * step at a time; at most `MAX_CONCURRENT` addresses compute at once.
 */
@Injectable()
export class TradeAnalyticsService {
  private readonly logger = new Logger(TradeAnalyticsService.name);
  private readonly inflight = new Map<string, Promise<AnalyticsRow>>();
  /** The running computation's cost (its rank is promoted by joiners). */
  private readonly costs = new Map<string, Cost>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  /** Where each tracked address's last full rebuild started (this process).
   * A refresh at the same depth only extends the stored trades. */
  private readonly trackedDepth = new Map<string, number>();
  /** Watched addresses whose last refresh failed: failures in a row and
   * when the next turn may try again (the worker's own attempt marker). */
  private readonly trackedBackoff = new Map<string, { failures: number; retryAt: number }>();
  readonly lastLog = new Map<string, ComputeLog[]>();

  constructor(
    private readonly repository: TradeAnalyticsRepository,
    private readonly traders: TradersService,
    private readonly info: HyperliquidInfoClient,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
    @Optional() private readonly history?: AnalysisHistoryService,
  ) {}

  // --- reading --------------------------------------------------------------

  /** `caller`: who is asking (the routes are public). It only decides
   * whether a cold address also gets a durable history job. */
  async analytics(address: string, window: TradeWindow, caller: HistoryCaller = "product"): Promise<TraderAnalyticsResponse> {
    const read = await this.current(address, caller);
    const { watched } = read;
    let { row } = read;
    // A row stored before a window existed is recomputed first.
    if (!(window in row.summary)) row = await this.compute(address, true, { caller });
    const summaries = row.summary as Record<TradeWindow, unknown>;
    return {
      address,
      window,
      summary: tradeSummarySchema.parse(summaries[window]),
      classification: traderClassificationSchema.parse(row.classification),
      coverage: await this.coverage(address, row),
      computedAt: row.computedAt,
      // A watched address is the worker's to refresh once stale; past
      // TRACKED_FALLBACK_MS this read started the refresh itself (inflight).
      refreshing: this.inflight.has(address) || (watched && workerDue(row.computedAt.getTime(), Date.now())),
    };
  }

  async trades(address: string, query: TraderTradesQuery, caller: HistoryCaller = "product"): Promise<TraderTradesResponse> {
    const { row } = await this.current(address, caller);
    const [ms, tid] = query.cursor ? query.cursor.split("_") : [];
    const cursor = query.cursor ? { sortTime: new Date(Number(ms)), openTid: BigInt(tid) } : null;
    const [rows, total] = await Promise.all([
      this.repository.page(address, query.status, query.limit + 1, cursor),
      this.repository.count(address, query.status),
    ]);
    const now = row.historyThrough?.getTime() ?? Date.now();
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      address,
      items: page.map((t) => toRoundTrip(t, now)),
      nextCursor: rows.length > query.limit && last ? `${last.exitTime ?? last.entryTime}_${last.openTid}` : null,
      total,
      coverage: await this.coverage(address, row),
      computedAt: row.computedAt,
    };
  }

  /** What the figures cover, including the archive-certified span, so a
   * client never has to infer completeness. */
  private async coverage(address: string, row: Stored): Promise<TradeCoverage> {
    const [backfill, span] = await Promise.all([
      this.history?.status(address),
      this.history?.archiveSpan(address).catch(() => null) ?? null,
    ]);
    return { ...coverageOf(row), backfill, archiveFrom: span ? new Date(span.from) : null, archiveThrough: span ? new Date(span.through) : null };
  }

  /**
   * The stored row. A watched address's figures are the worker's to keep
   * fresh (`refreshTracked`, every minute, and after a backfill revises its
   * fills), so a read leaves a stale one to the worker, unless the figures
   * are older than `TRACKED_FALLBACK_MS`: then no worker is refreshing them
   * and the read refreshes them in the background, as it does any other
   * address once stale (nothing else would). A cold address is computed
   * (the caller's deadline turns a long one into 503 busy, and it carries on).
   */
  private async current(address: string, caller: HistoryCaller): Promise<{ row: Stored; watched: boolean }> {
    const row = await this.repository.state(address);
    if (!row) return { row: await this.compute(address, true, { caller }), watched: false };
    const watched = await this.traders.isTracked(address);
    const age = Date.now() - row.computedAt.getTime();
    // Nobody waits for a stale row's refresh (the stored answer goes out
    // now), so it goes behind every page's own calls: at the analytics rank
    // its list and state reads drained the main bucket the next cold page's
    // first paint and fill lists needed (Stage, 2026-10-05).
    if (age > (watched ? TRACKED_FALLBACK_MS : STALE_MS)) this.compute(address, false, { caller, rank: UNRANKED_BASE }).catch(() => undefined);
    return { row, watched };
  }

  /**
   * The worker's turn, every minute: the watched addresses whose figures
   * are due (none yet, older than `STALE_MS`, or a backfill that just ended),
   * oldest first, `TRACKED_REFRESH_PER_TICK` at most, one after another. A
   * tracked rebuild reads our fills (no fill weight) and the account's state;
   * funding is read at most once an hour per address. Returns the addresses
   * refreshed.
   */
  refreshTracked(now = Date.now()): Promise<string[]> {
    // One turn at a time: a turn can wait minutes for the budget, and the
    // minute cron would otherwise start dozens of turns over the same due
    // addresses, each counting the same failure again (seen 2026-10-04:
    // "46 in a row" logged in one millisecond for one address).
    if (this.trackedTurn) return Promise.resolve([]);
    this.trackedTurn = this.refreshTrackedTurn(now).finally(() => { this.trackedTurn = undefined; });
    return this.trackedTurn;
  }

  private trackedTurn: Promise<string[]> | undefined;

  private async refreshTrackedTurn(now: number): Promise<string[]> {
    const waiting = [...this.trackedBackoff].filter(([, backoff]) => backoff.retryAt > now).map(([address]) => address);
    const due = await this.repository.trackedDue(new Date(now - STALE_MS), TRACKED_REFRESH_PER_TICK, waiting);
    const done: string[] = [];
    for (const { address, fundingCursor } of due) {
      if (this.jobs.stopping) break;
      const funding = fundingCursor === null || now - fundingCursor.getTime() >= TRACKED_FUNDING_EVERY_MS;
      try {
        await this.compute(address, false, { rank: UNRANKED_BASE, funding });
        this.trackedBackoff.delete(address);
        done.push(address);
      } catch (error) {
        // Busy is this process's queue being full, not the address failing.
        if (error instanceof BusyException) continue;
        const failures = (this.trackedBackoff.get(address)?.failures ?? 0) + 1;
        const waitMs = Math.min(TRACKED_BACKOFF_MAX_MS, TRACKED_BACKOFF_BASE_MS * 2 ** (failures - 1));
        this.trackedBackoff.set(address, { failures, retryAt: now + waitMs });
        this.logger.warn(`Tracked analytics for ${address} failed (${failures} in a row, next try in ${Math.round(waitMs / 60_000)} min): ${(error as Error).message}`);
      }
    }
    return done;
  }

  /** When a watched address's next refresh may run after failures (tests, health). */
  trackedRetryAt(address: string): number | undefined {
    return this.trackedBackoff.get(address)?.retryAt;
  }

  /** The watcher stored history inside an address's verified span. */
  @OnEvent("fills.revised")
  onFillsRevised(event: { address: string }): void {
    if (this.jobs.stopping) return;
    this.compute(event.address, false).catch(() => undefined);
  }

  /** One computation per address at a time; callers share it. A caller
   * with a better rank than the computation in flight (a page request
   * joining the discovery pool's unranked build) promotes it: its calls
   * from then on go at the page's rank instead of waiting behind every
   * other page's. `rank` defaults to the trader page's fills rank;
   * `funding: false` (the discovery pool) skips the funding step that
   * normally follows. */
  compute(address: string, _cold: boolean, options: { rank?: number; funding?: boolean; caller?: HistoryCaller } = {}): Promise<AnalyticsRow> {
    const { rank, funding = true, caller = "product" } = options;
    const existing = this.inflight.get(address);
    if (existing) {
      const cost = this.costs.get(address);
      if (cost && (cost.rank ?? RANK) > (rank ?? RANK)) cost.rank = rank ?? RANK;
      return existing;
    }
    if (this.jobs.stopping) return Promise.reject(new Error("Shutting down"));
    if (this.inflight.size >= MAX_CONCURRENT + MAX_WAITING) return Promise.reject(new BusyException(5_000));
    // A job a request started reads as "analytics" (the background lane,
    // waiting for room); a worker loop's keeps its own label and cap.
    const labelled = <T>(work: () => Promise<T>) => (currentBudgetConsumer() ? work() : budgetConsumer(ANALYTICS_CONSUMER, work));
    const promise = this.jobs.run(() => labelled(() => this.serial(address, () => this.limited(() => this.refresh(address, rank, caller)))));
    this.inflight.set(address, promise);
    promise
      .then(() => funding ? this.jobs.run(() => labelled(() => this.serial(address, () => this.limited(() => this.fundingStep(address))))) : undefined)
      .catch((error: Error) => {
        if (!(error instanceof BusyException)) this.logger.warn(`Trade analytics for ${address} failed: ${error.message}`);
      })
      .finally(() => {
        if (this.inflight.get(address) === promise) this.inflight.delete(address);
      });
    return promise;
  }

  /** Whether figures are stored for this address (a read answers at once). */
  async isStored(address: string): Promise<boolean> {
    return (await this.repository.state(address)) !== undefined;
  }

  /** Resolves once no computation or funding step is running (tests). */
  async settled(): Promise<void> {
    while (this.chains.size > 0 || this.inflight.size > 0) {
      await Promise.allSettled([...this.chains.values(), ...this.inflight.values()]);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  private serial<T>(address: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(address) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.chains.set(address, next);
    next
      .finally(() => {
        if (this.chains.get(address) === next) this.chains.delete(address);
      })
      .catch(() => undefined);
    return next;
  }

  private async limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_CONCURRENT) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running += 1;
    try {
      return await work();
    } finally {
      this.running -= 1;
      this.waiting.shift()?.();
    }
  }

  // --- computing trades -------------------------------------------------------

  /** Brings the address's trades and summary up to date (cold, incremental
   * or, when tracked, a rebuild from our fills). */
  async refresh(address: string, rank?: number, caller: HistoryCaller = "product"): Promise<AnalyticsRow> {
    const started = Date.now();
    const cost: Cost = { calls: 0, weight: 0, rank, caller };
    this.costs.set(address, cost);
    try {
      return await this.refreshAt(address, cost, started);
    } finally {
      if (this.costs.get(address) === cost) this.costs.delete(address);
    }
  }

  /** The rank the computation in flight for `address` runs at (tests). */
  rankOf(address: string): number | undefined {
    return this.costs.get(address)?.rank;
  }

  private async refreshAt(address: string, cost: Cost, started: number): Promise<AnalyticsRow> {
    const [state, watched] = await Promise.all([this.repository.state(address), this.traders.isTracked(address)]);
    // Our own fills are the source only once their backward backfill has
    // ended: before that the verified span is a recent sliver, and the
    // REST read below describes the account better.
    const coverage = watched ? await this.repository.fillCoverage(address) : undefined;
    const tracked = Boolean(coverage?.verifiedFrom && coverage.verifiedThrough && coverage.backfillStatus !== "pending");
    // Figures stored before raw fills were kept get a job over exactly the
    // range they claim, so that range becomes auditable first.
    // Only for an address that may have a durable job (anyone can ask for
    // any address): without one the answer is computed from Hyperliquid as
    // before, and nothing is stored for a background scan.
    cost.keep = !watched && (await this.history?.ensure(address, state?.source === "hyperliquid" ? state.coverageFrom?.getTime() : undefined, cost.caller)) === true;
    const snapshot = cost.keep ? await this.history?.snapshot(address) : null;
    // Never replace a newer legacy ledger with an older archive snapshot.
    const historyStartsAt = snapshot?.fills.reduce((min, f) => Math.min(min, f.time), Infinity) ?? Infinity;
    const useHistory = snapshot && snapshot.through.getTime() >= (state?.fillCursor?.getTime() ?? 0)
      && (!state?.coverageFrom || historyStartsAt <= state.coverageFrom.getTime());
    const live = await this.liveAccount(address, cost);
    let kind: ComputeLog["kind"];
    let next: Omit<AnalyticsInsert, "summary" | "classification" | "computedAt">;
    let fillCount: number;
    let persist: (tx: TradeAnalyticsTx) => Promise<void>;
    if (tracked) {
      kind = "tracked";
      ({ next, fillCount, persist } = await this.rebuildTracked(address, state, coverage!));
    } else if (useHistory) {
      kind = "refresh";
      ({ next, fillCount, persist } = await this.rebuildHistory(address, snapshot!, state));
    } else if (!state || state.source !== "hyperliquid" || state.fillCursor === null) {
      // Where the archive certifies a span its stored fills are the
      // history: no newest-first REST read (up to 32 range calls), and no
      // wait for the durable job, which brings what precedes the span later.
      const span = cost.keep && this.history?.trusts("regular") ? await this.history.archiveSpan(address).catch(() => null) : null;
      kind = span ? "archive" : "cold";
      ({ next, fillCount, persist } = span ? await this.archiveHyperliquid(address, span, cost) : await this.coldHyperliquid(address, cost));
    } else {
      kind = "refresh";
      ({ next, fillCount, persist } = await this.incrementalHyperliquid(address, state, cost));
    }
    const classification = await this.classify(address, live, cost);
    const { row, trades } = await this.repository.transaction(async (tx) => {
      await this.repository.assertState(tx, address, state);
      await persist(tx);
      const dropped = tracked || useHistory ? 0 : await this.dropClosedElsewhere(address, live, tx);
      return this.store(address, { ...next, truncated: next.truncated || dropped > 0 }, classification, tx);
    });
    this.record(address, { kind, ms: Date.now() - started, ...cost, fills: fillCount, trades });
    return row;
  }

  /** Summaries of every stored trade + the new state, in one write. */
  private async store(
    address: string,
    next: Omit<AnalyticsInsert, "summary" | "classification" | "computedAt">,
    classification: Omit<TraderClassification, "style">,
    tx?: TradeAnalyticsTx,
    computedAt = new Date(),
  ): Promise<{ row: AnalyticsRow; trades: number }> {
    const now = next.historyThrough?.getTime() ?? Date.now();
    const trades = (await this.repository.allTrades(address, tx)).map((t) => toRoundTrip(t, now));
    const summary = Object.fromEntries(WINDOWS.map((w) => [w, summarize(trades, w, now)])) as Record<TradeWindow, TradeSummary>;
    const full: TraderClassification = { ...classification, style: tradingStyle(summary.all.medianHoldSeconds) };
    const row = await this.repository.saveState({
      ...next,
      summary: jsonSummary(summary),
      classification: full,
      computedAt,
    }, tx);
    return { row, trades: trades.length };
  }

  private record(address: string, log: ComputeLog): void {
    const list = this.lastLog.get(address) ?? [];
    list.push(log);
    if (list.length > 10) list.shift();
    this.lastLog.delete(address);
    this.lastLog.set(address, list);
    if (this.lastLog.size > 200) this.lastLog.delete(this.lastLog.keys().next().value!);
    this.logger.log(
      `Trade analytics ${log.kind} ${address}: ${log.fills} ${log.kind === "funding" ? "payments" : "fills"}, ` +
        `${log.trades} trades, ${log.calls} calls, weight ${log.weight}, ${log.ms} ms`,
    );
  }

  /** Rebuild only a jointly completed, immutable cutoff. Older data can
   * repair partial entries, so a historical extension resets funding. */
  private async rebuildHistory(address: string, snapshot: HistorySnapshot, state: AnalyticsRow | undefined) {
    const earliest = snapshot.fills.reduce((min, f) => Math.min(min, f.time), Infinity);
    const extended = !state?.historyThrough || earliest < (state.coverageFrom?.getTime() ?? Infinity);
    const fundingFrom = extended ? null : state?.fundingFrom?.getTime() ?? null;
    const result = applyFills(address, new Map<string, Trade>(), snapshot.fills, fundingFrom);
    const persist = async (tx: TradeAnalyticsTx) => {
      if (!extended) {
        const kept = await this.repository.fundingByTid(address, tx);
        for (const trade of result.touched) {
          const funding = kept.get(trade.openTid);
          if (funding !== undefined && trade.funding !== null) trade.funding = funding;
        }
      }
      await this.repository.replaceTrades(tx, address, result.touched);
    };
    return {
      persist,
      fillCount: snapshot.fills.length,
      next: {
        chain: CHAIN_DEFAULT, address, source: "hyperliquid" as const,
        coverageFrom: Number.isFinite(earliest) ? new Date(earliest) : null,
        historyThrough: snapshot.through,
        // A completed upstream scan cannot certify the account's lifetime.
        // (`lifetimeComplete` in fill-integrity.ts is the candidate proof;
        // it is reported by the reconciliation, not yet trusted here.)
        truncated: true,
        fillsRead: snapshot.fills.length, fillCursor: snapshot.through, cursorTids: [],
        fundingFrom: extended ? null : state?.fundingFrom ?? null,
        fundingCursor: extended ? null : state?.fundingCursor ?? null,
      },
    };
  }

  /**
   * From our own fills, and only from the span proven complete: fills
   * stored outside `[verified_from, verified_through]` (live confirms
   * ahead of the cursor, rows on the far side of a hole) are not counted,
   * so the figures never run across a gap. Where the S3 archive's
   * certified span reaches the verified one, the history starts at the
   * archive's first hour instead (the REST backfill reaches only as far as
   * REST retains, a week or two of a 10,000-fills-a-day account). Both the
   * archive and our span are walked page by page, so the depth is not
   * bounded by memory, and the span keeps growing with every fill the
   * watcher stores.
   *
   * Once built, a later refresh only applies the fills after the cursor to
   * the open trades, unless the depth or the history below the cursor
   * changed (a longer archive span, a backfill, a repaired hole).
   */
  private async rebuildTracked(address: string, state: AnalyticsRow | undefined, coverage: FillCoverage) {
    const through = coverage.verifiedThrough!;
    const verifiedFrom = coverage.verifiedFrom!.getTime();
    // The archive holds fills the watcher's own backfill could not reach
    // (REST keeps a moving window); before `verified_from` it is the source.
    const span = await this.history?.archiveSpan(address).catch(() => null);
    const archiveFrom = span && span.from < verifiedFrom && span.through >= verifiedFrom ? span.from : null;
    const start = archiveFrom ?? Math.max(Date.now() - LOOKBACK_MS, verifiedFrom);
    const revised = coverage.revisedAt !== null && state !== undefined && coverage.revisedAt > state.computedAt;
    if (state?.source === "tracked" && state.fillCursor && state.fillCursor.getTime() >= verifiedFrom && !revised && this.trackedDepth.get(address) === start) {
      return this.extendTracked(address, state, coverage);
    }
    const fundingFrom = state?.fundingFrom?.getTime() ?? null;
    const open = new Map<string, Trade>();
    const touched = new Map<bigint, Trade>();
    // The last millisecond of each coin read so far, so a break between two
    // pages is seen like one inside a page.
    let tail: HlUserFill[] = [];
    let breaks = 0;
    let fillCount = 0;
    let first: number | null = null;
    let newest: { time: number | null; tids: string[] } = { time: null, tids: [] };
    const consume = (batch: HlUserFill[]) => {
      const counted = batch.filter((f) => f.time >= start && f.time <= through.getTime() && !f.coin.startsWith("@") && !f.coin.includes("/"));
      if (counted.length === 0) return;
      breaks += positionBreaks([...tail, ...counted]).length;
      tail = lastMillisecondPerCoin([...tail, ...counted]);
      const result = applyFills(address, open, counted, fundingFrom);
      for (const trade of result.dropped) touched.delete(trade.openTid);
      for (const trade of result.touched) touched.set(trade.openTid, trade);
      fillCount += counted.length;
      for (const f of counted) if (first === null || f.time < first) first = f.time;
      const latest = latestOf(counted);
      if (latest.time !== null && (newest.time === null || latest.time > newest.time)) newest = latest;
      else if (latest.time !== null && latest.time === newest.time) newest = { time: newest.time, tids: [...newest.tids, ...latest.tids] };
    };
    if (archiveFrom !== null) {
      for await (const page of this.history!.archivedFillPages(address, archiveFrom, verifiedFrom)) consume(page);
    }
    // Our own span, page by page: it grows with every fill stored and is no
    // longer held to a 50,000-fill backfill cap.
    for await (const page of this.repository.trackedFillPages(address, new Date(Math.max(start, verifiedFrom)), through)) consume(dedupe(page));
    const trades = [...touched.values()];
    const persist = async (tx: TradeAnalyticsTx) => {
      // Funding already read stays with its trade across the rebuild.
      const kept = state?.source === "tracked" ? await this.repository.fundingByTid(address, tx) : new Map<bigint, number>();
      for (const t of trades) {
        const funding = kept.get(t.openTid);
        if (funding !== undefined && t.funding !== null) t.funding = funding;
      }
      await this.repository.replaceTrades(tx, address, trades);
      this.trackedDepth.set(address, start);
    };
    // Complete only when the history reaches its start (the backfill's
    // floor, or the archive's first hour) and the position chain of what is
    // counted has no break.
    const continuous = coverage.breaks.length === 0 && breaks === 0;
    return {
      persist,
      fillCount,
      next: {
        chain: CHAIN_DEFAULT,
        address,
        source: "tracked" as const,
        historyThrough: through,
        coverageFrom: first === null ? null : new Date(first),
        truncated: trades.some(isPartial) || !continuous || (coverage.backfillStatus !== "complete" && archiveFrom === null),
        fillsRead: fillCount,
        fillCursor: newest.time === null ? null : new Date(newest.time),
        cursorTids: newest.tids,
        // A source switch starts funding over.
        fundingFrom: state?.source === "tracked" ? state.fundingFrom : null,
        fundingCursor: state?.source === "tracked" ? state.fundingCursor : null,
      },
    };
  }

  /** A tracked refresh with nothing changed below the cursor: the fills
   * stored since, applied to the open trades. */
  private async extendTracked(address: string, state: AnalyticsRow, coverage: FillCoverage) {
    const through = coverage.verifiedThrough!;
    const since = state.fillCursor!.getTime();
    const seen = new Set(state.cursorTids);
    const fresh = dedupe(await this.repository.trackedFills(address, state.fillCursor!, through))
      .filter((f) => (f.time > since || !seen.has(String(f.tid))) && !f.coin.startsWith("@") && !f.coin.includes("/"));
    const open = new Map((await this.repository.openTrades(address)).map((t) => [t.coin, t]));
    const result = applyFills(address, open, fresh, state.fundingFrom?.getTime() ?? null);
    const persist = async (tx: TradeAnalyticsTx) => {
      await this.repository.deleteTrades(tx, address, result.dropped.map((t) => t.openTid));
      await this.repository.upsertTrades(tx, address, result.touched);
    };
    const newest = latestOf(fresh);
    const cursorTids = newest.time === since ? [...state.cursorTids, ...newest.tids] : newest.tids;
    return {
      persist,
      fillCount: fresh.length,
      next: {
        chain: CHAIN_DEFAULT,
        address,
        source: "tracked" as const,
        historyThrough: through,
        coverageFrom: state.coverageFrom,
        truncated: state.truncated || result.touched.some(isPartial) || coverage.breaks.length > 0 || positionBreaks(fresh).length > 0,
        fillsRead: state.fillsRead + fresh.length,
        fillCursor: newest.time === null ? state.fillCursor : new Date(newest.time),
        cursorTids: newest.time === null ? state.cursorTids : cursorTids,
        fundingFrom: state.fundingFrom,
        fundingCursor: state.fundingCursor,
      },
    };
  }

  private fillSource(address: string, twap: boolean, latest: HlUserFill[], cost: Cost): FillSource {
    return {
      latest: async () => latest,
      range: async (start, end) => {
        const batch = twap
          ? (await this.info.userTwapSliceFillsByTime(address, start, end, LANE, cost.rank ?? RANK)).map(twapSliceToFill)
          : await this.info.userFillsByTime(address, start, end, LANE, cost.rank ?? RANK);
        cost.calls += 1;
        cost.weight += listWeight(batch.length);
        return batch;
      },
    };
  }

  private async coldHyperliquid(address: string, cost: Cost) {
    const now = Date.now();
    // Shared with the page's fills tab and activity (cached 5 min).
    const fillsCached = this.traders.userFillsCache.peek(address) !== undefined;
    const twapCached = this.traders.twapFillsCache.peek(address) !== undefined;
    const [latest, latestTwap] = await this.traders.latestFills(address);
    for (const [cached, list] of [[fillsCached, latest], [twapCached, latestTwap]] as const) {
      if (cached) continue;
      cost.calls += 1;
      cost.weight += listWeight(list.length);
    }
    const history = await readRecentHistory(this.fillSource(address, false, latest, cost), {
      now,
      lookbackStart: now - LOOKBACK_MS,
      target: COLD_TARGET_FILLS,
      maxCalls: COLD_FILL_CALLS,
      enough: (fills) => reconstructTrades(address, fills).filter(isClosed).length >= COLD_MIN_TRADES,
    });
    // TWAP slices over the same span (they interleave with the fills).
    const twapFrom = history.from ?? now - LOOKBACK_MS;
    const twap = await readRecentHistory(this.fillSource(address, true, latestTwap, cost), {
      now,
      lookbackStart: twapFrom,
      target: Number.POSITIVE_INFINITY,
      maxCalls: COLD_TWAP_CALLS,
    });
    const from = Math.max(history.from ?? 0, twap.truncated && twap.from !== null ? twap.from : 0) || null;
    let all = [...history.fills, ...twap.fills].filter((f) => from === null || f.time >= from);
    // Both streams must cover the same fixed upper bound before sharing a
    // checkpoint. Their caches can have different observation times.
    const tail = async (isTwap: boolean, cached: HlUserFill[]) => {
      const start = latestOf(cached).time ?? now - FILLS_TTL_MS;
      const result = await readForward(async (since) => {
        const batch = isTwap
          ? (await this.info.userTwapSliceFillsByTime(address, since, now, LANE, cost.rank ?? RANK)).map(twapSliceToFill)
          : await this.info.userFillsByTime(address, since, now, LANE, cost.rank ?? RANK);
        cost.calls += 1;
        cost.weight += listWeight(batch.length);
        return batch;
      }, start, REFRESH_PAGES);
      if (!result.complete) throw new BusyException(5_000);
      return result.fills;
    };
    const [regularTail, twapTail] = await Promise.all([tail(false, latest), tail(true, latestTwap)]);
    all = dedupe([...all, ...regularTail, ...twapTail]).filter(f => f.time <= now && (from === null || f.time >= from));
    if (cost.keep) await this.history?.preserve(address, all);
    const open = new Map<string, Trade>();
    const result = applyFills(address, open, all, null);
    const persist = (tx: TradeAnalyticsTx) => this.repository.replaceTrades(tx, address, result.touched);
    const cursor = latestOf(all);
    return {
      persist,
      fillCount: all.length,
      next: {
        chain: CHAIN_DEFAULT,
        address,
        source: "hyperliquid" as const,
        historyThrough: null,
        coverageFrom: all.length > 0 ? new Date(Math.min(...all.map((f) => f.time))) : null,
        truncated: history.truncated || twap.truncated || result.touched.some(isPartial),
        fillsRead: all.length,
        fillCursor: cursor.time === null ? new Date(now) : new Date(cursor.time),
        cursorTids: cursor.tids,
        fundingFrom: null,
        fundingCursor: null,
      },
    };
  }

  /**
   * First build of an address the archive covers: the stored fills of the
   * certified span (the newest `HISTORY_BUILD_MAX_FILLS`), REST from the
   * span's end to now, and TWAP slices: stored ones where the archive is
   * trusted for them (`S3_ARCHIVE_TRUST=all`, then only their tail is
   * read), otherwise REST's over the same range, as a cold read does.
   */
  private async archiveHyperliquid(address: string, span: ArchiveSpan, cost: Cost) {
    const now = Date.now();
    const stored = await this.history!.archivedFills(address, span);
    // A cut read may have split its oldest millisecond: start after it.
    let from = stored.capped ? stored.reduce((min, f) => Math.min(min, f.time), Infinity) + 1 : Math.max(span.from, now - LOOKBACK_MS);
    const forward = async (twap: boolean) => {
      const result = await readForward(async (since) => {
        const batch = twap
          ? (await this.info.userTwapSliceFillsByTime(address, since, now, LANE, cost.rank ?? RANK)).map(twapSliceToFill)
          : await this.info.userFillsByTime(address, since, now, LANE, cost.rank ?? RANK);
        cost.calls += 1;
        cost.weight += listWeight(batch.length);
        return batch;
      }, span.through, REFRESH_PAGES);
      if (!result.complete) throw new BusyException(5_000);
      return result.fills;
    };
    let twap: HlUserFill[];
    if (this.history!.trusts("twap")) {
      twap = await forward(true);
    } else {
      const cached = this.traders.twapFillsCache.peek(address) !== undefined;
      const [, latestTwap] = await this.traders.latestFills(address);
      if (!cached) {
        cost.calls += 1;
        cost.weight += listWeight(latestTwap.length);
      }
      const slices = await readRecentHistory(this.fillSource(address, true, latestTwap, cost), { now, lookbackStart: from, target: Number.POSITIVE_INFINITY, maxCalls: COLD_TWAP_CALLS });
      // Slices older than REST could page through: the span starts where they are complete.
      if (slices.truncated && slices.from !== null) from = Math.max(from, slices.from);
      twap = slices.fills;
    }
    const tail = await forward(false);
    const fresh = dedupe([...tail, ...twap]).filter((f) => f.time <= now);
    if (cost.keep) await this.history?.preserve(address, fresh);
    const all = dedupe([...stored, ...fresh]).filter((f) => f.time >= from && f.time <= now);
    const result = applyFills(address, new Map<string, Trade>(), all, null);
    const cursor = latestOf(all);
    return {
      persist: (tx: TradeAnalyticsTx) => this.repository.replaceTrades(tx, address, result.touched),
      fillCount: all.length,
      next: {
        chain: CHAIN_DEFAULT,
        address,
        source: "hyperliquid" as const,
        historyThrough: null,
        coverageFrom: all.length > 0 ? new Date(all.reduce((min, f) => Math.min(min, f.time), Infinity)) : null,
        // The archive certifies its span, not the account's lifetime.
        truncated: true,
        fillsRead: all.length,
        fillCursor: cursor.time === null ? new Date(now) : new Date(cursor.time),
        cursorTids: cursor.tids,
        fundingFrom: null,
        fundingCursor: null,
      },
    };
  }

  private async incrementalHyperliquid(address: string, state: AnalyticsRow, cost: Cost) {
    const until = Date.now();
    const since = state.fillCursor!.getTime();
    const seen = new Set(state.cursorTids);
    const read = (twap: boolean) =>
      readForward(async (start) => {
        const batch = twap
          ? (await this.info.userTwapSliceFillsByTime(address, start, until, LANE, cost.rank ?? RANK)).map(twapSliceToFill)
          : await this.info.userFillsByTime(address, start, until, LANE, cost.rank ?? RANK);
        cost.calls += 1;
        cost.weight += listWeight(batch.length);
        return batch;
      }, since, REFRESH_PAGES);
    const [regular, twap] = await Promise.all([read(false), read(true)]);
    // A shared cursor cannot advance past unread history in either stream.
    // Preserve the last good checkpoint instead of silently skipping fills.
    if (!regular.complete || !twap.complete) throw new BusyException(5_000);
    const fresh = dedupe([...regular.fills, ...twap.fills]).filter(
      (f) => f.time > since || (f.time === since && !seen.has(String(f.tid))),
    );
    if (cost.keep) await this.history?.preserve(address, fresh);
    const fundingFrom = state.fundingFrom?.getTime() ?? null;
    const open = new Map((await this.repository.openTrades(address)).map((t) => [t.coin, t]));
    const result = applyFills(address, open, fresh, fundingFrom);
    const partial = result.touched.some(isPartial);
    const persist = async (tx: TradeAnalyticsTx) => {
      await this.repository.deleteTrades(tx, address, result.dropped.map((t) => t.openTid));
      await this.repository.upsertTrades(tx, address, result.touched);
    };
    const newest = latestOf(fresh);
    const cursorTids = newest.time === since ? [...state.cursorTids, ...newest.tids] : newest.tids;
    return {
      persist,
      fillCount: fresh.length,
      next: {
        chain: CHAIN_DEFAULT,
        address,
        source: "hyperliquid" as const,
        historyThrough: null,
        coverageFrom: state.coverageFrom,
        truncated: state.truncated || partial,
        fillsRead: state.fillsRead + fresh.length,
        fillCursor: newest.time === null ? state.fillCursor : new Date(newest.time),
        cursorTids: newest.time === null ? state.cursorTids : cursorTids,
        fundingFrom: state.fundingFrom,
        fundingCursor: state.fundingCursor,
      },
    };
  }

  /**
   * The tiers' inputs, one definition each (audit A4, A5): the PnL tier on
   * all-time perp PnL (the portfolio's `perpAllTime`, as the trader page's
   * 表現 and the cohorts; Hyperliquid's leaderboard PnL includes spot), the
   * size tier on the whole account's value (as the trader page's 帳戶價值;
   * CopyDog tiers on perp equity and calls a unified account holding its
   * funds in spot small). A failure leaves a tier null rather than failing
   * the trades.
   */
  private async classify(address: string, live: LiveAccount | null, cost: Cost): Promise<Omit<TraderClassification, "style">> {
    const raw = await this.portfolio(address, cost).catch((error: Error) => {
      this.logger.warn(`Portfolio for ${address} failed: ${error.message}`);
      return null;
    });
    const allTimePnl = raw ? (portfolioSeries(raw, "allTime", "perp").pnl.at(-1)?.[1] ?? null) : null;
    const perpAccountValue = live?.perpAccountValue ?? null;
    // The profile's total (perp + spot + staked) when the page just read it;
    // else the portfolio's latest whole-account value.
    const profile = this.traders.profileCache.peek(address)?.value as { accountValue?: number | null; unavailableParts?: unknown } | undefined;
    const whole = profile && !profile.unavailableParts ? profile.accountValue : null;
    const accountValue = whole ?? (raw ? (portfolioSeries(raw, "allTime", "all").accountValue.at(-1)?.[1] ?? null) : null);
    return { allTimePnl, perpAccountValue, accountValue, pnlTier: pnlTier(allTimePnl), sizeTier: sizeTier(accountValue) };
  }

  /**
   * An open trade the account no longer holds (no position in that coin, or
   * one on the other side, in a state newer than the trade's last fill) was
   * closed by fills we can't read — typically TWAP slices older than
   * Hyperliquid keeps. It is dropped rather than shown open forever.
   */
  private async dropClosedElsewhere(address: string, live: LiveAccount | null, tx: TradeAnalyticsTx): Promise<number> {
    if (!live || !Number.isFinite(live.time)) return 0;
    const open = await this.repository.openTrades(address, tx);
    const gone = open.filter((t) => {
      if (t.lastFillTime >= live.time) return false;
      const szi = live.positions.get(t.coin) ?? 0;
      return szi === 0 || (szi > 0) !== (t.side === "long");
    });
    if (gone.length > 0) {
      await this.repository.deleteTrades(tx, address, gone.map((t) => t.openTid));
    }
    return gone.length;
  }

  /** Positions and perp account value: one
   * `clearinghouseState` per dex (2 weight each). */
  private async liveAccount(address: string, cost: Cost): Promise<LiveAccount | null> {
    try {
      // A profile is assembled from independent sources and can be partial;
      // its fetchedAt is not the clearinghouse observation time. Reconcile
      // only against a complete set of upstream states and their own times.
      if (this.traders.dexCache.peek("dexes") === undefined) {
        cost.calls += 1;
        cost.weight += 20;
      }
      const dexes = await this.traders.perpDexes();
      const states = await Promise.all(dexes.map((dex) => this.info.clearinghouseState(address, dex || undefined, LANE, cost.rank ?? RANK)));
      cost.calls += states.length;
      cost.weight += 2 * states.length;
      const positions = new Map<string, number>();
      for (const state of states) {
        for (const { position } of state.assetPositions ?? []) positions.set(position.coin, Number(position.szi) || 0);
      }
      return {
        time: Math.min(...states.map((state) => state.time)),
        positions,
        perpAccountValue: states.reduce((sum, state) => sum + (Number(state.marginSummary?.accountValue) || 0), 0),
      };
    } catch (error) {
      this.logger.warn(`Account state for ${address} failed: ${(error as Error).message}`);
      return null;
    }
  }

  private async portfolio(address: string, cost: Cost) {
    const cached = this.traders.portfolioCache.peek(address) !== undefined;
    const raw = await this.traders.rawPortfolio(address);
    if (!cached) {
      cost.calls += 1;
      cost.weight += 20;
    }
    return raw;
  }

  // --- funding ----------------------------------------------------------------

  /**
   * Adds funding paid since the last read to the trades that held the coin.
   * The first read covers trades opened in the last `FUNDING_LOOKBACK_MS`
   * (or since coverage began); older trades keep null. Unranked: it waits
   * behind every page load.
   */
  async fundingStep(address: string): Promise<void> {
    const state = await this.repository.state(address);
    if (!state) return;
    const started = Date.now();
    const cost: Cost = { calls: 0, weight: 0 };
    const now = state.historyThrough?.getTime() ?? Date.now();
    const first = state.fundingCursor === null;
    const fundingFrom = first
      ? Math.max(state.coverageFrom?.getTime() ?? now, now - FUNDING_LOOKBACK_MS)
      : state.fundingFrom!.getTime();
    const start = first ? fundingFrom : state.fundingCursor!.getTime() + 1;
    if (start > now) return;

    const events: FundingEvent[] = [];
    const seen = new Set<string>();
    let cursor = start;
    let lastComplete = start - 1;
    for (let page = 0; page < FUNDING_MAX_PAGES; page++) {
      const batch = await this.info.userFunding(address, cursor, now, LANE);
      cost.calls += 1;
      cost.weight += 20 + Math.ceil(batch.length / 20);
      const full = batch.length >= USER_FUNDING_PAGE_SIZE;
      const lastTime = batch.at(-1)?.time;
      for (const entry of batch) {
        // A full page may cut a timestamp's entries: keep those for the
        // next page (read from that time again).
        if (full && entry.time === lastTime) continue;
        const key = `${entry.time}:${entry.delta.coin}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push({ time: entry.time, coin: entry.delta.coin, usdc: Number(entry.delta.usdc) });
      }
      if (!full) {
        lastComplete = now;
        break;
      }
      lastComplete = lastTime! - 1;
      cursor = lastTime!;
    }

    let trades = 0;
    await this.repository.transaction(async (tx) => {
      await this.repository.assertState(tx, address, state);
      const rows = first
        ? (await this.repository.allTrades(address, tx)).map((t) => ({ ...t, funding: t.entryTime >= fundingFrom ? 0 : null }))
        : await this.repository.fundableSince(address, new Date(start), tx);
      attributeFunding(rows, events);
      await this.repository.updateFunding(tx, address, rows);
      const { style: _style, ...tiers } = traderClassificationSchema.parse(state.classification);
      ({ trades } = await this.store(address, {
        ...state,
        fundingFrom: new Date(fundingFrom),
        fundingCursor: new Date(Math.max(lastComplete, start - 1)),
      }, tiers, tx, state.computedAt));
    });
    this.record(address, { kind: "funding", ms: Date.now() - started, ...cost, fills: events.length, trades });
  }
}

/** A watched address's figures the worker is due to refresh (stale, not yet
 * past the age at which a read refreshes them itself). */
function workerDue(computedAt: number, now: number): boolean {
  return now - computedAt > STALE_MS && now - computedAt <= TRACKED_FALLBACK_MS;
}

function coverageOf(row: Stored): TradeCoverage {
  return {
    source: row.source,
    from: row.coverageFrom,
    truncated: row.truncated,
    completeness: row.truncated ? "partial" : "complete",
    partialSince: row.truncated ? row.coverageFrom : null,
    fundingFrom: row.fundingFrom,
    fundingThrough: row.fundingCursor,
    fills: row.fillsRead,
    through: row.historyThrough ?? null,
  };
}

/** The newest fill time and the tids at exactly that millisecond. */
function latestOf(fills: HlUserFill[]): { time: number | null; tids: string[] } {
  let time: number | null = null;
  for (const f of fills) if (time === null || f.time > time) time = f.time;
  return { time, tids: time === null ? [] : fills.filter((f) => f.time === time).map((f) => String(f.tid)) };
}

function dedupe(fills: HlUserFill[]): HlUserFill[] {
  return [...new Map(fills.map((f) => [f.tid, f])).values()];
}

/** Dates as ISO strings for jsonb. */
function jsonSummary(summary: Record<TradeWindow, TradeSummary>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(summary)) as Record<string, unknown>;
}

