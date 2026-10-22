import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { leaderboardImports, traderStats } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";
import { upsertChanged } from "../db/upsert-changed.js";
import { chunk, UPSERT_CHUNK_ROWS, type TraderStatsInsert } from "./leaderboard.js";
import { LEADERBOARD_AS_OF_SQL } from "./trader-stats-as-of.js";

/** The figures an import compares and writes (not the key, not `updated_at`). */
const FIGURES = [
  traderStats.displayName, traderStats.accountValue,
  traderStats.pnlDay, traderStats.pnlWeek, traderStats.pnlMonth, traderStats.pnlAllTime,
  traderStats.roiDay, traderStats.roiWeek, traderStats.roiMonth, traderStats.roiAllTime,
  traderStats.volumeDay, traderStats.volumeWeek, traderStats.volumeMonth, traderStats.volumeAllTime,
] as const;

/** Persist leaderboard generations; network fetch, freshness and empty-import policy stay in the service. */
@Injectable()
export class LeaderboardIngestRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  /** When the last import landed, or null while the table is empty. */
  async lastImportAt(): Promise<Date | null> {
    const { rows } = await this.db.execute<{ at: string | Date | null }>(sql.raw(`SELECT ${LEADERBOARD_AS_OF_SQL} AS at`));
    const at = rows[0]?.at;
    return at === null || at === undefined ? null : new Date(at);
  }

  /**
   * Upsert and prune one chain in the caller's transaction; preserve existing
   * vault flags on fetch failure. A row whose figures (and vault flag, when
   * updated) are unchanged is not written: it keeps its `updated_at`, and the
   * import's time goes to `leaderboard_imports`.
   */
  async replaceAll(tx: DbTransaction, rows: TraderStatsInsert[], importedAt: Date, updateVaultFlags: boolean): Promise<number> {
    const compared = updateVaultFlags ? [...FIGURES, traderStats.isVault] : [...FIGURES];
    for (const part of chunk(rows, UPSERT_CHUNK_ROWS)) {
      await tx
        .insert(traderStats)
        .values(part)
        .onConflictDoUpdate({
          target: [traderStats.chain, traderStats.address],
          set: {
            displayName: sql`excluded.display_name`,
            accountValue: sql`excluded.account_value`,
            pnlDay: sql`excluded.pnl_day`,
            pnlWeek: sql`excluded.pnl_week`,
            pnlMonth: sql`excluded.pnl_month`,
            pnlAllTime: sql`excluded.pnl_all_time`,
            roiDay: sql`excluded.roi_day`,
            roiWeek: sql`excluded.roi_week`,
            roiMonth: sql`excluded.roi_month`,
            roiAllTime: sql`excluded.roi_all_time`,
            volumeDay: sql`excluded.volume_day`,
            volumeWeek: sql`excluded.volume_week`,
            volumeMonth: sql`excluded.volume_month`,
            volumeAllTime: sql`excluded.volume_all_time`,
            ...(updateVaultFlags ? { isVault: sql`excluded.is_vault` } : {}),
            updatedAt: sql`excluded.updated_at`,
          },
          setWhere: upsertChanged(compared),
        });
    }
    // An unchanged row keeps an older updated_at, so what this import did not
    // list is found by address (one array parameter).
    const listed = rows.map((row) => row.address);
    const removed = await tx
      .delete(traderStats)
      .where(and(eq(traderStats.chain, CHAIN_DEFAULT), sql`not (${traderStats.address} = any(${sql.param(listed)}::text[]))`))
      .returning({ address: traderStats.address });
    await tx.insert(leaderboardImports).values({ chain: CHAIN_DEFAULT, importedAt })
      .onConflictDoUpdate({ target: leaderboardImports.chain, set: { importedAt } });
    return removed.length;
  }
}
