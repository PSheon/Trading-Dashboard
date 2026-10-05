import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { deletedBeforeUser, purgeStatements, STRATEGY_RECORD_TABLES, USER_REFERENCES } from "../src/users/account-closure.plan.js";
import { closeTestDb, getTestDb } from "./db-test-utils.js";

/**
 * Guards account deletion against new tables (docs/account-deletion.md):
 * reads the migrated schema's foreign keys and columns and fails when
 * something that holds a user id isn't handled, so deletion can never stop
 * on a foreign key error again and the retention purge never leaves a row
 * behind (or fails on one).
 */
const db = getTestDb();
afterAll(async () => { await closeTestDb(); });

type ForeignKey = { child: string; column: string; parent: string; action: "a" | "r" | "c" | "n" | "d" };
async function foreignKeys(): Promise<ForeignKey[]> {
  const { rows } = await db.execute<ForeignKey>(sql`
    select c.conrelid::regclass::text as child, a.attname as column, c.confrelid::regclass::text as parent, c.confdeltype as action
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace`);
  return rows;
}
const cascades = (action: ForeignKey["action"]) => action === "c" || action === "n" || action === "d";

describe("account deletion handles every reference to a user", () => {
  it("every foreign key to users is listed, with the delete rule its handling needs", async () => {
    const toUsers = (await foreignKeys()).filter((fk) => fk.parent === "users");
    expect(toUsers.length).toBeGreaterThan(30);
    for (const fk of toUsers) {
      const key = `${fk.child}.${fk.column}`;
      const handling = (USER_REFERENCES as Record<string, string>)[key];
      expect(handling, `${key} references users but account-closure.plan.ts doesn't say what deletion does with it`).toBeDefined();
      if (handling === "cascade") expect(fk.action, `${key} is personal data but its foreign key doesn't cascade`).toBe("c");
      if (handling === "set_null") expect(fk.action, `${key} should be ON DELETE SET NULL`).toBe("n");
    }
  });

  it("every column named like a user id is listed, foreign key or not, and every listed column exists", async () => {
    const { rows } = await db.execute<{ ref: string }>(sql`
      select table_name || '.' || column_name as ref from information_schema.columns
      where table_schema = 'public' and data_type = 'integer' and (column_name = 'user_id' or column_name like '%\\_user\\_id' escape '\\')`);
    const listed = new Set(Object.keys(USER_REFERENCES));
    for (const { ref } of rows) expect(listed.has(ref), `${ref} holds a user id but account-closure.plan.ts doesn't list it`).toBe(true);
    const { rows: all } = await db.execute<{ ref: string }>(sql`select table_name || '.' || column_name as ref from information_schema.columns where table_schema = 'public'`);
    const existing = new Set(all.map((r) => r.ref));
    for (const ref of listed) expect(existing.has(ref), `${ref} is listed but not in the schema`).toBe(true);
  });

  it("nothing deleted with the user is still pointed at by a kept record (RESTRICT)", async () => {
    const fks = await foreignKeys();
    // What deleting a users row removes, following cascading keys.
    const removed = new Set(["users"]);
    for (let grew = true; grew;) {
      grew = false;
      for (const fk of fks) if (fk.action === "c" && removed.has(fk.parent) && !removed.has(fk.child)) { removed.add(fk.child); grew = true; }
    }
    const strategyRecords = new Set<string>(STRATEGY_RECORD_TABLES);
    const cleared = new Set(Object.keys(deletedBeforeUser(1)));
    for (const fk of fks) {
      if (!removed.has(fk.parent) || fk.parent === "users" || cascades(fk.action) || cleared.has(`${fk.child}.${fk.column}`)) continue;
      // A copy strategy is kept whenever a record points at it.
      if (fk.parent === "copy_strategies") {
        expect(strategyRecords.has(fk.child), `${fk.child}.${fk.column} points at copy_strategies: add it to STRATEGY_RECORD_TABLES`).toBe(true);
        continue;
      }
      expect.fail(`${fk.child}.${fk.column} restricts deleting ${fk.parent}, which is deleted with the user`);
    }
    // And the list has nothing the schema doesn't.
    const live = new Set(fks.filter((fk) => fk.parent === "copy_strategies" && !cascades(fk.action)).map((fk) => fk.child));
    expect([...strategyRecords].sort()).toEqual([...live].sort());
  });

  it("the purge reaches every record kept under a tombstone, children before parents", async () => {
    const fks = await foreignKeys();
    const plan = purgeStatements(1).map((s) => s.table);
    expect(new Set(plan).size).toBe(plan.length);
    const order = new Map(plan.map((table, i) => [table, i]));
    // The kept records: tombstoned columns' tables, then whatever points at them.
    const kept = new Set<string>(["copy_strategies"]);
    for (const fk of fks) if (fk.parent === "users" && (USER_REFERENCES as Record<string, string>)[`${fk.child}.${fk.column}`] === "tombstone") kept.add(fk.child);
    for (let grew = true; grew;) {
      grew = false;
      for (const fk of fks) if (kept.has(fk.parent) && !cascades(fk.action) && !kept.has(fk.child)) { kept.add(fk.child); grew = true; }
    }
    for (const table of kept) expect(order.has(table), `${table} holds records kept under a tombstone but the purge never deletes it`).toBe(true);
    for (const fk of fks) {
      if (fk.child === fk.parent || cascades(fk.action) || !order.has(fk.child) || !order.has(fk.parent)) continue;
      expect(order.get(fk.child)!, `${fk.child} must be purged before ${fk.parent}`).toBeLessThan(order.get(fk.parent)!);
    }
    expect(plan.at(-1)).toBe("users");
  });
});
