/**
 * The portfolio page's figures, from GET /me/copy and GET /me/copy/portfolio.
 * Pure (no React): CopyDog's definitions (bundle `index-Dp4CR15e.js`,
 * 2026-10-04), with the deviations noted where CopyDog's figure would be wrong.
 */
import type { CopyOverview, CopyStrategyView } from "@/lib/contracts";
import type { CopyPerformanceWindow } from "@trading-dashboard/shared/contracts";

/** CopyDog's chart windows 24H / 7D / 30D / ALL, in Orbie's copy windows. */
export const PORTFOLIO_WINDOWS: Array<[CopyPerformanceWindow, "day" | "week" | "month" | "allTime"]> = [
  ["1d", "day"],
  ["7d", "week"],
  ["30d", "month"],
  ["all", "allTime"],
];

/**
 * Today's change and its percentage (CopyDog: `T / (M − T)`, M the total
 * value). Orbie: today is since 00:00 UTC (as each copy's own today figure;
 * CopyDog labels a rolling 24 h "Today"), and M is the paper account's
 * total, the paper copies' money only: the wallet's real funds are never
 * mixed into paper figures.
 */
export function todayChange(overview: Pick<CopyOverview, "paper">, todayPnl: number | null | undefined): { pnl: number; pct: number | null } | null {
  if (todayPnl === null || todayPnl === undefined || !Number.isFinite(todayPnl)) return null;
  const total = overview.paper.totalValue;
  const start = total === null ? null : total - todayPnl;
  return { pnl: todayPnl, pct: start !== null && start > 0 ? todayPnl / start : null };
}

/** CopyDog's hero legend: Available (the paper balance), Copied (the live
 * copies' equity) and Unrealized P&L. Null where a price is missing. */
export function paperLegend(overview: CopyOverview): { available: number; copied: number | null; unrealized: number | null } {
  const live = overview.strategies.filter((s) => s.status !== "stopped");
  const copied = live.some((s) => s.equity === null) ? null : live.reduce((a, s) => a + (s.equity ?? 0), 0);
  const unrealized = live.some((s) => s.positions.length > 0 && s.unrealizedPnl === null) ? null : live.reduce((a, s) => a + (s.unrealizedPnl ?? 0), 0);
  return { available: overview.paper.balance, copied, unrealized };
}

/**
 * Insights → Overview. CopyDog: Invested = Σ net deposits of the copies
 * whose P&L is known, Total P&L = Σ their P&L, ROI = P&L ÷ Invested. Its
 * "Value" is the whole account (wallet included), which does not sit next
 * to Invested; Orbie's Value is the same copies' equity, so Value −
 * Invested = Total P&L.
 */
export function insightsOverview(strategies: CopyStrategyView[]): { invested: number; value: number | null; totalPnl: number | null; roiPct: number | null } {
  const live = strategies.filter((s) => s.status !== "stopped");
  const known = live.filter((s) => s.totalPnl !== null);
  const invested = known.reduce((a, s) => a + s.allocated - (s.withdrawn ?? 0), 0);
  const totalPnl = known.length ? known.reduce((a, s) => a + (s.totalPnl ?? 0), 0) : live.length ? null : 0;
  const value = live.some((s) => s.equity === null) ? null : live.reduce((a, s) => a + (s.equity ?? 0), 0);
  return { invested, value, totalPnl, roiPct: totalPnl !== null && invested > 0 ? (totalPnl / invested) * 100 : null };
}

/** The current net deposits the portfolio chart's ROI divides by (CopyDog:
 * `netInvested`, the live copies with a known P&L). */
export function netInvested(strategies: CopyStrategyView[]): number {
  return insightsOverview(strategies).invested;
}

export interface AssetLine {
  strategyId: number;
  leaderAddress: string;
  size: number;
  notional: number;
  unrealizedPnl: number;
  roiPct: number | null;
}
export interface AssetExposure {
  coin: string;
  netSize: number;
  grossNotional: number;
  pnl: number;
  copyCount: number;
  /** Long in one copy and short in another (CopyDog's Hedged badge). */
  hedged: boolean;
  isLong: boolean;
  lines: AssetLine[];
}

/**
 * Exposure across the live copies (CopyDog's Direction, Leverage and By
 * Asset): gross notional per coin, the long and short split, and leverage
 * = gross notional ÷ the copies' equity. Null when a price is missing: an
 * unpriced position is never counted as 0.
 */
