import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIVE_EVIDENCE_MAX_AGE_MS, LIVE_TESTNET_EVIDENCE_MAX_AGE_CAP_MS } from "../src/config/constants/timings.js";

/**
 * Migration 0086 (testnet evidence window, 2026-10-16): the time checks of
 * copy_live_position_baselines and copy_follower_observations, which pinned the
 * live evidence window at 5 s, allow LIVE_TESTNET_EVIDENCE_MAX_AGE_CAP_MS (10 s)
 * on testnet and keep exactly LIVE_EVIDENCE_MAX_AGE_MS (5 s) on mainnet; any
 * other network fails. The migrated database's own constraint definitions, and
 * the previous ones (0046, 0048), are applied to scratch tables without foreign
 * keys, so the bounds are tested alone, before and after.
 */
let pool: Pool, client: PoolClient;
beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  client = await pool.connect();
});
afterAll(async () => { client.release(); await pool.end(); });

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const T0 = Date.parse("2026-10-16T00:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const CAP = LIVE_TESTNET_EVIDENCE_MAX_AGE_CAP_MS, MAIN = LIVE_EVIDENCE_MAX_AGE_MS;

/** The checks as 0048 and 0046 wrote them (the schema before 0086). */
const BEFORE = {
  baseline: "check (extract(epoch from observed_at) > 0 and completed_at >= observed_at and created_at >= completed_at and created_at <= observed_at + interval '5 seconds')",
  observation: "check (completed_at >= observed_at and completed_at <= observed_at + interval '5 seconds' and earliest_provider_time <= completed_at and earliest_provider_time >= completed_at - interval '5 seconds')",
};
const COLUMNS = {
  baseline: "network text not null, observed_at timestamptz not null, completed_at timestamptz not null, created_at timestamptz not null",
  observation: "network text not null, observed_at timestamptz not null, completed_at timestamptz not null, earliest_provider_time timestamptz not null",
};

async function after(name: string): Promise<string> {
  const { rows } = await client.query<{ d: string }>("select pg_get_constraintdef(oid) as d from pg_constraint where conname = $1", [name]);
  expect(rows).toHaveLength(1);
  return rows[0]!.d;
}
/** Whether a scratch table carrying `check` accepts each row (one savepoint each). */
async function verdicts(kind: keyof typeof COLUMNS, check: string, rows: Record<string, string>[]): Promise<boolean[]> {
  await client.query("begin");
  try {
    await client.query(`create temp table probe (${COLUMNS[kind]}) on commit drop`);
    await client.query(`alter table probe add constraint probe_check ${check}`);
    const out: boolean[] = [];
    for (const row of rows) {
      const keys = Object.keys(row);
      await client.query("savepoint one");
      try {
        await client.query(`insert into probe (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, keys.map(k => row[k]));
        await client.query("release savepoint one"); out.push(true);
      } catch (error) {
        await client.query("rollback to savepoint one");
        if ((error as { code?: string }).code !== "23514") throw error;
        out.push(false);
      }
    }
    return out;
  } finally { await client.query("rollback"); }
}

describe("migration 0086: the evidence-window time checks follow the row's network (mainnet 5 s, testnet the 10 s cap)", () => {
  it("copy_live_baseline_time_check: a testnet row at 7 s is refused before and accepted after; mainnet at 5.001 s refused both times", async () => {
    const row = (network: string, createdMs: number) => ({ network, observed_at: at(0), completed_at: at(0), created_at: at(createdMs) });
    const rows = [row("testnet", 7000), row("mainnet", MAIN + 1), row("mainnet", MAIN), row("testnet", 6000), row("testnet", CAP), row("testnet", CAP + 1), row("devnet", 1000),
      { network: "testnet", observed_at: at(0), completed_at: at(2000), created_at: at(1000) }];
    expect(await verdicts("baseline", BEFORE.baseline, rows)).toEqual([false, false, true, false, false, false, true, false]);
    expect(await verdicts("baseline", await after("copy_live_baseline_time_check"), rows)).toEqual([true, false, true, true, true, false, false, false]);
  });

  it("copy_follower_observations_time_check: completed − observed and the provider-time floor, the same way", async () => {
    const span = (network: string, completedMs: number) => ({ network, observed_at: at(0), completed_at: at(completedMs), earliest_provider_time: at(completedMs) });
    const provider = (network: string, ageMs: number) => ({ network, observed_at: at(0), completed_at: at(1000), earliest_provider_time: at(1000 - ageMs) });
    const rows = [span("testnet", 7000), span("mainnet", MAIN + 1), provider("testnet", 7000), provider("mainnet", MAIN + 1),
      span("mainnet", MAIN), provider("mainnet", MAIN), span("testnet", CAP), span("testnet", CAP + 1), provider("testnet", CAP), provider("testnet", CAP + 1), span("devnet", 1000),
      { network: "testnet", observed_at: at(1000), completed_at: at(0), earliest_provider_time: at(0) },
      { network: "mainnet", observed_at: at(0), completed_at: at(1000), earliest_provider_time: at(2000) }];
    expect(await verdicts("observation", BEFORE.observation, rows)).toEqual([false, false, false, false, true, true, false, false, false, false, true, false, false]);
    expect(await verdicts("observation", await after("copy_follower_observations_time_check"), rows)).toEqual([true, false, true, false, true, true, true, false, true, false, false, false, false]);
  });

  it("the testnet bound is LIVE_TESTNET_EVIDENCE_MAX_AGE_CAP_MS (10 s) and the mainnet bound LIVE_EVIDENCE_MAX_AGE_MS (5 s), named where they are written", async () => {
    expect([MAIN, CAP]).toEqual([5000, 10_000]);
    const seconds = (def: string) => [...def.matchAll(/'(\d\d):(\d\d):(\d\d)'::interval/g)].map(m => (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
    const testnetPart = (def: string) => def.slice(def.indexOf("'testnet'"));
    for (const name of ["copy_live_baseline_time_check", "copy_follower_observations_time_check"]) {
      const def = await after(name);
      expect(new Set(seconds(testnetPart(def))), name).toEqual(new Set([CAP]));
      expect(new Set(seconds(def.slice(0, def.indexOf("'testnet'")))), name).toEqual(new Set([MAIN]));
    }
    expect(read("../../../packages/shared/drizzle/0086_testnet_evidence_window.sql")).toContain("LIVE_TESTNET_EVIDENCE_MAX_AGE_CAP_MS");
    expect(read("../../../packages/shared/src/schema/db.ts").match(/LIVE_TESTNET_EVIDENCE_MAX_AGE_CAP_MS, migration 0086/g)).toHaveLength(2);
  });

  it("applies over existing rows: drop and add each check, nothing else; mainnet rows the old check held validate under the new one", async () => {
    const statements = read("../../../packages/shared/drizzle/0086_testnet_evidence_window.sql").split("--> statement-breakpoint")
      .map(part => part.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
    expect(statements.map(s => s.replace(/ CHECK .*/s, ""))).toEqual([
      'ALTER TABLE "copy_follower_observations" DROP CONSTRAINT "copy_follower_observations_time_check";',
      'ALTER TABLE "copy_live_position_baselines" DROP CONSTRAINT "copy_live_baseline_time_check";',
      'ALTER TABLE "copy_follower_observations" ADD CONSTRAINT "copy_follower_observations_time_check"',
      'ALTER TABLE "copy_live_position_baselines" ADD CONSTRAINT "copy_live_baseline_time_check"',
    ]);
    const check = await after("copy_live_baseline_time_check");
    await client.query("begin");
    try {
      await client.query(`create temp table existing (${COLUMNS.baseline}) on commit drop`);
      await client.query(`alter table existing add constraint old_check ${BEFORE.baseline}`);
      for (const ms of [0, 2500, MAIN]) await client.query("insert into existing values ('mainnet', $1, $1, $2)", [at(0), at(ms)]);
      await client.query("alter table existing drop constraint old_check");
      await client.query(`alter table existing add constraint new_check ${check}`);
      expect((await client.query("select count(*)::int as n from existing")).rows[0].n).toBe(3);
    } finally { await client.query("rollback"); }
  });
});
