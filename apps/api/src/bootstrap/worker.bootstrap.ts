import { randomUUID } from "node:crypto";

import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Pool, type PoolClient } from "pg";

import type { RuntimeConfig } from "../config/runtime-config.js";
import { guardPool, onShutdownSignals } from "./process-guards.js";
import { RequestBudgeterService } from "../hyperliquid/request-budgeter.service.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { operationalSwitches } from "../runtime/operational-switches.js";
import type { StructuredLogger } from "../runtime/structured-logger.js";
import { acquireWorkerLeases, acquireWorkerOwnership, WORKER_LEASE_SESSION_OPTIONS } from "../runtime/worker-lease.js";
import { roleLeases, runsCopy } from "../runtime/worker-role.js";
import { EgressLeaseGuard, egressIdentity, type EgressIdentityMonitor } from "../runtime/egress-identity.js";
import { SettingsService } from "../settings/settings.service.js";
import { WorkerHeartbeatService } from "../worker/worker-heartbeat.service.js";
import { startWorkerHealthServer, type WorkerHealthSource } from "./worker-health-server.js";
import { workerMonitorKey } from "../runtime/worker-calls.js";

/** What the health server reads from the worker's application context:
 * /health's heartbeat and /health/monitor's sample (`active`: the worker
 * holds its lease and has not begun stopping). */
export function workerHealthReads(config: RuntimeConfig, app: () => INestApplicationContext, active: () => boolean): Pick<WorkerHealthSource, "heartbeat" | "monitor"> {
  return {
    heartbeat: () => app().get(WorkerHeartbeatService).heartbeat(),
    monitor: async (isActive) => {
      const live = isActive && active();
      const budgeter = live ? app().get(RequestBudgeterService) : undefined;
      return {
        settings: live ? app().get(SettingsService).appliedDiscovery() : [],
        switches: operationalSwitches(config),
        tuning: config.tuning,
        budget: budgeter ? { ...budgeter.introspect(), queued: budgeter.queued() } : null,
        heartbeat: live ? await app().get(WorkerHeartbeatService).heartbeat() : null,
      };
    },
  };
}

/** The lease gate of HL_EGRESS_IDENTITY=enforce, on a worker that runs copy
 * work (`copy`, `all`); undefined otherwise (off and observe never block). */
export function egressLeaseGuard(config: RuntimeConfig, logger: Pick<StructuredLogger, "log" | "warn" | "error">,
  options: { fetcher?: typeof fetch; now?: () => number; monitor?: EgressIdentityMonitor } = {}): EgressLeaseGuard | undefined {
  const egress = config.egressIdentity;
  if (egress?.mode !== "enforce" || !runsCopy(config.app.workerRole)) return undefined;
  return new EgressLeaseGuard({ monitor: options.monitor ?? egressIdentity, peers: egress.peers, monitorKey: workerMonitorKey(config.database.url), expectedIps: egress.expectedIps,
    timeoutMs: egress.timeoutMs, logger: { log: m => logger.log(m), warn: m => logger.warn(m), error: m => logger.error(m) }, fetcher: options.fetcher, now: options.now });
}

/** A lease attempt: the role's leases, unless the egress gate (when there
 * is one) refuses first; then no lease query runs and the worker stays on
 * standby (acquireWorkerOwnership asks again a second later). */
export function gatedLeaseAcquire<C extends Pick<PoolClient, "query">>(guard: Pick<EgressLeaseGuard, "allows"> | undefined, leases: readonly number[]): (client: C) => Promise<boolean> {
  return async client => guard && !(await guard.allows()) ? false : acquireWorkerLeases(client, leases);
}

/**
 * IS_WORKER=true. Serves health first, then waits for the PG advisory-lock
 * lease (one active worker per database; a replacement Railway starts before
 * stopping the old deployment stays on standby, live but not ready). With the
 * lease it creates `AppModule.worker()` as an application context (no HTTP
 * routes). WORKER_ROLE picks the leases and the modules (runtime/worker-role.ts).
 * A standby constructs nothing, so it sends nothing to Hyperliquid (design
 * I-8). Under HL_EGRESS_IDENTITY=enforce a copy-running worker takes no lease
 * while its public IP is unknown or shared (gatedLeaseAcquire). Losing the
 * lease connection exits the process; before ownership, an unreachable
 * database is retried instead (WORKER_DB_RETRY_WINDOW_MS).
 */
