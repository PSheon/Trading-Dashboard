import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { RETENTION_TABLES, type RetentionSettings, type RetentionTable } from "@trading-dashboard/shared/contracts";

import { recordAdminAudit } from "../common/audit/admin-audit.js";
import { UnitOfWork } from "../db/unit-of-work.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { safeErrorText } from "../runtime/safe-error-text.js";
import { SettingsService } from "../settings/settings.service.js";
import { RetentionRepository, type HistorySweep, type RetentionOutcome } from "./retention.repository.js";
import { DAY_MS } from "../config/constants/time.js";
import {
  CLOSED_WS_LEASE_RETENTION_MS, HISTORY_RETENTION_BATCH_CAP, HISTORY_RETENTION_BATCH_FLOOR, HISTORY_RETENTION_BATCH_LIMIT, HISTORY_RETENTION_TARGET_MS,
  RETENTION_MIN_INTERVAL_MS,
} from '../config/constants/background.js';
import { QUERY_CANCELED, sqlState } from "../db/sql-state.js";

/** Off-peak: 18:00–22:00 UTC is 02:00–06:00 in Taipei, where most users are. */
const RETENTION_WINDOW_UTC = { fromHour: 18, toHour: 22 } as const;

interface RetentionLimits {
  /** Rows per DELETE statement. */
  batchSize: number;
  /** DELETE statements per table per run; the rest waits for the next run. */
  maxBatchesPerTable: number;
  /** Pause between statements, so the job never holds the database's attention. */
  pauseMs: number;
  /** The whole run stops after this, finished or not. */
  maxRunMs: number;
  /** The lease lasts this long past the last statement. */
  leaseMs: number;
  /** `history_fills` rows of the history sweep's first DELETE statement in a run. */
  historyBatchSize: number;
  /** The sweep's statement size adapts between these. */
  historyBatchFloor: number;
  historyBatchCap: number;
  /** Faster than half of this: the batch grows by a quarter; slower: it halves. */
  historyTargetMs: number;
}
const RETENTION_LIMITS: RetentionLimits = {
  batchSize: 2_000, maxBatchesPerTable: 250, pauseMs: 200, maxRunMs: 20 * 60_000, leaseMs: 5 * 60_000,
  historyBatchSize: HISTORY_RETENTION_BATCH_LIMIT, historyBatchFloor: HISTORY_RETENTION_BATCH_FLOOR, historyBatchCap: HISTORY_RETENTION_BATCH_CAP,
  historyTargetMs: HISTORY_RETENTION_TARGET_MS,
};

type RetentionRun =
  | { ran: false; reason: "disabled" | "outside_window" | "recent" | "leased" | "stopping" }
  | ({ ran: true } & RetentionOutcome);

/** The cutoff of every table for these settings at `now`. */
export function retentionCutoffs(settings: RetentionSettings, now: Date): Record<RetentionTable, Date> {
  const before = (days: number) => new Date(now.getTime() - days * DAY_MS);
  return {
    position_snapshots: before(settings.snapshotDays),
    equity_snapshots: before(settings.snapshotDays),
    admin_audit_logs: before(settings.auditDays),
    account_deletion_records: before(settings.accountDeletionDays),
    deleted_accounts: before(settings.accountDeletionDays),
    account_deletion_markers: before(settings.accountDeletionDays),
    action_outbox: before(settings.queueDays),
    notification_outbox: before(settings.queueDays),
    copy_signal_outbox: before(settings.queueDays),
    alerts: before(settings.alertDays),
    hyperliquid_ws_leases: new Date(now.getTime() - CLOSED_WS_LEASE_RETENTION_MS),
    // A running copy's; a stopped one's is as far before its stop (the statement).
    copy_equity_snapshots: before(settings.copyEquityFullDays),
    cohort_snapshot_members: before(settings.cohortMemberListDays),
    copy_follower_observations: before(settings.followerObservationDays),
  };
}

/** The `history_fills` cut for `days` at `now`: the start of the UTC day
 * `days` days back (a day boundary, so archive spans stay on whole hours and
 * the cut moves once a day). */
export function historyRetentionCut(now: Date, days: number): Date {
  return new Date(Math.floor((now.getTime() - days * DAY_MS) / DAY_MS) * DAY_MS);
}

export function inRetentionWindow(now: Date): boolean {
  const hour = now.getUTCHours();
  return hour >= RETENTION_WINDOW_UTC.fromHour && hour < RETENTION_WINDOW_UTC.toHour;
}

