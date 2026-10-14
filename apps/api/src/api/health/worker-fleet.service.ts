import { Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { workerMonitorSchema, type HeartbeatResponse, type WorkerAlert } from "@trading-dashboard/shared/contracts";
import type { z } from "zod";

import { AppConfig } from "../../config/app-config.js";
import { terminalSettlementApplies } from "../../copy/live-worker/copy-live-api-settlement.service.js";
import { workerCallHeaders, workerMonitorKey } from "../../runtime/worker-calls.js";
import { runsCopy, runsRead } from "../../runtime/worker-role.js";

/** How long the api waits for a copy worker heartbeat that reports the
 * terminal settlement loop on, while its own loop is off. */
export const SETTLEMENT_OWNER_WINDOW_MS = 2 * 60_000;
/** Snapshots run every 5 minutes (SchedulerService.snapshotAll): three
 * missed runs make them stale. */
export const SNAPSHOT_STALE_MS = 15 * 60_000;
/** How often the api reads the workers on its own for its guards. */
export const WORKER_GUARD_CHECK_MS = 30_000;
/** One ALERT log line per condition at most this often. */
export const WORKER_ALERT_EVERY_MS = 10 * 60_000;

/**
 * What the `read` worker owns in a heartbeat once the roles are split: the
 * scheduler's snapshots and sweeps, discovery, the archive ingest and
 * Telegram (its dry run). The rest (feed, fills, budgets, the wallet
 * network's meter lanes, explorer, clock) is the `copy` worker's.
 */
export const READ_HEARTBEAT_FIELDS = ["lastSnapshotAt", "lastSnapshotAttemptAt", "lastSnapshotFailureAt", "lastSweepAt", "discovery", "archive", "dryRun"] as const;

export type WorkerMonitorSample = z.infer<typeof workerMonitorSchema>;
type WireHeartbeat = NonNullable<WorkerMonitorSample["heartbeat"]>;
/** A worker as the api reads it: its state and its monitor sample. */
export interface WorkerProbe {
  state: "active" | "standby" | "stopping" | "stale" | "unavailable" | "not_configured";
  sample: WorkerMonitorSample | null;
}

/** `main`'s heartbeat with the read worker's fields (READ_HEARTBEAT_FIELDS) in place of its own. */
export function mergeHeartbeats<T extends HeartbeatResponse | WireHeartbeat>(main: T, read: T | null | undefined): T {
  if (!read) return main;
  const merged = { ...main } as Record<string, unknown>;
  for (const key of READ_HEARTBEAT_FIELDS) merged[key] = (read as Record<string, unknown>)[key];
  return merged as T;
}

/**
 * The api's view of its workers. WORKER_URL is the `copy` worker (or the
 * single `all` worker); WORKER_READ_URL, when set, the `read` worker. The
 * api reads both for /health and the admin system overview and merges them
 * (mergeHeartbeats: snapshots, sweeps, discovery, archive and Telegram from
 * the read worker; with only WORKER_URL, the one worker's heartbeat as it
 * is). It also watches what no single process can see:
 *
 * - terminal_settlement_unowned: on a testnet copy deployment with the
 *   api's own terminal settlement loop off (API_TERMINAL_SETTLEMENT=off),
 *   some copy worker must run it (WORKER_TERMINAL_SETTLEMENT in effect,
 *   reported in its heartbeat's `worker.terminalSettlement`). When no
 *   heartbeat read in the last SETTLEMENT_OWNER_WINDOW_MS said so, nothing
 *   settles terminal copies.
 * - snapshots_stale (WORKER_READ_URL set): the read worker's heartbeats
 *   have shown no snapshot newer than SNAPSHOT_STALE_MS (it is down, on
 *   standby, or its snapshots fail).
 *
 * Each is an ALERT log line at most every WORKER_ALERT_EVERY_MS and the
 * admin overview's `alerts`. Every heartbeat the api reads counts (an admin
 * page, /health), and while a guard applies the api reads the workers
 * itself every WORKER_GUARD_CHECK_MS (not under NODE_ENV=test: tests call
 * check()). What it last saw is kept in memory; the api's start counts as
 * the last time all was well (for snapshots, until a read worker's
 * heartbeat shows one), so a restarted api waits a full window before it
 * alerts.
 */
@Injectable()
export class WorkerFleetService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("WorkerFleet");
  private readonly startedAt: number;
  private settlementOwnerSeenAt: number;
  /** The newest snapshot a read worker's heartbeat has shown (none yet: the api's start counts). */
  private snapshotAt: number | null = null;
  private readonly alertedAt = new Map<WorkerAlert["code"], number>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly config: AppConfig,
    @Optional() private readonly now: () => number = Date.now) {
    this.startedAt = this.now();
    this.settlementOwnerSeenAt = this.startedAt;
  }

  onApplicationBootstrap(): void {
    if (this.config.value.app.nodeEnv === "test" || (!this.settlementGuardApplies() && !this.readUrl())) return;
    this.timer = setInterval(() => void this.check(), WORKER_GUARD_CHECK_MS);
    this.timer.unref();
  }
  onModuleDestroy(): void { clearInterval(this.timer); }

  /** The api's own terminal settlement loop is off on a deployment that has
   * one: a copy worker must run it. */
  settlementGuardApplies(): boolean {
    const app = this.config.value.app;
    return !app.isWorker && terminalSettlementApplies(this.config) && app.terminalSettlement?.api === false;
  }
  private readUrl(): string | undefined { return this.config.value.app.workerReadUrl; }

  /** The workers' full heartbeat (GET /health): WORKER_URL's, merged with
   * WORKER_READ_URL's when that one answers. Throws when WORKER_URL's
   * cannot be read. */
  async heartbeat(): Promise<HeartbeatResponse> {
    const url = this.config.value.app.workerUrl, readUrl = this.readUrl();
    if (!url) throw new Error("Worker not configured");
    const [main, read] = await Promise.all([this.health(url), readUrl ? this.health(readUrl).catch(() => null) : null]);
    this.observe(main, false);
    if (read) this.observe(read, true);
    return mergeHeartbeats(main, read);
  }
  private async health(url: string): Promise<HeartbeatResponse> {
    const response = await fetch(new URL("/health", url), { headers: workerCallHeaders(), signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error("Worker unavailable");
    return await response.json() as HeartbeatResponse;
  }

  /**
   * The workers' private monitor samples (GET /health/monitor). `worker`
   * is WORKER_URL's; while WORKER_READ_URL's is active, `worker`'s heartbeat
   * carries the read worker's fields and its discovery settings are the
   * read worker's (it runs discovery). `read` is WORKER_READ_URL's own
   * sample, absent when that is not set.
   */
  async monitors(): Promise<{ worker: WorkerProbe; read?: WorkerProbe }> {
    const readUrl = this.readUrl();
    const [worker, read] = await Promise.all([this.probe(this.config.value.app.workerUrl, false), readUrl ? this.probe(readUrl, true) : undefined]);
    const readSample = read?.state === "active" ? read.sample : null;
    if (!readSample?.heartbeat || !worker.sample?.heartbeat) return read ? { worker, read } : { worker };
    return { worker: { ...worker, sample: { ...worker.sample, heartbeat: mergeHeartbeats(worker.sample.heartbeat, readSample.heartbeat), settings: readSample.settings } }, read };
  }

  private async probe(url: string | undefined, read: boolean): Promise<WorkerProbe> {
    if (!url) return { state: "not_configured", sample: null };
    try {
      const response = await fetch(new URL("/health/monitor", url), {
        headers: workerCallHeaders({ Authorization: `Bearer ${workerMonitorKey(this.config.value.database.url)}` }),
        signal: AbortSignal.timeout(3000), cache: "no-store",
      });
      if (!response.ok) throw new Error("unavailable");
      const sample = workerMonitorSchema.parse(await response.json());
      const age = this.now() - Date.parse(sample.sampledAt);
      const stale = age > 30_000 || age < -5000;
      if (!stale && sample.state === "active" && sample.heartbeat) this.observe(sample.heartbeat, read);
      return { state: stale ? "stale" : sample.state, sample };
    } catch { return { state: "unavailable", sample: null }; }
  }

  /** Notes what a worker's heartbeat proves. `read`: it came from WORKER_READ_URL. */
  private observe(heartbeat: Pick<HeartbeatResponse | WireHeartbeat, "worker" | "lastSnapshotAt">, read: boolean): void {
    const worker = heartbeat.worker;
    if (worker && runsCopy(worker.role) && worker.terminalSettlement === true) this.settlementOwnerSeenAt = this.now();
    // Snapshot freshness is the read worker's to prove (a worker that
    // predates the role field is taken at its URL's word).
    const snapshot = heartbeat.lastSnapshotAt ? Date.parse(String(heartbeat.lastSnapshotAt)) : NaN;
    if (read && (!worker || runsRead(worker.role)) && Number.isFinite(snapshot)) this.snapshotAt = Math.max(this.snapshotAt ?? snapshot, Math.min(snapshot, this.now()));
  }

  /** What is wrong now, from what the api has seen. */
  alerts(): WorkerAlert[] {
    const now = this.now(), alerts: WorkerAlert[] = [];
    if (this.settlementGuardApplies() && now - this.settlementOwnerSeenAt > SETTLEMENT_OWNER_WINDOW_MS)
      alerts.push({ code: "terminal_settlement_unowned", lastOkAt: new Date(this.settlementOwnerSeenAt).toISOString() });
    const snapshotAt = this.snapshotAt ?? this.startedAt;
    if (this.readUrl() && now - snapshotAt > SNAPSHOT_STALE_MS)
      alerts.push({ code: "snapshots_stale", lastOkAt: new Date(snapshotAt).toISOString() });
    return alerts;
  }

  /** Reads the workers, then logs each alert (rate-limited). */
  async check(): Promise<WorkerAlert[]> {
    await this.monitors();
    const alerts = this.alerts(), now = this.now();
    for (const alert of alerts) {
      const last = this.alertedAt.get(alert.code);
      if (last !== undefined && now - last < WORKER_ALERT_EVERY_MS) continue;
      this.alertedAt.set(alert.code, now);
      this.logger.error(`ALERT ${alert.code} ${JSON.stringify({ ...alert, ...ALERT_CONTEXT[alert.code] })}`);
    }
    for (const code of this.alertedAt.keys()) {
      if (alerts.some(alert => alert.code === code)) continue;
      this.alertedAt.delete(code);
      this.logger.log(`${code} resolved`);
    }
    return alerts;
  }
}

/** What each ALERT line says beside its fields. */
const ALERT_CONTEXT: Record<WorkerAlert["code"], Record<string, string>> = {
  terminal_settlement_unowned: { reason: "API_TERMINAL_SETTLEMENT=off and no copy worker heartbeat in the last 2 minutes reports WORKER_TERMINAL_SETTLEMENT on: terminal copies are not settled" },
  snapshots_stale: { reason: "the read worker (WORKER_READ_URL) has shown no snapshot in the last 15 minutes" },
};
