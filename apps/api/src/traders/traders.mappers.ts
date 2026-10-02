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
  HlPerpDexsResponse,
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

/** Perp dexes with at least one listed market, the main dex ("") first.
 * Each is its own clearinghouse: a standard account's perp equity is the
 * sum over all of them. */
export function activePerpDexes(list: HlPerpDexsResponse): string[] {
  const hip3 = list
    .filter((d): d is NonNullable<typeof d> => d !== null && (d.assetToStreamingOiCap?.length ?? 0) > 0)
    .map((d) => d.name);
  return ["", ...hip3];
}

/** The perp side of an account, summed over dexes. */
export interface AccountSummary {
  /** Sum of every dex's `marginSummary.accountValue`; not the account's
   * total (that adds spot and staking, see `totalAccountValue`). */
  perpEquity: number;
  marginUsed: number;
  maintenanceMarginUsed: number;
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
    maintenanceMarginUsed: 0,
    withdrawable: 0,
    longNotional: 0,
    shortNotional: 0,
    positions: [],
  };
  for (const state of states) {
    out.perpEquity += num(state.marginSummary?.accountValue);
    out.marginUsed += num(state.marginSummary?.totalMarginUsed);
    out.maintenanceMarginUsed += num(state.crossMaintenanceMarginUsed);
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
  // Sharpe and max drawdown are always the whole account's (perp + spot), as
  // CopyDog's are, whichever market the chart shows; ROI and the % curve are
  // the market's own. Falls back to the market's series when Hyperliquid
  // didn't send the whole-account one.
  const whole = market === "all" ? series : portfolioSeries(raw, window, "all");
  const { roi, cumulativeReturn, capital } = returnMetrics(series);
  const risk = riskMetrics(whole.pnl.length > 0 ? whole : series);
  return {
    window,
    market,
    ...series,
    roi,
    cumulativeReturn,
    sharpe: risk.sharpe,
    volatility: risk.volatility,
    maxDrawdownPct: risk.maxDrawdownPct,
    maxDrawdownUsd: risk.maxDrawdownUsd,
    basis: { version: "copydog-v1", capital, ...risk.basis },
  };
}

/** A window's PnL and account value, as Hyperliquid samples them. */
export interface CapitalSeries {
  accountValue: Point[];
  pnl: Point[];
}

const DAY_MS = 24 * 3_600_000;

/** Below this much capital a return means nothing (CopyDog's calendar
 * rule, `apps/web/src/lib/pnl-calendar.ts`). */
export const MIN_ROI_CAPITAL = 100;
/** Above this (+10,000 %) a return is a denominator artefact, not a return. */
export const MAX_ROI = 100;

/**
 * CopyDog's ROI (verified against its public API on 18 traders and every
 * window, 2026-09-30): the window's PnL ÷ its peak net deposits, the most
 * capital that was ever in the account over the window: C = max over the
 * window's points of (account value − cumulative PnL). Deposits and
 * withdrawals move account value and C, never PnL, so they don't count as
 * return. `cumulativeReturn` is PnL ÷ C at every point, so the chart's %
 * mode ends at the ROI.
 *
 * The denominator must be capital that was actually in the account: only
 * points whose account value is above 0 count. Hyperliquid reports a perp
 * account value of 0 at every point of a unified account's perp series
 * (its collateral is spot), and `0 − PnL` is then not a deposit but the
 * loss itself, so a −$66 month read as −100 % (seen live on
 * 0x1aa7…29ed, 0xeecc…4c09, 0x8bf3…9060, 2026-10-02). As CopyDog's calendar
 * does, no return is given below `MIN_ROI_CAPITAL` of capital or above
 * `MAX_ROI`, and a loss is capped at −100 %; the ROI is then null (shown
 * as "—") and the % curve stays flat at 0. Null without data.
 */
export function returnMetrics({ accountValue, pnl }: CapitalSeries): {
  roi: number | null;
  cumulativeReturn: Point[];
  capital: number | null;
} {
  if (pnl.length === 0) return { roi: null, cumulativeReturn: [], capital: null };
  let capital = -Infinity;
  for (let i = 0; i < pnl.length; i++) {
    const av = valueAt(accountValue, pnl[i][0]);
    if (av !== null && av > 0) capital = Math.max(capital, av - pnl[i][1]);
  }
  const flat = (): Point[] => pnl.map(([t]) => [t, 0]);
  if (!(capital >= MIN_ROI_CAPITAL)) return { roi: null, cumulativeReturn: flat(), capital: capital > 0 ? capital : null };
  const roi = Math.max(-1, pnl[pnl.length - 1][1] / capital);
  if (roi > MAX_ROI) return { roi: null, cumulativeReturn: flat(), capital };
  // Hyperliquid starts every window's PnL at 0, so no rebasing is needed.
  const cumulativeReturn: Point[] = pnl.map(([t, p]) => [t, Math.max(-1, p / capital)]);
  return { roi, cumulativeReturn, capital };
}

