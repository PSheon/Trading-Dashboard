import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { SchedulerRegistry } from "@nestjs/schedule";
import type { INestApplicationContext } from "@nestjs/common";

import { AppConfig } from "../src/config/app-config.js";
import { validateEnvironment } from "../src/config/runtime-config.js";
import { WorkerFleetService } from '../src/api/health/worker-fleet.service.js';
import { workerHealthReads } from "../src/bootstrap/worker.bootstrap.js";
import { startWorkerHealthServer } from "../src/bootstrap/worker-health-server.js";
import { DiscoveryPoolService } from "../src/discovery/discovery-pool.service.js";
import { RequestBudgeterService } from "../src/hyperliquid/request-budgeter.service.js";
import { WALLET_NETWORK_HL } from "../src/hyperliquid/wallet-network-hyperliquid.js";
import { ArchiveIngestService } from "../src/ingest/archive-ingest.service.js";
import { workerMonitorKey } from "../src/runtime/worker-calls.js";
import type { WorkerRole } from "../src/runtime/worker-role.js";
import { SchedulerService } from "../src/scheduler/scheduler.service.js";
import { AccountStateService, type AccountState } from "../src/watcher/account-state.service.js";
import { WatcherService } from "../src/watcher/watcher.service.js";
import { WorkerHeartbeatService } from "../src/worker/worker-heartbeat.service.js";
import { SNAPSHOT_STALE_MS } from '../src/config/constants/alerts.js';

// Stage, 2026-10-14: the `read` worker logged "Snapshots: 4 written" and
// wrote the rows, yet its /health showed lastSnapshotAt, ...AttemptAt and
// ...FailureAt null, so the api's snapshots_stale alert (15 min, from
// WORKER_READ_URL) would fire on a healthy fleet. The heartbeat must read
// the very SchedulerService whose cron ran, through the health server's
// real path, on `read` and on `all`.

const LEADER = "0x00000000000000000000000000000000000000aa";
const environment = (extra: Record<string, string>) => ({ NODE_ENV: "test", DATABASE_URL: process.env.TEST_DATABASE_URL!, ...extra });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

/** GET on the worker's health server (the global fetch is Hyperliquid's, stubbed offline). */
function get(server: Server, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text || "null") }));
    }).on("error", reject).end();
  });
}

/** A worker of `role` initialised as the bootstrap does (Hyperliquid unreachable, crons stopped), served by its real health server. */
async function worker(role: WorkerRole, run: (app: INestApplicationContext, server: Server, config: AppConfig) => Promise<void>) {
  vi.stubEnv("DATABASE_URL", process.env.TEST_DATABASE_URL!);
  const config = new AppConfig(validateEnvironment(environment({ IS_WORKER: "true", WORKER_ROLE: role })));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const { AppModule } = await import("../src/app.module.js");
  const ref = await Test.createTestingModule({ imports: [AppModule.worker(role)] }).overrideProvider(AppConfig).useValue(config).compile();
  const app = await ref.init();
  const server = await startWorkerHealthServer({
    instanceId: `w-${role}`, monitorKey: workerMonitorKey(config.value.database.url), state: () => "active", probe: async () => undefined,
    ...workerHealthReads(config.value, () => app, () => true),
  }, 0, "127.0.0.1");
  try {
    for (const job of app.get(SchedulerRegistry, { strict: false }).getCronJobs().values()) void job.stop();
    await run(app, server, config);
  } finally { server.close(); server.closeAllConnections(); await app.close(); }
}

/** One leader whose account reads succeed (`ok`) or fail; the rows' writing is the repository's own business. */
function leader(ok: () => boolean) {
  vi.spyOn(WatcherService.prototype, "activeAddresses").mockResolvedValue([LEADER]);
  vi.spyOn(AccountStateService.prototype, "refresh").mockImplementation(async () => {
    if (!ok()) throw new Error("account read failed");
    return { fetchedAt: new Date(), byDex: new Map() } as unknown as AccountState;
  });
  vi.spyOn(SchedulerService.prototype as unknown as { writeSnapshots: () => Promise<void> }, "writeSnapshots").mockResolvedValue(undefined);
}

