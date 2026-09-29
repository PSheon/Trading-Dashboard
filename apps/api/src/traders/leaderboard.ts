import { traderStats } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

/** Official leaderboard (stats host, not the rate-limited info API). */
export const LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
/** Every vault ever created (≈9.5k, open and closed), same host. */
export const VAULTS_URL = "https://stats-data.hyperliquid.xyz/Mainnet/vaults";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** `GET /Mainnet/vaults` → the set of vault addresses, lowercased. Closed
 * vaults count too: the address is still a vault, not a trader. */
export function parseVaults(payload: unknown): Set<string> {
  if (!Array.isArray(payload)) throw new Error("Vault list payload is not an array");
  const out = new Set<string>();
  for (const entry of payload as Array<{ summary?: { vaultAddress?: unknown } } | null>) {
    const address = entry?.summary?.vaultAddress;
    if (typeof address !== "string") continue;
    const lower = address.trim().toLowerCase();
    if (ADDRESS_RE.test(lower)) out.add(lower);
  }
  return out;
}

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
 * Leaderboard JSON → `trader_stats` rows, all stamped `updatedAt`, with
 * `isVault` from `vaults` (false when not given).
 * Addresses are lowercased and de-duplicated (first wins; one INSERT … ON
 * CONFLICT can't touch the same key twice). Missing windows count as 0.
 * Rows without a valid address are dropped.
 */
export function parseLeaderboard(
  payload: unknown,
  updatedAt: Date,
  vaults?: ReadonlySet<string>,
): TraderStatsInsert[] {
  const rows = (payload as Partial<LeaderboardPayload> | null)?.leaderboardRows;
  if (!Array.isArray(rows)) throw new Error("Leaderboard payload has no leaderboardRows array");

  const out = new Map<string, TraderStatsInsert>();
  for (const row of rows) {
    const address = typeof row?.ethAddress === "string" ? row.ethAddress.trim().toLowerCase() : "";
    if (!ADDRESS_RE.test(address) || out.has(address)) continue;

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
      isVault: vaults?.has(address) ?? false,
      updatedAt,
    });
  }
  return [...out.values()];
}

/** Postgres caps one statement at 65,535 bind parameters; trader_stats has
 * 18 columns, so 2,000 rows (36,000 parameters) per INSERT stays well under. */
export const UPSERT_CHUNK_ROWS = 2_000;

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
