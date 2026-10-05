import { Inject, Injectable } from "@nestjs/common";
import { retentionState, users } from "@trading-dashboard/shared/database";
import type { RetentionTable } from "@trading-dashboard/shared/contracts";
import { and, asc, eq, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";
import { purgeStatements } from "../users/account-closure.plan.js";

export interface RetentionOutcome {
  status: "ok" | "partial" | "failed";
  removed: Record<string, number>;
  cutoffs: Record<string, string>;
  error: string | null;
  durationMs: number;
}

/**
 * The retention job's lease and its deletes. Every delete removes at most
 * `limit` rows in one statement, oldest first, through an index (see
 * docs/data-retention.md for each plan); nothing here opens a long
 * transaction or locks a table.
 *
 * What is never removed:
 * - an outbox row that is not finished (`pending` / `processing`);
 * - a finished evaluation (`action_outbox`) whose action still has a
 *   delivery waiting, and a finished delivery (`notification_outbox`) whose
 *   action's evaluation is still open: while either side is unfinished the
 *   other is what stops the action from being evaluated or sent twice;
 * - a copy signal row at or above the consumer's checkpoint;
 * - an alert record whose delivery is still queued;
 * - `actions` themselves. Both outboxes reference `actions` (ON DELETE
 *   CASCADE), so deleting an action would take its queue rows with it; this
 *   job deletes queue rows only, which touches nothing else.
 */
@Injectable()
export class RetentionRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  /** Takes the lease when nobody holds a live one. False: another worker is cleaning. */
  async acquire(token: string, leaseMs: number, now: Date): Promise<boolean> {
    await this.db.insert(retentionState).values({ id: 1 }).onConflictDoNothing();
    const rows = await this.db.update(retentionState)
      .set({ leaseToken: token, lockedUntil: new Date(now.getTime() + leaseMs), lastStartedAt: now })
      .where(and(eq(retentionState.id, 1), or(isNull(retentionState.lockedUntil), lt(retentionState.lockedUntil, now))))
      .returning({ id: retentionState.id });
    return rows.length > 0;
  }

  /** Keeps the lease while batches run. False: it expired and someone else took it; stop. */
  async extend(token: string, leaseMs: number, now: Date): Promise<boolean> {
    const rows = await this.db.update(retentionState).set({ lockedUntil: new Date(now.getTime() + leaseMs) })
      .where(and(eq(retentionState.id, 1), eq(retentionState.leaseToken, token))).returning({ id: retentionState.id });
    return rows.length > 0;
  }

  /** Records the run and gives the lease back, in the caller's transaction (with the audit row). */
  async finish(tx: DbTransaction, token: string, at: Date, outcome: RetentionOutcome): Promise<boolean> {
    const rows = await tx.update(retentionState).set({
      leaseToken: null, lockedUntil: null, lastFinishedAt: at, lastStatus: outcome.status,
      removed: outcome.removed, cutoffs: outcome.cutoffs, lastError: outcome.error, durationMs: outcome.durationMs,
    }).where(and(eq(retentionState.id, 1), eq(retentionState.leaseToken, token))).returning({ id: retentionState.id });
    return rows.length > 0;
  }

  async state() {
    const [row] = await this.db.select().from(retentionState).where(eq(retentionState.id, 1));
    return row;
  }

  /** Deletes up to `limit` rows of `table` older than `cutoff`; returns how
   * many (for `deleted_accounts`, how many tombstones were purged). */
  async deleteBatch(table: RetentionTable, cutoff: Date, limit: number): Promise<number> {
    if (table === "deleted_accounts") return this.purgeDeletedAccounts(cutoff, limit);
    const result = await this.db.execute(STATEMENTS[table](cutoff, limit));
    return result.rowCount ?? 0;
  }

  /**
   * Purges up to `limit` account-deletion tombstones deleted before `cutoff`,
   * oldest first, each with every record kept under it, in one transaction
   * per tombstone (users/account-closure.plan.ts, children before parents).
   * A tombstone that can't be purged (a row of someone else still points at
   * one of its records) is left as it was and reported after the others.
   */
  async purgeDeletedAccounts(cutoff: Date, limit: number): Promise<number> {
    const due = await this.db.select({ id: users.id }).from(users)
      .where(and(isNotNull(users.deletedAt), lt(users.deletedAt, cutoff))).orderBy(asc(users.deletedAt), asc(users.id)).limit(limit);
    let purged = 0;
    const failed: number[] = [];
    for (const { id } of due) {
      try {
        await this.db.transaction(async (tx) => {
          for (const { statement } of purgeStatements(id)) await tx.execute(statement);
        });
        purged++;
      } catch {
        failed.push(id);
      }
    }
    if (failed.length) throw new Error(`deleted_accounts: ${failed.length} tombstone(s) could not be purged (first ${failed[0]}); ${purged} purged`);
    return purged;
  }
}

const UNFINISHED = sql`('pending', 'processing')`;

/** The oldest finished evaluations of one status, read in order from
 * (status, available_at): the scan ends after `limit` rows. */
