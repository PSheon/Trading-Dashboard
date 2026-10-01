import { BusyException } from "./busy.js";
import { isDeepStrictEqual } from "node:util";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, notLike, or, sql, type SQL } from "drizzle-orm";
import { fillCoverage, fills, traderAnalytics, traderTrades } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import type { Trade } from "../analytics/trade-reconstruction.js";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { HlUserFill } from "../hyperliquid/types.js";
import { fromScaled, toScaled } from "../watcher/action-classifier.js";

export type AnalyticsRow = typeof traderAnalytics.$inferSelect;
export type AnalyticsInsert = typeof traderAnalytics.$inferInsert;
export type FillCoverage = typeof fillCoverage.$inferSelect;
type TradeRow = typeof traderTrades.$inferSelect;
export type TradeAnalyticsTx = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];
type DbOrTx = DrizzleDb | TradeAnalyticsTx;

const INSERT_CHUNK = 500;

function toRow(address: string, t: Trade): typeof traderTrades.$inferInsert {
  return {
    chain: CHAIN_DEFAULT,
    address,
    openTid: t.openTid,
    coin: t.coin,
    side: t.side,
    entryTime: new Date(t.entryTime),
    exitTime: t.exitTime === null ? null : new Date(t.exitTime),
    sortTime: new Date(t.exitTime ?? t.entryTime),
    position: fromScaled(t.position),
    preSize: fromScaled(t.preSize),
    prePx: t.prePx === null ? null : String(t.prePx),
    entrySz: String(t.entrySz),
    entryNtl: String(t.entryNtl),
    exitSz: String(t.exitSz),
    exitNtl: String(t.exitNtl),
    realizedPnl: String(t.realizedPnl),
    fees: String(t.fees),
    funding: t.funding === null ? null : String(t.funding),
    netPnl: String(t.realizedPnl - t.fees),
    liquidated: t.liquidated,
    twap: t.twap,
    fills: t.fills,
    lastFillTime: new Date(t.lastFillTime),
  };
}

export function fromRow(r: TradeRow): Trade {
  return {
    coin: r.coin,
    openTid: r.openTid,
    side: r.side,
    entryTime: r.entryTime.getTime(),
    exitTime: r.exitTime === null ? null : r.exitTime.getTime(),
    position: toScaled(r.position),
    preSize: toScaled(r.preSize),
    prePx: r.prePx === null ? null : Number(r.prePx),
    entrySz: Number(r.entrySz),
    entryNtl: Number(r.entryNtl),
    exitSz: Number(r.exitSz),
    exitNtl: Number(r.exitNtl),
    realizedPnl: Number(r.realizedPnl),
    fees: Number(r.fees),
    funding: r.funding === null ? null : Number(r.funding),
    liquidated: r.liquidated,
    twap: r.twap,
    fills: r.fills,
    lastFillTime: r.lastFillTime.getTime(),
  };
}

const mine = (address: string) => and(eq(traderTrades.chain, CHAIN_DEFAULT), eq(traderTrades.address, address));

/** `trader_trades` and `trader_analytics`: the stored round trips and each
 * address's summary and cursors. */
@Injectable()
export class TradeAnalyticsRepository {
  constructor(@Inject(DRIZZLE_CLIENT) readonly db: DrizzleDb) {}

