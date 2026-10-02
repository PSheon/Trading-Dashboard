import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { Pool } from "pg";

import { canonicalJson } from "../src/analytics/fill-codec.js";
import type { HlUserFill } from "../src/hyperliquid/types.js";
import { conversionStatus, copyFills, dropRetired, exact, finishConversion, verifyFills } from "../src/traders/convert-history-fills.js";
import { HistoryFillStore, HistoryNotConvertedError } from "../src/traders/history-fill.store.js";
import { ALL_SHAPES } from "./fill-shapes.js";
import { closeTestDb, getTestDb, storedFills, truncateAll } from "./db-test-utils.js";

const expected = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/archive/expected.json", import.meta.url)), "utf8")) as Record<string, HlUserFill[]>;
const ODD = `0x${"0d".repeat(20)}`;
const quiet = { batch: 97, log: () => undefined };

/** Rows of the raw layout as the previous release wrote them: archive
 * fixtures (origin s3) and every odd shape (origin rest). */
const RAW = [
  ...Object.entries(expected).flatMap(([address, fills]) => fills.map((fill) => ({ address, source: fill.twapId == null ? "regular" : "twap", origin: "s3", fill }))),
  ...ALL_SHAPES.map((fill) => ({ address: ODD, source: fill.twapId == null ? "regular" : "twap", origin: "rest", fill })),
];

