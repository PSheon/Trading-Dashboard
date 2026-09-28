// Parquet tables under data/warehouse, written atomically.
//
// Every write goes to a temporary file first and is renamed into place, so a
// reader (the web page, a notebook) never sees half a file and never holds a
// lock the jobs need. DuckDB does the Parquet work.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { DuckDBConnection } from "@duckdb/node-api";

import { lit, litList, queryRows, type Row, withConnection } from "./db";

// Column kinds and how they cross between DuckDB and TypeScript.
//   big: BIGINT ↔ bigint (raw token amounts, lamports: may exceed 2^53)
//   int: BIGINT ↔ number (times, slots, counts, indexes)
export type Kind = "str" | "int" | "big" | "float" | "bool" | "strs" | "date";
export type Schema = Record<string, Kind>;

const SQL_TYPE: Record<Kind, string> = {
  str: "VARCHAR",
  int: "BIGINT",
  big: "BIGINT",
  float: "DOUBLE",
  bool: "BOOLEAN",
  strs: "VARCHAR[]",
  date: "DATE",
};

export const SCHEMAS = {
  wallets: {
    address: "str",
    first_seen_at: "int", // when we discovered it, not its first transaction
    discovered_via: "str",
    discovered_from_token: "str",
    funnel_run_id: "str",
    fetch_cursor_time: "int", // newest block time fetched so far
    last_fetched_at: "int",
    history_from: "int", // start of the first backfill; nothing older is held
  },
  tokens: {
    mint: "str",
    created_at: "int",
    creator_address: "str",
    create_tx_sig: "str",
    create_slot: "int",
    graduated_at: "int",
    migration_venue: "str",
  },
  trades: {
    tx_sig: "str",
    wallet: "str",
    mint: "str",
    side: "str",
    token_amount_raw: "big",
    decimals: "int",
    quote_mint: "str",
    quote_amount_raw: "big",
    sol_lamports: "big", // null when the quote was a stablecoin
    fee_lamports: "big",
    rent_lamports: "big",
    price_sol: "float",
    price_confidence: "str",
    programs: "strs",
    slot: "int",
    tx_index: "int", // order within the slot
    block_time: "int",
    parser_version: "int",
    ingested_at: "int",
  },
  token_transfers: {
    tx_sig: "str",
    wallet: "str",
    mint: "str",
    direction: "str", // in | out
    kind: "str", // transfer | complex
    token_amount_raw: "big",
    decimals: "int",
    counterparty: "str",
    slot: "int",
    tx_index: "int",
    block_time: "int",
    parser_version: "int",
    ingested_at: "int",
  },
  lots: {
    wallet: "str",
    mint: "str",
    lot_seq: "int",
    position_seq: "int",
    buy_tx_sig: "str",
    buy_time: "int",
    close_tx_sig: "str",
    close_time: "int",
    close_type: "str", // sell | transfer_out | dust | null while open
    token_amount_raw: "big",
    cost_lamports: "big",
    proceeds_lamports: "big",
    realized_pnl_lamports: "big",
    hold_seconds: "int",
    cost_unknown: "bool",
  },
  positions: {
    wallet: "str",
    mint: "str",
    position_seq: "int",
    opened_at: "int",
    closed_at: "int",
    cost_lamports: "big",
    proceeds_lamports: "big",
    realized_pnl_lamports: "big",
    lots: "int",
    has_unknown_cost: "bool",
    has_transfer_out: "bool",
    complete: "bool", // closed, every cost and proceeds known, nothing transferred away
  },
  wallet_metrics_daily: {
    as_of_date: "date",
    wallet: "str",
    trade_count: "int",
    token_count: "int",
    realized_pnl_sol: "float",
    fees_sol: "float",
    win_rate: "float",
    pnl_concentration: "float",
    median_hold_seconds: "float",
    median_entry_age_seconds: "float",
    pre_graduation_ratio: "float",
    tx_per_active_hour: "float",
    last_active_at: "int",
    max_drawdown_sol: "float",
    unknown_cost_ratio: "float",
  },
  token_accounts: {
    // Token accounts whose own history repair has fetched, and how far.
    wallet: "str",
    mint: "str",
    pubkey: "str",
    cursor_time: "int",
    last_fetched_at: "int",
  },
  reconciliation: {
    wallet: "str",
    mint: "str",
    checked_at: "int",
    derived_balance_raw: "big",
    onchain_balance_raw: "big",
    diff_raw: "big",
    token_created_in_window: "bool",
  },
} as const satisfies Record<string, Schema>;

