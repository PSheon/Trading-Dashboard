import { describe, expect, it, vi } from "vitest";
import { acquireWorkerOwnership, WORKER_DB_RETRY_WINDOW_MS, type LeaseClient } from "../src/runtime/worker-lease.js";

/**
 * The worker used to exit 3 s after start when Postgres was down, so a DB
 * outage longer than Railway's restart retries left it dead after the
 * database came back (2026-10-12). It now waits the outage out on standby.
 */
type Answer = "down" | "held" | "acquired" | "drop";
function fakePool(script: Answer[]) {
  const clock = { now: 0 };
  const released: boolean[] = [];
  let step = 0;
  const next = () => script[Math.min(step++, script.length - 1)];
  const pool = {
    connects: 0,
    async connect(): Promise<LeaseClient> {
      pool.connects += 1;
      if (next() === "down") throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      return {
        query: (async () => {
          const answer = next();
          if (answer === "drop" || answer === "down") throw new Error("Connection terminated unexpectedly");
          return { rows: [{ acquired: answer === "acquired" }] };
        }) as unknown as LeaseClient["query"],
        release: (destroy?: boolean) => { released.push(destroy === true); },
      };
    },
  };
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); clock.now += ms; };
  const logger = { log: vi.fn(), warn: vi.fn() };
  return { pool, clock, released, sleeps, sleep, logger };
}

describe("worker ownership while the database is down", () => {
  it("retries a refused connection with backoff, then takes the lease once Postgres is back", async () => {
    // Five refused connects, then a connection whose first lease query succeeds
    // (the script's "acquired" answers both the connect and the query).
    const f = fakePool(["down", "down", "down", "down", "down", "acquired"]);
    const client = await acquireWorkerOwnership({ connect: () => f.pool.connect(), signal: new AbortController().signal, logger: f.logger, now: () => f.clock.now, sleep: f.sleep });
    expect(client).toBeDefined();
    expect(f.pool.connects).toBe(6);
    expect(f.sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(f.logger.warn).toHaveBeenCalledTimes(5);
    expect(f.logger.log).toHaveBeenCalledWith("Worker database reachable again");
  });

  it("gives up after the retry window of continuous unavailability", async () => {
    const f = fakePool(["down"]);
    await expect(acquireWorkerOwnership({ connect: () => f.pool.connect(), signal: new AbortController().signal, logger: f.logger, now: () => f.clock.now, sleep: f.sleep }))
      .rejects.toThrow("ECONNREFUSED");
    expect(WORKER_DB_RETRY_WINDOW_MS).toBe(600_000);
    // Backoff caps at 30 s; the last wait ends exactly at the window.
    expect(Math.max(...f.sleeps)).toBe(30_000);
    expect(f.sleeps.reduce((a, b) => a + b, 0)).toBe(WORKER_DB_RETRY_WINDOW_MS);
    expect(f.clock.now).toBe(WORKER_DB_RETRY_WINDOW_MS);
  });

  it("a standby whose connection drops reconnects instead of exiting, and standby itself is not bounded", async () => {
    // connect, held ×700 (700 s of standby, past the 10 min window), the
    // connection drops, reconnect, acquired.
    const script: Answer[] = ["held", ...Array<Answer>(700).fill("held"), "drop", "held", "acquired"];
    const f = fakePool(script);
    const client = await acquireWorkerOwnership({ connect: () => f.pool.connect(), signal: new AbortController().signal, logger: f.logger, now: () => f.clock.now, sleep: f.sleep });
    expect(client).toBeDefined();
    expect(f.pool.connects).toBe(2);
    // The dropped connection was destroyed, not returned to the pool.
    expect(f.released).toEqual([true]);
  });

  it("stops on shutdown", async () => {
    const f = fakePool(["down"]);
    const abort = new AbortController();
    const sleep = async (ms: number) => { await f.sleep(ms); if (f.sleeps.length === 2) abort.abort(); };
    await expect(acquireWorkerOwnership({ connect: () => f.pool.connect(), signal: abort.signal, logger: f.logger, now: () => f.clock.now, sleep })).rejects.toThrow();
    expect(f.pool.connects).toBe(2);
  });
});
