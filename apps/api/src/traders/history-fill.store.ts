import { and, asc, desc, eq, gt, gte, inArray, lt, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { historyAccounts, historyFills, historyTerms } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import { decodeFill, encodeFill, termsOf, type FillColumns } from "../analytics/fill-codec.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { HlUserFill } from "../hyperliquid/types.js";

export type FillSource = "regular" | "twap";
export type FillOrigin = "rest" | "s3";
/** The pool or a transaction of it. */
export type FillExecutor = Pick<DrizzleDb, "select" | "insert" | "delete" | "execute">;

export interface NewHistoryFill {
  address: string;
  source: FillSource;
  origin: FillOrigin;
  fill: HlUserFill;
}
export interface StoredHistoryFill {
  source: FillSource;
  origin: FillOrigin;
  fill: HlUserFill;
}
/** `from` inclusive; `before` exclusive; `through` inclusive. `source`: one
 * stream only. `newest`: at most this many rows, the latest ones (still
 * returned oldest first), so a read of a very active address is bounded. */
export interface FillRange { from?: Date; before?: Date; through?: Date; source?: FillSource; newest?: number }

/** Rows per INSERT: 27 parameters each, far below the protocol's 65,535. */
const INSERT_BATCH = 500;
const IN_BATCH = 1000;

/** The raw layout's table; it exists only until `history:convert` retires it. */
export const LEGACY_FILLS_TABLE = "analysis_history_fills";

export class HistoryNotConvertedError extends Error {
  constructor() {
    super(`Stored fills are not converted yet: run "pnpm --filter @trading-dashboard/api history:convert finish"`);
    this.name = "HistoryNotConvertedError";
  }
}

const coin = alias(historyTerms, "coin");
const dir = alias(historyTerms, "dir");
const feeToken = alias(historyTerms, "fee_token");

/**
 * The only reader and writer of `history_fills`. Callers hand it Hyperliquid
 * fills and get the same objects back; the typed, compact layout (address
 * and term ids, numerics, bytea — see `fill-codec.ts`) stays in here.
 */
export class HistoryFillStore {
  private converted: Promise<void> | undefined;
  /** `legacy: "ignore"` is for the converter only (it fills the table
   * while the raw one still exists). */
  constructor(private readonly db: DrizzleDb, private readonly legacy: "refuse" | "ignore" = "refuse") {}

  /**
   * Rows of the raw layout (`analysis_history_fills`, before migration
   * 0021) that were not converted are invisible here; checkpoints already
   * count them as read. So nothing is read or written until
   * `history:convert` has retired that table. Checked once per process;
   * a refusal is checked again on the next call.
   */
  private ready(): Promise<void> {
    if (this.legacy === "ignore") return Promise.resolve();
    this.converted ??= this.db.execute<{ pending: boolean }>(sql`SELECT to_regclass(${`public.${LEGACY_FILLS_TABLE}`}) IS NOT NULL AS pending`).then((result) => {
      if (result.rows[0]?.pending) throw new HistoryNotConvertedError();
    }).catch((error: Error) => {
      this.converted = undefined;
      throw error;
    });
    return this.converted;
  }

  /**
   * Stores fills under `(chain, address, source, tid)`; a row that exists
   * is left as it is (the first origin stays recorded). Idempotent.
   */
  async insert(rows: NewHistoryFill[], db: FillExecutor = this.db): Promise<void> {
    await this.ready();
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const batch = rows.slice(i, i + INSERT_BATCH);
      const encoded = batch.map((row) => encodeFill(row.fill));
      const [accounts, terms] = await Promise.all([
        this.ids("account", [...new Set(batch.map((row) => row.address))]),
        this.ids("term", termsOf(encoded)),
      ]);
      const term = (value: string | null) => (value === null ? null : terms.get(value)!);
      await db.insert(historyFills).values(batch.map((row, index) => {
        const { coin: coinTerm, dir: dirTerm, feeToken: feeTerm, ...columns } = encoded[index];
        return {
          ...columns, accountId: accounts.get(row.address)!, twap: row.source === "twap", origin: row.origin,
          coinId: term(coinTerm), dirId: term(dirTerm), feeTokenId: term(feeTerm),
        };
      })).onConflictDoNothing();
    }
  }

  /** Newest ingested fill per account, independent of trade reconstruction.
   * Correlated indexed lookups avoid scanning each account's entire history. */
  async latestTimes(addresses: string[]): Promise<Map<string, Date>> {
    if (addresses.length === 0) return new Map();
    await this.ready();
    const rows = await this.db.select({
      address: historyAccounts.address,
      latest: sql<Date | null>`(select max(${historyFills.time}) from ${historyFills} where ${historyFills.accountId} = ${historyAccounts.id})`,
    }).from(historyAccounts).where(and(eq(historyAccounts.chain, CHAIN_DEFAULT), inArray(historyAccounts.address, addresses)));
    return new Map(rows.flatMap(row => row.latest ? [[row.address, new Date(row.latest)] as const] : []));
  }

  /** An address's stored fills in a time range, oldest first (the regular
   * row before the TWAP row of the same millisecond, then ascending tid). */
  async read(address: string, range: FillRange = {}, db: FillExecutor = this.db): Promise<StoredHistoryFill[]> {
    await this.ready();
    const account = await this.accountId(address, db);
    if (account === undefined) return [];
    const query = this.rows(db).where(and(eq(historyFills.accountId, account), ...timeRange(range)));
    if (range.newest === undefined) return (await query.orderBy(asc(historyFills.time), asc(historyFills.twap), asc(historyFills.tid))).map(stored);
    return (await query.orderBy(desc(historyFills.time), desc(historyFills.twap), desc(historyFills.tid)).limit(range.newest)).reverse().map(stored);
  }

  /** One stream of an address in tid order, `limit` rows after `afterTid`:
   * a walk over everything stored that never holds more than a page. */
  async page(address: string, source: FillSource, afterTid: bigint | null, limit: number, db: FillExecutor = this.db): Promise<StoredHistoryFill[]> {
    await this.ready();
    const account = await this.accountId(address, db);
    if (account === undefined) return [];
    const rows = await this.rows(db).where(and(
      eq(historyFills.accountId, account), eq(historyFills.twap, source === "twap"), afterTid === null ? undefined : gt(historyFills.tid, afterTid),
    )).orderBy(asc(historyFills.tid)).limit(limit);
    return rows.map(stored);
  }

  private rows(db: FillExecutor) {
    return db.select({
      tid: historyFills.tid, time: historyFills.time, oid: historyFills.oid, twapId: historyFills.twapId,
      coin: coin.term, dir: dir.term, feeToken: feeToken.term, twap: historyFills.twap, origin: historyFills.origin,
      sideBuy: historyFills.sideBuy, crossed: historyFills.crossed, hash: historyFills.hash, px: historyFills.px, sz: historyFills.sz,
      startPosition: historyFills.startPosition, closedPnl: historyFills.closedPnl, fee: historyFills.fee, cloid: historyFills.cloid,
      builder: historyFills.builder, builderFee: historyFills.builderFee, deployerFee: historyFills.deployerFee,
      priorityGas: historyFills.priorityGas, liquidatedUser: historyFills.liquidatedUser,
      liquidationMarkPx: historyFills.liquidationMarkPx, liquidationMethod: historyFills.liquidationMethod, extra: historyFills.extra,
    }).from(historyFills)
      .leftJoin(coin, eq(coin.id, historyFills.coinId))
      .leftJoin(dir, eq(dir.id, historyFills.dirId))
      .leftJoin(feeToken, eq(feeToken.id, historyFills.feeTokenId))
      .$dynamic();
  }

  /** {@link read}, one fill per tid: a fill can come from both endpoints,
   * and the TWAP row carries the extra identity (`twapId`). */
  async fills(address: string, range: FillRange = {}, db: FillExecutor = this.db): Promise<HlUserFill[]> {
    const byTid = new Map<number, HlUserFill>();
    for (const row of await this.read(address, range, db)) {
      if (!byTid.has(row.fill.tid) || row.source === "twap") byTid.set(row.fill.tid, row.fill);
    }
    return [...byTid.values()];
  }

  /** Rows stored for an address (both streams; a tid in both counts twice). */
  async count(address: string, range: FillRange = {}, db: FillExecutor = this.db): Promise<number> {
    await this.ready();
    const account = await this.accountId(address, db);
    if (account === undefined) return 0;
    const [row] = await db.select({ n: sql<string>`count(*)` }).from(historyFills).where(and(eq(historyFills.accountId, account), ...timeRange(range)));
    return Number(row?.n ?? 0);
  }

  /** Removes every fill of these addresses; returns the rows deleted. */
  async remove(addresses: string[], db: FillExecutor = this.db): Promise<number> {
    await this.ready();
    let removed = 0;
    for (let i = 0; i < addresses.length; i += IN_BATCH) {
      const accounts = db.select({ id: historyAccounts.id }).from(historyAccounts)
        .where(and(eq(historyAccounts.chain, CHAIN_DEFAULT), inArray(historyAccounts.address, addresses.slice(i, i + IN_BATCH))));
      removed += (await db.delete(historyFills).where(inArray(historyFills.accountId, accounts))).rowCount ?? 0;
    }
    return removed;
  }

  private async accountId(address: string, db: FillExecutor): Promise<number | undefined> {
    const [row] = await db.select({ id: historyAccounts.id }).from(historyAccounts)
      .where(and(eq(historyAccounts.chain, CHAIN_DEFAULT), eq(historyAccounts.address, address)));
    return row?.id;
  }

  /**
   * Dictionary ids of addresses or terms, adding the ones not there yet.
   * Looked up before inserting, so a batch of known values takes no
   * sequence number and no row lock. Always on the pool, never inside the
   * caller's transaction: a dictionary row is harmless if that transaction
   * rolls back, and two transactions adding the same new terms in a
   * different order would otherwise deadlock. Ids never change, but they
   * are not cached: the lookup is one indexed query per batch.
   */
  private async ids(kind: "account" | "term", wanted: string[]): Promise<Map<string, number>> {
    const db = this.db;
    const values = [...wanted].sort();
    const found = new Map<string, number>();
    for (let attempt = 0; attempt < 3 && found.size < values.length; attempt++) {
      const missing = values.filter((value) => !found.has(value));
      for (let i = 0; i < missing.length; i += IN_BATCH) {
        const chunk = missing.slice(i, i + IN_BATCH);
        if (kind === "account") {
          if (attempt > 0) await db.insert(historyAccounts).values(chunk.map((address) => ({ address }))).onConflictDoNothing();
          const rows = await db.select({ id: historyAccounts.id, value: historyAccounts.address }).from(historyAccounts)
            .where(and(eq(historyAccounts.chain, CHAIN_DEFAULT), inArray(historyAccounts.address, chunk)));
          for (const row of rows) found.set(row.value, row.id);
        } else {
          if (attempt > 0) await db.insert(historyTerms).values(chunk.map((term) => ({ term }))).onConflictDoNothing();
          const rows = await db.select({ id: historyTerms.id, value: historyTerms.term }).from(historyTerms).where(inArray(historyTerms.term, chunk));
          for (const row of rows) found.set(row.value, row.id);
        }
      }
    }
    if (found.size < values.length) throw new Error(`History ${kind} ids could not be resolved`);
    return found;
  }
}

function stored({ twap, origin, ...columns }: FillColumns & { twap: boolean; origin: FillOrigin }): StoredHistoryFill {
  return { source: twap ? "twap" : "regular", origin, fill: decodeFill(columns) };
}

function timeRange(range: FillRange): SQL[] {
  return [
    ...(range.from ? [gte(historyFills.time, range.from)] : []),
    ...(range.before ? [lt(historyFills.time, range.before)] : []),
    ...(range.through ? [lte(historyFills.time, range.through)] : []),
    ...(range.source ? [eq(historyFills.twap, range.source === "twap")] : []),
  ];
}

/** SQL: distinct tids stored for `address` between two times (both
 * inclusive), for statements that count per row of another table. */
export function storedTids(address: SQL, from: SQL, through: SQL): SQL {
  return sql`(SELECT count(DISTINCT f.tid)::int FROM history_fills f JOIN history_accounts h ON h.id = f.account_id
    WHERE h.chain = ${CHAIN_DEFAULT} AND h.address = ${address} AND f.time >= ${from} AND f.time <= ${through})`;
}
