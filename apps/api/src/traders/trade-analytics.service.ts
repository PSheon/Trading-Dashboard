import { Injectable, Logger, Optional } from "@nestjs/common";
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
import { HyperliquidInfoClient, twapSliceToFill, USER_FUNDING_PAGE_SIZE } from "../hyperliquid/hyperliquid-info.client.js";
import { PAGE_RANK } from "../hyperliquid/request-budgeter.service.js";
import type { HlUserFill } from "../hyperliquid/types.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { BusyException } from "./busy.js";
import { TradeAnalyticsRepository, type AnalyticsInsert, type AnalyticsRow } from "./trade-analytics.repository.js";
import { portfolioSeries } from "./traders.mappers.js";
import { TradersService } from "./traders.service.js";

/** Served from the store for this long; older answers are still served
 * while a refresh runs in the background. */
export const STALE_MS = 10 * 60_000;
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
/** Pages per incremental refresh (a refresh every ~10 min rarely needs 2). */
export const REFRESH_PAGES = 6;
/** Funding is read for trades opened in the last 30 days (the 30D window);
 * older holds show no funding. */
export const FUNDING_LOOKBACK_MS = 30 * 86_400_000;
export const FUNDING_MAX_PAGES = 40;
/** Cold computations at once; more wait. Beyond `MAX_WAITING` a new cold
 * address is answered busy without queueing. */
export const MAX_CONCURRENT = 2;
export const MAX_WAITING = 20;
/** Every call of the computation is a trader-page call at the fills rank
 * (background lane, behind first paint and the chart, ahead of sweeps);
 * funding, the heavy tail, goes unranked, behind everything page-driven. */
const LANE = "background" as const;
const RANK = PAGE_RANK.fills;

const WINDOWS: TradeWindow[] = ["all", "30d", "7d", "1d"];

/** Weight and calls one computation spent (Hyperliquid's formula: 20 per
 * call, +1 per 20 items on list calls). */
export interface Cost {
  calls: number;
  weight: number;
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
  kind: "cold" | "refresh" | "tracked" | "funding";
  ms: number;
  calls: number;
  weight: number;
  fills: number;
  trades: number;
}

type Stored = Pick<AnalyticsRow, "summary" | "classification" | "source" | "coverageFrom" | "truncated" | "fundingFrom" | "fillsRead" | "computedAt">;

