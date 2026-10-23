import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { workerMonitorSchema, type HeartbeatResponse, type WorkerAlert } from "@trading-dashboard/shared/contracts";
import type { z } from "zod";

import { AppConfig } from "../../config/app-config.js";
import { EgressIdentityMonitor, egressIdentity, sharedIps } from "../../runtime/egress-identity.js";
import { workerCallHeaders, workerMonitorKey } from "../../runtime/worker-calls.js";
import { runsCopy, runsRead } from "../../runtime/worker-role.js";
import { ALERT_EVERY_MS } from '../../config/constants/alerts.js';
import { SETTLEMENT_OWNER_WINDOW_MS, SNAPSHOT_STALE_MS, WORKER_GUARD_CHECK_MS } from '../../config/constants/alerts.js';


/** Heartbeat fields the `read` worker owns once roles are split; the rest is the `copy` worker's. */
const READ_HEARTBEAT_FIELDS = ["lastSnapshotAt", "lastSnapshotAttemptAt", "lastSnapshotFailureAt", "lastSweepAt", "discovery", "archive", "dryRun"] as const;
/** The three processes whose public IPs are compared, and every pair of them (an alert names the pair). */
type EgressPeerRole = NonNullable<WorkerAlert["peers"]>[number];
type EgressPair = NonNullable<WorkerAlert["pairs"]>[number];
const EGRESS_PAIRS: readonly (readonly [EgressPeerRole, EgressPeerRole, EgressPair])[] = [["copy", "api", "copy-api"], ["copy", "read", "copy-read"], ["read", "api", "read-api"]];

type WorkerMonitorSample = z.infer<typeof workerMonitorSchema>;
type WireHeartbeat = NonNullable<WorkerMonitorSample["heartbeat"]>;
/** A worker as the api reads it: its state and its monitor sample. */
interface WorkerProbe {
  state: "active" | "standby" | "stopping" | "stale" | "unavailable" | "not_configured";
  sample: WorkerMonitorSample | null;
}

/** `main`'s heartbeat with the read worker's fields (READ_HEARTBEAT_FIELDS) in place of its own. */
function mergeHeartbeats<T extends HeartbeatResponse | WireHeartbeat>(main: T, read: T | null | undefined): T {
  if (!read) return main;
  const merged = { ...main } as Record<string, unknown>;
  for (const key of READ_HEARTBEAT_FIELDS) merged[key] = (read as Record<string, unknown>)[key];
  return merged as T;
}

