import { Inject, Injectable } from "@nestjs/common";
import { and, eq, max, ne, sql } from "drizzle-orm";
import { traderStats } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";
import { chunk, UPSERT_CHUNK_ROWS, type TraderStatsInsert } from "./leaderboard.js";

/** Persist leaderboard generations; network fetch, freshness and empty-import policy stay in the service. */
@Injectable()
export class LeaderboardIngestRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async lastImportAt(): Promise<Date | null> {
    const [row] = await this.db
      .select({ at: max(traderStats.updatedAt) })
      .from(traderStats)
      .where(eq(traderStats.chain, CHAIN_DEFAULT));
    return row?.at ?? null;
  }

  /** Upsert and prune one chain in the caller's transaction; preserve existing vault flags on fetch failure. */
  async replaceAll(tx: DbTransaction, rows: TraderStatsInsert[], importedAt: Date, updateVaultFlags: boolean): Promise<number> {
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
        });
    }
    const removed = await tx
      .delete(traderStats)
      .where(and(eq(traderStats.chain, CHAIN_DEFAULT), ne(traderStats.updatedAt, importedAt)))
      .returning({ address: traderStats.address });
    return removed.length;
  }
}
