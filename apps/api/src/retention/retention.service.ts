import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { RETENTION_TABLES, type RetentionSettings, type RetentionTable } from "@trading-dashboard/shared/contracts";

import { recordAdminAudit } from "../common/audit/admin-audit.js";
import { UnitOfWork } from "../db/unit-of-work.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { RetentionRepository, type RetentionOutcome } from "./retention.repository.js";

/** Off-peak: 18:00–22:00 UTC is 02:00–06:00 in Taipei, where most users are. */
export const RETENTION_WINDOW_UTC = { fromHour: 18, toHour: 22 } as const;
/** A finished run is not repeated before this (one run a day). */
export const RETENTION_MIN_INTERVAL_MS = 20 * 3_600_000;
const DAY_MS = 86_400_000;

export interface RetentionLimits {
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
}
export const RETENTION_LIMITS: RetentionLimits = { batchSize: 2_000, maxBatchesPerTable: 250, pauseMs: 200, maxRunMs: 20 * 60_000, leaseMs: 5 * 60_000 };

export type RetentionRun =
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
    action_outbox: before(settings.queueDays),
    notification_outbox: before(settings.queueDays),
    copy_signal_outbox: before(settings.queueDays),
    alerts: before(settings.alertDays),
  };
}

export function inRetentionWindow(now: Date): boolean {
  const hour = now.getUTCHours();
  return hour >= RETENTION_WINDOW_UTC.fromHour && hour < RETENTION_WINDOW_UTC.toHour;
}

/**
 * Data retention (review findings 3 and 20; privacy policy §6). Once a day,
 * off-peak, the worker deletes what is older than the periods in
 * `general.retention`:
 *
 * | data | default |
 * | --- | --- |
 * | position and equity snapshots | 90 days |
 * | admin audit log | 1 year |
 * | account-deletion records (`user.delete` audit rows) | 1 year |
 * | finished action / notification / copy-signal outbox rows | 30 days |
 * | alert delivery records (`alerts`) | 30 days |
 *
 * Deletes are bounded (`RETENTION_LIMITS`): a table that has more to remove
 * than one run allows is finished by the next runs ("partial"). A lease row
 * (`retention_state`) keeps two workers from cleaning at once and carries
 * the last run for the admin system page; each run also writes one admin
 * audit entry (`retention.run`) with the rows removed per table.
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
    const settings = (await this.settings.get("general")).retention;
    if (!settings.enabled) return { ran: false, reason: "disabled" };
    if (!force) {
      if (!inRetentionWindow(now)) return { ran: false, reason: "outside_window" };
      const last = (await this.repository.state())?.lastFinishedAt;
      if (last && now.getTime() - last.getTime() < RETENTION_MIN_INTERVAL_MS) return { ran: false, reason: "recent" };
    }
    const token = randomUUID();
    if (!(await this.repository.acquire(token, this.limits.leaseMs, new Date()))) return { ran: false, reason: "leased" };

    const started = Date.now();
    const cutoffs = retentionCutoffs(settings, now);
    const removed: Record<string, number> = {};
    let status: RetentionOutcome["status"] = "ok";
    let error: string | null = null;
    try {
      tables: for (const table of RETENTION_TABLES) {
        removed[table] = 0;
        for (let batches = 0; ; batches++) {
          // Out of time, or shutting down: the next run continues from here.
          if (this.jobs.stopping || Date.now() - started > this.limits.maxRunMs) { status = "partial"; break tables; }
          // This table has had its share of the run; the others still get theirs.
          if (batches >= this.limits.maxBatchesPerTable) { status = "partial"; break; }
          const count = await this.repository.deleteBatch(table, cutoffs[table], this.limits.batchSize);
          removed[table] += count;
          if (count < this.limits.batchSize) break;
          // Another worker took an expired lease: it owns the cleanup now.
          if (!(await this.repository.extend(token, this.limits.leaseMs, new Date()))) throw new Error("lease lost");
          if (this.limits.pauseMs > 0) await delay(this.limits.pauseMs);
        }
      }
    } catch (cause) {
      status = "failed";
      error = (cause as Error).message.slice(0, 300);
      this.logger.error(`Retention failed: ${error}`);
    }
    const outcome: RetentionOutcome = {
      status, removed, error, durationMs: Date.now() - started,
      cutoffs: Object.fromEntries(RETENTION_TABLES.map((table) => [table, cutoffs[table].toISOString()])),
    };
    await this.uow.run(async (tx) => {
      // Only the lease holder records the run; a lost lease writes nothing.
      if (!(await this.repository.finish(tx, token, new Date(), outcome))) return;
      await recordAdminAudit(tx, null, "retention.run", "retention", { settings, cutoffs: outcome.cutoffs }, { status, removed, error, durationMs: outcome.durationMs });
    });
    const total = Object.values(removed).reduce((a, b) => a + b, 0);
    this.logger.log(`Retention ${status}: ${total} rows removed in ${outcome.durationMs} ms (${RETENTION_TABLES.map((t) => `${t} ${removed[t] ?? "-"}`).join(", ")})`);
    return { ran: true, ...outcome };
  }
}
