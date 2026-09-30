import type { CohortDetailResponse, CohortMarket, CohortTier, CohortWallet, CohortWindow, PnlTier } from "@trading-dashboard/shared/contracts";
import type { CohortPosition } from "@trading-dashboard/shared/database";

import type { HlClearinghouseStateResponse } from "../hyperliquid/types.js";

/** Display and refresh order of the tiers (極度盈利 first, the default). */
export const COHORT_TIERS: CohortTier[] = [
  "extremely_profitable", "very_profitable", "profitable", "break_even", "unprofitable", "very_unprofitable", "rekt",
];

/** All-time PnL bounds of each tier (CopyDog's cohorts; `pnlTier`):
 * `min` inclusive / exclusive as named, null = unbounded. */
export const TIER_BOUNDS: Record<PnlTier, { gte?: number; gt?: number; lt?: number; lte?: number; eq?: number }> = {
  extremely_profitable: { gte: 1_000_000 },
  very_profitable: { gte: 100_000, lt: 1_000_000 },
  profitable: { gt: 0, lt: 100_000 },
  break_even: { eq: 0 },
  unprofitable: { gt: -100_000, lt: 0 },
  very_unprofitable: { gt: -1_000_000, lte: -100_000 },
  rekt: { lte: -1_000_000 },
};

/** Window lengths of the 倉位傾向 chart. */
export const WINDOW_MS: Record<CohortWindow, number> = {
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000,
  all: Number.POSITIVE_INFINITY,
};

/** BTC candle size per window: about 90–180 candles each. */
export function candleInterval(window: CohortWindow, spanMs: number): { interval: string; ms: number } {
  if (window === "7d" || spanMs <= 7 * 86_400_000) return { interval: "1h", ms: 3_600_000 };
  if (window === "30d" || spanMs <= 30 * 86_400_000) return { interval: "4h", ms: 4 * 3_600_000 };
  if (window === "90d" || spanMs <= 90 * 86_400_000) return { interval: "12h", ms: 12 * 3_600_000 };
  return { interval: "1d", ms: 86_400_000 };
}

/** The dex of a coin: "xyz:TSLA" → "xyz"; main-dex coins → "". */
export const dexOf = (coin: string): string => (coin.includes(":") ? coin.split(":")[0] : "");

/** Open positions and perp equity from one member's clearinghouse states
 * (one per dex queried). HIP-3 coins already carry their dex prefix. */
export function positionsFrom(states: HlClearinghouseStateResponse[]): { positions: CohortPosition[]; equity: number } {
  const positions: CohortPosition[] = [];
  let equity = 0;
  for (const state of states) {
    equity += Number(state.marginSummary.accountValue) || 0;
    for (const { position: p } of state.assetPositions) {
      const size = Number(p.szi);
      if (!size) continue;
      const value = Math.abs(Number(p.positionValue ?? 0)) || Math.abs(size * Number(p.entryPx ?? 0));
      positions.push({ coin: p.coin, notional: size > 0 ? value : -value, upnl: Number(p.unrealizedPnl) || 0 });
    }
  }
  return { positions, equity };
}

/** A member as the aggregation reads it. */
export interface MemberSnapshot {
  address: string;
  pnlAll: number | null;
  roiAll: number | null;
  perpEquity: number | null;
  positions: CohortPosition[];
  fetchedAt: Date | null;
  displayName: string | null;
  avatarUrl: string | null;
  verified: boolean;
  copyScore: number | null;
}

const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((1000 * part) / whole) / 10 : null);

export function walletOf(m: MemberSnapshot): CohortWallet {
  let long = 0;
  let short = 0;
  let upnl = 0;
  for (const p of m.positions) {
    if (p.notional > 0) long += p.notional;
    else short -= p.notional;
    upnl += p.upnl;
  }
  const positionValue = long + short;
  const topAssets = [...m.positions].sort((a, b) => Math.abs(b.notional) - Math.abs(a.notional)).map((p) => p.coin).slice(0, 5);
  return {
    address: m.address,
    displayName: m.displayName,
    avatarUrl: m.avatarUrl,
    verified: m.verified,
    topAssets,
    totalPnl: m.pnlAll,
    roi: m.roiAll,
    perpEquity: m.perpEquity,
    copyScore: m.copyScore,
    positionValue,
    leverage: m.perpEquity && m.perpEquity > 0 ? positionValue / m.perpEquity : null,
    sumUpnl: upnl,
    biasPct: pct(long, positionValue),
  };
}

