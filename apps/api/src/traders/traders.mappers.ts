import type { traderStats } from "@trading-dashboard/shared/database";
import type {
  LivePosition,
  PortfolioResponse,
  TraderFill,
  TraderActivity,
  TraderStats,
  TraderWindowInput,
} from "@trading-dashboard/shared/contracts";

import type { RoundTrip } from "../analytics/round-trip.service.js";
import type {
  HlClearinghouseStateResponse,
  HlPortfolioResponse,
  HlUserFill,
} from "../hyperliquid/types.js";

type TraderStatsRow = typeof traderStats.$inferSelect;
type Point = [number, number];

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The shortest leaderboard window with volume: when the account last
 * traded, to a day. No volume in 30 days = a holder, not a trader. */
export function activityOf(row: Pick<TraderStatsRow, "volumeDay" | "volumeWeek" | "volumeMonth">): TraderActivity {
  if (num(row.volumeDay) > 0) return "day";
  if (num(row.volumeWeek) > 0) return "week";
  if (num(row.volumeMonth) > 0) return "month";
  return "inactive";
}

export function toTraderStats(row: TraderStatsRow): TraderStats {
  return {
    address: row.address,
    displayName: row.displayName,
    accountValue: num(row.accountValue),
    pnl: { day: num(row.pnlDay), week: num(row.pnlWeek), month: num(row.pnlMonth), allTime: num(row.pnlAllTime) },
    roi: { day: num(row.roiDay), week: num(row.roiWeek), month: num(row.roiMonth), allTime: num(row.roiAllTime) },
    volume: {
      day: num(row.volumeDay),
      week: num(row.volumeWeek),
      month: num(row.volumeMonth),
      allTime: num(row.volumeAllTime),
    },
    isVault: row.isVault,
    activity: activityOf(row),
    updatedAt: row.updatedAt,
  };
}

/** The perp side of an account, summed over dexes. */
export interface AccountSummary {
  /** Sum of every dex's `marginSummary.accountValue`; not the account's
   * total (that adds spot and staking, see `totalAccountValue`). */
  perpEquity: number;
  marginUsed: number;
  withdrawable: number;
  longNotional: number;
  shortNotional: number;
  positions: LivePosition[];
}

/** Sums one address's clearinghouse states across dexes (each HIP-3 dex is
 * its own clearinghouse with its own collateral) and lists open positions,
 * largest first. */
export function summarizeAccount(states: Iterable<HlClearinghouseStateResponse>): AccountSummary {
  const out: AccountSummary = {
    perpEquity: 0,
    marginUsed: 0,
    withdrawable: 0,
    longNotional: 0,
    shortNotional: 0,
    positions: [],
  };
  for (const state of states) {
    out.perpEquity += num(state.marginSummary?.accountValue);
    out.marginUsed += num(state.marginSummary?.totalMarginUsed);
    out.withdrawable += num(state.withdrawable);
    for (const { position: p } of state.assetPositions ?? []) {
      const szi = num(p.szi);
      if (szi === 0) continue;
      const entryPx = numOrNull(p.entryPx);
      const positionValue =
        numOrNull(p.positionValue) ?? (entryPx === null ? 0 : Math.abs(szi) * entryPx);
      const side = szi > 0 ? "long" : "short";
      if (side === "long") out.longNotional += positionValue;
      else out.shortNotional += positionValue;
      out.positions.push({
        coin: p.coin,
        szi,
        side,
        entryPx,
        positionValue,
        unrealizedPnl: num(p.unrealizedPnl),
        leverage: numOrNull(p.leverage?.value),
        marginMode: p.leverage?.type ?? null,
        liqPx: numOrNull(p.liquidationPx),
        marginUsed: num(p.marginUsed),
        fundingSinceOpen: numOrNull(p.cumFunding?.sinceOpen),
        returnOnEquity: numOrNull(p.returnOnEquity),
      });
    }
  }
  out.positions.sort((a, b) => b.positionValue - a.positionValue);
  return out;
}

export interface TraderAnalytics {
  winRate30d: number | null;
  roundTrips30d: number;
  realizedPnl30d: number;
  avgHoldSeconds: number | null;
  bestCoins: Array<{ coin: string; pnl: number }>;
  worstCoins: Array<{ coin: string; pnl: number }>;
}

/** Profile analytics over round trips closed since `since` (30 days). Best
 * coins are the top 3 with positive realized PnL, worst the bottom 3 with
 * negative PnL, so a coin never shows as both. */
