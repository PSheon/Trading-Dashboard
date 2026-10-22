import { and, asc, desc, eq, gt, gte, inArray, lt, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { historyAccounts, historyFills, historyTerms } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import { decodeFill, encodeFill, termsOf, type FillColumns } from "../analytics/fill-codec.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { HlUserFill } from "../hyperliquid/types.js";
import { HISTORY_RETENTION_BATCH_LIMIT } from "../config/constants/background.js";

export type FillSource = "regular" | "twap";
export type FillOrigin = "rest" | "s3";
/** The pool or a transaction of it. */
type FillExecutor = Pick<DrizzleDb, "select" | "insert" | "delete" | "execute">;

interface NewHistoryFill {
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
 * stream only. `newest` / `oldest`: at most that many rows from that end
 * (both returned oldest first). */
interface FillRange { from?: Date; before?: Date; through?: Date; source?: FillSource; newest?: number; oldest?: number }

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
   * Unconverted raw-layout rows would be invisible yet counted as read by
   * checkpoints, so nothing is read or written until `history:convert` has
   * retired the raw table. Checked once per process (a refusal rechecks).
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
    const ascending = query.orderBy(asc(historyFills.time), asc(historyFills.twap), asc(historyFills.tid));
    if (range.oldest !== undefined) return (await ascending.limit(range.oldest)).map(stored);
    if (range.newest === undefined) return (await ascending).map(stored);
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

  /**
   * Deletes the fills of these addresses once nothing refers to them
   * ({@link unreferencedAccount}), oldest first, one bounded statement at a
   * time and at most `maxRows` in all; returns the rows deleted. A history
   * job or archive span created meanwhile stops it (each statement checks).
   * What is left past `maxRows` is the retention job's (its sweep deletes
   * unreferenced accounts' fills whole).
   */
  async purgeUnreferenced(addresses: string[], maxRows: number, batch = HISTORY_RETENTION_BATCH_LIMIT): Promise<number> {
    await this.ready();
    let removed = 0;
    for (const address of addresses) {
      while (removed < maxRows) {
        const limit = Math.min(batch, maxRows - removed);
        const result = await inIndexOrder(this.db, sql`
          DELETE FROM history_fills WHERE ctid = ANY (ARRAY(
            SELECT f.ctid FROM history_accounts h JOIN history_fills f ON f.account_id = h.id
            WHERE h.chain = ${CHAIN_DEFAULT} AND h.address = ${address} AND ${unreferencedAccount(sql`h`)}
            ORDER BY f.time LIMIT ${limit}))`);
        removed += result.rowCount ?? 0;
        if ((result.rowCount ?? 0) < limit) break;
      }
    }
    return removed;
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
   * Dictionary ids of addresses or terms, adding missing ones. Looked up
   * first so known values take no sequence number or row lock. Always on
   * the pool, never in the caller's transaction: an orphan dictionary row
   * is harmless, and in-transaction inserts in differing order could deadlock.
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

/**
 * Runs a bounded statement that must walk `history_fills_account_time_idx`
 * in order and stop at its LIMIT. The planner sizes an account by the
 * table's average, while a few accounts hold most rows (30 addresses, 75 %):
 * estimated small, it may pick a bitmap scan and a sort, which read and sort
 * every row of a heavy account before the LIMIT (millions, past
 * statement_timeout). Without those two for this statement it walks the
 * index and stops.
 */
export function inIndexOrder<T extends Record<string, unknown>>(db: DrizzleDb, statement: SQL) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
    await tx.execute(sql`SET LOCAL enable_sort = off`);
    return tx.execute<T>(statement);
  });
}

/** SQL: the live copy strategies' leaders (lower case). Their stored
 * history is never pruned or purged. */
export const COPIED_LEADERS = sql`(SELECT lower(leader_address) FROM copy_strategies WHERE chain = ${CHAIN_DEFAULT} AND status <> 'stopped')`;

/** SQL: the `history_accounts` row `h` has fills no reader can reach: no
 * history job (its snapshots) and no active archive coverage (its spans)
 * for the address, and it is not a copied leader. */
export function unreferencedAccount(h: SQL): SQL {
  return sql`(NOT EXISTS (SELECT 1 FROM analysis_history_jobs j WHERE j.chain = ${h}.chain AND j.address = ${h}.address)
    AND NOT EXISTS (SELECT 1 FROM archive_coverage c WHERE c.chain = ${h}.chain AND c.address = ${h}.address AND c.status = 'active')
    AND ${h}.address NOT IN ${COPIED_LEADERS})`;
}

/** SQL: distinct tids stored for `address` between two times (both
 * inclusive), for statements that count per row of another table. */
export function storedTids(address: SQL, from: SQL, through: SQL): SQL {
  return sql`(SELECT count(DISTINCT f.tid)::int FROM history_fills f JOIN history_accounts h ON h.id = f.account_id
    WHERE h.chain = ${CHAIN_DEFAULT} AND h.address = ${address} AND f.time >= ${from} AND f.time <= ${through})`;
}