describe("conversion of raw history fills to typed columns", () => {
  const db = getTestDb();
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 });
  const exists = async (table: string) => (await db.execute<{ found: boolean }>(sql`SELECT to_regclass(${table}) IS NOT NULL AS found`)).rows[0].found;
  const insertRaw = async (rows: typeof RAW) => {
    for (const row of rows) {
      await db.execute(sql`INSERT INTO analysis_history_fills (address, source, tid, "time", raw, origin)
        VALUES (${row.address}, ${row.source}, ${row.fill.tid}, ${new Date(row.fill.time).toISOString()}::timestamptz, ${JSON.stringify(row.fill)}::jsonb, ${row.origin})`);
    }
  };

  beforeEach(async () => {
    await truncateAll(db);
    await db.execute(sql`DROP TABLE IF EXISTS analysis_history_fills, analysis_history_fills_retired, analysis_history_fills_conversion`);
    // The raw table exactly as migrations 0013 and 0017 left it.
    await db.execute(sql`CREATE TABLE analysis_history_fills (chain text DEFAULT 'hyperliquid' NOT NULL, address text NOT NULL, source text NOT NULL, tid bigint NOT NULL,
      "time" timestamptz NOT NULL, raw jsonb NOT NULL, origin text DEFAULT 'rest' NOT NULL, PRIMARY KEY (chain, address, source, tid))`);
    await insertRaw(RAW);
  });
  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS analysis_history_fills, analysis_history_fills_retired, analysis_history_fills_conversion`);
    await pool.end();
    await closeTestDb();
  });

  it("copy, verify, finish: every row matches, the raw table is retired, and the release's store reads the same fills", async () => {
    expect(await copyFills(db, quiet)).toBe(RAW.length);
    const verification = await verifyFills(db, quiet);
    expect(verification).toMatchObject({ raw: RAW.length, typed: RAW.length, compared: RAW.length, missing: 0, different: 0, extra: 0 });
    expect(exact(verification)).toBe(true);
    await expect(new HistoryFillStore(db).read(ODD)).rejects.toThrow(HistoryNotConvertedError);

    expect(await finishConversion(pool, db, quiet)).toMatchObject({ retired: true, compared: RAW.length });
    expect([await exists("analysis_history_fills"), await exists("analysis_history_fills_retired")]).toEqual([false, true]);
    const stored = await storedFills(db);
    expect(stored).toHaveLength(RAW.length);
    const key = (address: string, source: string, tid: number) => `${address}:${source}:${tid}`;
    const byKey = new Map(stored.map((row) => [key(row.address, row.source, row.tid), row]));
    for (const row of RAW) {
      const got = byKey.get(key(row.address, row.source, row.fill.tid))!;
      expect([got.origin, canonicalJson(got.fill)]).toEqual([row.origin, canonicalJson(row.fill)]);
    }
    // The retired copy can still be verified against, until it is dropped.
    expect(exact(await verifyFills(db, { ...quiet, table: "analysis_history_fills_retired" }))).toBe(true);
    await dropRetired(db, quiet.log);
    expect([await exists("analysis_history_fills_retired"), await exists("analysis_history_fills_conversion")]).toEqual([false, false]);
  });

  it("an interrupted copy resumes at its cursor: no row is copied twice or skipped", async () => {
    // A row the copy refuses (it does not describe itself consistently) stops it midway.
    const middle = [...RAW].sort((a, b) => (a.address + a.source).localeCompare(b.address + b.source) || a.fill.tid - b.fill.tid)[Math.floor(RAW.length / 2)];
    await db.execute(sql`UPDATE analysis_history_fills SET "time" = "time" + interval '1 second' WHERE address = ${middle.address} AND source = ${middle.source} AND tid = ${middle.fill.tid}`);
    await expect(copyFills(db, quiet)).rejects.toThrow(/raw.time differs/);
    const copied = Number((await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM history_fills`)).rows[0].n);
    const cursor = (await db.execute<{ copied: string; copy_finished_at: Date | null }>(sql`SELECT copied, copy_finished_at FROM analysis_history_fills_conversion`)).rows[0];
    // Whole batches committed together with the cursor; the failing batch stored nothing.
    expect(copied).toBeGreaterThan(0);
    expect(copied % quiet.batch).toBe(0);
    expect([Number(cursor.copied), cursor.copy_finished_at]).toEqual([copied, null]);
    expect((await verifyFills(db, quiet)).missing).toBe(RAW.length - copied);

    await db.execute(sql`UPDATE analysis_history_fills SET "time" = "time" - interval '1 second' WHERE address = ${middle.address} AND source = ${middle.source} AND tid = ${middle.fill.tid}`);
    expect(await copyFills(db, quiet)).toBe(RAW.length - copied);
    expect(exact(await verifyFills(db, quiet))).toBe(true);
    // Nothing left: a further run copies no row.
    expect(await copyFills(db, quiet)).toBe(0);
  });

  it("rows the previous release wrote after the copy passed them are caught at finish", async () => {
    await copyFills(db, quiet);
    // Behind the cursor (an early address) and ahead of it.
    const late = [{ address: `0x${"00".repeat(20)}`, source: "regular", origin: "rest", fill: { ...ALL_SHAPES[0], tid: 900_001 } },
      { address: ODD, source: "twap", origin: "s3", fill: { ...ALL_SHAPES[0], tid: 900_002, twapId: 5 } }];
    await insertRaw(late);
    expect(await verifyFills(db, quiet)).toMatchObject({ missing: 2, different: 0 });
    expect(await finishConversion(pool, db, quiet)).toMatchObject({ retired: true, raw: RAW.length + 2, compared: RAW.length + 2, missing: 0 });
    expect((await storedFills(db, late[0].address)).map((row) => row.tid)).toEqual([900_001]);
  });

  it("a single differing value keeps the raw table: finish verifies before it renames", async () => {
    await copyFills(db, quiet);
    await db.execute(sql`UPDATE history_fills SET px = px + 0 WHERE tid = (SELECT min(tid) FROM history_fills)`);
    expect(exact(await verifyFills(db, quiet))).toBe(true);
    // "64585.0" stored as "64585.00": numerically equal, not the string Hyperliquid sent.
    await db.execute(sql`UPDATE history_fills SET px = (px::text || '0')::numeric WHERE tid = (SELECT max(tid) FROM history_fills)`);
    const lines: string[] = [];
    const result = await finishConversion(pool, db, { ...quiet, log: (line) => lines.push(line) });
    expect(result).toMatchObject({ retired: false, different: 1 });
    expect(lines.join("\n")).toMatch(/NOT retired/);
    expect([await exists("analysis_history_fills"), await exists("analysis_history_fills_retired")]).toEqual([true, false]);
    await expect(dropRetired(db, quiet.log)).rejects.toThrow(/still exists/);
    // Writers were blocked only for the attempt.
    await insertRaw([{ address: ODD, source: "regular", origin: "rest", fill: { ...ALL_SHAPES[0], tid: 900_003 } }]);
    await conversionStatus(db, (line) => lines.push(line));
    expect(lines.at(-1)).toMatch(/^cursor: /);
  });
});
