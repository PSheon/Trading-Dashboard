import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

/**
 * Migration 0071 (the one signing model, 2026-10-07): a setup still in
 * flight under the browser-signed path (`owner_session`) ends failed with
 * `signer_model_changed`; the browser-signed columns and checks are dropped.
 * The pre-0071 schema is rebuilt inside a transaction that is rolled back,
 * so no other spec sees it.
 */
const db = getTestDb();
const migration = readFileSync(fileURLToPath(new URL("../../../packages/shared/drizzle/0071_one_signing_model.sql", import.meta.url)), "utf8");
class Rollback extends Error {}

beforeEach(async () => { await truncateAll(db); });
afterAll(closeTestDb);

describe("migration 0071: one signing model", () => {
  it("fails in-flight owner_session setups with signer_model_changed, leaves the rest, and drops the browser-signed columns", async () => {
    const uid = (await insertUser(db, { privyUserId: "did:privy:migration-owner" })).id;
    const result = await db.transaction(async tx => {
      // The schema as 0070 left it.
      await tx.execute(sql.raw(`
        ALTER TABLE "copy_live_setups" DROP CONSTRAINT "copy_live_setups_consent_check";
        ALTER TABLE "copy_live_setups" ADD COLUMN "signer_kind" text, ADD COLUMN "pending_signature" jsonb, ADD COLUMN "owner_signature" jsonb;
        ALTER TABLE "copy_live_setups" ADD CONSTRAINT "copy_live_setups_signer_check" CHECK ("signer_kind" is null or "signer_kind" in ('owner_session', 'worker_policy'));
        ALTER TABLE "copy_live_setups" ADD CONSTRAINT "copy_live_setups_consent_check" CHECK ("stage" in ('provisioning', 'awaiting_consent', 'failed', 'expired', 'cancelled') or ("consent_digest" ~ '^[0-9a-f]{64}$' and "intent_digest" ~ '^[0-9a-f]{64}$' and "confirmed_at" is not null and "signer_kind" is not null and "setup_deadline" is not null));
        ALTER TABLE "copy_funding_operations" ADD COLUMN "signer_kind" text;
        ALTER TABLE "copy_funding_operations" ADD CONSTRAINT "copy_funding_signer_kind_check" CHECK ("signer_kind" is null or "signer_kind" in ('owner_session', 'worker_policy'));`));
      const strategies = await tx.execute<{ id: number }>(sql`insert into copy_strategies (user_id, leader_address, allocated, cash, activated_at)
        select ${uid}, '0x' || repeat(to_hex(n), 40 / length(to_hex(n))), '100', '100', now() from generate_series(10, 14) n returning id`);
      const [owned, worker, running, unconfirmed, ended] = strategies.rows.map(row => row.id);
      const setup = (id: string, strategyId: number, stage: string, signer: string | null) => sql`insert into copy_live_setups
        (id, user_id, strategy_id, kind, idempotency_key, stage, signer_kind, leader_address, source_network, budget_usd, settings, intent_digest, consent_digest, confirmed_at, setup_deadline,
         pending_signature, owner_signature, next_attempt_at)
        values (${id}, ${uid}, ${strategyId}, 'start', ${`migration-key-${id}`}, ${stage}, ${signer}, ${`0x${"44".repeat(20)}`}, 'mainnet', '100', '{}'::jsonb,
          ${stage === "awaiting_consent" ? null : "a".repeat(64)}, ${stage === "awaiting_consent" ? null : "b".repeat(64)}, ${stage === "awaiting_consent" ? null : new Date()},
          ${stage === "awaiting_consent" ? null : new Date(Date.now() + 86_400_000)},
          ${signer === "owner_session" ? JSON.stringify({ kind: "account_mode", digest: `0x${"cd".repeat(32)}` }) : null}::jsonb, null, now())`;
      await tx.execute(setup("owner-funded", owned!, "funded", "owner_session"));
      await tx.execute(setup("worker-funded", worker!, "funded", "worker_policy"));
      await tx.execute(setup("owner-running", running!, "running", "owner_session"));
      await tx.execute(setup("not-confirmed", unconfirmed!, "awaiting_consent", null));
      await tx.execute(setup("owner-expired", ended!, "expired", "owner_session"));
      for (const statement of migration.split("--> statement-breakpoint")) await tx.execute(sql.raw(statement));
      const rows = await tx.execute<{ id: string; stage: string; issue: string | null; next_attempt_at: Date | null; revision: number }>(
        sql`select id, stage, issue, next_attempt_at, revision from copy_live_setups order by id`);
      const columns = await tx.execute<{ table_name: string; column_name: string }>(sql`select table_name, column_name from information_schema.columns
        where table_name in ('copy_live_setups', 'copy_funding_operations') and column_name in ('signer_kind', 'pending_signature', 'owner_signature')`);
      const checks = await tx.execute<{ conname: string }>(sql`select conname from pg_constraint where conname in ('copy_live_setups_signer_check', 'copy_funding_signer_kind_check', 'copy_live_setups_consent_check')`);
      // A confirmed setup no longer needs a signer kind to satisfy its consent check.
      await tx.execute(sql`update copy_live_setups set stage = 'funded', issue = null where id = 'worker-funded'`);
      throw new Rollback(JSON.stringify({ rows: rows.rows, columns: columns.rows, checks: checks.rows.map(row => row.conname) }));
    }).catch((error: unknown) => { if (error instanceof Rollback) return JSON.parse(error.message) as { rows: { id: string; stage: string; issue: string | null; next_attempt_at: string | null; revision: number }[]; columns: unknown[]; checks: string[] }; throw error; });
    const byId = Object.fromEntries(result.rows.map(row => [row.id, row]));
    expect(byId["owner-funded"]).toMatchObject({ stage: "failed", issue: "signer_model_changed", next_attempt_at: null, revision: 2 });
    expect(byId["worker-funded"]).toMatchObject({ stage: "funded", issue: null, revision: 1 });
    expect(byId["owner-running"]).toMatchObject({ stage: "running", issue: null, revision: 1 });
    expect(byId["not-confirmed"]).toMatchObject({ stage: "awaiting_consent", revision: 1 });
    expect(byId["owner-expired"]).toMatchObject({ stage: "expired", issue: null, revision: 1 });
    expect(result.columns).toEqual([]);
    expect(result.checks).toEqual(["copy_live_setups_consent_check"]);
  });
});
