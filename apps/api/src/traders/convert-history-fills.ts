/**
 * Moves stored fills from the raw layout (`analysis_history_fills`, one
 * `raw jsonb` per row) to the typed one (`history_fills`, migration 0021).
 *
 *   DATABASE_URL=postgres://… pnpm --filter @trading-dashboard/api history:convert <command> [--batch N]
 *
 * Commands:
 *   copy     Copies rows in batches of `--batch` (default 5000), each batch
 *            in its own short transaction together with the cursor, so it can
 *            be interrupted and run again at any time. The raw table is only
 *            read: the running api and worker (previous release) keep using it.
 *   verify   Reads both tables side by side, a page at a time, and compares
 *            every row: the fill rebuilt from the typed columns must equal
 *            the raw JSON value for value. Prints the counts and the first
 *            differences; exit code 1 unless everything matches.
 *   finish   For the moment of the switch, with the previous release stopped:
 *            blocks writes to the raw table, copies what was written since
 *            `copy` went by, verifies every row, then renames the raw table to
 *            `analysis_history_fills_retired`. Nothing is renamed unless the
 *            verification is exact. The new release reads `history_fills` only
 *            and refuses to while the raw table exists.
 *   drop     Drops the retired table and the conversion cursor (frees the
 *            old copy's disk). Separate on purpose: run it when you no longer
 *            want the raw rows as a fallback.
 *   status   Prints the cursor and both tables' row counts.
 *
 * `all` = copy, then finish; does nothing (exit 0) when there is no raw
 * table, so a release command may run it every time.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { canonicalJson } from "../analytics/fill-codec.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { HlUserFill } from "../hyperliquid/types.js";
import { HistoryFillStore, LEGACY_FILLS_TABLE, type FillOrigin, type FillSource } from "./history-fill.store.js";

export const RETIRED_FILLS_TABLE = "analysis_history_fills_retired";
const STATE_TABLE = "analysis_history_fills_conversion";
const DEFAULT_BATCH = 5000;

/** `time_us`: the time column in microseconds, as text (exact; the driver
 * hands timestamps back as strings). */
type RawRow = { chain: string; address: string; source: FillSource; tid: string; time_us: string; raw: HlUserFill; origin: FillOrigin };
/** Of a raw table aliased `o`. `tid` leaves as text, so every ORDER BY names
 * `o.tid`: a bare `tid` would mean this output column and sort as text. */
const RAW_COLUMNS = sql.raw(`o.chain, o.address, o.source, o.tid::text AS tid, (extract(epoch FROM o."time") * 1000000)::bigint::text AS time_us, o.raw, o.origin`);
interface Cursor { address: string; source: string; tid: string }
export interface Verification { raw: number; typed: number; compared: number; missing: number; extra: number; different: number; examples: string[] }
export interface ConvertOptions { batch?: number; log?: (line: string) => void }

const exists = async (db: DrizzleDb, table: string) =>
  (await db.execute<{ found: boolean }>(sql`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS found`)).rows[0].found;