const evaluations = (status: "done" | "failed", cutoff: Date, limit: number) => sql`
  (SELECT o.action_id FROM action_outbox o
    WHERE o.status = ${status} AND o.available_at < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM notification_outbox n WHERE n.action_id = o.action_id AND n.status IN ${UNFINISHED})
    ORDER BY o.available_at LIMIT ${limit})`;
const deliveries = (status: "sent" | "dry_run" | "failed", cutoff: Date, limit: number) => sql`
  (SELECT n.id FROM notification_outbox n
    WHERE n.status = ${status} AND n.available_at < ${cutoff} AND n.created_at < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM action_outbox o WHERE o.action_id = n.action_id AND o.status IN ${UNFINISHED})
    ORDER BY n.available_at LIMIT ${limit})`;
/** The `limit` lowest ids of one status, from (status, id), then those old
 * enough: ids are handed out in time order, so the old rows are the first
 * ones and the scan never goes past `limit` rows. */
const signals = (status: "done" | "failed", cutoff: Date, limit: number) => sql`
  (SELECT t.id FROM (SELECT s.id, coalesce(s.processed_at, s.created_at) AS at FROM copy_signal_outbox s
      WHERE s.status = ${status} AND s.id < coalesce((SELECT min(last_outbox_id) FROM copy_consumer_checkpoints), 0)
      ORDER BY s.id LIMIT ${limit}) t
    WHERE t.at < ${cutoff})`;

/** One bounded, index-driven DELETE per table (plans: docs/data-retention.md).
 * The inner query picks the batch; the outer delete re-checks the status so a
 * row that changed in between is left alone. */
export const STATEMENTS: Record<Exclude<RetentionTable, "deleted_accounts">, (cutoff: Date, limit: number) => SQL> = {
  position_snapshots: (cutoff, limit) => sql`
    DELETE FROM position_snapshots WHERE ctid = ANY (ARRAY(
      SELECT ctid FROM position_snapshots WHERE ts < ${cutoff} ORDER BY ts LIMIT ${limit}))`,
  equity_snapshots: (cutoff, limit) => sql`
    DELETE FROM equity_snapshots WHERE ctid = ANY (ARRAY(
      SELECT ctid FROM equity_snapshots WHERE ts < ${cutoff} ORDER BY ts LIMIT ${limit}))`,
  admin_audit_logs: (cutoff, limit) => sql`
    DELETE FROM admin_audit_logs WHERE id = ANY (ARRAY(
      SELECT id FROM admin_audit_logs WHERE created_at < ${cutoff} AND event <> 'user.delete' ORDER BY created_at LIMIT ${limit}))`,
  account_deletion_records: (cutoff, limit) => sql`
    DELETE FROM admin_audit_logs WHERE id = ANY (ARRAY(
      SELECT id FROM admin_audit_logs WHERE created_at < ${cutoff} AND event = 'user.delete' ORDER BY created_at LIMIT ${limit}))`,
  account_deletion_markers: (cutoff, limit) => sql`
    DELETE FROM account_deletion_markers WHERE digest = ANY (ARRAY(
      SELECT digest FROM account_deletion_markers WHERE deleted_at < ${cutoff} ORDER BY deleted_at LIMIT ${limit}))`,
  action_outbox: (cutoff, limit) => sql`
    DELETE FROM action_outbox WHERE action_id = ANY (ARRAY(
      ${evaluations("done", cutoff, limit)} UNION ALL ${evaluations("failed", cutoff, limit)})) AND status IN ('done', 'failed')`,
  notification_outbox: (cutoff, limit) => sql`
    DELETE FROM notification_outbox WHERE id = ANY (ARRAY(
      ${deliveries("sent", cutoff, limit)} UNION ALL ${deliveries("dry_run", cutoff, limit)} UNION ALL ${deliveries("failed", cutoff, limit)}))
      AND status IN ('sent', 'dry_run', 'failed')`,
  copy_signal_outbox: (cutoff, limit) => sql`
    DELETE FROM copy_signal_outbox WHERE id = ANY (ARRAY(
      ${signals("done", cutoff, limit)} UNION ALL ${signals("failed", cutoff, limit)})) AND status IN ('done', 'failed')`,
  alerts: (cutoff, limit) => sql`
    DELETE FROM alerts WHERE id = ANY (ARRAY(
      (SELECT a.id FROM alerts a WHERE a.sent_at < ${cutoff} ORDER BY a.sent_at DESC NULLS LAST LIMIT ${limit})
      UNION ALL
      (SELECT a.id FROM alerts a
        WHERE a.sent_at IS NULL
          AND (a.action_id IS NULL OR EXISTS (SELECT 1 FROM actions x WHERE x.id = a.action_id AND x.ts < ${cutoff}))
          AND NOT EXISTS (SELECT 1 FROM notification_outbox n WHERE n.action_id = a.action_id AND n.user_id = a.user_id AND n.status IN ${UNFINISHED})
        ORDER BY a.id LIMIT ${limit})))`,
};