/**
 * Data retention (review 3, 20; privacy policy §6): once a day, off-peak, the worker
 * deletes what is older than RETENTION_* (deploy-time):
 *
 * | data | default |
 * | --- | --- |
 * | position and equity snapshots | 90 days |
 * | admin audit log | 1 year |
 * | account-deletion records (`user.delete` audit rows) | 1 year |
 * | deleted accounts' kept records (tombstones, docs/account-deletion.md) | 1 year after deletion |
 * | deleted identities' keyed hashes (account_deletion_markers) | 1 year after deletion |
 * | finished action / notification / copy-signal outbox rows | 30 days |
 * | alert delivery records (`alerts`) | 30 days |
 * | closed Hyperliquid socket leases (`hyperliquid_ws_leases`) | 1 day after closing (fixed) |
 * | a paper copy's per-minute valuations (`copy_equity_snapshots`), thinned to an hour's first and last | 31 days before its end |
 * | cohort history rows' member lists (`cohort_snapshot_members`; the rows stay) | 30 days |
 * | a live account's superseded follower observations (never its latest) | 7 days |
 * | traders' stored fill history (`history_fills`) | 90 days (`RETENTION_HISTORY_FILL_DAYS`) |
 *
 * Deletes are bounded (`RETENTION_LIMITS`); leftovers wait for the next run ("partial").
 * A lease row (`retention_state`) keeps two workers apart; each run is audited (`retention.run`).
 *
 * `history_fills` (~2 M rows a day) has its own sweep after the tables: it
 * first moves the archive's floor and spans to the cut (nothing is reported
 * held that is being deleted), then deletes the rows below it account by
 * account, pausing as long as each statement took. A sweep the run's time
 * cut short is continued by the window's later ticks until it reaches the
 * day's cut (`retention_state.history_cut`), without repeating the tables.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);
  private flight: Promise<RetentionRun> | undefined;
  /** Settable for tests. */
  limits: RetentionLimits = RETENTION_LIMITS;

  constructor(
    private readonly repository: RetentionRepository,
    private readonly settings: SettingsService,
    private readonly uow: UnitOfWork,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
  ) {}

  /** The scheduled entry: runs only in the window and at most once a day. */
  tick(now = new Date()): Promise<RetentionRun> {
    return this.run(now, false);
  }

  /** `force` skips the window and the once-a-day rule (tests, an operator's script). */
  run(now = new Date(), force = false): Promise<RetentionRun> {
    this.flight ??= this.jobs.run(() => this.runOnce(now, force)).finally(() => { this.flight = undefined; });
    return this.flight;
  }

  private async runOnce(now: Date, force: boolean): Promise<RetentionRun> {
    if (this.jobs.stopping) return { ran: false, reason: "stopping" };
    const settings = this.settings.tuning.retention;
    if (!settings.enabled) return { ran: false, reason: "disabled" };
    const historyCut = historyRetentionCut(now, settings.historyFillDays);
    // The tables: once a day. The history sweep: until it reaches today's cut.
    let tablesDue = true;
    if (!force) {
      if (!inRetentionWindow(now)) return { ran: false, reason: "outside_window" };
      const state = await this.repository.state();
      const last = state?.lastFinishedAt;
      tablesDue = !(last && now.getTime() - last.getTime() < RETENTION_MIN_INTERVAL_MS);
      const sweepDue = !state?.historyCut || state.historyCut.getTime() < historyCut.getTime();
      if (!tablesDue && !sweepDue) return { ran: false, reason: "recent" };
    }
    const token = randomUUID();
    if (!(await this.repository.acquire(token, this.limits.leaseMs, new Date()))) return { ran: false, reason: "leased" };

    const started = Date.now();
    const cutoffs = tablesDue ? retentionCutoffs(settings, now) : undefined;
    const removed: Record<string, number> = {};
    let history: HistorySweep | undefined;
    let status: RetentionOutcome["status"] = "ok";
    let error: string | null = null;
    try {
      if (cutoffs) tables: for (const table of RETENTION_TABLES) {
        removed[table] = 0;
        for (let batches = 0; ; batches++) {
          // Out of time, or shutting down: the next run continues from here.
          if (this.jobs.stopping || Date.now() - started > this.limits.maxRunMs) { status = "partial"; break tables; }
          // This table has had its share of the run; the others still get theirs.
          if (batches >= this.limits.maxBatchesPerTable) { status = "partial"; break; }
          const count = await this.repository.deleteBatch(table, cutoffs[table], this.limits.batchSize, now);
          removed[table] += count;
          if (count < this.limits.batchSize) break;
          // Another worker took an expired lease: it owns the cleanup now.
          if (!(await this.repository.extend(token, this.limits.leaseMs, new Date()))) throw new Error("lease lost");
          if (this.limits.pauseMs > 0) await delay(this.limits.pauseMs);
        }
      }
      if (!this.jobs.stopping && Date.now() - started <= this.limits.maxRunMs) {
        history = { cut: historyCut.toISOString(), removed: 0, complete: false, batch: this.limits.historyBatchSize, timeouts: 0 };
        await this.sweepHistory(token, historyCut, started, history);
      }
      // A sweep cut short is continued by the next tick (see `history_cut`).
      if (!cutoffs && !history?.complete) status = "partial";
    } catch (cause) {
      status = "failed";
      error = (cause as Error).message.slice(0, 300);
      this.logger.error(`Retention failed: ${safeErrorText(cause)}`);
    }
    const outcome: RetentionOutcome = {
      status, removed, error, durationMs: Date.now() - started, history,
      cutoffs: cutoffs ? Object.fromEntries(RETENTION_TABLES.map((table) => [table, cutoffs[table].toISOString()])) : {},
    };
    await this.uow.run(async (tx) => {
      // Only the lease holder records the run; a lost lease writes nothing.
      // A run that only continued the sweep leaves the last full run's record.
      if (!(await (cutoffs ? this.repository.finish(tx, token, new Date(), outcome) : this.repository.finishSweep(tx, token, history)))) return;
      await recordAdminAudit(tx, null, "retention.run", "retention", { settings, cutoffs: outcome.cutoffs, historyCut: historyCut.toISOString() }, { status, removed, error, durationMs: outcome.durationMs, history: history ?? null });
    });
    const total = Object.values(removed).reduce((a, b) => a + b, 0);
    const swept = history ? `; history_fills ${history.removed} below ${history.cut}${history.complete ? "" : " (continues)"}` : "";
    this.logger.log(`Retention ${status}: ${total} rows removed in ${outcome.durationMs} ms (${cutoffs ? RETENTION_TABLES.map((t) => `${t} ${removed[t] ?? "-"}`).join(", ") : "tables done today"}${swept})`);
    return { ran: true, ...outcome };
  }

  /**
   * The history sweep (see the class comment): the cut first, then bounded
   * deletes in account order until one comes back short (`complete`), the
   * run's time is up or the process stops. After each statement it waits as
   * long as the statement took (at least `pauseMs`), so it never holds the
   * database more than half the time. Progress is written to `sweep` as it
   * goes, so a failure still reports what was removed.
   *
   * The statement size adapts (a cold heap reads a page per row): a
   * statement cancelled by statement_timeout rolled back whole, so the batch
   * halves and the same rows are tried again, down to `historyBatchFloor`
   * (a timeout there fails the run; the next tick retries). A statement
   * slower than `historyTargetMs` halves it too; one faster than half of it
   * grows it by a quarter, up to `historyBatchCap`.
   */
  private async sweepHistory(token: string, cut: Date, started: number, sweep: HistorySweep): Promise<void> {
    if (!(await this.repository.historyConverted())) return;
    await this.repository.retainHistoryFrom(cut);
    const { historyBatchFloor: floor, historyBatchCap: cap, historyTargetMs: target } = this.limits;
    let size = Math.min(cap, Math.max(floor, this.limits.historyBatchSize));
    sweep.batch = size;
    for (let from = 0; ;) {
      if (this.jobs.stopping || Date.now() - started > this.limits.maxRunMs) return;
      const statementStarted = Date.now();
      let batch: { removed: number; last: number | null } | undefined;
      try {
        batch = await this.repository.deleteHistoryBatch(cut, from, size);
      } catch (error) {
        if (sqlState(error) !== QUERY_CANCELED || size <= floor) throw error;
        sweep.timeouts += 1;
      }
      const took = Date.now() - statementStarted;
      if (batch) {
        sweep.removed += batch.removed;
        if (batch.removed < size) {
          sweep.complete = true;
          return;
        }
        from = batch.last ?? from;
      }
      if (!batch || took > target) size = Math.max(floor, Math.floor(size / 2));
      else if (took < target / 2) size = Math.min(cap, size + Math.max(1, Math.floor(size / 4)));
      sweep.batch = size;
      if (!(await this.repository.extend(token, this.limits.leaseMs, new Date()))) throw new Error("lease lost");
      await delay(Math.max(this.limits.pauseMs, took));
    }
  }
}
