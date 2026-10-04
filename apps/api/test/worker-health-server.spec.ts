import { afterEach, expect, it } from "vitest";
import type { Server } from "node:http";
import { startWorkerHealthServer, type WorkerHealthSource } from "../src/bootstrap/worker-health-server.js";

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => { if (!server) return resolve(); server.close(() => resolve()); server = undefined; }));

async function start(state: ReturnType<WorkerHealthSource["state"]>, probe = async () => undefined) {
  server = await startWorkerHealthServer({
    instanceId: "w-1", state: () => state, probe,
    heartbeat: async () => ({ feedConnected: true }) as never,
    monitor: async (active) => ({ settings: [], budget: active ? { weightLastMinute: 1 } : null, heartbeat: active ? { feedConnected: true } : null }),
  }, 0, "127.0.0.1");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return (path: string, method = "GET") => fetch(`http://127.0.0.1:${port}${path}`, { method });
}

it("serves only health on the worker port: business routes are 404, other methods 405", async () => {
  const get = await start("active");
  expect((await get("/health")).status).toBe(200);
  expect(await (await get("/health")).json()).toEqual({ feedConnected: true });
  expect(await (await get("/health/ready")).json()).toEqual({ ready: true, worker: true });
  for (const path of ["/me", "/traders", "/admin/system/overview", "/", "/healthz"]) expect((await get(path)).status, path).toBe(404);
  expect((await get("/health", "POST")).status).toBe(405);
  const monitor = await (await get("/health/monitor")).json();
  expect(monitor).toMatchObject({ state: "active", instanceId: "w-1", budget: { weightLastMinute: 1 }, heartbeat: { feedConnected: true } });
});

it("a standby worker is live but not ready and reports no telemetry; a stopping one is not live", async () => {
  let get = await start("standby");
  expect((await get("/health/live")).status).toBe(200);
  expect((await get("/health/ready")).status).toBe(503);
  expect((await get("/health")).status).toBe(503);
  expect(await (await get("/health/monitor")).json()).toMatchObject({ state: "standby", budget: null, heartbeat: null });
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  get = await start("stopping");
  expect((await get("/health/live")).status).toBe(503);
});

it("is not ready when the lease connection does not answer", async () => {
  const get = await start("active", async () => { throw new Error("connection lost"); });
  expect((await get("/health/ready")).status).toBe(503);
});
