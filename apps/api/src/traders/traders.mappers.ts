import type {
  LivePosition,
  PortfolioResponse,
  TraderFill,
  TraderStats,
  TraderWindowInput,
  traderStats,
} from "@trading-dashboard/shared";

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

export function toPortfolioResponse(
  raw: HlPortfolioResponse,
  window: TraderWindowInput,
  market: "all" | "perp",
): PortfolioResponse {
  const key = portfolioKey(window, market);
  const entry = raw.find(([name]) => name === key)?.[1];
  return {
    window,
    market,
    accountValue: toPoints(entry?.accountValueHistory),
    pnl: toPoints(entry?.pnlHistory),
    volume: num(entry?.vlm),
  };
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
  };
}
