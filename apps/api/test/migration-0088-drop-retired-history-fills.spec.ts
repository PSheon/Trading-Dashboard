import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 0088 (cost reduction 2026-10-22, §1 #1): the retired raw history
 * fills (4.4 GB on Stage, read by nothing since the 0021 conversion renamed
 * them) are dropped, with the conversion's cursor, as `history:convert drop`
 * does; a database still mid-conversion keeps its raw table and cursor. The
 * migration's own statements are replayed on scratch copies of the tables.
 */
const FOLDER = fileURLToPath(new URL("../../../packages/shared/drizzle/", import.meta.url));
const TAG = "0088_drop_retired_history_fills";
const statements = () => readFileSync(`${FOLDER}${TAG}.sql`, "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);

let pool: Pool, client: PoolClient;
beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  client = await pool.connect();
});
const drop = () => client.query("DROP TABLE IF EXISTS analysis_history_fills, analysis_history_fills_retired, analysis_history_fills_conversion");
beforeEach(drop);
afterAll(async () => { await drop(); client.release(); await pool.end(); });

const exists = async (table: string) => (await client.query<{ found: boolean }>("SELECT to_regclass($1) IS NOT NULL AS found", [`public.${table}`])).rows[0]!.found;
const raw = (table: string) => client.query(`CREATE TABLE ${table} (chain text NOT NULL DEFAULT 'hyperliquid', address text NOT NULL, source text NOT NULL,
  tid bigint NOT NULL, "time" timestamptz NOT NULL, raw jsonb NOT NULL, origin text NOT NULL DEFAULT 'rest', PRIMARY KEY (chain, address, source, tid))`);
const cursor = () => client.query("CREATE TABLE analysis_history_fills_conversion (id boolean PRIMARY KEY DEFAULT true CHECK (id), cursor jsonb, copied bigint NOT NULL DEFAULT 0, copy_finished_at timestamptz)");
const migrate = async () => { for (const statement of statements()) await client.query(statement); };

describe("migration 0088: the retired raw history fills are dropped", () => {
  it("is in the journal, so the release's migrator applies it", () => {
    const journal = JSON.parse(readFileSync(`${FOLDER}meta/_journal.json`, "utf8")) as { entries: { tag: string; when: number }[] };
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    // The migrator reads the journal in order: this entry's statements are the file's.
    const entry = readMigrationFiles({ migrationsFolder: FOLDER })[at]!;
    expect(entry.folderMillis).toBe(journal.entries[at]!.when);
    expect(entry.sql.join("\n")).toContain('DROP TABLE IF EXISTS "analysis_history_fills_retired"');
  });

  it("a converted database loses the retired table and the conversion cursor", async () => {
    await raw("analysis_history_fills_retired");
    await client.query(`INSERT INTO analysis_history_fills_retired (address, source, tid, "time", raw) VALUES ('0xab', 'regular', 1, now(), '{}')`);
    await cursor();
    await migrate();
    expect([await exists("analysis_history_fills_retired"), await exists("analysis_history_fills_conversion")]).toEqual([false, false]);
    // history_fills, the converted store, is untouched.
    expect(await exists("history_fills")).toBe(true);
  });

  it("a database mid-conversion keeps its raw table and cursor; one with neither table is a no-op", async () => {
    await raw("analysis_history_fills");
    await cursor();
    await migrate();
    expect([await exists("analysis_history_fills"), await exists("analysis_history_fills_conversion")]).toEqual([true, true]);
    await drop();
    await expect(migrate()).resolves.toBeUndefined();
  });
});