/**
 * The tier's positioning from its members' latest snapshots (only those
 * fetched since `freshSince`): CopyDog's hero figures, per-market split and
 * wallet rows.
 */
export function aggregate(tier: CohortTier, members: MemberSnapshot[], freshSince: Date): CohortDetailResponse {
  const fresh = members.filter((m) => m.fetchedAt !== null && m.fetchedAt >= freshSince);
  const wallets = fresh.map(walletOf).sort((a, b) => (b.perpEquity ?? 0) - (a.perpEquity ?? 0));
  const markets = new Map<string, CohortMarket>();
  let upnlProfit = 0;
  let upnlLoss = 0;
  let notionalLong = 0;
  let notionalShort = 0;
  for (const m of fresh) {
    for (const p of m.positions) {
      const row = markets.get(p.coin) ?? { coin: p.coin, notionalLong: 0, notionalShort: 0, biasPct: null, upnl: 0, tradersLong: 0, tradersShort: 0, tradersProfit: 0, tradersLoss: 0 };
      if (p.notional > 0) {
        row.notionalLong += p.notional;
        row.tradersLong += 1;
        notionalLong += p.notional;
      } else {
        row.notionalShort -= p.notional;
        row.tradersShort += 1;
        notionalShort -= p.notional;
      }
      row.upnl += p.upnl;
      if (p.upnl > 0) row.tradersProfit += 1;
      else if (p.upnl < 0) row.tradersLoss += 1;
      if (p.upnl > 0) upnlProfit += p.upnl;
      else upnlLoss -= p.upnl;
      markets.set(p.coin, row);
    }
  }
  for (const row of markets.values()) row.biasPct = pct(row.notionalLong, row.notionalLong + row.notionalShort);
  const inProfit = wallets.filter((w) => w.sumUpnl > 0).length;
  const inLoss = wallets.filter((w) => w.sumUpnl < 0).length;
  const oldest = fresh.reduce<Date | null>((min, m) => (m.fetchedAt && (!min || m.fetchedAt < min) ? m.fetchedAt : min), null);
  return {
    tier,
    memberCount: members.length,
    walletCount: wallets.length,
    hero: {
      upnlProfit,
      upnlLoss,
      upnlProfitPct: pct(upnlProfit, upnlProfit + upnlLoss),
      walletsInProfit: inProfit,
      walletsInLoss: inLoss,
      notionalLong,
      notionalShort,
      longPct: pct(notionalLong, notionalLong + notionalShort),
    },
    markets: [...markets.values()].sort((a, b) => b.notionalLong + b.notionalShort - (a.notionalLong + a.notionalShort)),
    wallets,
    updatedAt: oldest,
  };
}

/** At most `max` points, averaged in equal buckets; the last point kept. */
export function downsample<T extends { t: Date; pctLong: number }>(points: T[], max: number): Array<{ t: Date; pctLong: number }> {
  if (points.length <= max) return points.map(({ t, pctLong }) => ({ t, pctLong }));
  const out: Array<{ t: Date; pctLong: number }> = [];
  for (let i = 0; i < max; i++) {
    const from = Math.floor((i * points.length) / max);
    const to = Math.max(from + 1, Math.floor(((i + 1) * points.length) / max));
    let t = 0;
    let v = 0;
    for (let j = from; j < to; j++) {
      t += points[j].t.getTime();
      v += points[j].pctLong;
    }
    out.push({ t: new Date(t / (to - from)), pctLong: Math.round((10 * v) / (to - from)) / 10 });
  }
  out[out.length - 1] = { t: points[points.length - 1].t, pctLong: points[points.length - 1].pctLong };
  return out;
}
