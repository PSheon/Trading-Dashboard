import { it, expect } from "vitest";
import { Pool } from "pg";
import { acquireWorkerLease, WORKER_LEASE_SESSION_OPTIONS } from "../src/runtime/worker-lease.js";
it("allows one worker per database and releases ownership on shutdown", async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL required");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const a = await pool.connect(), b = await pool.connect();
  try {
    expect(await acquireWorkerLease(a)).toBe(true);
    expect(await acquireWorkerLease(b)).toBe(false);
    await a.query("SELECT pg_advisory_unlock_all()");
    expect(await acquireWorkerLease(b)).toBe(true);
  } finally { a.release(true); b.release(true); await pool.end(); }
});

it("a lease holder that goes silent (a network partition) loses the lease to the server's idle limit", async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL required");
  // The production options are accepted by the server and set the limits.
  const production = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1, options: WORKER_LEASE_SESSION_OPTIONS });
  try {
    const settings = await production.query<{ idle: string; keepalive: string }>("SELECT current_setting('idle_session_timeout') AS idle, current_setting('tcp_keepalives_idle') AS keepalive");
    expect(settings.rows[0]).toEqual({ idle: "30s", keepalive: "10" });
  } finally { await production.end(); }
  // The same mechanism, faster: the silent holder's session ends and another worker takes over.
  const silent = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1, options: WORKER_LEASE_SESSION_OPTIONS.replace("30s", "1s") });
  silent.on("error", () => undefined);
  const standby = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  const holder = await silent.connect(), next = await standby.connect();
  holder.on("error", () => undefined);
  try {
    expect(await acquireWorkerLease(holder)).toBe(true);
    expect(await acquireWorkerLease(next)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 2500));
    expect(await acquireWorkerLease(next)).toBe(true);
  } finally { holder.release(true); next.release(true); await silent.end().catch(() => undefined); await standby.end(); }
});