export type Table = keyof typeof SCHEMAS;

// Tables split into one file per month of block_time, and per as_of_date.
const MONTHLY: ReadonlySet<Table> = new Set(["trades", "token_transfers"]);
const DAILY: ReadonlySet<Table> = new Set(["wallet_metrics_daily"]);

const SORT_KEY: Partial<Record<Table, string[]>> = {
  trades: ["wallet", "slot", "tx_index", "tx_sig", "mint"],
  token_transfers: ["wallet", "slot", "tx_index", "tx_sig", "mint"],
  lots: ["wallet", "mint", "lot_seq"],
  positions: ["wallet", "mint", "position_seq"],
  token_accounts: ["wallet", "mint", "pubkey"],
  wallets: ["first_seen_at", "address"],
  wallet_metrics_daily: ["wallet"],
  reconciliation: ["checked_at", "wallet", "mint"],
};

/** Columns of a schema, cast to their declared types, in schema order. */
function projection(schema: Schema, prefix = ""): string {
  return Object.entries(schema)
    .map(([c, k]) => `CAST(${prefix}"${c}" AS ${SQL_TYPE[k]}) AS "${c}"`)
    .join(", ");
}

/** An empty relation with the schema's columns. */
function emptyRelation(schema: Schema): string {
  const cols = Object.entries(schema).map(([c, k]) => `CAST(NULL AS ${SQL_TYPE[k]}) AS "${c}"`);
  return `(SELECT ${cols.join(", ")} WHERE false)`;
}

/** DuckDB values → the TypeScript shapes the schema promises. */
export function fromDb<T = Row>(row: Row, schema: Schema): T {
  const out: Row = {};
  for (const [c, k] of Object.entries(schema)) {
    const v = row[c];
    if (v === null || v === undefined) out[c] = null;
    else if (k === "int" || k === "float") out[c] = Number(v);
    else if (k === "big") out[c] = BigInt(v as bigint);
    else if (k === "date") out[c] = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    else out[c] = v;
  }
  return out as T;
}

// JSON cannot carry bigint; write them as bare integers so nothing is rounded.
function ndjson(rows: readonly Row[], schema: Schema): string {
  const cols = Object.keys(schema);
  return rows
    .map((r) => {
      const o: Row = {};
      for (const c of cols) o[c] = r[c] ?? null;
      return JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? `__big__${v}` : v)).replace(
        /"__big__(-?\d+)"/g,
        "$1",
      );
    })
    .join("\n");
}

/** Load rows into a temp table on this connection; returns its name. */
async function loadRows(c: DuckDBConnection, rows: readonly Row[], schema: Schema): Promise<string> {
  const name = `rows_${randomUUID().replaceAll("-", "")}`;
  const columns = Object.entries(schema).map(([col, k]) => `"${col}" ${SQL_TYPE[k]}`);
  await c.run(`CREATE TEMP TABLE ${name} (${columns.join(", ")})`);
  if (rows.length) {
    const file = path.join(os.tmpdir(), `${name}.ndjson`);
    writeFileSync(file, ndjson(rows, schema));
    try {
      const spec = Object.entries(schema)
        .map(([col, k]) => `${lit(col)}: ${lit(SQL_TYPE[k])}`)
        .join(", ");
      await c.run(
        `INSERT INTO ${name} SELECT * FROM read_json(${lit(file)}, format='newline_delimited', columns={${spec}})`,
      );
    } finally {
      rmSync(file, { force: true });
    }
  }
  return name;
}

async function copyAtomic(c: DuckDBConnection, select: string, target: string): Promise<void> {
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  await c.run(`COPY (${select}) TO ${lit(tmp)} (FORMAT parquet)`);
  renameSync(tmp, target);
}

export class Warehouse {
  constructor(readonly root: string) {}

  path(table: Table): string {
    return MONTHLY.has(table) || DAILY.has(table)
      ? path.join(this.root, table)
      : path.join(this.root, `${table}.parquet`);
  }

