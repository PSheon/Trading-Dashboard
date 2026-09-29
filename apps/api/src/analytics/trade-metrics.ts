import type {
  PnlTier,
  RoundTrip,
  SizeTier,
  TradeCoin,
  TradeSummary,
  TradeWindow,
  TradingStyle,
} from "@trading-dashboard/shared/contracts";

/**
 * Summary metrics and CopyDog-style classification over round trips.
 *
 * Thresholds (documented in docs/trade-analytics.md):
 *
 * - Trading style, on the median hold of every closed trade in coverage.
 *   CopyDog computes it server-side and only publishes descriptions
 *   ("seconds to minutes", "hours, same day", "days to weeks", "weeks or
 *   longer"); the cut-offs below were fitted to 48 of its traders (12 per
 *   style), whose medians fall in 0–8.4 min (scalp), 28 min–23.6 h
 *   (intraday), 25 h–9.9 days (swing) and 14.3–54 days (position).
 * - PnL tier, on Hyperliquid's all-time PnL: CopyDog's bundle labels
 *   ("+$1M+", "+$100K to +$1M", "$0 to +$100K", "$0 to −$100K", "−$100K to
 *   −$1M", "−$1M+"); its break-even band has no label, so ±$100 is ours.
 * - Size tier, on total account value: CopyDog's bundle labels ($5M+,
 *   $1M–5M, $100K–1M, $10K–100K, $0–10K).
 */
export const STYLE_MAX_SECONDS = {
  scalp: 15 * 60,
  intraday: 24 * 3600,
  swing: 14 * 86400,
} as const;

export const PNL_TIER_MIN: ReadonlyArray<[PnlTier, number]> = [
  ["extremely_profitable", 1_000_000],
  ["very_profitable", 100_000],
  ["profitable", 100],
  ["break_even", -100],
  ["unprofitable", -100_000],
  ["very_unprofitable", -1_000_000],
];

export const SIZE_TIER_MIN: ReadonlyArray<[SizeTier, number]> = [
  ["apex", 5_000_000],
  ["whale", 1_000_000],
  ["large", 100_000],
  ["medium", 10_000],
];

export function tradingStyle(medianHoldSeconds: number | null): TradingStyle | null {
  if (medianHoldSeconds === null) return null;
  if (medianHoldSeconds < STYLE_MAX_SECONDS.scalp) return "scalp";
  if (medianHoldSeconds < STYLE_MAX_SECONDS.intraday) return "intraday";
  if (medianHoldSeconds < STYLE_MAX_SECONDS.swing) return "swing";
  return "position";
}

/** Positive bounds are inclusive, negative ones exclusive: break even is
 * −$100 < PnL < +$100, −$100K itself is very unprofitable. */
export function pnlTier(pnl: number | null): PnlTier | null {
  if (pnl === null || !Number.isFinite(pnl)) return null;
  for (const [tier, min] of PNL_TIER_MIN) {
    if (min < 0 ? pnl > min : pnl >= min) return tier;
  }
  return "rekt";
}

export function sizeTier(accountValue: number | null): SizeTier | null {
  if (accountValue === null || !Number.isFinite(accountValue)) return null;
  for (const [tier, min] of SIZE_TIER_MIN) if (accountValue >= min) return tier;
  return "small";
}

export const WINDOW_MS: Record<TradeWindow, number | null> = {
  all: null,
  "30d": 30 * 86_400_000,
  "7d": 7 * 86_400_000,
};

export const LIST_SIZE = 10;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const exitMs = (t: RoundTrip) => (t.exitTime === null ? null : new Date(t.exitTime).getTime());

/** Closed trades that exited in the window (all: every closed trade). */
export function closedInWindow(trades: RoundTrip[], window: TradeWindow, now: number): RoundTrip[] {
  const span = WINDOW_MS[window];
  return trades.filter((t) => {
    const exit = exitMs(t);
    return exit !== null && (span === null || exit >= now - span);
  });
}

/** One window's summary. Wins are net PnL > 0; a net 0 trade is neither
 * a win nor a loss but still counts as a trade. */
export function summarize(trades: RoundTrip[], window: TradeWindow, now: number): TradeSummary {
  const closed = closedInWindow(trades, window, now);
  const wins = closed.filter((t) => t.netPnl > 0);
  const losses = closed.filter((t) => t.netPnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.netPnl, 0);
  const holds = closed.map((t) => t.holdSeconds);
  const coins = new Map<string, TradeCoin>();
  for (const t of closed) {
    const c = coins.get(t.coin) ?? { coin: t.coin, volume: 0, trades: 0, wins: 0, netPnl: 0 };
    c.volume += t.volume;
    c.trades += 1;
    if (t.netPnl > 0) c.wins += 1;
    c.netPnl += t.netPnl;
    coins.set(t.coin, c);
  }
  return {
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length === 0 ? null : wins.length / closed.length,
    avgHoldSeconds: holds.length === 0 ? null : holds.reduce((s, h) => s + h, 0) / holds.length,
    medianHoldSeconds: median(holds),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    realizedPnl: closed.reduce((s, t) => s + t.realizedPnl, 0),
    fees: closed.reduce((s, t) => s + t.fees, 0),
    netPnl: closed.reduce((s, t) => s + t.netPnl, 0),
    volume: closed.reduce((s, t) => s + t.volume, 0),
    openTrades: trades.filter((t) => t.status === "open").length,
    best: [...wins].sort((a, b) => b.netPnl - a.netPnl).slice(0, LIST_SIZE),
    worst: [...losses].sort((a, b) => a.netPnl - b.netPnl).slice(0, LIST_SIZE),
    topCoins: [...coins.values()].sort((a, b) => b.volume - a.volume).slice(0, LIST_SIZE),
  };
}