  transaction<T>(work: (tx: TradeAnalyticsTx) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  /** Optimistic commit guard across API/worker processes. Upstream I/O happens
   * outside the transaction; reject stale work before changing trades/funding. */
  async assertState(tx: TradeAnalyticsTx, address: string, expected: AnalyticsRow | undefined): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(73107, hashtext(${address}))`);
    const current = await this.state(address, tx);
    if (!isDeepStrictEqual(current, expected)) throw new BusyException(5000);
  }

  async state(address: string, executor: DbOrTx = this.db): Promise<AnalyticsRow | undefined> {
    const [row] = await executor
      .select()
      .from(traderAnalytics)
      .where(and(eq(traderAnalytics.chain, CHAIN_DEFAULT), eq(traderAnalytics.address, address)))
      .limit(1);
    return row;
  }

  async saveState(row: AnalyticsInsert, tx: DbOrTx = this.db): Promise<AnalyticsRow> {
    const { chain: _chain, address: _address, ...rest } = row;
    const [saved] = await tx
      .insert(traderAnalytics)
      .values(row)
      .onConflictDoUpdate({ target: [traderAnalytics.chain, traderAnalytics.address], set: rest })
      .returning();
    return saved;
  }

  async allTrades(address: string, tx: DbOrTx = this.db): Promise<Trade[]> {
    const rows = await tx.select().from(traderTrades).where(mine(address)).orderBy(asc(traderTrades.entryTime));
    return rows.map(fromRow);
  }

  async openTrades(address: string, tx: DbOrTx = this.db): Promise<Trade[]> {
    const rows = await tx.select().from(traderTrades).where(and(mine(address), isNull(traderTrades.exitTime)));
    return rows.map(fromRow);
  }

  /** Trades that may take funding paid after `since`: open, or closed at or
   * after it, and not opened before funding coverage. */
  async fundableSince(address: string, since: Date, tx: DbOrTx = this.db): Promise<Trade[]> {
    const rows = await tx
      .select()
      .from(traderTrades)
      .where(
        and(
          mine(address),
          isNotNull(traderTrades.funding),
          or(isNull(traderTrades.exitTime), gte(traderTrades.exitTime, since)),
        ),
      );
    return rows.map(fromRow);
  }

  /** Funding so far per trade (tracked addresses keep it across a rebuild). */
  async fundingByTid(address: string, tx: DbOrTx = this.db): Promise<Map<bigint, number>> {
    const rows = await tx
      .select({ openTid: traderTrades.openTid, funding: traderTrades.funding })
      .from(traderTrades)
      .where(and(mine(address), isNotNull(traderTrades.funding)));
    return new Map(rows.map((r) => [r.openTid, Number(r.funding)]));
  }

  async upsertTrades(tx: DbOrTx, address: string, trades: Trade[]): Promise<void> {
    for (let i = 0; i < trades.length; i += INSERT_CHUNK) {
      const rows = trades.slice(i, i + INSERT_CHUNK).map((t) => toRow(address, t));
      await tx
        .insert(traderTrades)
        .values(rows)
        .onConflictDoUpdate({
          target: [traderTrades.chain, traderTrades.address, traderTrades.openTid],
          set: {
            exitTime: sql`excluded.exit_time`,
            sortTime: sql`excluded.sort_time`,
            position: sql`excluded.position`,
            preSize: sql`excluded.pre_size`,
            prePx: sql`excluded.pre_px`,
            entrySz: sql`excluded.entry_sz`,
            entryNtl: sql`excluded.entry_ntl`,
            exitSz: sql`excluded.exit_sz`,
            exitNtl: sql`excluded.exit_ntl`,
            realizedPnl: sql`excluded.realized_pnl`,
            fees: sql`excluded.fees`,
            funding: sql`excluded.funding`,
            netPnl: sql`excluded.net_pnl`,
            liquidated: sql`excluded.liquidated`,
            twap: sql`excluded.twap`,
            fills: sql`excluded.fills`,
            lastFillTime: sql`excluded.last_fill_time`,
          },
        });
    }
  }

  async deleteTrades(tx: DbOrTx, address: string, openTids: bigint[]): Promise<void> {
    if (openTids.length === 0) return;
    await tx.delete(traderTrades).where(and(mine(address), inArray(traderTrades.openTid, openTids)));
  }

  async replaceTrades(tx: DbOrTx, address: string, trades: Trade[]): Promise<void> {
    await tx.delete(traderTrades).where(mine(address));
    await this.upsertTrades(tx, address, trades);
  }

  async updateFunding(tx: DbOrTx, address: string, trades: Trade[]): Promise<void> {
    for (const t of trades) {
      await tx
        .update(traderTrades)
        .set({ funding: t.funding === null ? null : String(t.funding) })
        .where(and(mine(address), eq(traderTrades.openTid, t.openTid)));
    }
  }

  async count(address: string, status: "all" | "open" | "closed"): Promise<number> {
    const conditions: SQL[] = [mine(address)!];
    if (status === "open") conditions.push(isNull(traderTrades.exitTime));
    if (status === "closed") conditions.push(isNotNull(traderTrades.exitTime));
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(traderTrades).where(and(...conditions));
    return row?.n ?? 0;
  }

  /** Latest first by exit time (open trades by entry time), as CopyDog
   * lists them; `cursor` is the last row's (that time, openTid). */
  async page(
    address: string,
    status: "all" | "open" | "closed",
    limit: number,
    cursor: { sortTime: Date; openTid: bigint } | null,
  ): Promise<Trade[]> {
    const conditions: SQL[] = [mine(address)!];
    if (status === "open") conditions.push(isNull(traderTrades.exitTime));
    if (status === "closed") conditions.push(isNotNull(traderTrades.exitTime));
    if (cursor) {
      conditions.push(
        or(
          lt(traderTrades.sortTime, cursor.sortTime),
          and(eq(traderTrades.sortTime, cursor.sortTime), lt(traderTrades.openTid, cursor.openTid)),
        )!,
      );
    }
    const rows = await this.db
      .select()
      .from(traderTrades)
      .where(and(...conditions))
      .orderBy(desc(traderTrades.sortTime), desc(traderTrades.openTid))
      .limit(limit);
    return rows.map(fromRow);
  }

  /** What the watcher's `fills` table is proven to hold for the address. */
  async fillCoverage(address: string): Promise<FillCoverage | undefined> {
    const [row] = await this.db.select().from(fillCoverage)
      .where(and(eq(fillCoverage.chain, CHAIN_DEFAULT), eq(fillCoverage.address, address))).limit(1);
    return row;
  }

  /** A tracked address's stored perp fills in `[since, through]`, as
   * Hyperliquid sent them (`raw` keeps startPosition, liquidation and twapId). */
  async trackedFills(address: string, since: Date, through: Date): Promise<HlUserFill[]> {
    const rows = await this.db
      .select({ raw: fills.raw })
      .from(fills)
      .where(
        and(
          eq(fills.chain, CHAIN_DEFAULT),
          eq(fills.address, address),
          gte(fills.ts, since),
          lte(fills.ts, through),
          notLike(fills.coin, "@%"),
          notLike(fills.coin, "%/%"),
        ),
      );
    return rows.map((r) => r.raw as unknown as HlUserFill);
  }
}