/** The heartbeat's collaborators are the graph's own instances (none from a token Nest could not resolve). */
function wiredToGraph(app: INestApplicationContext, role: WorkerRole) {
  const heartbeat = app.get(WorkerHeartbeatService) as unknown as Record<string, unknown>;
  const instance = (type: unknown) => { try { return app.get(type as never, { strict: false }); } catch { return undefined; } };
  expect(heartbeat.watcher, "watcher").toBe(app.get(WatcherService, { strict: false }));
  expect(heartbeat.budgeter, "budgeter").toBe(app.get(RequestBudgeterService, { strict: false }));
  expect(heartbeat.wallet, "wallet network").toBe(instance(WALLET_NETWORK_HL));
  for (const [field, type] of [["scheduler", SchedulerService], ["archive", ArchiveIngestService], ["pool", DiscoveryPoolService]] as const) {
    if (role === "copy") expect(heartbeat[field], `${field} on copy`).toBeUndefined();
    else expect(heartbeat[field], field).toBe(app.get(type, { strict: false }));
  }
}

for (const role of ["read", "all"] as const) {
  it(`WORKER_ROLE=${role}: /health and /health/monitor report the snapshots the scheduler's cron took`, async () => {
    let ok = true;
    leader(() => ok);
    await worker(role, async (app, server, config) => {
      const scheduler = app.get(SchedulerService, { strict: false });
      expect((await get(server, "/health")).body).toMatchObject({ lastSnapshotAt: null, lastSnapshotAttemptAt: null, lastSnapshotFailureAt: null });

      expect(await scheduler.snapshotAll()).toEqual({ written: 1, reconciled: 0, failed: 0 });
      const taken = scheduler.lastSnapshotAt!.toISOString();
      const health = await get(server, "/health");
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ lastSnapshotAt: taken, lastSnapshotAttemptAt: scheduler.lastSnapshotAttemptAt!.toISOString(), lastSnapshotFailureAt: null, worker: { role } });
      // The read side's discovery figures come from the graph's pool (a DB read here).
      expect(health.body.discovery).toEqual(expect.objectContaining({ poolRows: expect.any(Number) }));
      const monitor = await get(server, "/health/monitor", { authorization: `Bearer ${workerMonitorKey(config.value.database.url)}` });
      expect((monitor.body.heartbeat as Record<string, unknown>).lastSnapshotAt).toBe(taken);

      ok = false;
      expect(await scheduler.snapshotAll()).toEqual({ written: 0, reconciled: 0, failed: 1 });
      expect((await get(server, "/health")).body).toMatchObject({ lastSnapshotAt: taken, lastSnapshotFailureAt: scheduler.lastSnapshotFailureAt!.toISOString() });
      wiredToGraph(app, role);
    });
  });
}

it("WORKER_ROLE=copy reports no snapshots of its own, and the api's /health takes them from the read worker without a false snapshots_stale", async () => {
  leader(() => true);
  let copyBeat: Record<string, unknown> = {};
  await worker("copy", async (app, server) => {
    wiredToGraph(app, "copy");
    copyBeat = (await get(server, "/health")).body;
    expect(copyBeat).toMatchObject({ lastSnapshotAt: null, worker: { role: "copy" } });
    expect(copyBeat).not.toHaveProperty("discovery");
  });
  await worker("read", async (app, server) => {
    const scheduler = app.get(SchedulerService, { strict: false });
    await scheduler.snapshotAll();
    const { port } = server.address() as AddressInfo, readUrl = `http://127.0.0.1:${port}`, copyUrl = "http://worker-copy.internal:3000";
    // The api: WORKER_URL is the copy worker (its heartbeat as served above), WORKER_READ_URL this read worker's real health server.
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => {
      const u = new URL(String(url));
      if (u.origin === new URL(copyUrl).origin) return { ok: true, status: 200, json: async () => copyBeat };
      return await new Promise((resolve, reject) => request({ host: "127.0.0.1", port, path: u.pathname }, (res) => {
        let text = ""; res.on("data", (c) => { text += c; });
        res.on("end", () => resolve({ ok: res.statusCode === 200, status: res.statusCode, json: async () => JSON.parse(text) }));
      }).on("error", reject).end());
    }));
    const api = new AppConfig(validateEnvironment(environment({ WORKER_URL: copyUrl, WORKER_READ_URL: readUrl })));
    expect(api.value.app.workerReadUrl).toBe(readUrl);
    // The api started 20 minutes before the snapshot: only the read worker's heartbeat can keep the alert quiet.
    const taken = scheduler.lastSnapshotAt!.getTime();
    let now = taken - 20 * 60_000;
    const fleet = new WorkerFleetService(api, () => now);
    now = taken + 60_000;
    const merged = await fleet.heartbeat();
    expect(String(merged.lastSnapshotAt)).toBe(scheduler.lastSnapshotAt!.toISOString());
    expect(merged.worker).toMatchObject({ role: "copy" });
    expect(fleet.alerts()).toEqual([]);
    now = taken + SNAPSHOT_STALE_MS + 1000;
    expect(fleet.alerts().map((a) => a.code)).toEqual(["snapshots_stale"]);
  });
});
