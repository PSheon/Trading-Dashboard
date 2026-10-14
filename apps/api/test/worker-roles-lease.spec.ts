import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { NestFactory } from "@nestjs/core";
import { Pool, type PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { validateEnvironment } from "../src/config/runtime-config.js";
import { acquireWorkerLeases, acquireWorkerOwnership } from "../src/runtime/worker-lease.js";
import { roleLeases, type WorkerRole } from "../src/runtime/worker-role.js";
import { StructuredLogger } from "../src/runtime/structured-logger.js";

// Every WebSocket the process opens (the trade feed, account reads, the meter's
// subscriptions all use `ws`): a standby must open none.
const sockets = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock("ws", async (original) => {
  const actual = await original<typeof import("ws")>();
  class CountingWebSocket extends actual.WebSocket {
    constructor(...args: ConstructorParameters<typeof actual.WebSocket>) { sockets.opened.push(String(args[0])); super(...args); }
  }
  return { ...actual, default: CountingWebSocket, WebSocket: CountingWebSocket };
});

const url = () => { if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL required"); return process.env.TEST_DATABASE_URL; };
const silent = { log: () => undefined, warn: () => undefined };
const pools: Pool[] = [];
function connection(): Promise<PoolClient> {
  const pool = new Pool({ connectionString: url(), max: 1 });
  pool.on("error", () => undefined);
  pools.push(pool);
  return pool.connect();
}
afterEach(async () => { for (const pool of pools.splice(0)) await pool.end().catch(() => undefined); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const settled = async <T>(promise: Promise<T>, ms: number) => Promise.race([promise.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), ms))]);

describe("worker leases by role (WORKER_ROLE)", () => {
  it("hands off from one `all` worker to a `copy` and a `read` worker: both wait on standby, then each takes its own lease", async () => {
    const all = await connection();
    expect(await acquireWorkerLeases(all, roleLeases("all"))).toBe(true);
    const own = (role: WorkerRole) => acquireWorkerOwnership({ connect: connection, acquire: client => acquireWorkerLeases(client, roleLeases(role)), signal: new AbortController().signal, logger: silent });
    const copy = own("copy"), read = own("read");
    // Neither takes over while the `all` worker holds both leases.
    expect(await settled(Promise.race([copy, read]), 2500)).toBe(false);
    // The old worker stops (its session ends): each new one takes its lease within a poll.
    all.release(true);
    const [copyClient, readClient] = await Promise.all([copy, read]);
    const held = await copyClient.query<{ objid: number; pid: number }>(
      "SELECT objid::int, pid FROM pg_locks WHERE locktype = 'advisory' AND classid = 73106 AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) ORDER BY objid");
    const pid = async (client: PoolClient) => (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    expect(held.rows).toEqual([{ objid: 1, pid: await pid(copyClient) }, { objid: 2, pid: await pid(readClient) }]);
    // A second `copy` or `read` (a deploy's replacement) stays on standby.
    const extra = await connection();
    expect(await acquireWorkerLeases(extra, roleLeases("copy"))).toBe(false);
    expect(await acquireWorkerLeases(extra, roleLeases("read"))).toBe(false);
    copyClient.release(true); readClient.release(true); extra.release(true);
  });

  it("an `all` worker takes both leases or none: it never sits on the copy lease while a `read` worker holds the other", async () => {
    const read = await connection(), all = await connection(), copy = await connection();
    expect(await acquireWorkerLeases(read, roleLeases("read"))).toBe(true);
    expect(await acquireWorkerLeases(all, roleLeases("all"))).toBe(false);
    // The `all` worker gave lease 1 back at once: a `copy` worker can take it.
    expect(await acquireWorkerLeases(copy, roleLeases("copy"))).toBe(true);
    expect((await all.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()")).rows[0]).toEqual({ n: 0 });
    read.release(true); all.release(true); copy.release(true);
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer().listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
    server.on("error", reject);
  });
}

describe("a standby worker (design I-8)", () => {
  it.each(["copy", "read", "all"] as const)("WORKER_ROLE=%s makes no Hyperliquid call and constructs nothing until it holds its lease", async (role) => {
    const holder = await connection();
    // Another worker holds the role's lease(s).
    expect(await acquireWorkerLeases(holder, roleLeases(role))).toBe(true);
    const port = await freePort();
    const local = globalThis.fetch;
    const outbound: string[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input instanceof Request ? input.url : input);
      if (!target.startsWith(`http://127.0.0.1:${port}/`)) outbound.push(target);
      return local(input, init);
    });
    sockets.opened = [];
    // The application context is what would start the feed, the catalog and the
    // loops: count it and hand back an inert one.
    const fakeApp = { get: () => ({ stop: () => undefined, heartbeat: async () => ({}) }), close: async () => undefined };
    const create = vi.spyOn(NestFactory, "createApplicationContext").mockResolvedValue(fakeApp as never);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const config = validateEnvironment({ NODE_ENV: "test", DATABASE_URL: url(), IS_WORKER: "true", WORKER_PORT: String(port), ...(role === "all" ? {} : { WORKER_ROLE: role }) });
    const signals = Object.assign(new EventEmitter(), { exitCode: undefined }) as unknown as NodeJS.Process;
    const { startWorker } = await import("../src/bootstrap/worker.bootstrap.js");
    // Resolves once it is active (it waits for the lease inside).
    const started = startWorker(config, new StructuredLogger([], () => undefined), signals);
    try {
      const ready = async () => (await local(`http://127.0.0.1:${port}/health/ready`)).status;
      // Three lease polls on standby.
      await new Promise(resolve => setTimeout(resolve, 3200));
      expect(await ready()).toBe(503);
      expect(create).not.toHaveBeenCalled();
      expect(outbound).toEqual([]);
      expect(sockets.opened).toEqual([]);
      // The holder goes: the standby takes over and only then builds its role's graph.
      holder.release(true);
      for (let i = 0; i < 50 && create.mock.calls.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 100));
      expect(create).toHaveBeenCalledOnce();
      const graph = JSON.stringify(create.mock.calls[0]![0], (_key, value: unknown) => typeof value === "function" ? value.name : value);
      expect(graph).toContain(role === "read" ? "SchedulerModule" : "CopyLiveWorkerModule");
      if (role === "copy") expect(graph).not.toContain("SchedulerModule");
      if (role === "read") expect(graph).not.toContain("CopyLiveWorkerModule");
      await started;
      await expect.poll(ready, { timeout: 3000 }).toBe(200);
      expect(outbound).toEqual([]);
    } finally {
      signals.emit("SIGTERM");
      await expect.poll(() => exit.mock.calls.length, { timeout: 5000 }).toBeGreaterThan(0);
    }
  }, 20_000);
});
