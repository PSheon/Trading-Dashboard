import { sql } from "drizzle-orm";
import { traderStats } from "@trading-dashboard/shared/database";

/**
 * When a `trader_stats` row's figures were last confirmed: its chain's last
 * import (`leaderboard_imports`; an import deletes every row it did not list),
 * or the row's own `updated_at` (when its figures last changed: an import
 * leaves an unchanged row alone since 2026-10-22) if that is later, as on a
 * database the previous release imported into. Null for a missing row (a left
 * join). Every reader of a row's "as of" time reads this, not `updated_at`.
 */
export const traderStatsAsOf = sql<Date>`greatest(${traderStats.updatedAt}, (select li.imported_at from leaderboard_imports li where li.chain = ${traderStats.chain}))`
  .mapWith(traderStats.updatedAt);

/** The same for the whole `hyperliquid` leaderboard, for raw SQL readers:
 * null while it holds no row. */
export const LEADERBOARD_AS_OF_SQL = `(SELECT CASE WHEN count(*) = 0 THEN NULL ELSE greatest(max(s.updated_at),
  (SELECT li.imported_at FROM leaderboard_imports li WHERE li.chain = 'hyperliquid')) END FROM trader_stats s WHERE s.chain = 'hyperliquid')`;
