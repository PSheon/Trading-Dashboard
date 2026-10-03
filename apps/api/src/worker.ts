import { SettingsService } from "./settings/settings.service.js";
import { randomUUID } from "node:crypto";
import { RequestBudgeterService } from "./hyperliquid/request-budgeter.service.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Pool, type PoolClient } from "pg";
import { validateEnvironment } from "./config/runtime-config.js";
import { acquireWorkerLease } from "./runtime/worker-lease.js";
import { BackgroundJobs } from "./runtime/background-jobs.service.js";
import { StructuredLogger } from "./runtime/structured-logger.js";
import { HealthService } from "./api/health/health.service.js";
import { operationalSwitches } from "./runtime/operational-switches.js";

const envFile = resolve(import.meta.dirname, "../../../.env");
if (process.env.NODE_ENV !== "test" && existsSync(envFile)) process.loadEnvFile(envFile);
process.env.APP_ROLE ??= "worker";
const config = validateEnvironment();
if (config.app.role !== "worker") throw new Error("worker entrypoint requires APP_ROLE=worker");
const logger = new StructuredLogger([config.database.url, config.telegram.botToken, config.auth.appSecret, config.archive.credentials?.secretAccessKey, config.archive.credentials?.sessionToken, config.copy.agent?.authorizationPrivateKey].filter((x): x is string => Boolean(x)));
const pool = new Pool({ connectionString: config.database.url, max: 1, keepAlive: true, connectionTimeoutMillis: 3000, query_timeout: 3000 });
let client: PoolClient | undefined;
let app: INestApplicationContext | undefined;
let ready = false;
let stopping = false;
let leaseProbe: ReturnType<typeof setInterval> | undefined;
const abort = new AbortController();
const instanceId = randomUUID();
// Only operational endpoints. No controllers, admin routes or user authentication
// surface are mounted by the application context.
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method !== "GET") { res.writeHead(405).end(); return; }
    if (req.url === "/health/monitor") {
      const state = stopping ? "stopping" : ready ? "active" : "standby";
      const budgeter = ready && !stopping ? app?.get(RequestBudgeterService) : undefined;
      const heartbeat = ready && !stopping ? await app?.get(HealthService).heartbeat() : null;
      res.end(JSON.stringify({ state, instanceId, sampledAt: new Date().toISOString(), uptimeSeconds: Math.floor(process.uptime()),
        settings: ready && !stopping ? app?.get(SettingsService).appliedDiscovery() ?? [] : [],
        switches: operationalSwitches(config),
        budget: budgeter ? { ...budgeter.introspect(), queued: budgeter.queued() } : null, heartbeat: heartbeat ?? null })); return;
    }
    if (req.url === "/health/live") {
      res.writeHead(stopping ? 503 : 200).end(JSON.stringify({ role: "worker", state: stopping ? "stopping" : ready ? "active" : "standby" })); return;
    }
    if (req.url !== "/health" && req.url !== "/health/ready") { res.writeHead(404).end(); return; }
    if (!ready || stopping || !app || !client) { res.writeHead(503).end('{"ready":false}'); return; }
    await client.query("SELECT 1");
    res.end(JSON.stringify(req.url === "/health" ? await app.get(HealthService).heartbeat() : { ready: true, role: "worker" }));
  } catch { res.writeHead(503).end('{"ready":false}'); }
});
async function shutdown(code: number) {
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
await new Promise<void>((resolve) => server.listen(config.app.port, "::", resolve));
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
  // Railway may start a replacement before stopping the old deployment. Standby
  // is live, but not ready and does not construct/start any background providers.
  while (!await acquireWorkerLease(client)) await delay(1000, undefined, { signal: abort.signal });
  if (!stopping) {
    logger.log("Worker ownership acquired");
    const { AppModule } = await import("./app.module.js");
    app = await NestFactory.createApplicationContext(AppModule, { logger });
    if (stopping) { await app.close(); process.exit(0); }
    ready = true;
    logger.log("Worker active: watcher, schedules and outbox enabled");
  }
} catch { if (!stopping) { logger.error("Worker startup failed"); await shutdown(1); } }
