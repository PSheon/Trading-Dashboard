/**
 * Fixture round trips for GET /traders/:address/analytics and /trades
 * (fixture mode only): a deterministic ledger per address, summarized the
 * way the api does (closed trades by exit time; win = net PnL > 0).
 */
import type {
  PnlTier,
  RoundTrip,
  SizeTier,
  TradeCoin,
  TradeSummary,
  TradeWindow,
  TraderAnalyticsResponse,
  TraderTradesResponse,
  TradingStyle,
} from "@trading-dashboard/shared/contracts";

const COINS = ["BTC", "ETH", "SOL", "HYPE", "xyz:NVDA", "DOGE"];
const PRICES: Record<string, number> = { BTC: 64_000, ETH: 2_500, SOL: 140, HYPE: 38, "xyz:NVDA": 180, DOGE: 0.12 };
const HOUR = 3_600_000;
const WINDOW_MS: Record<TradeWindow, number | null> = { all: null, "30d": 30 * 24 * HOUR, "7d": 7 * 24 * HOUR, "1d": 24 * HOUR };

function seeded(seed: string) {
  let a = 0;
  for (let i = 0; i < seed.length; i++) a = (Math.imul(a, 31) + seed.charCodeAt(i)) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ledgers = new Map<string, RoundTrip[]>();

/** Newest exit first; the first two are still open. */
export function fixtureTrades(address: string): RoundTrip[] {
  const cached = ledgers.get(address);
  if (cached) return cached;
  const random = seeded(`trades:${address}`);
  const now = Date.now();
  const trades: RoundTrip[] = [];
  let cursor = now;
  for (let i = 0; i < 64; i++) {
    const coin = COINS[Math.floor(random() * COINS.length)];
    const hold = (0.2 + random() ** 2 * 120) * HOUR;
    const open = i < 2;
    const exit = open ? null : cursor - random() * 6 * HOUR;
    const entryTime = (exit ?? cursor) - hold;
    cursor = entryTime;
    const entryPx = PRICES[coin] * (0.85 + random() * 0.3);
    const move = (random() - 0.45) * 0.08;
    const side = random() < 0.65 ? "long" : "short";
    const exitPx = open ? null : entryPx * (1 + (side === "long" ? move : -move));
    const size = (5_000 + random() * 250_000) / entryPx;
    const realizedPnl = exitPx === null ? 0 : (side === "long" ? exitPx - entryPx : entryPx - exitPx) * size;
    const fees = size * entryPx * 0.0009;
    const funding = entryTime > now - 30 * 24 * HOUR ? -size * entryPx * 0.00001 * (hold / HOUR) : null;
    trades.push({
      id: String(9_000_000 + i),
      coin,
      side,
      status: open ? "open" : "closed",
      entryTime: new Date(entryTime),
      exitTime: exit === null ? null : new Date(exit),
      entryPx,
      exitPx,
      size,
      notional: size * (entryPx + (exitPx ?? 0)),
      volume: size * entryPx,
      holdSeconds: ((exit ?? now) - entryTime) / 1000,
      realizedPnl,
      fees,
      funding,
      netPnl: realizedPnl - fees,
      liquidated: false,
      twap: i % 17 === 5,
      fills: 1 + Math.floor(random() * 12),
      partial: i === 63,
      entryApprox: false,
    });
  }
  ledgers.set(address, trades);
  return trades;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize(trades: RoundTrip[], window: TradeWindow, now: number): TradeSummary {
  const span = WINDOW_MS[window];
  const closed = trades.filter((t) => t.exitTime !== null && (span === null || new Date(t.exitTime).getTime() >= now - span));
  const wins = closed.filter((t) => t.netPnl > 0);
  const losses = closed.filter((t) => t.netPnl < 0);
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
  const grossLoss = -losses.reduce((s, t) => s + t.netPnl, 0);
  const holds = closed.map((t) => t.holdSeconds);
  return {
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? wins.length / closed.length : null,
    avgHoldSeconds: holds.length ? holds.reduce((s, h) => s + h, 0) / holds.length : null,
    medianHoldSeconds: median(holds),
    profitFactor: grossLoss > 0 ? wins.reduce((s, t) => s + t.netPnl, 0) / grossLoss : null,
    realizedPnl: closed.reduce((s, t) => s + t.realizedPnl, 0),
    fees: closed.reduce((s, t) => s + t.fees, 0),
    netPnl: closed.reduce((s, t) => s + t.netPnl, 0),
    volume: closed.reduce((s, t) => s + t.volume, 0),
    openTrades: trades.filter((t) => t.status === "open").length,
    best: [...closed].sort((a, b) => b.netPnl - a.netPnl).slice(0, 10),
    worst: [...closed].sort((a, b) => a.netPnl - b.netPnl).slice(0, 10),
    coins: [...coins.values()].sort((a, b) => b.netPnl - a.netPnl),
  };
}

const STYLES: TradingStyle[] = ["intraday", "swing", "scalp", "position"];
const PNL_TIERS: PnlTier[] = ["extremely_profitable", "very_profitable", "profitable", "unprofitable", "rekt"];
const SIZE_TIERS: SizeTier[] = ["apex", "whale", "large", "medium", "small"];

function coverage(address: string, trades: RoundTrip[]) {
  const truncated = seeded(`coverage:${address}`)() < 0.4;
  const from = trades.at(-1)!.entryTime;
  return { source: "hyperliquid" as const, from, truncated, fundingFrom: new Date(Date.now() - 30 * 24 * HOUR), fundingThrough: new Date(Date.now() - 60_000), fills: 1_840 };
}

export function fixtureAnalytics(address: string, window: TradeWindow): TraderAnalyticsResponse {
  const trades = fixtureTrades(address);
  const random = seeded(`tiers:${address}`);
  const now = Date.now();
  const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)];
  return {
    address,
    window,
    summary: summarize(trades, window, now),
    classification: {
      style: pick(STYLES),
      pnlTier: pick(PNL_TIERS),
      sizeTier: pick(SIZE_TIERS),
      allTimePnl: 1_250_000,
      perpAccountValue: 3_400_000,
    },
    coverage: coverage(address, trades),
    computedAt: new Date(now - 60_000),
    refreshing: false,
  };
}

export function fixtureTradePage(
  address: string,
  status: "all" | "closed" | "open",
  limit: number,
  cursor: string | undefined,
): TraderTradesResponse {
  const trades = fixtureTrades(address).filter((t) => status === "all" || t.status === status);
  const start = cursor ? Number(cursor.split("_")[1]) : 0;
  const items = trades.slice(start, start + limit);
  return {
    address,
    items,
    nextCursor: start + limit < trades.length ? `0_${start + limit}` : null,
    total: trades.length,
    coverage: coverage(address, fixtureTrades(address)),
    computedAt: new Date(Date.now() - 60_000),
  };
}
