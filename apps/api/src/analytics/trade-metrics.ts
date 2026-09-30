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
 * Summary metrics and classification over round trips, reproducing
 * CopyDog's (its public API: `/traders/:a/summary`, `/trades`,
 * `/performance`; its bundle for labels). Details and the validation in
 * docs/trade-analytics.md.
 *
 * - Trade count: closed trades. Win: net PnL (gross − fees, funding aside)
 *   > 0; win rate = wins ÷ closed trades, liquidations included. Checked
 *   against CopyDog's snapshot (`metricsUpdatedAt`) on 19 traders; its
 *   tile can lag ours by a day. Windows count trades by exit time. Average and
 *   median hold over closed trades (partial ones from their first held fill).
 * - Best / worst: the 10 closed trades with the highest / lowest net PnL,
 *   whatever the sign (CopyDog's 表現 tab lists them so); the rail keeps
 *   the winners / losers among them and shows 3. Coins (`byAsset`): trades, wins, losses, volume = Σ size × entry
 *   price, net PnL; ordered by net PnL, the rail's "most traded" by volume,
 *   the 表現 tab's by trade count.
 * - Trading style, on the median hold: CopyDog computes it server-side and
 *   only publishes descriptions ("seconds to minutes", "hours, same day",
 *   "days to weeks", "weeks or longer"). The cut-offs were fitted to its
 *   labels on 48 traders (12 per style): their medians fall in 0–8.4 min
 *   (scalp), 28 min–23.6 h (intraday), 25 h–9.9 days (swing) and
 *   14.3–54 days (position); 15 min, 24 h and 14 days separate all 48.
 * - PnL tier, on Hyperliquid's leaderboard all-time PnL (CopyDog's
 *   `totalPnl` equals it): bundle labels "+$1M+", "+$100K to +$1M", "$0 to
 *   +$100K", "$0 to −$100K", "−$100K to −$1M", "−$1M+"; break even is
 *   exactly $0 (its label has no range).
 * - Size tier, on perp account value (CopyDog's `accountValue`: a unified
 *   account holding everything in spot is "small"): bundle labels $5M+,
 *   $1M–5M, $100K–1M, $10K–100K, $0–10K.
 */
export const STYLE_MAX_SECONDS = {
  scalp: 15 * 60,
  intraday: 24 * 3600,
  swing: 14 * 86400,
} as const;

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

/** ≥ $1M, ≥ $100K, > 0, = 0, > −$100K, > −$1M, else rekt. */
export function pnlTier(pnl: number | null): PnlTier | null {
  if (pnl === null || !Number.isFinite(pnl)) return null;
  if (pnl >= 1_000_000) return "extremely_profitable";
  if (pnl >= 100_000) return "very_profitable";
  if (pnl > 0) return "profitable";
  if (pnl === 0) return "break_even";
  if (pnl > -100_000) return "unprofitable";
  if (pnl > -1_000_000) return "very_unprofitable";
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
  "1d": 86_400_000,
};

export const LIST_SIZE = 10;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const exitMs = (t: RoundTrip) => (t.exitTime === null ? null : new Date(t.exitTime).getTime());

/** Closed trades that exited within the window through the observation time. */
export function closedInWindow(trades: RoundTrip[], window: TradeWindow, now: number): RoundTrip[] {
  const span = WINDOW_MS[window];
  return trades.filter((t) => {
    const exit = exitMs(t);
    return exit !== null && exit <= now && (span === null || exit >= now - span);
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
    const c = coins.get(t.coin) ?? { coin: t.coin, trades: 0, wins: 0, losses: 0, volume: 0, netPnl: 0, winRate: 0 };
    c.trades += 1;
    if (t.netPnl > 0) c.wins += 1;
    if (t.netPnl < 0) c.losses += 1;
    c.volume += t.volume;
    c.netPnl += t.netPnl;
    c.winRate = c.wins / c.trades;
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
    best: [...closed].sort((a, b) => b.netPnl - a.netPnl).slice(0, LIST_SIZE),
    worst: [...closed].sort((a, b) => a.netPnl - b.netPnl).slice(0, LIST_SIZE),
    coins: [...coins.values()].sort((a, b) => b.netPnl - a.netPnl),
  };
}