const countOf = async (db: DrizzleDb, table: string) =>
  Number((await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM ${sql.identifier(table)}`)).rows[0].n);

/** A raw row must describe itself consistently before it is converted: the
 * typed row is keyed by the fill's own `tid` and `time`. Null when it does. */
function inconsistency(row: RawRow): string | null {
  if (row.chain !== CHAIN_DEFAULT) return `chain ${row.chain} is not ${CHAIN_DEFAULT}`;
  if (row.source !== "regular" && row.source !== "twap") return "unknown source";
  if (row.origin !== "rest" && row.origin !== "s3") return "unknown origin";
  if (String(row.raw?.tid) !== row.tid) return "raw.tid differs from the key";
  if (!Number.isSafeInteger(row.raw.time) || BigInt(row.raw.time) * 1000n !== BigInt(row.time_us)) return "raw.time differs from the time column";
  return null;
}
function check(row: RawRow): void {
  const problem = inconsistency(row);
  if (problem) throw new Error(`Raw row ${row.address} ${row.source} ${row.tid}: ${problem}`);
}

/** Copies the raw rows after the stored cursor; returns how many this run copied. */
export async function copyFills(db: DrizzleDb, options: ConvertOptions = {}): Promise<number> {
  const log = options.log ?? console.log;
  const batch = options.batch ?? DEFAULT_BATCH;
  const store = new HistoryFillStore(db, "ignore");
  if (!(await exists(db, LEGACY_FILLS_TABLE))) throw new Error(`No ${LEGACY_FILLS_TABLE} table: nothing to copy`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(STATE_TABLE)} (
    id boolean PRIMARY KEY DEFAULT true CHECK (id), cursor jsonb, copied bigint NOT NULL DEFAULT 0, copy_finished_at timestamptz)`);
  await db.execute(sql`INSERT INTO ${sql.identifier(STATE_TABLE)} DEFAULT VALUES ON CONFLICT DO NOTHING`);
  let { cursor, copied } = (await db.execute<{ cursor: Cursor | null; copied: string }>(sql`SELECT cursor, copied FROM ${sql.identifier(STATE_TABLE)}`)).rows[0];
  let done = 0;
  const started = Date.now();
  for (;;) {
    // The raw table's primary key order; chain is constant (checked per row).
    const rows = (await db.execute<RawRow>(sql`
      SELECT ${RAW_COLUMNS} FROM ${sql.identifier(LEGACY_FILLS_TABLE)} o
      WHERE ${cursor ? sql`(o.chain, o.address, o.source, o.tid) > (${CHAIN_DEFAULT}, ${cursor.address}, ${cursor.source}, ${cursor.tid}::bigint)` : sql`true`}
      ORDER BY o.chain, o.address, o.source, o.tid LIMIT ${batch}`)).rows;
    if (rows.length === 0) break;
    rows.forEach(check);
    const last = rows[rows.length - 1];
    const next: Cursor = { address: last.address, source: last.source, tid: last.tid };
    await db.transaction(async (tx) => {
      await store.insert(rows.map((row) => ({ address: row.address, source: row.source, origin: row.origin, fill: row.raw })), tx);
      await tx.execute(sql`UPDATE ${sql.identifier(STATE_TABLE)} SET cursor = ${JSON.stringify(next)}::jsonb, copied = copied + ${rows.length}`);
    });
    cursor = next;
    done += rows.length;
    if (Math.floor(done / 250_000) !== Math.floor((done - rows.length) / 250_000)) {
      log(`copy: ${Number(copied) + done} rows (${Math.round(done / ((Date.now() - started) / 1000))} rows/s this run)`);
    }
  }
  await db.execute(sql`UPDATE ${sql.identifier(STATE_TABLE)} SET copy_finished_at = now()`);
  log(`copy: finished, ${done} rows this run, ${Number(copied) + done} in total, ${Math.round((Date.now() - started) / 1000)} s`);
  return done;
}

/** Raw rows that have no typed row (written after `copy` passed their key). */
async function copyMissing(db: DrizzleDb, batch: number, log: (line: string) => void): Promise<number> {
  const store = new HistoryFillStore(db, "ignore");
  let done = 0;
  for (;;) {
    const rows = (await db.execute<RawRow>(sql`
      SELECT ${RAW_COLUMNS} FROM ${sql.identifier(LEGACY_FILLS_TABLE)} o
      WHERE NOT EXISTS (
        SELECT 1 FROM history_fills n JOIN history_accounts a ON a.id = n.account_id
        WHERE a.chain = o.chain AND a.address = o.address AND n.twap = (o.source = 'twap') AND n.tid = o.tid)
      LIMIT ${batch}`)).rows;
    if (rows.length === 0) break;
    rows.forEach(check);
    await store.insert(rows.map((row) => ({ address: row.address, source: row.source, origin: row.origin, fill: row.raw })));
    done += rows.length;
  }
  log(`catch-up: ${done} rows written to the raw table after the copy passed them`);
  return done;
}

/**
 * Compares every raw row with its typed row: same key, same origin, and a
 * rebuilt fill equal to the raw JSON value for value. Both sides are read
 * in key order a page at a time, so memory stays at two pages.
 */
