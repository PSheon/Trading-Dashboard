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

export interface AccountSummary {
  accountValue: number;
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
    accountValue: 0,
    marginUsed: 0,
    withdrawable: 0,
    longNotional: 0,
    shortNotional: 0,
    positions: [],
  };
  for (const state of states) {
    out.accountValue += num(state.marginSummary?.accountValue);
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
  return { window, market, ...series, ...portfolioMetrics(series.pnl, series.accountValue) };
}

const YEAR_MS = 365 * 24 * 3_600_000;
export const SHARPE_MIN_POINTS = 5;

export interface PortfolioMetrics {
  maxDrawdownUsd: number;
  maxDrawdownPct: number | null;
  sharpe: number | null;
}

/** Account value at `ts`: the point with that timestamp, else the latest
 * one before it; null when there is none. Hyperliquid samples both series
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
 * Risk metrics of one portfolio window (§10, 競品分析 §3.1–3.2):
 *
 * - `maxDrawdownUsd`: the largest fall of cumulative PnL from a running peak
 *   to a later point, max over the window of (peak so far − value), ≥ 0.
 * - `maxDrawdownPct`: that fall ÷ the account value at the peak it fell
 *   from; null when that account value is ≤ 0 or unknown.
 * - `sharpe`: per-point returns rᵢ = (pnlᵢ − pnlᵢ₋₁) ÷ accountValueᵢ₋₁
 *   (points whose prior account value is ≤ 0 are skipped); mean(r) ÷
 *   sample stdev(r) (n − 1), risk-free rate 0, × √(periods per year), where
 *   a period is the series' mean sampling interval (span ÷ (points − 1)) and
 *   a year is 365 days. Null with fewer than 5 PnL points, fewer than 2
 *   returns, or zero variance.
 */
export function portfolioMetrics(pnl: Point[], accountValue: Point[]): PortfolioMetrics {
  let maxDrawdownUsd = 0;
  let maxDrawdownPct: number | null = null;
  if (pnl.length > 0) {
    let peak = pnl[0];
    let ddPeak = pnl[0];
    for (const point of pnl) {
      if (point[1] > peak[1]) peak = point;
      const dd = peak[1] - point[1];
      if (dd > maxDrawdownUsd) {
        maxDrawdownUsd = dd;
        ddPeak = peak;
      }
    }
    const av = valueAt(accountValue, ddPeak[0]);
    maxDrawdownPct = av !== null && av > 0 ? maxDrawdownUsd / av : null;
  }
  return { maxDrawdownUsd, maxDrawdownPct, sharpe: sharpeRatio(pnl, accountValue) };
}

function sharpeRatio(pnl: Point[], accountValue: Point[]): number | null {
  if (pnl.length < SHARPE_MIN_POINTS) return null;
  const returns: number[] = [];
  for (let i = 1; i < pnl.length; i++) {
    const prior = valueAt(accountValue, pnl[i - 1][0]);
    if (prior !== null && prior > 0) returns.push((pnl[i][1] - pnl[i - 1][1]) / prior);
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const stdev = Math.sqrt(variance);
  const interval = (pnl[pnl.length - 1][0] - pnl[0][0]) / (pnl.length - 1);
  if (!(stdev > 0) || !(interval > 0)) return null;
  return (mean / stdev) * Math.sqrt(YEAR_MS / interval);
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
  };
}