/**
 * The api's view of its workers: WORKER_URL (`copy` or `all`) and, when set,
 * WORKER_READ_URL (`read`), merged for /health and the admin overview. It
 * alerts on what no single process can see:
 * - terminal_settlement_unowned: no copy worker heartbeat within
 *   SETTLEMENT_OWNER_WINDOW_MS reports it settles (only the copy worker's
 *   live engine settles terminal copies; the api never does: D13).
 * - snapshots_stale: no read-worker snapshot newer than SNAPSHOT_STALE_MS.
 * - egress_identity_shared: two of the api, the copy worker and the read
 *   worker report a common public IP (sets compared: a static gateway has
 *   several). Any pair breaks the meter split (D12): the copy side's shared
 *   meter and the read worker's own are then one limit at the provider.
 * ALERT lines are rate-limited to ALERT_EVERY_MS; while a guard applies the api
 * polls every WORKER_GUARD_CHECK_MS (not in tests). The api's start counts as
 * the last time all was well, so a restarted api waits a full window.
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
  /** The public IPs the copy (WORKER_URL) and read (WORKER_READ_URL) workers' heartbeats last reported. */
  private copyIps: readonly string[] = [];
  private readIps: readonly string[] = [];
  /** When the copy worker's addresses were last seen apart from the api's and the read worker's. */
  private egressOkAt: number;

  constructor(private readonly config: AppConfig,
    @Optional() private readonly now: () => number = Date.now,
    /** This api process's own egress identity (tests pass their own). */
    @Optional() @Inject(EgressIdentityMonitor) private readonly identity: EgressIdentityMonitor = egressIdentity) {
    this.startedAt = this.now();
    this.settlementOwnerSeenAt = this.startedAt;
    this.egressOkAt = this.startedAt;
  }

  onApplicationBootstrap(): void {
    const egressGuard = this.identity.mode !== "off" && !!(this.config.value.app.workerUrl || this.readUrl());
    if (this.config.value.app.nodeEnv === "test" || (!this.settlementGuardApplies() && !this.readUrl() && !egressGuard)) return;
    this.timer = setInterval(() => void this.check(), WORKER_GUARD_CHECK_MS);
    this.timer.unref();
  }
  onModuleDestroy(): void { clearInterval(this.timer); }

  /** The api of a live copy deployment (COPY_TRADING_MODE testnet or live)
   * with a copy worker to watch: that worker must report it settles. */
  settlementGuardApplies(): boolean {
    const { app, copy } = this.config.value;
    return !app.isWorker && !!app.workerUrl && copy.live !== undefined;
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
   * The workers' monitor samples (GET /health/monitor). While the read worker
   * is active, `worker`'s heartbeat and settings carry its fields; `read` is
   * its own sample, absent when WORKER_READ_URL is unset.
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
  private observe(heartbeat: Pick<HeartbeatResponse | WireHeartbeat, "worker" | "lastSnapshotAt" | "egressIdentity">, read: boolean): void {
    const worker = heartbeat.worker;
    if (worker && runsCopy(worker.role) && worker.terminalSettlement === true) this.settlementOwnerSeenAt = this.now();
    // Snapshot freshness is the read worker's to prove (a worker that
    // predates the role field is taken at its URL's word).
    const snapshot = heartbeat.lastSnapshotAt ? Date.parse(String(heartbeat.lastSnapshotAt)) : NaN;
    if (read && (!worker || runsRead(worker.role)) && Number.isFinite(snapshot)) this.snapshotAt = Math.max(this.snapshotAt ?? snapshot, Math.min(snapshot, this.now()));
    // Egress identities: what each worker reports now (none: nothing known).
    const ips = heartbeat.egressIdentity?.publicIps ?? [];
    if (read) this.readIps = ips;
    else if (!worker || runsCopy(worker.role)) this.copyIps = ips;
    if ((this.copyIps.length || this.readIps.length) && !this.egressShared()) this.egressOkAt = this.now();
  }

  /**
   * Addresses two of the three roles both report (the api: its own; the
   * workers: their heartbeats), by pair; null when none. Any pair breaks a
   * meter split: the copy worker beside the api or the read worker (its
   * limiter is not its own), and the read worker beside the api (D12: the
   * read worker's own meter and the api's shared one would be one limit on
   * the provider's side).
   */
  private egressShared(): { ips: string[]; peers: EgressPeerRole[]; pairs: EgressPair[] } | null {
    const sets: Record<EgressPeerRole, readonly string[]> = { api: this.identity.ips(), copy: this.copyIps, read: this.readIps };
    const ips = new Set<string>(), peers = new Set<EgressPeerRole>(), pairs: EgressPair[] = [];
    for (const [a, b, pair] of EGRESS_PAIRS) {
      const both = sharedIps(sets[a], sets[b]);
      if (!both.length) continue;
      both.forEach(ip => ips.add(ip)); peers.add(a); peers.add(b); pairs.push(pair);
    }
    if (!pairs.length) return null;
    return { ips: [...ips].sort(), peers: [...peers].sort(), pairs };
  }

  /** What is wrong now, from what the api has seen. */
  alerts(): WorkerAlert[] {
    const now = this.now(), alerts: WorkerAlert[] = [];
    if (this.settlementGuardApplies() && now - this.settlementOwnerSeenAt > SETTLEMENT_OWNER_WINDOW_MS)
      alerts.push({ code: "terminal_settlement_unowned", lastOkAt: new Date(this.settlementOwnerSeenAt).toISOString() });
    const snapshotAt = this.snapshotAt ?? this.startedAt;
    if (this.readUrl() && now - snapshotAt > SNAPSHOT_STALE_MS)
      alerts.push({ code: "snapshots_stale", lastOkAt: new Date(snapshotAt).toISOString() });
    const shared = this.egressShared();
    if (shared) alerts.push({ code: "egress_identity_shared", lastOkAt: new Date(this.egressOkAt).toISOString(), ips: shared.ips, peers: shared.peers, pairs: shared.pairs });
    return alerts;
  }

  /** Reads the workers, then logs each alert (rate-limited). */
  async check(): Promise<WorkerAlert[]> {
    await this.monitors();
    const alerts = this.alerts(), now = this.now();
    for (const alert of alerts) {
      const last = this.alertedAt.get(alert.code);
      if (last !== undefined && now - last < ALERT_EVERY_MS) continue;
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
  terminal_settlement_unowned: { reason: "no copy worker heartbeat in the last 2 minutes reports its live engine running (worker.terminalSettlement): terminal copies are not settled" },
  snapshots_stale: { reason: "the read worker (WORKER_READ_URL) has shown no snapshot in the last 15 minutes" },
  egress_identity_shared: { reason: "two of the api, the copy worker and the read worker share a public IP (pairs): the Hyperliquid per-IP meters they keep apart (D12: the copy side's shared meter, the read worker's own) are one limit on the provider's side; check the services' egress, or set HYPERLIQUID_READ_METER=shared on worker-read" },
};