/**
 * CopyDog's Sharpe, volatility and max drawdown (verified against its
 * public API on 18 traders, 2026-09-30; see docs/trade-analytics.md), all on
 * the whole account's series of the window, with Hyperliquid's latest point
 * (the live value) included:
 *
 * - interval returns rᵢ = ΔPnLᵢ ÷ the window's peak account value; an
 *   interval that starts from an empty account (value ≤ 0) is skipped;
 * - `sharpe` = mean(r) ÷ sample stdev(r) × √(365 ÷ the median spacing of
 *   the returns' time index, in days): Hyperliquid samples a window at
 *   uneven spacing (hours for a day, 9 h to a week for all time), and
 *   CopyDog annualises by the typical one. Null with fewer than 2 returns
 *   or no variance;
 * - `maxDrawdownPct`: the largest fall of the equity line 1 + Σr from its
 *   running peak (which starts at 1), ÷ that peak, capped at 1. Coarse
 *   all-time sampling and a larger peak account value can make it smaller
 *   than a shorter window's, on CopyDog too;
 * - `maxDrawdownUsd`: separately, the largest fall of cumulative PnL from a
 *   running peak (USD, ≥ 0).
 */
export function riskMetrics({ accountValue, pnl }: CapitalSeries): {
  sharpe: number | null;
  volatility: number | null;
  maxDrawdownPct: number | null;
  maxDrawdownUsd: number;
  basis: { peakAccountValue: number | null; returns: number; skippedIntervals: number; periodsPerYear: number | null };
} {
  let maxDrawdownUsd = 0;
  if (pnl.length > 0) {
    let peak = pnl[0][1];
    for (const [, v] of pnl) {
      peak = Math.max(peak, v);
      maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - v);
    }
  }
  const peakAccountValue = accountValue.reduce((m, [, v]) => Math.max(m, v), 0);
  const returns: number[] = [];
  /** When each kept return ends: the returns' time index. */
  const times: number[] = [];
  let skippedIntervals = 0;
  for (let i = 1; i < pnl.length; i++) {
    const prior = valueAt(accountValue, pnl[i - 1][0]);
    if (prior === null || prior <= 0) {
      skippedIntervals += 1;
      continue;
    }
    returns.push((pnl[i][1] - pnl[i - 1][1]) / peakAccountValue);
    times.push(pnl[i][0]);
  }
  // The spacing of the returns' own time index (so n − 1 gaps). Hyperliquid's
  // spacing is often bimodal (daily, then ~9 h), and this median, not the
  // intervals', is the one that reproduces CopyDog's figures.
  const gaps = times.slice(1).map((t, i) => (t - times[i]) / DAY_MS);
  const basis = { peakAccountValue: peakAccountValue > 0 ? peakAccountValue : null, returns: returns.length, skippedIntervals, periodsPerYear: null as number | null };
  if (!(peakAccountValue > 0) || returns.length === 0) {
    return { sharpe: null, volatility: null, maxDrawdownPct: null, maxDrawdownUsd, basis };
  }
  let equity = 1;
  let peakEquity = 1;
  let maxDrawdownPct = 0;
  for (const r of returns) {
    equity += r;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, (peakEquity - equity) / peakEquity);
  }
  maxDrawdownPct = Math.min(1, maxDrawdownPct);
  const typicalGap = median(gaps);
  const periodsPerYear = typicalGap > 0 ? 365 / typicalGap : null;
  basis.periodsPerYear = periodsPerYear;
  if (returns.length < 2 || periodsPerYear === null) return { sharpe: null, volatility: null, maxDrawdownPct, maxDrawdownUsd, basis };
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const stdev = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1));
  // Below this the variance is rounding noise, not risk.
  if (!(stdev > 1e-12)) return { sharpe: null, volatility: null, maxDrawdownPct, maxDrawdownUsd, basis };
  return {
    sharpe: (mean / stdev) * Math.sqrt(periodsPerYear),
    volatility: stdev * Math.sqrt(periodsPerYear),
    maxDrawdownPct,
    maxDrawdownUsd,
    basis,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
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
