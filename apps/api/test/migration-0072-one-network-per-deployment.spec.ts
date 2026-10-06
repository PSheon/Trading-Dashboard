import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

/**
 * Migration 0072 (one network per deployment, 2026-10-07): every check that
 * pinned `network = 'testnet'` accepts mainnet rows, and an actual copy
 * records its network (existing copies: testnet), so the same trader can be
 * copied once per network. The pre-0072 schema is rebuilt inside a
 * transaction that is rolled back, so no other spec sees it.
 */
const db = getTestDb();
const migration = readFileSync(fileURLToPath(new URL("../../../packages/shared/drizzle/0072_one_network_per_deployment.sql", import.meta.url)), "utf8");
const statements = migration.split("--> statement-breakpoint").map(part => part.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
const RELAXED = ["copy_account_modes_states_check", "copy_follower_observation_budget_network_check", "copy_follower_observations_identity_check", "copy_live_builder_approvals_check",
  "copy_live_evidence_identity_check", "copy_live_mandates_network_check", "copy_live_baseline_identity_check", "copy_live_risk_reservations_identity_check", "copy_live_stops_identity_check"];
class Rollback extends Error {}

beforeEach(async () => { await truncateAll(db); });
afterAll(closeTestDb);

describe("migration 0072: one network per deployment", () => {
  it("accepts mainnet rows in every network check, keeps existing rows as testnet copies, and lets a trader be copied once per network", async () => {
    const uid = (await insertUser(db, { privyUserId: "did:privy:migration-0072" })).id;
    const leader = `0x${"44".repeat(20)}`;
    const result = await db.transaction(async tx => {
      // The schema as 0071 left it: each relaxed check pinned to testnet, no copy network.
      const adds = statements.filter(s => / ADD CONSTRAINT "(?:copy_[a-z_]+)" CHECK/.test(s) && RELAXED.some(name => s.includes(`"${name}"`)));
      expect(adds).toHaveLength(RELAXED.length);
      for (const add of adds) {
        const table = /ALTER TABLE "([a-z_]+)"/.exec(add)![1], name = /ADD CONSTRAINT "([a-z_]+)"/.exec(add)![1];
        await tx.execute(sql.raw(`ALTER TABLE "${table}" DROP CONSTRAINT "${name}"`));
        await tx.execute(sql.raw(add.replace(/"network" in \('testnet','mainnet'\)/, `"network" = 'testnet'`)));
      }
      await tx.execute(sql.raw(`ALTER TABLE "copy_strategies" DROP CONSTRAINT "copy_strategies_network_check"; DROP INDEX "copy_strategies_live_uq";
        ALTER TABLE "copy_strategies" DROP COLUMN "network";
        CREATE UNIQUE INDEX "copy_strategies_live_uq" ON "copy_strategies" USING btree ("user_id","chain","leader_address","mode") WHERE status <> 'stopped';`));
      // An existing (testnet) copy and observation budget.
      await tx.execute(sql`insert into copy_strategies (user_id, leader_address, mode, status, pause_new_risk, allocated, cash, activated_at)
        values (${uid}, ${leader}, 'testnet', 'active', false, 0, 0, now())`);
      await tx.execute(sql`insert into copy_follower_observation_budget (network, next_allowed_at) values ('testnet', now())`);
      const refusedBefore = await tx.transaction(async inner => {
        await inner.execute(sql`insert into copy_follower_observation_budget (network, next_allowed_at) values ('mainnet', now())`); return false;
      }).catch(() => true);

      for (const statement of statements) await tx.execute(sql.raw(statement));

      await tx.execute(sql`insert into copy_follower_observation_budget (network, next_allowed_at) values ('mainnet', now())`);
      // The same trader, copied on mainnet beside the testnet copy.
      await tx.execute(sql`insert into copy_strategies (user_id, leader_address, mode, network, status, pause_new_risk, allocated, cash, activated_at)
        values (${uid}, ${leader}, 'testnet', 'mainnet', 'paused', true, 0, 0, now())`);
      const duplicate = await tx.transaction(async inner => {
        await inner.execute(sql`insert into copy_strategies (user_id, leader_address, mode, network, status, pause_new_risk, allocated, cash, activated_at)
          values (${uid}, ${leader}, 'testnet', 'mainnet', 'paused', true, 0, 0, now())`); return false;
      }).catch(() => true);
      const unknownNetwork = await tx.transaction(async inner => {
        await inner.execute(sql`insert into copy_strategies (user_id, leader_address, mode, network, status, pause_new_risk, allocated, cash, activated_at)
          values (${uid}, ${`0x${"45".repeat(20)}`}, 'testnet', 'devnet', 'paused', true, 0, 0, now())`); return false;
      }).catch(() => true);
      const strategies = await tx.execute<{ network: string; status: string }>(sql`select network, status from copy_strategies order by id`);
      const checks = await tx.execute<{ conname: string; def: string }>(sql`select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conname in (${sql.join(RELAXED.map(name => sql`${name}`), sql`, `)})`);
      throw new Rollback(JSON.stringify({ refusedBefore, duplicate, unknownNetwork, strategies: strategies.rows, checks: checks.rows }));
    }).catch((error: unknown) => {
      if (error instanceof Rollback) return JSON.parse(error.message) as { refusedBefore: boolean; duplicate: boolean; unknownNetwork: boolean;
        strategies: { network: string; status: string }[]; checks: { conname: string; def: string }[] };
      throw error;
    });
    expect(result.refusedBefore).toBe(true);
    expect(result.strategies).toEqual([{ network: "testnet", status: "active" }, { network: "mainnet", status: "paused" }]);
    expect(result.duplicate).toBe(true);
    expect(result.unknownNetwork).toBe(true);
    expect(result.checks.map(row => row.conname).sort()).toEqual([...RELAXED].sort());
    for (const row of result.checks) {
      expect(row.def).toContain("'mainnet'");
      expect(row.def).not.toMatch(/network\)? = 'testnet'::text\)? AND/);
    }
  });

  it("the current schema (after 0072) takes a mainnet row in each relaxed table's network check", async () => {
    const rows = await db.execute<{ conname: string; def: string }>(sql`select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conname in (${sql.join(RELAXED.map(name => sql`${name}`), sql`, `)})`);
    expect(rows.rows).toHaveLength(RELAXED.length);
    for (const row of rows.rows) expect(row.def).toContain("'mainnet'");
  });
});