export function summarizeRoundTrips(trips: RoundTrip[], since: Date): TraderAnalytics {
  const recent = trips.filter((t) => t.closeTs >= since);
  const byCoin = new Map<string, number>();
  for (const t of recent) byCoin.set(t.coin, (byCoin.get(t.coin) ?? 0) + t.pnl);
  const coins = [...byCoin].map(([coin, pnl]) => ({ coin, pnl }));
  return {
    winRate30d: recent.length === 0 ? null : recent.filter((t) => t.pnl > 0).length / recent.length,
    roundTrips30d: recent.length,
    realizedPnl30d: recent.reduce((sum, t) => sum + t.pnl, 0),
    avgHoldSeconds:
      recent.length === 0 ? null : recent.reduce((sum, t) => sum + t.holdTimeSeconds, 0) / recent.length,
    bestCoins: coins
      .filter((c) => c.pnl > 0)
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 3),
    worstCoins: coins
      .filter((c) => c.pnl < 0)
      .sort((a, b) => a.pnl - b.pnl)
      .slice(0, 3),
  };
}

/** `portfolio` key for a window/market: "month" or "perpMonth". */
export function portfolioKey(window: TraderWindowInput, market: "all" | "perp"): string {
  return market === "all" ? window : `perp${window[0].toUpperCase()}${window.slice(1)}`;
}

const toPoints = (series: Array<[number, string]> | undefined): Point[] =>
  (series ?? []).map(([ts, v]) => [Number(ts), num(v)]);

/** One window/market of a `portfolio` response as numeric series. */
export function portfolioSeries(
  raw: HlPortfolioResponse,
  window: TraderWindowInput,
  market: "all" | "perp",
): { accountValue: Point[]; pnl: Point[]; volume: number } {
  const entry = raw.find(([name]) => name === portfolioKey(window, market))?.[1];
  return {
    accountValue: toPoints(entry?.accountValueHistory),
    pnl: toPoints(entry?.pnlHistory),
    volume: num(entry?.vlm),
  };
}

export function toPortfolioResponse(
  raw: HlPortfolioResponse,
  window: TraderWindowInput,
  market: "all" | "perp",
): PortfolioResponse {
  const series = portfolioSeries(raw, window, market);
  // Returns are always measured on the whole account's value: in unified
  // and portfolio-margin accounts the perp account value history is "not
  // meaningful" (Hyperliquid docs), and even in standard ones spot ↔ perp
  // transfers would look like deposits and withdrawals. Falls back to the
  // market's own series when Hyperliquid didn't send the whole-account one.
  const whole = market === "all" ? series : portfolioSeries(raw, window, "all");
  const capital = whole.accountValue.length > 0 ? whole : series;
  return { window, market, ...series, ...portfolioMetrics(series.pnl, capital) };
}

/** The whole account's value and PnL over the same window: the capital that
 * returns are measured against. */
export interface CapitalSeries {
  accountValue: Point[];
  pnl: Point[];
}

const DAY_MS = 24 * 3_600_000;
/** Fewer daily returns than this and there is no Sharpe (a "day" window
 * never has one). */
export const SHARPE_MIN_DAYS = 7;
/** An interval whose capital base is below this many USD … */
export const MIN_BASE_USD = 10;
/** … or below this fraction of the window's largest account value is
 * skipped: dust balances, or a deposit, trade and withdrawal netting out
 * inside one sampling interval, would otherwise produce absurd returns, and
 * a few hundred dollars lost before an account grew to millions would
 * otherwise set its all-time return to −100 % for good. */
export const MIN_BASE_FRACTION = 0.01;

export interface PortfolioMetrics {
  methodology: {
    version: "flow-neutral-v1";
    intervals: number;
    excludedIntervals: number;
    excludedFraction: number | null;
    capitalFloorUsd: number;
    quality: "observed" | "partial" | "unavailable";
  };
  maxDrawdownUsd: number;
  maxDrawdownPct: number | null;
  sharpe: number | null;
  roi: number | null;
  cumulativeReturn: Point[];
}

/** The value at `ts`: the point with that timestamp, else the latest one
 * before it; null when there is none. Hyperliquid samples a window's series
 * at the same timestamps, so the exact match is the normal case. */
function valueAt(series: Point[], ts: number): number | null {
  let found: number | null = null;
  for (const [t, v] of series) {
    if (t > ts) break;
    found = v;
  }
  return found;
}

/**
 * Flow-neutral (time-weighted) return of each interval between two PnL
 * points, keyed by the interval's end: [ts, r], or [ts, null] when the
 * interval is skipped.
 *
 * - The gain is the change in cumulative PnL (Hyperliquid's `pnlHistory`
 *   excludes deposits, withdrawals and transfers).
 * - Net flow F = change in the whole account's value − change in its PnL:
 *   money that moved in or out, not return.
 * - The base is the prior whole-account value V plus any deposit in the
 *   interval: V + max(F, 0) (Modified Dietz with deposits counted from the
 *   start of the interval and withdrawals at its end: the most capital that
 *   could have been at work). Since the account can't end the interval
 *   below 0, a loss never exceeds the base, so r ≥ −1.
 * - Skipped when the base is below MIN_BASE_USD or MIN_BASE_FRACTION of the
 *   window's largest account value (see those).
 */