export async function verifyFills(db: DrizzleDb, options: ConvertOptions & { table?: string } = {}): Promise<Verification> {
  const log = options.log ?? console.log;
  const batch = options.batch ?? DEFAULT_BATCH;
  const table = options.table ?? LEGACY_FILLS_TABLE;
  const store = new HistoryFillStore(db, "ignore");
  const result: Verification = { raw: await countOf(db, table), typed: await countOf(db, "history_fills"), compared: 0, missing: 0, extra: 0, different: 0, examples: [] };
  const note = (line: string) => { if (result.examples.length < 20) result.examples.push(line); };
  const addresses = (await db.execute<{ address: string }>(sql`
    SELECT address FROM history_accounts WHERE chain = ${CHAIN_DEFAULT}
    UNION SELECT DISTINCT address FROM ${sql.identifier(table)} ORDER BY 1`)).rows.map((row) => row.address);
  const started = Date.now();
  let reported = 0;
  for (const address of addresses) {
    for (const source of ["regular", "twap"] as const) {
      // Merge of two tid-ordered streams.
      let rawAfter: string | null = null;
      let typedAfter: bigint | null = null;
      let raws: RawRow[] = [];
      let typeds: Awaited<ReturnType<HistoryFillStore["page"]>> = [];
      let rawDone = false;
      let typedDone = false;
      for (;;) {
        if (raws.length === 0 && !rawDone) {
          raws = (await db.execute<RawRow>(sql`
            SELECT ${RAW_COLUMNS} FROM ${sql.identifier(table)} o
            WHERE o.chain = ${CHAIN_DEFAULT} AND o.address = ${address} AND o.source = ${source} ${rawAfter === null ? sql`` : sql`AND o.tid > ${rawAfter}::bigint`}
            ORDER BY o.tid LIMIT ${batch}`)).rows;
          rawDone = raws.length < batch;
          if (raws.length > 0) rawAfter = raws[raws.length - 1].tid;
        }
        if (typeds.length === 0 && !typedDone) {
          typeds = await store.page(address, source, typedAfter, batch);
          typedDone = typeds.length < batch;
          if (typeds.length > 0) typedAfter = BigInt(typeds[typeds.length - 1].fill.tid);
        }
        if (raws.length === 0 && typeds.length === 0) break;
        let r = 0;
        let t = 0;
        while (r < raws.length && t < typeds.length) {
          const raw = raws[r];
          const typed = typeds[t];
          const rawTid = BigInt(raw.tid);
          const typedTid = BigInt(typed.fill.tid);
          if (rawTid < typedTid) { result.missing += 1; note(`missing ${address} ${source} ${raw.tid}`); r += 1; continue; }
          if (rawTid > typedTid) { result.extra += 1; t += 1; continue; }
          result.compared += 1;
          if (inconsistency(raw) !== null || raw.origin !== typed.origin || canonicalJson(raw.raw) !== canonicalJson(typed.fill)) {
            result.different += 1;
            note(`different ${address} ${source} ${raw.tid}: ${canonicalJson(raw.raw)} / ${typed.origin} ${canonicalJson(typed.fill)}`);
          }
          r += 1;
          t += 1;
        }
        raws = raws.slice(r);
        typeds = typeds.slice(t);
        // One side is exhausted for good: the rest of the other has no partner.
        if (raws.length > 0 && typeds.length === 0 && typedDone) {
          result.missing += raws.length;
          note(`missing ${address} ${source} ${raws[0].tid}`);
          raws = [];
        }
        if (typeds.length > 0 && raws.length === 0 && rawDone) {
          result.extra += typeds.length;
          typeds = [];
        }
      }
    }
    if (result.compared - reported >= 500_000) {
      reported = result.compared;
      log(`verify: ${result.compared} rows compared (${Math.round(result.compared / ((Date.now() - started) / 1000))} rows/s)`);
    }
  }
  log(`verify: raw ${result.raw} rows, typed ${result.typed}; compared ${result.compared}, missing ${result.missing}, different ${result.different}, typed-only ${result.extra}; ${Math.round((Date.now() - started) / 1000)} s`);
  for (const line of result.examples) log(`  ${line}`);
  return result;
}

export const exact = (v: Verification) => v.missing === 0 && v.different === 0 && v.compared === v.raw;

/**
 * The switch: writes to the raw table are blocked (SHARE lock, held to the
 * end), late rows are copied, every row is verified, and only an exact
 * result renames the table. Returns the verification; `retired` says
 * whether the rename happened.
 */
