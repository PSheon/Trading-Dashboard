import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthRepository } from "../src/common/auth/auth.repository.js";
import { ADVISORY_LOCKS } from "../src/db/advisory-lock.js";
import { closeTestDb, getTestDb, truncateAll, type TestDb } from "./db-test-utils.js";

/** G8: first-admin bootstrap serializes on BOOTSTRAP's own namespace, not on
 * (7404, 0) inside COPY_USER's (7404, userId) space. */
let db: TestDb, pool: Pool, repository: AuthRepository;
const { namespace } = ADVISORY_LOCKS.BOOTSTRAP;
beforeAll(() => { db = getTestDb(); pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 }); repository = new AuthRepository(db); });
beforeEach(async () => { await truncateAll(db); });
afterAll(async () => { await pool?.end(); await closeTestDb(); });

const input = { privyUserId: "did:privy:bootstrap-lock", email: "boot@example.com", walletAddress: null };

async function waitsOn(classid: number, objid: number, done: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 200 && !done(); attempt++) {
    const { rows } = await pool.query<{ waiting: boolean }>(
      "select exists(select 1 from pg_locks where locktype='advisory' and not granted and objsubid=2 and classid::bigint=$1 and objid::bigint=$2) as waiting",
      [classid, objid]);
    if (rows[0]?.waiting) return true;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return false;
}

describe("first-admin bootstrap advisory lock", () => {
  it("is not in COPY_USER's namespace", () => {
    expect(namespace).not.toBe(ADVISORY_LOCKS.COPY_USER.namespace);
  });

  it("waits on (BOOTSTRAP namespace, 0) and creates the admin once it is released", async () => {
    const holder = await pool.connect();
    let done = false, pending!: Promise<unknown>;
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock($1::integer, 0)", [namespace]);
      pending = repository.createBootstrapCandidate(input).finally(() => { done = true; });
      expect(await waitsOn(namespace, 0, () => done)).toBe(true);
      expect(done).toBe(false);
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    expect(await pending).toMatchObject({ privyUserId: input.privyUserId, role: "admin" });
  });

  it("does not wait on a holder of (7404, 0)", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(7404, 0)");
      const row = await Promise.race([
        repository.createBootstrapCandidate(input),
        new Promise((_, reject) => setTimeout(() => reject(new Error("bootstrap blocked on (7404, 0)")), 2000)),
      ]);
      expect(row).toMatchObject({ role: "admin" });
    } finally {
      await holder.query("rollback");
      holder.release();
    }
  });
});