export function periodReturns(pnl: Point[], capital: CapitalSeries): Array<[number, number | null]> {
  const peak = capital.accountValue.reduce((m, [, v]) => Math.max(m, v), 0);
  const minBase = Math.max(MIN_BASE_USD, MIN_BASE_FRACTION * peak);
  const netDeposits = (ts: number): number | null => {
    const av = valueAt(capital.accountValue, ts);
    const p = valueAt(capital.pnl, ts);
    return av === null || p === null ? null : av - p;
  };
  const out: Array<[number, number | null]> = [];
  for (let i = 1; i < pnl.length; i++) {
    const [t0, p0] = pnl[i - 1];
    const [t1, p1] = pnl[i];
    const prior = valueAt(capital.accountValue, t0);
    const d0 = netDeposits(t0);
    const d1 = netDeposits(t1);
    const flow = d0 === null || d1 === null ? 0 : d1 - d0;
    const base = (prior ?? 0) + Math.max(flow, 0);
    out.push([t1, base >= minBase ? Math.max(-1, (p1 - p0) / base) : null]);
  }
  return out;
}

/**
 * Risk and return of one portfolio window (§10, 競品分析 §3.1–3.2), all
 * from the flow-neutral interval returns rᵢ of `periodReturns`, so
 * deposits and withdrawals never read as gains, losses or drawdowns:
 *
 * - `cumulativeReturn`: the time-weighted return index minus one at each
 *   PnL point, [ts, ∏(1 + rᵢ) − 1], starting at 0 (skipped intervals count
 *   as 0 %).
 * - `roi`: its last value: what one dollar kept in the account over the
 *   whole window would have returned. Null without a single usable
 *   interval.
 * - `maxDrawdownPct`: the largest fall of the index from a running peak,
 *   1 − index ÷ peak, so always within 0–1 (1 = the account was wiped out).
 *   Null without a usable interval.
 * - `maxDrawdownUsd`: separately, the largest fall of cumulative PnL from a
 *   running peak (USD, ≥ 0).
 * - `sharpe`: the index resampled to UTC days (each day's growth compounds
 *   the intervals ending that day; days without a point return 0), as log
 *   returns ln(growth) (a wiped-out day floored at WIPEOUT_FLOOR); mean ÷
 *   sample stdev (n − 1), risk-free rate 0, × √365. Log returns keep its
 *   sign equal to the ROI's. Null with fewer than SHARPE_MIN_DAYS daily
 *   returns or zero variance.
 */
export function portfolioMetrics(pnl: Point[], capital: CapitalSeries): PortfolioMetrics {
  let maxDrawdownUsd = 0;
  if (pnl.length > 0) {
    let peak = pnl[0][1];
    for (const [, v] of pnl) {
      peak = Math.max(peak, v);
      maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - v);
    }
  }

  const returns = periodReturns(pnl, capital);
  const usable = returns.some(([, r]) => r !== null);
  const cumulativeReturn: Point[] = pnl.length > 0 ? [[pnl[0][0], 0]] : [];
  let index = 1;
  let peakIndex = 1;
  let maxDrawdownPct = 0;
  for (const [ts, r] of returns) {
    index *= 1 + (r ?? 0);
    peakIndex = Math.max(peakIndex, index);
    if (peakIndex > 0) maxDrawdownPct = Math.max(maxDrawdownPct, 1 - index / peakIndex);
    cumulativeReturn.push([ts, index - 1]);
  }

  const excludedIntervals = returns.filter(([, r]) => r === null).length;
  return {
    methodology: {
      version: "flow-neutral-v1",
      intervals: returns.length,
      excludedIntervals,
      excludedFraction: returns.length ? excludedIntervals / returns.length : null,
      capitalFloorUsd: Math.max(MIN_BASE_USD, MIN_BASE_FRACTION * capital.accountValue.reduce((peak, [, v]) => Math.max(peak, v), 0)),
      quality: !usable ? "unavailable" : excludedIntervals ? "partial" : "observed",
    },
    maxDrawdownUsd,
    maxDrawdownPct: usable ? maxDrawdownPct : null,
    sharpe: usable ? dailySharpe(pnl[0][0], returns) : null,
    roi: usable ? index - 1 : null,
    cumulativeReturn,
  };
}

/** A day that lost everything counts as this much growth (−99.99 %) in
 * the Sharpe ratio, whose log return would otherwise be −∞. */
export const WIPEOUT_FLOOR = 1e-4;

/** Annualized Sharpe of the daily-resampled log returns (see
 * `portfolioMetrics`). */
