import { it, expect } from "vitest";
import { Pool } from "pg";
import { acquireWorkerLease } from "../src/runtime/worker-lease.js";
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
