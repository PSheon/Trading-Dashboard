import { CHAIN_DEFAULT, traderStats } from "@trading-dashboard/shared";

/** Official leaderboard (stats host, not the rate-limited info API). */
export const LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";

interface WindowPerformance {
  pnl?: string | number | null;
  roi?: string | number | null;
  vlm?: string | number | null;
}

/** Shape of `GET /Mainnet/leaderboard` (≈38 MB, ≈46k rows). */
export interface LeaderboardPayload {
  leaderboardRows: Array<{
    ethAddress: string;
    accountValue: string | number | null;
    displayName?: string | null;
    windowPerformances?: Array<[string, WindowPerformance]>;
  }>;
}

export type TraderStatsInsert = typeof traderStats.$inferInsert;

/** Decimal string for a numeric column; anything unparseable or non-finite
 * becomes "0" so one odd row can't fail the whole import. */
function decimal(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? String(n) : "0";
}

/**
 * Leaderboard JSON → `trader_stats` rows, all stamped `updatedAt`.
 * Addresses are lowercased and de-duplicated (first wins; one INSERT … ON
 * CONFLICT can't touch the same key twice). Missing windows count as 0.
 * Rows without a valid address are dropped.
 */
export function parseLeaderboard(payload: unknown, updatedAt: Date): TraderStatsInsert[] {
  const rows = (payload as Partial<LeaderboardPayload> | null)?.leaderboardRows;
  if (!Array.isArray(rows)) throw new Error("Leaderboard payload has no leaderboardRows array");

  const out = new Map<string, TraderStatsInsert>();
  for (const row of rows) {
    const address = typeof row?.ethAddress === "string" ? row.ethAddress.trim().toLowerCase() : "";
    if (!/^0x[0-9a-f]{40}$/.test(address) || out.has(address)) continue;

    const windows = new Map<string, WindowPerformance>();
    for (const entry of row.windowPerformances ?? []) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && entry[1]) windows.set(entry[0], entry[1]);
    }
    const w = (name: string, field: keyof WindowPerformance) => decimal(windows.get(name)?.[field] ?? 0);
    const displayName = typeof row.displayName === "string" ? row.displayName.trim() : "";

    out.set(address, {
      chain: CHAIN_DEFAULT,
      address,
      displayName: displayName || null,
      accountValue: decimal(row.accountValue),
      pnlDay: w("day", "pnl"),
      pnlWeek: w("week", "pnl"),
      pnlMonth: w("month", "pnl"),
      pnlAllTime: w("allTime", "pnl"),
      roiDay: w("day", "roi"),
      roiWeek: w("week", "roi"),
      roiMonth: w("month", "roi"),
      roiAllTime: w("allTime", "roi"),
      volumeDay: w("day", "vlm"),
      volumeWeek: w("week", "vlm"),
      volumeMonth: w("month", "vlm"),
      volumeAllTime: w("allTime", "vlm"),
      updatedAt,
    });
  }
  return [...out.values()];
}

/** Postgres caps one statement at 65,535 bind parameters; trader_stats has
 * 17 columns, so 2,000 rows (34,000 parameters) per INSERT stays well under. */
export const UPSERT_CHUNK_ROWS = 2_000;

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