export function exposure(strategies: CopyStrategyView[]): {
  assets: AssetExposure[];
  long: number;
  short: number;
  gross: number;
  longPct: number;
  shortPct: number;
  equity: number;
  leverage: number | null;
} | null {
  const live = strategies.filter((s) => s.status !== "stopped");
  if (live.some((s) => s.equity === null || s.positions.some((p) => p.notionalUsd === null || p.unrealizedPnl === null))) return null;
  const byCoin = new Map<string, AssetExposure>();
  let long = 0;
  let short = 0;
  for (const s of live) {
    for (const p of s.positions) {
      if (p.size === 0) continue;
      const notional = Math.abs(p.notionalUsd ?? 0);
      const isLong = p.size > 0;
      if (isLong) long += notional;
      else short += notional;
      const a = byCoin.get(p.coin) ?? { coin: p.coin, netSize: 0, grossNotional: 0, pnl: 0, copyCount: 0, hedged: false, isLong: true, lines: [] };
      a.netSize += p.size;
      a.grossNotional += notional;
      a.pnl += p.unrealizedPnl ?? 0;
      a.lines.push({ strategyId: s.id, leaderAddress: s.leaderAddress, size: p.size, notional, unrealizedPnl: p.unrealizedPnl ?? 0, roiPct: p.entryPx > 0 ? ((p.unrealizedPnl ?? 0) / (Math.abs(p.size) * p.entryPx)) * 100 : null });
      byCoin.set(p.coin, a);
    }
  }
  const assets = [...byCoin.values()].map((a) => ({
    ...a,
    copyCount: new Set(a.lines.map((l) => l.strategyId)).size,
    hedged: a.lines.some((l) => l.size > 0) && a.lines.some((l) => l.size < 0),
    isLong: a.netSize >= 0,
  })).sort((x, y) => y.grossNotional - x.grossNotional);
  const gross = long + short;
  const equity = live.reduce((a, s) => a + (s.equity ?? 0), 0);
  return { assets, long, short, gross, longPct: gross > 0 ? (long / gross) * 100 : 0, shortPct: gross > 0 ? (short / gross) * 100 : 0, equity, leverage: equity > 0 ? gross / equity : null };
}

/** CopyDog's share label: "<1%" below one percent, else whole percent. */
export function sharePct(share: number): string {
  const pct = Math.max(share, 0) * 100;
  return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

/**
 * CopyDog's `hedge_warning` when a copy starts: the coins where the new
 * copy's side (the leader's, reversed for a counter copy) is opposite to a
 * position another live copy holds. Each Orbie copy has its own wallet, so
 * the two positions stay open side by side (they do not net out).
 */
export function hedgeWarning(
  leaderPositions: ReadonlyArray<{ coin: string; szi: number }>,
  direction: "same" | "reverse",
  others: CopyStrategyView[],
  leader: string,
): { coins: string[]; opposingLeaders: string[] } | null {
  const coins = new Set<string>();
  const opposing = new Set<string>();
  for (const p of leaderPositions) {
    if (!p.szi) continue;
    const side = Math.sign(p.szi) * (direction === "reverse" ? -1 : 1);
    for (const s of others) {
      if (s.status === "stopped" || s.leaderAddress === leader.toLowerCase()) continue;
      if (s.positions.some((q) => q.coin === p.coin && q.size !== 0 && Math.sign(q.size) === -side)) {
        coins.add(p.coin);
        opposing.add(s.leaderAddress);
      }
    }
  }
  return coins.size ? { coins: [...coins], opposingLeaders: [...opposing] } : null;
}

/** Start of a copy window at `to` (Orbie's copy windows). */
export function windowStart(window: CopyPerformanceWindow, to: number, copyStart: number): number {
  const span = window === "1d" ? 86_400_000 : window === "7d" ? 7 * 86_400_000 : window === "30d" ? 30 * 86_400_000 : Number.POSITIVE_INFINITY;
  return Math.max(copyStart, to - span);
}

/**
 * ROI over a period with the trader page's definition: the PnL change over
 * the period ÷ the highest net deposits (account value − cumulative PnL) in
 * it. `pnl` and `accountValue` are [time, value] series; `from` the period's
 * start. Null without a point at or before `from` and one after it, or
 * below $1 of net deposits.
 */
export function periodRoi(pnl: ReadonlyArray<readonly [number, number]>, accountValue: ReadonlyArray<readonly [number, number]>, from: number): { pnl: number; roi: number | null } | null {
  const before = pnl.filter(([t]) => t <= from).at(-1) ?? null;
  const inside = pnl.filter(([t]) => t >= from);
  const last = pnl.at(-1);
  if (!last || (!before && !inside.length)) return null;
  const base = before ?? inside[0]!;
  // A series that starts after `from` (a short window, a young account)
  // only covers part of the period: still the change it shows.
  const change = last[1] - base[1];
  const value = new Map(accountValue.map(([t, v]) => [t, v]));
  let peak = 0;
  for (const [t, p] of [base, ...inside]) {
    const av = value.get(t);
    if (av !== undefined) peak = Math.max(peak, av - p);
  }
  return { pnl: change, roi: peak >= 1 ? change / peak : null };
}
