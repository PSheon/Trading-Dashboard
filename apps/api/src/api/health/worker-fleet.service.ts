import { Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { workerMonitorSchema, type HeartbeatResponse, type WorkerAlert } from "@trading-dashboard/shared/contracts";
import type { z } from "zod";

import { AppConfig } from "../../config/app-config.js";
import { terminalSettlementApplies } from "../../copy/live-worker/copy-live-api-settlement.service.js";
import { workerCallHeaders, workerMonitorKey } from "../../runtime/worker-calls.js";
import { runsCopy } from "../../runtime/worker-role.js";

/** How long the api waits for a copy worker heartbeat that reports the
 * terminal settlement loop on, while its own loop is off. */
export const SETTLEMENT_OWNER_WINDOW_MS = 2 * 60_000;
/** How often the api reads the workers on its own for its guards. */
export const WORKER_GUARD_CHECK_MS = 30_000;
/** One ALERT log line per condition at most this often. */
export const WORKER_ALERT_EVERY_MS = 10 * 60_000;

export type WorkerMonitorSample = z.infer<typeof workerMonitorSchema>;
/** A worker as the api reads it: its state and its monitor sample. */
export interface WorkerProbe {
  state: "active" | "standby" | "stopping" | "stale" | "unavailable" | "not_configured";
  sample: WorkerMonitorSample | null;
}

/**
 * The api's view of its workers: it reads them (WORKER_URL: the `copy` or
 * `all` worker) for /health and the admin system overview, and watches a
 * condition no single process can see:
 *
 * - terminal_settlement_unowned: on a testnet copy deployment with the
 *   api's own terminal settlement loop off (API_TERMINAL_SETTLEMENT=off),
 *   some copy worker must run it (WORKER_TERMINAL_SETTLEMENT in effect,
 *   reported in its heartbeat's `worker.terminalSettlement`). When no
 *   heartbeat read in the last SETTLEMENT_OWNER_WINDOW_MS said so, nothing
 *   settles terminal copies: an ALERT, at most every WORKER_ALERT_EVERY_MS,
 *   and the admin overview's `alerts`.
 *
 * Every heartbeat the api reads counts (an admin page, /health), and while
 * a guard applies the api reads the workers itself every
 * WORKER_GUARD_CHECK_MS (not under NODE_ENV=test: tests call check()).
 * What it last saw is kept in memory; the api's start counts as the last
 * time all was well, so a restarted api waits a full window before it
 * alerts.
 */
@Injectable()
export class WorkerFleetService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("WorkerFleet");
  private readonly startedAt: number;
  private settlementOwnerSeenAt: number;
  private readonly alertedAt = new Map<WorkerAlert["code"], number>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly config: AppConfig,
    @Optional() private readonly now: () => number = Date.now) {
    this.startedAt = this.now();
    this.settlementOwnerSeenAt = this.startedAt;
  }

  onApplicationBootstrap(): void {
    if (this.config.value.app.nodeEnv === "test" || !this.settlementGuardApplies()) return;
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

  /** The WORKER_URL worker's full heartbeat (GET /health); throws when it
   * cannot be read. */
  async heartbeat(): Promise<HeartbeatResponse> {
    const url = this.config.value.app.workerUrl;
    if (!url) throw new Error("Worker not configured");
    const response = await fetch(new URL("/health", url), { headers: workerCallHeaders(), signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error("Worker unavailable");
    const heartbeat = await response.json() as HeartbeatResponse;
    this.observe(heartbeat);
    return heartbeat;
  }

  /** The WORKER_URL worker's private monitor sample (GET /health/monitor). */
  monitor(): Promise<WorkerProbe> { return this.probe(this.config.value.app.workerUrl); }

  private async probe(url: string | undefined): Promise<WorkerProbe> {
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
      if (!stale && sample.state === "active" && sample.heartbeat) this.observe(sample.heartbeat);
      return { state: stale ? "stale" : sample.state, sample };
    } catch { return { state: "unavailable", sample: null }; }
  }

  /** Notes what a worker's heartbeat proves. */
  private observe(heartbeat: Pick<HeartbeatResponse, "worker">): void {
    const worker = heartbeat.worker;
    if (worker && runsCopy(worker.role) && worker.terminalSettlement === true) this.settlementOwnerSeenAt = this.now();
  }

  /** What is wrong now, from what the api has seen. */
  alerts(): WorkerAlert[] {
    const now = this.now(), alerts: WorkerAlert[] = [];
    if (this.settlementGuardApplies() && now - this.settlementOwnerSeenAt > SETTLEMENT_OWNER_WINDOW_MS)
      alerts.push({ code: "terminal_settlement_unowned", lastOkAt: new Date(this.settlementOwnerSeenAt).toISOString() });
    return alerts;
  }

  /** Reads the workers, then logs each alert (rate-limited). */
  async check(): Promise<WorkerAlert[]> {
    await this.monitor();
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
};