/**
 * Round-trip analytics for any address (the trader page's win rate, 表現 and
 * 交易 tabs, 分組 and 最佳與最差).
 *
 * - Tracked addresses: rebuilt from our `fills` table (no fill weight).
 * - Other addresses: Hyperliquid's fill and TWAP-slice history, newest
 *   first, up to `COLD_TARGET_FILLS`; later refreshes read only fills after
 *   the stored cursor and continue the open trades.
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
  private readonly chains = new Map<string, Promise<unknown>>();
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  readonly lastLog = new Map<string, ComputeLog[]>();

  constructor(
    private readonly repository: TradeAnalyticsRepository,
    private readonly traders: TradersService,
    private readonly info: HyperliquidInfoClient,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
  ) {}

  // --- reading --------------------------------------------------------------

  async analytics(address: string, window: TradeWindow): Promise<TraderAnalyticsResponse> {
    const row = await this.current(address);
    const summaries = row.summary as Record<TradeWindow, unknown>;
    return {
      address,
      window,
      summary: tradeSummarySchema.parse(summaries[window]),
      classification: traderClassificationSchema.parse(row.classification),
      coverage: coverageOf(row),
      computedAt: row.computedAt,
      refreshing: this.inflight.has(address),
    };
  }

  async trades(address: string, query: TraderTradesQuery): Promise<TraderTradesResponse> {
    const row = await this.current(address);
    const [ms, tid] = query.cursor ? query.cursor.split("_") : [];
    const cursor = query.cursor ? { sortTime: new Date(Number(ms)), openTid: BigInt(tid) } : null;
    const rows = await this.repository.page(address, query.status, query.limit + 1, cursor);
    const now = Date.now();
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      address,
      items: page.map((t) => toRoundTrip(t, now)),
      nextCursor: rows.length > query.limit && last ? `${last.exitTime ?? last.entryTime}_${last.openTid}` : null,
      coverage: coverageOf(row),
      computedAt: row.computedAt,
    };
  }

  /** The stored row, refreshed in the background when stale; for a cold
   * address the computation (the caller's deadline turns a long one into
   * 503 busy, and it carries on). */
  private async current(address: string): Promise<Stored> {
    const row = await this.repository.state(address);
    if (!row) return this.compute(address, true);
    if (Date.now() - row.computedAt.getTime() > STALE_MS) this.compute(address, false).catch(() => undefined);
    return row;
  }

  /** One computation per address at a time; callers share it. */
  compute(address: string, cold: boolean): Promise<AnalyticsRow> {
    const existing = this.inflight.get(address);
    if (existing) return existing;
    if (this.jobs.stopping) return Promise.reject(new Error("Shutting down"));
    if (cold && this.waiting.length >= MAX_WAITING) return Promise.reject(new BusyException(5_000));
    const promise = this.jobs.run(() => this.serial(address, () => this.limited(() => this.refresh(address))));
    this.inflight.set(address, promise);
    promise
      .finally(() => {
        if (this.inflight.get(address) === promise) this.inflight.delete(address);
      })
      // Registered inside the caller's request: run it as its own job so
      // the request's end doesn't cancel its Hyperliquid calls.
      .then(() => this.jobs.run(() => this.serial(address, () => this.fundingStep(address))))
      .catch((error: Error) => {
        if (!(error instanceof BusyException)) this.logger.warn(`Trade analytics for ${address} failed: ${error.message}`);
      });
    return promise;
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
  async refresh(address: string): Promise<AnalyticsRow> {
    const started = Date.now();
    const cost: Cost = { calls: 0, weight: 0 };
    const [state, tracked] = await Promise.all([this.repository.state(address), this.traders.isTracked(address)]);
    let kind: ComputeLog["kind"];
    let next: Omit<AnalyticsInsert, "summary" | "classification" | "computedAt">;
    let fillCount: number;
    if (tracked) {
      kind = "tracked";
      ({ next, fillCount } = await this.rebuildTracked(address, state));
    } else if (!state || state.source !== "hyperliquid" || state.fillCursor === null) {
      kind = "cold";
      ({ next, fillCount } = await this.coldHyperliquid(address, cost));
    } else {
      kind = "refresh";
      ({ next, fillCount } = await this.incrementalHyperliquid(address, state, cost));
    }
    const live = await this.liveAccount(address, cost);
    await this.dropClosedElsewhere(address, live);
    const classification = await this.classify(address, live, cost);
    const { row, trades } = await this.store(address, next, classification);
    this.record(address, { kind, ms: Date.now() - started, ...cost, fills: fillCount, trades });
    return row;
  }

  /** Summaries of every stored trade + the new state, in one write. */
  private async store(
    address: string,
    next: Omit<AnalyticsInsert, "summary" | "classification" | "computedAt">,
    classification: Omit<TraderClassification, "style">,
  ): Promise<{ row: AnalyticsRow; trades: number }> {
    const now = Date.now();
    const trades = (await this.repository.allTrades(address)).map((t) => toRoundTrip(t, now));
    const summary = Object.fromEntries(WINDOWS.map((w) => [w, summarize(trades, w, now)])) as Record<TradeWindow, TradeSummary>;
    const full: TraderClassification = { ...classification, style: tradingStyle(summary.all.medianHoldSeconds) };
    const row = await this.repository.saveState({
      ...next,
      summary: jsonSummary(summary),
      classification: full,
      computedAt: new Date(now),
    });
    return { row, trades: trades.length };
  }

  private record(address: string, log: ComputeLog): void {
    const list = this.lastLog.get(address) ?? [];
    list.push(log);
    if (list.length > 10) list.shift();
    this.lastLog.set(address, list);
    this.logger.log(
      `Trade analytics ${log.kind} ${address}: ${log.fills} ${log.kind === "funding" ? "payments" : "fills"}, ` +
        `${log.trades} trades, ${log.calls} calls, weight ${log.weight}, ${log.ms} ms`,
    );
  }

  private async rebuildTracked(address: string, state: AnalyticsRow | undefined) {
    const fillsRead = await this.repository.trackedFills(address, new Date(Date.now() - LOOKBACK_MS));
    const fundingFrom = state?.fundingFrom?.getTime() ?? null;
    const open = new Map<string, Trade>();
    const result = applyFills(address, open, fillsRead, fundingFrom);
    const trades = result.touched;
    await this.repository.transaction(async (tx) => {
      // Funding already read stays with its trade across the rebuild.
      const kept = state?.source === "tracked" ? await this.repository.fundingByTid(address, tx) : new Map<bigint, number>();
      for (const t of trades) {
        const funding = kept.get(t.openTid);
        if (funding !== undefined && t.funding !== null) t.funding = funding;
      }
      await this.repository.replaceTrades(tx, address, trades);
    });
    const newest = latestOf(fillsRead);
    return {
      fillCount: fillsRead.length,
      next: {
        chain: CHAIN_DEFAULT,
        address,
        source: "tracked" as const,
        coverageFrom: fillsRead.length > 0 ? new Date(Math.min(...fillsRead.map((f) => f.time))) : null,
        truncated: trades.some(isPartial),
        fillsRead: fillsRead.length,
        fillCursor: newest.time === null ? null : new Date(newest.time),
        cursorTids: newest.tids,
        // A source switch starts funding over.
        fundingFrom: state?.source === "tracked" ? state.fundingFrom : null,
        fundingCursor: state?.source === "tracked" ? state.fundingCursor : null,
      },
    };
  }

  private fillSource(address: string, twap: boolean, latest: HlUserFill[], cost: Cost): FillSource {
    return {
      latest: async () => latest,
      range: async (start, end) => {
        const batch = twap
          ? (await this.info.userTwapSliceFillsByTime(address, start, end, LANE, RANK)).map(twapSliceToFill)
          : await this.info.userFillsByTime(address, start, end, LANE, RANK);
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
    // The cached latest lists may be a few minutes old: read on from them.
    const newest = latestOf(all).time;
    if (newest !== null) {
      const tail = await readForward(async (start) => {
        const batch = await this.info.userFillsByTime(address, start, undefined, LANE, RANK);
        cost.calls += 1;
        cost.weight += listWeight(batch.length);
        return batch;
      }, newest, 2);
      all = dedupe([...all, ...tail.fills]);
    }
    const open = new Map<string, Trade>();
    const result = applyFills(address, open, all, null);
    await this.repository.transaction((tx) => this.repository.replaceTrades(tx, address, result.touched));
    const cursor = latestOf(all);
    return {
      fillCount: all.length,
      next: {
        chain: CHAIN_DEFAULT,
        address,
        source: "hyperliquid" as const,
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

  private async incrementalHyperliquid(address: string, state: AnalyticsRow, cost: Cost) {
    const since = state.fillCursor!.getTime();
    const seen = new Set(state.cursorTids);
    const read = (twap: boolean) =>
      readForward(async (start) => {
        const batch = twap
          ? (await this.info.userTwapSliceFillsByTime(address, start, undefined, LANE, RANK)).map(twapSliceToFill)
          : await this.info.userFillsByTime(address, start, undefined, LANE, RANK);
        cost.calls += 1;
        cost.weight += listWeight(batch.length);
        return batch;
      }, since, REFRESH_PAGES);
    const [regular, twap] = await Promise.all([read(false), read(true)]);
    const fresh = dedupe([...regular.fills, ...twap.fills]).filter(
      (f) => f.time > since || (f.time === since && !seen.has(String(f.tid))),
    );
    const fundingFrom = state.fundingFrom?.getTime() ?? null;
    let partial = false;
    if (fresh.length > 0) {
      await this.repository.transaction(async (tx) => {
        const open = new Map((await this.repository.openTrades(address, tx)).map((t) => [t.coin, t]));
        const result = applyFills(address, open, fresh, fundingFrom);
        partial = result.touched.some(isPartial);
        await this.repository.deleteTrades(tx, address, result.dropped.map((t) => t.openTid));
        await this.repository.upsertTrades(tx, address, result.touched);
      });
    }
    const newest = latestOf(fresh);
    const cursorTids = newest.time === since ? [...state.cursorTids, ...newest.tids] : newest.tids;
    return {
      fillCount: fresh.length,
      next: {
        chain: CHAIN_DEFAULT,
        address,
        source: "hyperliquid" as const,
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
   * CopyDog's tier inputs: Hyperliquid's leaderboard all-time PnL (ours in
   * `trader_stats`; the portfolio's all-time PnL for an address not on it)
   * and the perp account value. A failure leaves a tier null rather than
   * failing the trades.
   */
  private async classify(address: string, live: LiveAccount | null, cost: Cost): Promise<Omit<TraderClassification, "style">> {
    const allTimePnl = await this.allTimePnl(address, cost).catch((error: Error) => {
      this.logger.warn(`All-time PnL for ${address} failed: ${error.message}`);
      return null;
    });
    const perpAccountValue = live?.perpAccountValue ?? null;
    return { allTimePnl, perpAccountValue, pnlTier: pnlTier(allTimePnl), sizeTier: sizeTier(perpAccountValue) };
  }

  /**
   * An open trade the account no longer holds (no position in that coin, or
   * one on the other side, in a state newer than the trade's last fill) was
   * closed by fills we can't read — typically TWAP slices older than
   * Hyperliquid keeps. It is dropped rather than shown open forever.
   */
  private async dropClosedElsewhere(address: string, live: LiveAccount | null): Promise<number> {
    if (!live || !Number.isFinite(live.time)) return 0;
    const open = await this.repository.openTrades(address);
    const gone = open.filter((t) => {
      if (t.lastFillTime >= live.time) return false;
      const szi = live.positions.get(t.coin) ?? 0;
      return szi === 0 || (szi > 0) !== (t.side === "long");
    });
    if (gone.length > 0) {
      await this.repository.deleteTrades(this.repository.db, address, gone.map((t) => t.openTid));
    }
    return gone.length;
  }

  /** Positions and perp account value: the page's cached profile, else one
   * `clearinghouseState` per dex (2 weight each). */
  private async liveAccount(address: string, cost: Cost): Promise<LiveAccount | null> {
    try {
      const profile = this.traders.profileCache.peek(address);
      if (profile) {
        return {
          time: new Date(profile.value.fetchedAt).getTime(),
          positions: new Map(profile.value.positions.map((p) => [p.coin, p.szi])),
          perpAccountValue: profile.value.perpEquity,
        };
      }
      if (this.traders.dexCache.peek("dexes") === undefined) {
        cost.calls += 1;
        cost.weight += 20;
      }
      const dexes = await this.traders.perpDexes();
      const states = await Promise.all(dexes.map((dex) => this.info.clearinghouseState(address, dex || undefined, LANE, RANK)));
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

  private async allTimePnl(address: string, cost: Cost): Promise<number | null> {
    const board = await this.traders.leaderboardAllTimePnl(address);
    if (board !== null) return board;
    const cached = this.traders.portfolioCache.peek(address) !== undefined;
    const raw = await this.traders.rawPortfolio(address);
    if (!cached) {
      cost.calls += 1;
      cost.weight += 20;
    }
    return portfolioSeries(raw, "allTime", "all").pnl.at(-1)?.[1] ?? null;
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
    const now = Date.now();
    const first = state.fundingCursor === null;
    const fundingFrom = first
      ? Math.max(state.coverageFrom?.getTime() ?? now, now - FUNDING_LOOKBACK_MS)
      : state.fundingFrom!.getTime();
    const start = first ? fundingFrom : state.fundingCursor!.getTime() + 1;

    const events: FundingEvent[] = [];
    const seen = new Set<string>();
    let cursor = start;
    let lastComplete = start - 1;
    for (let page = 0; page < FUNDING_MAX_PAGES; page++) {
      const batch = await this.info.userFunding(address, cursor, undefined, LANE);
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
        if (lastTime !== undefined) lastComplete = lastTime;
        break;
      }
      lastComplete = lastTime! - 1;
      cursor = lastTime!;
    }

    await this.repository.transaction(async (tx) => {
      const trades = first
        ? (await this.repository.allTrades(address, tx)).map((t) => ({ ...t, funding: t.entryTime >= fundingFrom ? 0 : null }))
        : await this.repository.fundableSince(address, new Date(start), tx);
      attributeFunding(trades, events);
      await this.repository.updateFunding(tx, address, trades);
      await this.repository.saveState({
        ...state,
        fundingFrom: new Date(fundingFrom),
        fundingCursor: new Date(Math.max(lastComplete, start - 1)),
      }, tx);
    });
    // Best / worst lists carry each trade's funding.
    const latest = await this.repository.state(address);
    let trades = 0;
    if (latest) {
      const { summary: _s, classification, computedAt: _c, ...rest } = latest;
      const { style: _style, ...tiers } = traderClassificationSchema.parse(classification);
      ({ trades } = await this.store(address, rest, tiers));
    }
    this.record(address, { kind: "funding", ms: Date.now() - started, ...cost, fills: events.length, trades });
  }
}

function coverageOf(row: Stored): TradeCoverage {
  return {
    source: row.source,
    from: row.coverageFrom,
    truncated: row.truncated,
    fundingFrom: row.fundingFrom,
    fills: row.fillsRead,
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

