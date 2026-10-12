import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@trading-dashboard/shared/database";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, getTestDb } from "./db-test-utils.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { PostgresHyperliquidQuota } from "../src/hyperliquid/postgres-hyperliquid-quota.js";

/**
 * The meter reads a key's active leases in every quota transaction, order
 * path included. hyperliquid_ws_leases keeps closed rows (until retention),
 * and a btree on (egress_key, state) cannot serve `state <> 'closed'`: the
 * read scanned every closed row of the key inside the meter's lock. It must
 * go through the partial index of nonclosed leases.
 */
const egressKey = "plan-egress";
let pool: Pool;
let queries: Array<{ query: string; params: unknown[] }>;
let meter: PostgresHyperliquidQuota;
const db = getTestDb();

beforeAll(() => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
  queries = [];
  const logged = drizzle(pool, { schema, logger: { logQuery: (query, params) => { queries.push({ query, params }); } } });
  meter = new PostgresHyperliquidQuota(new UnitOfWork(logged));
});
beforeEach(async () => {
  await db.delete(schema.hyperliquidWsLeases);
  await db.delete(schema.hyperliquidEgressQuota);
  queries.length = 0;
});
afterAll(async () => {
  await db.delete(schema.hyperliquidWsLeases);
  await db.delete(schema.hyperliquidEgressQuota);
  await pool?.end();
  await closeTestDb();
});

async function seedClosed(n: number) {
  await db.insert(schema.hyperliquidEgressQuota).values({ egressKey, events: [], updatedAt: new Date() });
  await db.execute(sql`
    INSERT INTO hyperliquid_ws_leases (id, egress_key, socket_id, fence_token, owner_id, state, lease_until, latest_allowed_send_at, created_at, updated_at, closed_at)
    SELECT 'closed-' || g, ${egressKey}, 'socket-' || g, repeat('a', 64), 'worker-old', 'closed',
      now() - interval '2 days' + interval '1 minute', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days'
    FROM generate_series(1, ${n}) g`);
  await db.execute(sql`ANALYZE hyperliquid_ws_leases`);
}

describe("the meter's active-lease read", () => {
  it("uses the partial index of nonclosed leases, not a scan of the closed ones", async () => {
    await seedClosed(5_000);
    const { connection } = await meter.bindUnscoped({ egressKey, ownerId: "worker-a" }).reserveSocket(Date.now() + 5_000);
    const read = queries.find((q) => /from "hyperliquid_ws_leases"/i.test(q.query) && /"lease_until" >/.test(q.query));
    expect(read).toBeDefined();
    const plan = await pool.query(`EXPLAIN (FORMAT JSON) ${read!.query}`, read!.params);
    const text = JSON.stringify(plan.rows[0]["QUERY PLAN"]);
    expect(text).toContain("hyperliquid_ws_active_lease_idx");
    expect(text).not.toContain("Seq Scan");
    // Semantics unchanged: the new lease is the one nonclosed row read back.
    await connection.cancelBeforeConnect();
    const rows = await db.select().from(schema.hyperliquidWsLeases).where(sql`${schema.hyperliquidWsLeases.state} <> 'closed'`);
    expect(rows).toHaveLength(0);
    expect(await db.$count(schema.hyperliquidWsLeases)).toBe(5_001);
  });

  it("still sees every live lease of the key, and the eleventh connection is refused", async () => {
    await seedClosed(200);
    const bound = meter.bindUnscoped({ egressKey, ownerId: "worker-a" });
    for (let i = 0; i < 10; i++) await bound.reserveSocket(Date.now() + 5_000);
    await expect(bound.reserveSocket(Date.now() + 5_000)).rejects.toThrow("hyperliquid_quota_connections");
  });
});