function dailySharpe(start: number, returns: Array<[number, number | null]>): number | null {
  if (returns.length === 0) return null;
  const firstDay = Math.floor(start / DAY_MS);
  const days = Math.floor(returns[returns.length - 1][0] / DAY_MS) - firstDay + 1;
  if (days < SHARPE_MIN_DAYS) return null;
  const growth = Array.from({ length: days }, () => 1);
  for (const [ts, r] of returns) growth[Math.floor(ts / DAY_MS) - firstDay] *= 1 + (r ?? 0);
  // Log returns: their mean has the sign of the window's compounded return,
  // so the Sharpe never contradicts the ROI next to it (a simple-return mean
  // can stay positive through a −100% day). A wiped-out day is floored.
  const daily = growth.map((g) => Math.log(Math.max(g, WIPEOUT_FLOOR)));
  const mean = daily.reduce((s, r) => s + r, 0) / days;
  const variance = daily.reduce((s, r) => s + (r - mean) ** 2, 0) / (days - 1);
  const stdev = Math.sqrt(variance);
  // Below this the variance is rounding noise, not risk.
  if (!(stdev > 1e-12)) return null;
  return (mean / stdev) * Math.sqrt(365);
}

/** Evenly spaced subset of at most `max` points, always keeping the first
 * and last. */
export function downsample<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  if (max <= 1) return points.slice(-max);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]);
  return out;
}

/** Spot fills name the pair ("PURR/USDC") or a spot index ("@107"); perps,
 * HIP-3 included ("xyz:TSLA"), never do. */
export function isPerpCoin(coin: string): boolean {
  return !coin.startsWith("@") && !coin.includes("/");
}

/** `userFills` returns at most this many of the latest fills. */
export const USER_FILLS_CAP = 2_000;

/** Perp fills since `since` in a `userFills` response. `capped`: the list is
 * full and even its oldest fill is inside the window, so the true count may
 * be higher. */
export interface FillSample {
  fills30d: number;
  capped: boolean;
  /** Newest perp fill in the list, epoch ms. */
  lastTradeAt: number | null;
}

export function sampleFromUserFills(raw: HlUserFill[], since: number): FillSample {
  return sampleFromLists([raw], since);
}

/** The same over several capped lists (`userFills` and the latest TWAP
 * slices, which it doesn't include): counts every perp fill once, and is
 * `capped` if any one list is. */
export function sampleFromLists(lists: HlUserFill[][], since: number): FillSample {
  let fills30d = 0;
  let capped = false;
  let lastTradeAt: number | null = null;
  const seen = new Set<number>();
  for (const raw of lists) {
    let oldest = Infinity;
    for (const f of raw) {
      oldest = Math.min(oldest, f.time);
      if (!isPerpCoin(f.coin) || seen.has(f.tid)) continue;
      seen.add(f.tid);
      if (f.time >= since) fills30d += 1;
      if (lastTradeAt === null || f.time > lastTradeAt) lastTradeAt = f.time;
    }
    if (raw.length >= USER_FILLS_CAP && oldest >= since) capped = true;
  }
  return { fills30d, capped, lastTradeAt };
}

export function hlFillToTraderFill(f: HlUserFill): TraderFill {
  const px = num(f.px);
  const sz = num(f.sz);
  return {
    tid: String(f.tid),
    coin: f.coin,
    side: f.side === "B" ? "buy" : "sell",
    dir: f.dir,
    px,
    sz,
    notionalUsd: px * sz,
    closedPnl: numOrNull(f.closedPnl),
    fee: numOrNull(f.fee),
    ts: new Date(f.time),
    twapId: f.twapId ?? null,
    startPosition: numOrNull(f.startPosition),
    liquidation: f.liquidation != null,
  };
}

export function dbFillToTraderFill(row: {
  tid: bigint;
  coin: string;
  side: string;
  dir: string;
  px: string;
  sz: string;
  fee: string;
  closedPnl: string | null;
  ts: Date;
  /** `raw->>'twapId'`: text, or null for a regular fill. */
  twapId: string | null;
  /** `raw->>'startPosition'`. */
  startPosition?: string | null;
  /** `raw ? 'liquidation'` with a non-null value. */
  liquidation?: boolean | null;
}): TraderFill {
  const px = num(row.px);
  const sz = num(row.sz);
  return {
    tid: row.tid.toString(),
    coin: row.coin,
    side: row.side === "B" ? "buy" : "sell",
    dir: row.dir,
    px,
    sz,
    notionalUsd: px * sz,
    closedPnl: numOrNull(row.closedPnl),
    fee: numOrNull(row.fee),
    ts: row.ts,
    twapId: numOrNull(row.twapId),
    startPosition: numOrNull(row.startPosition),
    liquidation: row.liquidation ?? false,
  };
}
