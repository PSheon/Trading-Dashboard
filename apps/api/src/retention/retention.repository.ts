import { Inject, Injectable } from "@nestjs/common";
import { retentionState, users } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT, type RetentionTable } from "@trading-dashboard/shared/contracts";
import { and, asc, eq, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";
import { purgeDetachedReferences, purgeStatements } from "../users/account-closure.plan.js";
import { COPIED_LEADERS, LEGACY_FILLS_TABLE, inIndexOrder, unreferencedAccount } from "../traders/history-fill.store.js";

export interface RetentionOutcome {
  status: "ok" | "partial" | "failed";
  removed: Record<string, number>;
  cutoffs: Record<string, string>;
  error: string | null;
  durationMs: number;
  /** The `history_fills` sweep of this run; absent when it did not run. */
  history?: HistorySweep;
}

/** What one run's `history_fills` sweep did. `complete`: every account is
 * below `cut` (the next sweep is due when the cut moves, the next day).
 * `batch`: the statement size it ended at (adaptive); `timeouts`: statements
 * cancelled by statement_timeout (each halved the batch and was retried). */
export interface HistorySweep {
  cut: string;
  removed: number;
  complete: boolean;
  batch: number;
  timeouts: number;
}

/**
 * The retention job's lease and deletes: each delete removes at most `limit` rows in one
 * index-driven statement (plans: docs/data-retention.md); no long transaction, no table lock.
 *
 * Never removed:
 * - an unfinished outbox row (`pending` / `processing`);
 * - an evaluation whose delivery is unfinished, or a delivery whose evaluation is open
 *   (the other side is what stops a double evaluate/send);
 * - a copy signal at or above the consumer checkpoint; an alert whose delivery is queued;
 * - a Hyperliquid socket lease not yet closed (it still reserves capacity);
 * - `actions` (both outboxes cascade from them);
 * - a live copy's valuations (only paper copies' are thinned), and of a paper
 *   copy's, the first and last of every hour;
 * - a cohort history row (only its member list is cleared);
 * - an account's latest follower observation, and any observation a row
 *   still references.
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
      ...sweptTo(outcome.history),
    }).where(and(eq(retentionState.id, 1), eq(retentionState.leaseToken, token))).returning({ id: retentionState.id });
    return rows.length > 0;
  }

  /** Gives the lease back after a run that only continued the history sweep:
   * the last full run's record (what the admin page shows) stays as it is. */
  async finishSweep(tx: DbTransaction, token: string, sweep: HistorySweep | undefined): Promise<boolean> {
    const rows = await tx.update(retentionState).set({ leaseToken: null, lockedUntil: null, ...sweptTo(sweep) })
      .where(and(eq(retentionState.id, 1), eq(retentionState.leaseToken, token))).returning({ id: retentionState.id });
    return rows.length > 0;
  }

  /** False while stored fills are still in the raw layout (`history:convert`
   * not finished): the sweep's reference checks would not see them right. */
  async historyConverted(): Promise<boolean> {
    const result = await this.db.execute<{ pending: boolean }>(sql`SELECT to_regclass(${`public.${LEGACY_FILLS_TABLE}`}) IS NOT NULL AS pending`);
    return result.rows[0]?.pending !== true;
  }

  /**
   * Before any history row is deleted, in one transaction: the archive's
   * floor becomes `cut` (no backfill pass reads below it, no span is
   * extended below it), and every span starting before it starts at it
   * (one wholly before it is emptied, and the live cursor starts it again),
   * so nothing is reported as held that is being deleted. A copied leader's
   * span is left whole, as its fills are.
   */
  async retainHistoryFrom(cut: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO archive_ingest_state (chain, retained_from) VALUES (${CHAIN_DEFAULT}, ${cut})
        ON CONFLICT (chain) DO UPDATE SET retained_from = excluded.retained_from`);
      await tx.execute(sql`
        UPDATE archive_coverage SET
          covered_from = CASE WHEN covered_through > ${cut} THEN ${cut}::timestamptz END,
          covered_through = CASE WHEN covered_through > ${cut} THEN covered_through END
        WHERE chain = ${CHAIN_DEFAULT} AND covered_from < ${cut} AND address NOT IN ${COPIED_LEADERS}`);
    });
  }

  /**
   * One bounded statement of the history sweep: deletes at most `limit`
   * rows of `history_fills`, oldest first, from the accounts at or after
   * `fromAccount` in id order: those before `cut`, and every row of an
   * account nothing refers to any more (no history job, no active archive
   * coverage). Copied leaders are never touched. Each account's rows are
   * found through `history_fills_account_time_idx`; an account with none
   * costs one index probe (see `inIndexOrder`). `last`: the highest account the statement
   * reached (the next one starts there); fewer than `limit` rows: the sweep
   * reached the end.
   */
  async deleteHistoryBatch(cut: Date, fromAccount: number, limit: number): Promise<{ removed: number; last: number | null }> {
    const result = await inIndexOrder<{ removed: number; last: number | null }>(this.db, sql`
      WITH doomed AS (
        SELECT f.ctid AS row
        FROM (
          SELECT h.id, CASE WHEN ${unreferencedAccount(sql`h`)} THEN 'infinity'::timestamptz ELSE ${cut}::timestamptz END AS below
          FROM history_accounts h
          WHERE h.id >= ${fromAccount} AND h.chain = ${CHAIN_DEFAULT} AND h.address NOT IN ${COPIED_LEADERS}
          ORDER BY h.id
          OFFSET 0
        ) a
        CROSS JOIN LATERAL (
          SELECT x.ctid FROM history_fills x WHERE x.account_id = a.id AND x.time < a.below ORDER BY x.time LIMIT ${limit}
        ) f
        ORDER BY a.id
        LIMIT ${limit}
      ), gone AS (
        DELETE FROM history_fills WHERE ctid = ANY (ARRAY(SELECT row FROM doomed)) RETURNING account_id
      )
      SELECT count(*)::int AS removed, max(account_id) AS last FROM gone`);
    const row = result.rows[0];
    return { removed: Number(row?.removed ?? 0), last: row?.last === null || row?.last === undefined ? null : Number(row.last) };
  }

  async state() {
    const [row] = await this.db.select().from(retentionState).where(eq(retentionState.id, 1));
    return row;
  }

  /** Deletes up to `limit` rows of `table` older than `cutoff`; returns how
   * many (for `deleted_accounts`, how many tombstones were purged; for
   * `cohort_snapshot_members`, how many member lists were cleared). `now` is
   * the run's time (`cutoff` of a stopped paper copy's valuations is its stop's). */
  async deleteBatch(table: RetentionTable, cutoff: Date, limit: number, now = new Date()): Promise<number> {
    if (table === "deleted_accounts") return this.purgeDeletedAccounts(cutoff, limit);
    const result = await this.db.execute(STATEMENTS[table](cutoff, limit, now));
    return result.rowCount ?? 0;
  }

  /** Purges up to `limit` tombstones older than `cutoff` with their kept records, one
   * transaction each. One that can't be purged (a foreign row still points in) is left
   * and reported after the others. */
  async purgeDeletedAccounts(cutoff: Date, limit: number): Promise<number> {
    const due = await this.db.select({ id: users.id }).from(users)
      .where(and(isNotNull(users.deletedAt), lt(users.deletedAt, cutoff))).orderBy(asc(users.deletedAt), asc(users.id)).limit(limit);
    let purged = 0;
    const failed: number[] = [];
    for (const { id } of due) {
      try {
        await this.db.transaction(async (tx) => {
          for (const statement of Object.values(purgeDetachedReferences(id, cutoff))) await tx.execute(statement);
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

/** The `history_cut` a sweep moves the state to: its cut once complete. */
function sweptTo(sweep: HistorySweep | undefined): { historyCut?: Date } {
  return sweep?.complete ? { historyCut: new Date(sweep.cut) } : {};
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
/** The `limit` lowest ids of one status, then those old enough: ids are time-ordered,
 * so the scan never goes past `limit` rows. */
const signals = (status: "done" | "failed", cutoff: Date, limit: number) => sql`
  (SELECT t.id FROM (SELECT s.id, coalesce(s.processed_at, s.created_at) AS at FROM copy_signal_outbox s
      WHERE s.status = ${status} AND s.id < coalesce((SELECT min(last_outbox_id) FROM copy_consumer_checkpoints), 0)
      ORDER BY s.id LIMIT ${limit}) t
    WHERE t.at < ${cutoff})`;

/** One bounded, index-driven DELETE per table (plans: docs/data-retention.md).
 * The inner query picks the batch; the outer delete re-checks the status so a
 * row that changed in between is left alone. */
export const STATEMENTS: Record<Exclude<RetentionTable, "deleted_accounts">, (cutoff: Date, limit: number, now?: Date) => SQL> = {
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
  hyperliquid_ws_leases: (cutoff, limit) => sql`
    DELETE FROM hyperliquid_ws_leases WHERE id = ANY (ARRAY(
      SELECT id FROM hyperliquid_ws_leases WHERE state = 'closed' AND closed_at < ${cutoff} ORDER BY closed_at LIMIT ${limit}))
      AND state = 'closed'`,
  // A paper copy's valuations before its horizon (`cutoff` for a running copy, as far before
  // its stop for a stopped one, floored to the hour), other than the first and last of their
  // UTC hour; read per copy through the primary key. The api reads them with
  // COPY_EQUITY_THINNED_FRESH_MS (copy-runtime.repository.ts). Live copies' are never thinned.
  copy_equity_snapshots: (cutoff, limit, now = new Date()) => sql`
    DELETE FROM copy_equity_snapshots WHERE (strategy_id, "time") IN (
      SELECT c.strategy_id, c."time" FROM copy_strategies s
      CROSS JOIN LATERAL (
        SELECT c.strategy_id, c."time" FROM copy_equity_snapshots c
        WHERE c.strategy_id = s.id
          AND c."time" < date_trunc('hour', least(${cutoff}::timestamptz, s.stopped_at - make_interval(secs => ${(now.getTime() - cutoff.getTime()) / 1000}::double precision)), 'UTC')
          AND EXISTS (SELECT 1 FROM copy_equity_snapshots p WHERE p.strategy_id = c.strategy_id
            AND p."time" >= date_trunc('hour', c."time", 'UTC') AND p."time" < c."time")
          AND EXISTS (SELECT 1 FROM copy_equity_snapshots n WHERE n.strategy_id = c.strategy_id
            AND n."time" > c."time" AND n."time" < date_trunc('hour', c."time", 'UTC') + interval '1 hour')
        ORDER BY c."time" LIMIT ${limit}) c
      WHERE s.mode = 'paper'
      LIMIT ${limit})`,
  // Clears the member list of old cohort history rows (no reader uses it: the chart reads the
  // figures and membership_version, which stay). A small table (a row per tier every 40 min)
  // read whole: a toasted list is not opened by IS NOT NULL.
  cohort_snapshot_members: (cutoff, limit) => sql`
    UPDATE cohort_snapshots SET member_addresses = NULL WHERE id = ANY (ARRAY(
      SELECT id FROM cohort_snapshots WHERE ts < ${cutoff} AND member_addresses IS NOT NULL LIMIT ${limit}))
      AND member_addresses IS NOT NULL`,
  // A live account's observations older than `cutoff` except its latest (the only one read,
  // copy_follower_observation_jobs.latest_observation_id, ON DELETE RESTRICT); per account,
  // through copy_follower_observations_history_idx. The outer check spares any referenced one.
  copy_follower_observations: (cutoff, limit) => sql`
    DELETE FROM copy_follower_observations WHERE id = ANY (ARRAY(
      SELECT o.id FROM copy_execution_accounts a
      CROSS JOIN LATERAL (
        SELECT o.id FROM copy_follower_observations o
        WHERE o.account_id = a.id AND o.observed_at < ${cutoff}
          AND o.id IS DISTINCT FROM (SELECT j.latest_observation_id FROM copy_follower_observation_jobs j WHERE j.account_id = a.id)
        ORDER BY o.observed_at LIMIT ${limit}) o
      LIMIT ${limit}))
      AND NOT EXISTS (SELECT 1 FROM copy_follower_observation_jobs j WHERE j.latest_observation_id = copy_follower_observations.id)`,
};