export async function startWorker(config: RuntimeConfig, logger: StructuredLogger,
  /** Where SIGTERM/SIGINT come from (tests stop a worker without signalling the test process). */
  signals: NodeJS.Process = process): Promise<void> {
  const pool = guardPool(new Pool({ connectionString: config.database.url, max: 1, keepAlive: true, connectionTimeoutMillis: 3000, query_timeout: 3000, options: WORKER_LEASE_SESSION_OPTIONS }), logger, "worker lease");
  let client: PoolClient | undefined;
  let app: INestApplicationContext | undefined;
  let ready = false;
  let stopping = false;
  let leaseProbe: ReturnType<typeof setInterval> | undefined;
  const abort = new AbortController();
  const instanceId = randomUUID();
  const active = () => ready && !stopping && app !== undefined;

  // Learns this worker's public IP (HL_EGRESS_IDENTITY; off: nothing),
  // on standby too: never awaited, it holds nothing up.
  egressIdentity.configure({ role: config.app.workerRole, egressKey: config.hyperliquid.egressKey, config: config.egressIdentity, logger }).start();
  const server = await startWorkerHealthServer({
    instanceId,
    monitorKey: workerMonitorKey(config.database.url),
    egress: () => egressIdentity.snapshot(),
    state: () => stopping ? "stopping" : ready ? "active" : "standby",
    probe: async () => { if (!client) throw new Error("no lease"); await client.query("SELECT 1"); },
    ...workerHealthReads(config, () => app!, active),
  }, config.app.port);

  async function shutdown(code: number): Promise<void> {
    if (stopping) return;
    stopping = true; ready = false; abort.abort();
    clearInterval(leaseProbe);
    const deadline = setTimeout(() => process.exit(1), 30_000); deadline.unref();
    app?.get(BackgroundJobs).stop();
    server.close(); server.closeAllConnections();
    // Release ownership only after jobs and their DB pool have stopped.
    await app?.close();
    client?.release(true);
    await pool.end();
    clearTimeout(deadline);
    process.exit(code);
  }
  // Exit 1 after an uncaught exception (installProcessGuards), else 0.
  onShutdownSignals(shutdown, signals);

  try {
    // Standby and a database outage before ownership are retried here
    // (acquireWorkerOwnership: backoff, up to WORKER_DB_RETRY_WINDOW_MS of
    // continuous unavailability): nothing runs yet, so reconnecting is safe.
    const role = config.app.workerRole, leases = roleLeases(role);
    // HL_EGRESS_IDENTITY=enforce on a worker that runs copy work: no lease
    // (standby, nothing constructed) while its egress is unknown or shared.
    const owner = await acquireWorkerOwnership({ connect: () => pool.connect(), acquire: gatedLeaseAcquire(egressLeaseGuard(config, logger), leases), signal: abort.signal, logger });
    client = owner;
    // Once it owns the lease, losing that connection exits at once. The
    // lock is session-scoped: the server drops it with the session, and a
    // standby may already be taking over while this process's jobs still
    // run on their own pool. Exiting is the only fence that stops them
    // immediately (closing the Nest context waits for jobs to drain), so
    // the process does not drop back to standby; the restart is survivable
    // instead: the new process waits out an outage in acquireWorkerOwnership.
    const ownershipLost = () => {
      if (stopping) return;
      logger.error("Worker ownership connection lost");
      process.exit(1);
    };
    owner.on("error", ownershipLost);
    owner.on("end", ownershipLost);
    // A slow probe is not a lost lock: only three failures in a row (15 s),
    // or the connection's own 'error'/'end', give up the lease.
    let probeFailures = 0;
    leaseProbe = setInterval(() => {
      void owner.query("SELECT 1").then(() => { probeFailures = 0; }, () => { probeFailures += 1; if (probeFailures >= 3) ownershipLost(); });
    }, 5000);
    leaseProbe.unref();
    if (stopping) return;
    logger.log(`Worker ownership acquired: role ${role}, lease(s) ${leases.map(key => `(73106, ${key})`).join(" + ")}`);
    const { AppModule } = await import("../app.module.js");
    app = await NestFactory.createApplicationContext(AppModule.worker(role), { logger });
    if (stopping) { await app.close(); process.exit(0); }
    ready = true;
    logger.log(`Worker active as ${role} (health on ${config.app.port})`);
  } catch {
    if (!stopping) { logger.error("Worker startup failed"); await shutdown(1); }
  }
}