  files(table: Table): string[] {
    const p = this.path(table);
    if (MONTHLY.has(table) || DAILY.has(table)) {
      if (!existsSync(p)) return [];
      const prefix = MONTHLY.has(table) ? "month=" : "as_of_date=";
      return readdirSync(p)
        .filter((f) => f.startsWith(prefix) && f.endsWith(".parquet"))
        .sort()
        .map((f) => path.join(p, f));
    }
    return existsSync(p) ? [p] : [];
  }

  /** A SQL relation over the whole table, typed by its schema. */
  relation(table: Table): string {
    const files = this.files(table);
    const schema = SCHEMAS[table];
    if (!files.length) return emptyRelation(schema);
    return `(SELECT ${projection(schema)} FROM read_parquet([${litList(files)}], union_by_name=true))`;
  }

  async read<T = Row>(table: Table, where = "true", orderBy?: string): Promise<T[]> {
    const order = orderBy ? ` ORDER BY ${orderBy}` : "";
    const rows = await queryRows(`SELECT * FROM ${this.relation(table)} WHERE ${where}${order}`);
    return rows.map((r) => fromDb<T>(r, SCHEMAS[table]));
  }

  /** Replace a whole single-file table. */
  async write(table: Table, rows: readonly Row[]): Promise<void> {
    if (MONTHLY.has(table) || DAILY.has(table)) throw new Error(`${table} is partitioned`);
    const schema = SCHEMAS[table];
    await withConnection(async (c) => {
      const t = await loadRows(c, rows, schema);
      await copyAtomic(c, `SELECT * FROM ${t} ${orderClause(table)}`, this.path(table));
    });
  }

  /** Replace one as_of_date of a daily table. */
  async writeDay(table: Table, day: string, rows: readonly Row[]): Promise<string> {
    if (!DAILY.has(table)) throw new Error(`${table} is not daily`);
    const target = path.join(this.path(table), `as_of_date=${day}.parquet`);
    await withConnection(async (c) => {
      const t = await loadRows(c, rows, SCHEMAS[table]);
      await copyAtomic(c, `SELECT * FROM ${t} ${orderClause(table)}`, target);
    });
    return target;
  }

  days(table: Table): string[] {
    return this.files(table).map((f) => path.basename(f, ".parquet").replace("as_of_date=", ""));
  }

  /**
   * Drop every row of these wallets and put `rows` in their place.
   *
   * Whole-wallet replacement keeps rebuilds idempotent: a transaction the
   * parser no longer emits disappears instead of lingering.
   */
  async replaceWallets(table: Table, wallets: readonly string[], rows: readonly Row[]): Promise<void> {
    const schema = SCHEMAS[table];
    const keep = `"wallet" NOT IN (${litList(wallets)})`;
    await withConnection(async (c) => {
      const incoming = await loadRows(c, rows, schema);
      if (!MONTHLY.has(table)) {
        const select = `SELECT * FROM ${this.relation(table)} WHERE ${keep} UNION ALL SELECT * FROM ${incoming} ${orderClause(table)}`;
        await copyAtomic(c, select, this.path(table));
        return;
      }
      const month = `strftime(to_timestamp("block_time"), '%Y-%m')`;
      const newMonths = (await queryRows(`SELECT DISTINCT ${month} AS m FROM ${incoming}`, c)).map((r) => String(r.m));
      const existing = new Map(
        this.files(table).map((f) => [path.basename(f, ".parquet").replace("month=", ""), f]),
      );
      for (const m of [...new Set([...existing.keys(), ...newMonths])].sort()) {
        const file = existing.get(m);
        const old = file
          ? `(SELECT ${projection(schema)} FROM read_parquet(${lit(file)}, union_by_name=true))`
          : emptyRelation(schema);
        const [{ total, kept }] = await queryRows(
          `SELECT count(*) AS total, count(*) FILTER (WHERE ${keep}) AS kept FROM ${old}`,
          c,
        );
        const adding = newMonths.includes(m);
        if (!adding && total === kept) continue;
        const select = `SELECT * FROM ${old} WHERE ${keep} UNION ALL SELECT * FROM ${incoming} WHERE ${month} = ${lit(m)} ${orderClause(table)}`;
        await copyAtomic(c, select, path.join(this.path(table), `month=${m}.parquet`));
      }
    });
  }
}

function orderClause(table: Table): string {
  const key = SORT_KEY[table];
  return key ? `ORDER BY ${key.map((k) => `"${k}"`).join(", ")} NULLS LAST` : "";
}

