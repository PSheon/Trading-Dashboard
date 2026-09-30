import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, sql } from "drizzle-orm";
import { actions, fills } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";
import type { HlUserFill } from "../hyperliquid/types.js";
import type { ActionDraft } from "./action-classifier.js";
import { actionsCovering, chunks, draftToRow, insertActions, lockActions, storedFills } from "./action-store.js";
import { toFillRow } from "./fill-row.js";
import { enqueueCopySignals, lockCopyLeader } from "../copy/copy-outbox.js";

export type { ActionRow } from "./action-store.js";

/** Raw fills may commit before derivation; replay under the shared action lock repairs gaps. */
@Injectable()
export class FillSyncRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async recentTwap(address: string, cutoff: Date) {
    const [row] = await this.db
      .select({ ts: fills.ts })
      .from(fills)
      .where(
        and(
          eq(fills.chain, CHAIN_DEFAULT),
          eq(fills.address, address),
          gte(fills.ts, cutoff),
          sql`${fills.raw}->>'twapId' is not null`,
        ),
      )
      .limit(1);
    return row;
  }

  /** Chunk inserts to respect bind limits; return tids inserted by this call only.
   * Each chunk commits together with its copy-execution outbox rows (fills
   * of a copied leader), under the copy leader lock. */
  async insertFills(address: string, perps: HlUserFill[]): Promise<Set<bigint>> {
    const insertedTids = new Set<bigint>();
    for (const chunk of chunks(perps)) {
      const inserted = await this.db.transaction(async (tx) => {
        await lockCopyLeader(tx, address);
        const rows = await tx
          .insert(fills)
          .values(chunk.map((f) => toFillRow(address, f)))
          .onConflictDoNothing()
          .returning({ tid: fills.tid, ts: fills.ts });
        await enqueueCopySignals(tx, address, rows);
        return rows;
      });
      for (const r of inserted) insertedTids.add(r.tid);
    }
    return insertedTids;
  }

  /** Same advisory lock as the feed fast path; acquire before checking action coverage. */
  lock(tx: DbTransaction, address: string): Promise<void> {
    return lockActions(tx, address);
  }

  covering(tx: DbTransaction, address: string, tids: bigint[], minTime: number) {
    return actionsCovering(tx, address, tids, minTime);
  }

  storedFills(tx: DbTransaction, address: string, tids: bigint[]) {
    return storedFills(tx, address, tids);
  }

  /** Persist actions and optional delivery intent under the caller's address lock. */
  insertActions(tx: DbTransaction, address: string, drafts: ActionDraft[], enqueue = false,
    equityUsd: number | null = null, maxActionAgeSeconds?: number) {
    return insertActions(tx, address, drafts, enqueue, equityUsd, maxActionAgeSeconds);
  }

  /** Correct the derived shape while preserving the original leverage; do not enqueue alerts. */
  correct(tx: DbTransaction, address: string, id: bigint, draft: ActionDraft) {
    const { leverage: _leverage, ...shape } = draftToRow(address, draft);
    return tx.update(actions).set(shape).where(eq(actions.id, id)).returning();
  }
}
