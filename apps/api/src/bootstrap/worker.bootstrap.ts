import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Pool, type PoolClient } from "pg";

import type { RuntimeConfig } from "../config/runtime-config.js";
import { RequestBudgeterService } from "../hyperliquid/request-budgeter.service.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { operationalSwitches } from "../runtime/operational-switches.js";
import type { StructuredLogger } from "../runtime/structured-logger.js";
import { acquireWorkerLease } from "../runtime/worker-lease.js";
import { SettingsService } from "../settings/settings.service.js";
import { WorkerHeartbeatService } from "../worker/worker-heartbeat.service.js";
import { startWorkerHealthServer } from "./worker-health-server.js";

/**
 * IS_WORKER=true. Serves health first, then waits for the PG advisory-lock
 * lease (one active worker per database; Railway may start a replacement
 * before stopping the old deployment, and the replacement stays on standby,
 * live but not ready, constructing nothing). With the lease it creates
 * `AppModule.worker()` as an application context: no HTTP routes, only the
 * health server's. Losing the lease connection exits the process.
 */
export async function startWorker(config: RuntimeConfig, logger: StructuredLogger): Promise<void> {
  const pool = new Pool({ connectionString: config.database.url, max: 1, keepAlive: true, connectionTimeoutMillis: 3000, query_timeout: 3000 });
  let client: PoolClient | undefined;
  let app: INestApplicationContext | undefined;
  let ready = false;
  let stopping = false;
  let leaseProbe: ReturnType<typeof setInterval> | undefined;
  const abort = new AbortController();
  const instanceId = randomUUID();
  const active = () => ready && !stopping && app !== undefined;

  const server = await startWorkerHealthServer({
    instanceId,
    state: () => stopping ? "stopping" : ready ? "active" : "standby",
    probe: async () => { if (!client) throw new Error("no lease"); await client.query("SELECT 1"); },
    heartbeat: () => app!.get(WorkerHeartbeatService).heartbeat(),
    monitor: async (isActive) => {
      const live = isActive && active();
      const budgeter = live ? app!.get(RequestBudgeterService) : undefined;
      return {
        settings: live ? app!.get(SettingsService).appliedDiscovery() : [],
        switches: operationalSwitches(config),
        budget: budgeter ? { ...budgeter.introspect(), queued: budgeter.queued() } : null,
        heartbeat: live ? await app!.get(WorkerHeartbeatService).heartbeat() : null,
      };
    },
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
  process.once("SIGTERM", () => void shutdown(0));
  process.once("SIGINT", () => void shutdown(0));

  try {
    client = await pool.connect();
    const ownershipLost = () => {
      if (stopping) return;
      logger.error("Worker ownership connection lost");
      process.exit(1);
    };
    client.on("error", ownershipLost);
    client.on("end", ownershipLost);
    leaseProbe = setInterval(() => { void client?.query("SELECT 1").catch(ownershipLost); }, 5000);
    leaseProbe.unref();
    while (!await acquireWorkerLease(client)) await delay(1000, undefined, { signal: abort.signal });
    if (stopping) return;
    logger.log("Worker ownership acquired");
    const { AppModule } = await import("../app.module.js");
    app = await NestFactory.createApplicationContext(AppModule.worker(), { logger });
    if (stopping) { await app.close(); process.exit(0); }
    ready = true;
    logger.log(`Worker active: watcher, schedules and outbox enabled (health on ${config.app.port})`);
  } catch {
    if (!stopping) { logger.error("Worker startup failed"); await shutdown(1); }
  }
}
