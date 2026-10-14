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
 * Summary metrics and classification over round trips, reproducing CopyDog's
 * (validation in docs/trade-analytics.md).
 *
 * - Trades: closed, counted by exit time. Win: net PnL (gross − fees,
 *   funding aside) > 0; win rate over closed trades, liquidations included
 *   (checked on 19 traders).
 * - Best / worst: 10 closed trades by net PnL, whatever the sign. Coins:
 *   volume = Σ size × entry price; ordered by net PnL.
 * - Trading style on median hold: cut-offs 15 min / 24 h / 14 days fitted to
 *   CopyDog's labels on 48 traders.
 * - PnL tier on all-time perp PnL (not leaderboard PnL, which includes
 *   spot); break even is exactly $0.
 * - Size tier on the whole account's value (帳戶價值), not perp equity as
 *   CopyDog does (that misclassifies unified accounts).
 */
const STYLE_MAX_SECONDS = {
  scalp: 15 * 60,
  intraday: 24 * 3600,
  swing: 14 * 86400,
} as const;

const SIZE_TIER_MIN: ReadonlyArray<[SizeTier, number]> = [
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

const LIST_SIZE = 10;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const exitMs = (t: RoundTrip) => (t.exitTime === null ? null : new Date(t.exitTime).getTime());

/** Closed trades that exited within the window through the observation time. */
function closedInWindow(trades: RoundTrip[], window: TradeWindow, now: number): RoundTrip[] {
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