export async function finishConversion(pool: Pool, db: DrizzleDb, options: ConvertOptions = {}): Promise<Verification & { retired: boolean }> {
  const log = options.log ?? console.log;
  if (!(await exists(db, LEGACY_FILLS_TABLE))) throw new Error(`No ${LEGACY_FILLS_TABLE} table: nothing to finish`);
  if (await exists(db, RETIRED_FILLS_TABLE)) throw new Error(`${RETIRED_FILLS_TABLE} already exists: drop it first`);
  await copyFills(db, options);
  const lock = await pool.connect();
  try {
    await lock.query("BEGIN");
    await lock.query(`LOCK TABLE "${LEGACY_FILLS_TABLE}" IN SHARE MODE`);
    await copyMissing(db, options.batch ?? DEFAULT_BATCH, log);
    const verification = await verifyFills(db, options);
    if (!exact(verification)) {
      await lock.query("ROLLBACK");
      log("finish: NOT retired, the tables differ (see above); the raw table is unchanged");
      return { ...verification, retired: false };
    }
    await lock.query(`ALTER TABLE "${LEGACY_FILLS_TABLE}" RENAME TO "${RETIRED_FILLS_TABLE}"`);
    await lock.query("COMMIT");
    log(`finish: every row matches; ${LEGACY_FILLS_TABLE} renamed to ${RETIRED_FILLS_TABLE}`);
    return { ...verification, retired: true };
  } catch (error) {
    await lock.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    lock.release();
  }
}

/** Drops the retired raw table and the cursor. Refuses while the raw table
 * is still in use (not finished). */
export async function dropRetired(db: DrizzleDb, log: (line: string) => void = console.log): Promise<void> {
  if (await exists(db, LEGACY_FILLS_TABLE)) throw new Error(`${LEGACY_FILLS_TABLE} still exists: run "finish" first`);
  await db.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(RETIRED_FILLS_TABLE)}`);
  await db.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(STATE_TABLE)}`);
  log(`drop: ${RETIRED_FILLS_TABLE} and ${STATE_TABLE} removed`);
}

export async function conversionStatus(db: DrizzleDb, log: (line: string) => void = console.log): Promise<void> {
  for (const table of [LEGACY_FILLS_TABLE, RETIRED_FILLS_TABLE, "history_fills"]) {
    log(`${table}: ${(await exists(db, table)) ? `${await countOf(db, table)} rows` : "absent"}`);
  }
  if (await exists(db, STATE_TABLE)) log(`cursor: ${JSON.stringify((await db.execute(sql`SELECT cursor, copied, copy_finished_at FROM ${sql.identifier(STATE_TABLE)}`)).rows[0])}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const envFile = resolve(import.meta.dirname, "../../../../.env");
  // An explicit DATABASE_URL (the shell's) wins over the repo's .env.
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const command = args.find((arg) => !arg.startsWith("--"));
  const batchAt = args.indexOf("--batch");
  const options: ConvertOptions = { batch: batchAt >= 0 ? Number(args[batchAt + 1]) : DEFAULT_BATCH };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const db = drizzle(pool, { schema });
  const run = async (): Promise<boolean> => {
    if (command === "copy") { await copyFills(db, options); return true; }
    // After `finish` the raw rows live under the retired name.
    if (command === "verify") return exact(await verifyFills(db, { ...options, table: (await exists(db, LEGACY_FILLS_TABLE)) ? LEGACY_FILLS_TABLE : RETIRED_FILLS_TABLE }));
    if (command === "all" && !(await exists(db, LEGACY_FILLS_TABLE))) {
      // A release command runs this every time: nothing to do once converted.
      console.log(`No ${LEGACY_FILLS_TABLE} table: nothing to convert`);
      return true;
    }
    if (command === "finish" || command === "all") return (await finishConversion(pool, db, options)).retired;
    if (command === "drop") { await dropRetired(db); return true; }
    if (command === "status") { await conversionStatus(db); return true; }
    throw new Error("Usage: history:convert <copy|verify|finish|all|drop|status> [--batch N]");
  };
  run().then(async (ok) => { await pool.end(); process.exit(ok ? 0 : 1); }).catch(async (error: Error) => {
    console.error(`Conversion failed: ${error.message}`);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
}
