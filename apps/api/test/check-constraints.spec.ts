import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { copyLegEnum, copyOrderStatusEnum, copyStrategyStatusEnum, userRoleEnum } from "@trading-dashboard/shared/contracts";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error a plain .mjs script without types
import { parseChecks } from "../../../scripts/verify-check-constraints.mjs";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

const db = getTestDb();
const migrations = fileURLToPath(new URL("../../../packages/shared/drizzle/", import.meta.url));
const checks: Array<{ table: string; name: string; expression: string }> = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()
  .flatMap((f) => parseChecks(readFileSync(migrations + f, "utf8")));

/** The constraint a statement is refused by; null when it is accepted. Each attempt is rolled back. */
async function refusedBy(statement: ReturnType<typeof sql>): Promise<string | null> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(statement);
      tx.rollback();
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string; constraint?: string } }).cause ?? (error as { code?: string; constraint?: string });
    if (cause.code === "23514") return cause.constraint ?? "check";
    if (/Rollback/i.test(String(error))) return null;
    throw error;
  }
  return null;
}

beforeEach(async () => { await truncateAll(db); });
afterAll(closeTestDb);

describe("CHECK constraints (review finding 10)", () => {
  it("every constraint a migration adds exists in the database, under its name, on its table", async () => {
    expect(checks.length).toBeGreaterThanOrEqual(60);
    const { rows } = await db.execute(sql`select conrelid::regclass::text as "table", conname as name from pg_constraint where contype = 'c' and connamespace = 'public'::regnamespace`);
    const present = new Set(rows.map((r) => `${r.table}.${r.name}`));
    expect(checks.filter((c) => !present.has(`${c.table}.${c.name}`))).toEqual([]);
  });

  it("the enum lists in the constraints are the shared enums (a new value needs a migration, and this test says so)", () => {
    const listOf = (name: string) => [...checks.find((c) => c.name === name)!.expression.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(listOf("copy_orders_status_check")).toEqual([...copyOrderStatusEnum]);
    expect(listOf("copy_orders_leg_check")).toEqual([...copyLegEnum]);
    expect(listOf("copy_strategies_status_check")).toEqual([...copyStrategyStatusEnum]);
    expect(listOf("users_role_check")).toEqual([...userRoleEnum]);
  });

  it("refuses text the code would not understand", async () => {
    expect(await refusedBy(sql`insert into users (privy_user_id, role) values ('did:privy:x', 'root')`)).toBe("users_role_check");
    expect(await refusedBy(sql`insert into users (privy_user_id, role) values ('did:privy:x', 'operator')`)).toBeNull();
    // A locale is deliberately free text: a new language needs no migration.
    expect(await refusedBy(sql`insert into users (privy_user_id, locale) values ('did:privy:x', 'fr')`)).toBeNull();
    expect(await refusedBy(sql`insert into leaders (address, source) values ('0xabc', 'friend')`)).toBe("leaders_source_check");
    expect(await refusedBy(sql`insert into leaders (address, tier) values ('0xabc', 'D')`)).toBe("leaders_tier_check");
    expect(await refusedBy(sql`insert into actions (address, coin, kind, side, notional_usd, avg_px, fill_ids, ts) values ('0xabc', 'BTC', 'open', 'B', 1, 1, '{}', now())`)).toBe("actions_side_check");
    expect(await refusedBy(sql`insert into actions (address, coin, kind, side, notional_usd, avg_px, fill_ids, ts) values ('0xabc', 'BTC', 'hedge', 'long', 1, 1, '{}', now())`)).toBe("actions_kind_check");
    expect(await refusedBy(sql`insert into app_settings (key, value) values ('billing', '{}')`)).toBe("app_settings_key_check");
    expect(await refusedBy(sql`insert into admin_audit_logs (actor_kind, event, target) values ('robot', 'x', 'y')`)).toBe("admin_audit_logs_actor_kind_check");
    expect(await refusedBy(sql`insert into copy_signal_outbox (address, tid, fill_time, status) values ('0xabc', 1, now(), 'skipped')`)).toBe("copy_signal_outbox_status_check");
  });

  it("refuses money and sizes the copy engine assumes can't happen", async () => {
    const user = await insertUser(db);
    expect(await refusedBy(sql`insert into paper_accounts (user_id, balance, starting_balance) values (${user.id}, -0.01, 10000)`)).toBe("paper_accounts_balance_check");
    await db.execute(sql`insert into paper_accounts (user_id, balance, starting_balance) values (${user.id}, 9000, 10000)`);
    expect(await refusedBy(sql`update paper_accounts set balance = balance - 9000.00000001`)).toBe("paper_accounts_balance_check");

    const strategy = (values: string) => sql.raw(`insert into copy_strategies (user_id, leader_address, allocated, cash, activated_at${values}`);
    expect(await refusedBy(strategy(`) values (${user.id}, '0xabc', 0, 0, now())`))).toBe("copy_strategies_amounts_check");
    expect(await refusedBy(strategy(`, status) values (${user.id}, '0xabc', 100, 100, now(), 'closed')`))).toBe("copy_strategies_status_check");
    // Stopped needs its time, and what a stopped copy returned was not negative.
    expect(await refusedBy(strategy(`, status) values (${user.id}, '0xabc', 100, 100, now(), 'stopped')`))).toBe("copy_strategies_stopped_check");
    expect(await refusedBy(strategy(`, status, stopped_at) values (${user.id}, '0xabc', 100, -5, now(), 'stopped', now())`))).toBe("copy_strategies_stopped_check");
    // Below zero with a position open is a cross-margin account in profit elsewhere: allowed.
    expect(await refusedBy(strategy(`) values (${user.id}, '0xabc', 100, -5, now())`))).toBeNull();

    const { rows: [s] } = await db.execute(strategy(`) values (${user.id}, '0xabc', 100, 100, now()) returning id`));
    const order = (cols: string, values: string) => sql.raw(
      `insert into copy_orders (cloid, strategy_id, user_id, strategy_version, risk_policy_version, leader_address, coin, signal_px, signal_time, signal_tids, control_revisions${cols}) ` +
      `values ('0x' || md5(random()::text), ${s!.id}, ${user.id}, 1, 0, '0xabc', 'BTC', 100, now(), '{}', '{}'${values})`);
    const base = ", leg, side, reduce_only, size, status";
    expect(await refusedBy(order(base, ", 'open', 'B', false, 1, 'risk_approved'"))).toBeNull();
    expect(await refusedBy(order(base, ", 'open', 'B', false, -1, 'risk_approved'"))).toBe("copy_orders_sizes_check");
    expect(await refusedBy(order(`${base}, filled_size`, ", 'open', 'B', false, 1, 'filled', 1.00000001"))).toBe("copy_orders_sizes_check");
    expect(await refusedBy(order(base, ", 'open', 'X', false, 1, 'risk_approved'"))).toBe("copy_orders_side_check");
    expect(await refusedBy(order(base, ", 'open', 'B', false, 1, 'done'"))).toBe("copy_orders_status_check");
    expect(await refusedBy(order(base, ", 'hedge', 'B', false, 1, 'risk_approved'"))).toBe("copy_orders_leg_check");
    // Only reductions are reduce-only, and every reduction is.
    expect(await refusedBy(order(base, ", 'open', 'B', true, 1, 'risk_approved'"))).toBe("copy_orders_reduce_only_check");
    expect(await refusedBy(order(base, ", 'close', 'A', false, 1, 'risk_approved'"))).toBe("copy_orders_reduce_only_check");
    expect(await refusedBy(order(base, ", 'liquidation', 'A', true, 1, 'filled'"))).toBeNull();
    expect(await refusedBy(order(`${base}, fee`, ", 'open', 'B', false, 1, 'filled', -0.5"))).toBe("copy_orders_amounts_check");

    const ledger = (kind: string, amount: string) => sql.raw(`insert into copy_ledger (strategy_id, user_id, kind, amount) values (${s!.id}, ${user.id}, '${kind}', ${amount})`);
    expect(await refusedBy(ledger("fee", "0.5"))).toBe("copy_ledger_sign_check");
    expect(await refusedBy(ledger("allocate", "-100"))).toBe("copy_ledger_sign_check");
    expect(await refusedBy(ledger("release", "100"))).toBe("copy_ledger_sign_check");
    expect(await refusedBy(ledger("liquidation", "-1"))).toBe("copy_ledger_sign_check");
    expect(await refusedBy(ledger("funding", "0"))).toBe("copy_ledger_sign_check");
    expect(await refusedBy(ledger("bonus", "1"))).toBe("copy_ledger_kind_check");
    for (const [kind, amount] of [["fee", "-0.5"], ["realized_pnl", "-12.5"], ["realized_pnl", "12.5"], ["funding", "0.01"], ["funding", "-0.01"], ["release", "-100"], ["liquidation", "3"]]) {
      expect(await refusedBy(ledger(kind!, amount!)), `${kind} ${amount}`).toBeNull();
    }

    const position = (size: string, entry: string, carry: string) => sql.raw(`insert into copy_positions (strategy_id, coin, size, entry_px, reduce_carry) values (${s!.id}, 'BTC', ${size}, ${entry}, ${carry})`);
    expect(await refusedBy(position("0.05", "0", "0"))).toBe("copy_positions_entry_check");
    expect(await refusedBy(position("-0.05", "100000", "0.06"))).toBe("copy_positions_carry_check");
    expect(await refusedBy(position("-0.05", "100000", "0.00004"))).toBeNull();
    expect(await refusedBy(position("0", "0", "0"))).toBeNull();
  });

  it("the verifier reads a migration's checks, from ALTER TABLE and from CREATE TABLE", () => {
    const parsed = parseChecks([
      'CREATE TABLE "retention_state" (\n\t"id" integer PRIMARY KEY NOT NULL,\n\tCONSTRAINT "retention_state_single_row" CHECK ("retention_state"."id" = 1)\n);',
      'ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("users"."role" in (\'user\', \'operator\', \'admin\'));',
      'CREATE INDEX "x" ON "users" USING btree ("id");',
    ].join("\n--> statement-breakpoint\n"));
    expect(parsed).toEqual([
      { table: "retention_state", name: "retention_state_single_row", expression: '"retention_state"."id" = 1' },
      { table: "users", name: "users_role_check", expression: `"users"."role" in ('user', 'operator', 'admin')` },
    ]);
  });
});
