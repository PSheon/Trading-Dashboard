import { afterEach, expect, it } from "vitest";
import type { Server } from "node:http";
import { startWorkerHealthServer, type WorkerHealthSource } from "../src/bootstrap/worker-health-server.js";
import { withRequestSignal } from "../src/runtime/request-context.js";
import { workerCallHeaders, workerMonitorKey } from "../src/runtime/worker-calls.js";

const KEY = workerMonitorKey("postgres://worker:secret@db.internal:5432/orbie");
const AUTH = { Authorization: `Bearer ${KEY}` };

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => { if (!server) return resolve(); server.close(() => resolve()); server = undefined; }));

let seenRequestIds: Array<string | undefined> = [];
async function start(state: ReturnType<WorkerHealthSource["state"]>, probe = async () => undefined) {
  seenRequestIds = [];
  const { currentRequestId } = await import("../src/runtime/request-context.js");
  server = await startWorkerHealthServer({
    instanceId: "w-1", state: () => state, probe, monitorKey: KEY,
    heartbeat: async () => { seenRequestIds.push(currentRequestId()); return { feedConnected: true } as never; },
    monitor: async (active) => ({ settings: [], budget: active ? { weightLastMinute: 1 } : null, heartbeat: active ? { feedConnected: true } : null }),
  }, 0, "127.0.0.1");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return (path: string, method = "GET", headers: Record<string, string> = path === "/health/monitor" ? AUTH : {}) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers });
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

it("/health/monitor answers only the api's key: without it, or with another, it is an unknown path", async () => {
  const get = await start("active");
  expect((await get("/health/monitor", "GET", {})).status).toBe(404);
  expect((await get("/health/monitor", "GET", { Authorization: `Bearer ${workerMonitorKey("postgres://other@db/orbie")}` })).status).toBe(404);
  expect((await get("/health/monitor", "GET", { Authorization: KEY })).status).toBe(404);
  expect(await (await get("/health/monitor", "GET", {})).text()).toBe("");
  expect((await get("/health/monitor")).status).toBe(200);
});

it("carries the api's x-request-id into the worker's handling and echoes it; a malformed one is dropped", async () => {
  const get = await start("active");
  const headers = withRequestSignal(new AbortController().signal, () => workerCallHeaders(), "req-123_abc");
  expect(headers).toEqual({ "x-request-id": "req-123_abc" });
  const res = await get("/health", "GET", headers);
  expect(res.headers.get("x-request-id")).toBe("req-123_abc");
  expect(seenRequestIds).toEqual(["req-123_abc"]);
  const bad = await get("/health", "GET", { "x-request-id": "bad id!" });
  expect(bad.headers.get("x-request-id")).toBeNull();
  expect(seenRequestIds.at(-1)).toBeUndefined();
  expect(workerCallHeaders()).toEqual({});
});
