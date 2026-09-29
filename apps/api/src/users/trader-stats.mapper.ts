import type { TraderStats, traderStats } from "@trading-dashboard/shared";

type TraderStatsRow = typeof traderStats.$inferSelect;

/** `trader_stats` row (numerics as strings) → the `TraderStats` contract. */
export function toTraderStats(row: TraderStatsRow): TraderStats {
  return {
    address: row.address,
    displayName: row.displayName,
    accountValue: Number(row.accountValue),
    pnl: {
      day: Number(row.pnlDay),
      week: Number(row.pnlWeek),
      month: Number(row.pnlMonth),
      allTime: Number(row.pnlAllTime),
    },
    roi: {
      day: Number(row.roiDay),
      week: Number(row.roiWeek),
      month: Number(row.roiMonth),
      allTime: Number(row.roiAllTime),
    },
    volume: {
      day: Number(row.volumeDay),
      week: Number(row.volumeWeek),
      month: Number(row.volumeMonth),
      allTime: Number(row.volumeAllTime),
    },
    isVault: row.isVault,
    updatedAt: row.updatedAt,
  };
}
