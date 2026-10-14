import { enqueueBackfills } from "../jobs/backfill-jobs.repository.js";
import { Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  backfillJobs,
  leaderListItems,
  leaderLists,
  leaders,
} from "@trading-dashboard/shared/database";
import {
  CHAIN_DEFAULT,
  type ImportLeaderListRequest,
} from "@trading-dashboard/shared/contracts";

import {
  recordAdminAudit,
  type AuditActor,
} from "../common/audit/admin-audit.js";
import type { DbTransaction } from "../db/unit-of-work.js";

export interface ImportRow {
  address: string;
  rank: number;
  statsJson: Record<string, unknown>;
}

/** Persist a validated list, leader changes and its audit in one caller-owned transaction. */
@Injectable()
export class ImportRepository {
  async inspect(tx: DbTransaction, addresses: string[]) {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '2000ms'`);
    if (!addresses.length) return { existing: [], jobs: [] };
    const existing = await tx
      .select({
        address: leaders.address,
        source: leaders.source,
        active: leaders.active,
        tier: leaders.tier,
      })
      .from(leaders)
      .where(
        and(
          eq(leaders.chain, CHAIN_DEFAULT),
          inArray(leaders.address, addresses),
        ),
      );
    const jobs = await tx
      .select({ address: backfillJobs.address })
      .from(backfillJobs)
      .where(
        and(
          eq(backfillJobs.chain, CHAIN_DEFAULT),
          inArray(backfillJobs.address, addresses),
        ),
      );
    return { existing, jobs };
  }
  /** Existing imported leaders retain manual edits; favorite-only leaders become imported. */
  async save(
    tx: DbTransaction,
    request: Pick<ImportLeaderListRequest, "source" | "fileName">,
    dedupedRows: (ImportRow & { tier: "A" | "B" })[],
    actor: AuditActor,
  ) {
    const [list] = await tx
      .insert(leaderLists)
      .values({ source: request.source, fileName: request.fileName })
      .returning({ id: leaderLists.id });

    await tx.insert(leaderListItems).values(
      dedupedRows.map((row) => ({
        listId: list.id,
        address: row.address,
        rank: row.rank,
        statsJson: row.statsJson,
      })),
    );

    // A2: onConflictDoNothing, so A3 manual edits survive re-imports.
    const inserted = await tx
      .insert(leaders)
      .values(
        dedupedRows.map((row) => ({
          chain: CHAIN_DEFAULT,
          address: row.address,
          active: true,
          tier: row.tier,
        })),
      )
      .onConflictDoNothing({ target: [leaders.chain, leaders.address] })
      .returning({ address: leaders.address });

    // A favorite-sourced leader becomes imported (admins get its alerts; it stays watched)
    // with `active` reset to true; already-imported rows are left alone.
    await tx
      .update(leaders)
      .set({ source: "import", active: true })
      .where(
        and(
          eq(leaders.chain, CHAIN_DEFAULT),
          eq(leaders.source, "favorite"),
          inArray(
            leaders.address,
            dedupedRows.map((row) => row.address),
          ),
        ),
      );

    await enqueueBackfills(
      tx,
      inserted.map((row) => row.address),
      "import",
    );
    await recordAdminAudit(tx, actor, "list.import", String(list.id), null, {
      source: request.source,
      itemCount: dedupedRows.length,
      newAddressCount: inserted.length,
    });
    return {
      listId: list.id,
      itemCount: dedupedRows.length,
      newAddresses: inserted.map((r) => r.address),
    };
  }
}
