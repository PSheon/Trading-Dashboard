import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, gt, gte, inArray, lte, ne, notInArray, sql } from "drizzle-orm";
import {
  copyConsumerCheckpoints,
  copyControlEvents,
  copyControls,
  copyLedger,
  copyOrders,
  copyPaperFills,
  copyPositions,
  copyReservations,
  copyRiskPolicies,
  copySignalLegs,
  copySignalOutbox,
  copyStrategies,
  copyStrategyVersions,
  fills,
  leaders,
  paperAccounts,
  userFavorites,
  users,
  type CopyStrategySettingsJson,
} from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT, type CopyControlCommand, type CopyControlScope, type CopyLeg, type CopyOrderStatus } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbExecutor, DbTransaction } from "../db/unit-of-work.js";
import type { HlUserFill } from "../hyperliquid/types.js";
import { LIVE_STRATEGY_STATUSES, catchUpCopySignals, lockCopyLeader } from "./copy-outbox.js";

export type StrategyRow = typeof copyStrategies.$inferSelect;
export type OrderRow = typeof copyOrders.$inferSelect;
export type PositionRow = typeof copyPositions.$inferSelect;
export type ControlRow = typeof copyControls.$inferSelect;
export type OutboxRow = typeof copySignalOutbox.$inferSelect;

/** Orders that are not final yet (hold margin or wait for the executor). */
export const OPEN_ORDER_STATUSES: CopyOrderStatus[] = ["intent", "risk_approved", "submitting", "submitted", "unknown"];
/** Orders the executor may still cancel: not handed to an exchange. */
export const CANCELLABLE_ORDER_STATUSES: CopyOrderStatus[] = ["intent", "risk_approved"];
export const CONSUMER = "copy-signals";

/**
 * Persistence of copy trading. No method opens its own transaction or
 * calls out: services own UnitOfWork boundaries and pass `tx`. Methods named
 * `lock*` must run inside the caller's transaction.
 */
@Injectable()
export class CopyRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  // --- risk policy ------------------------------------------------------------

  async latestPolicy(ex: DbExecutor = this.db) {
    const [row] = await ex.select().from(copyRiskPolicies).orderBy(desc(copyRiskPolicies.version)).limit(1);
    return row;
  }

  async insertPolicy(tx: DbTransaction, limits: Record<string, unknown>, reason: string, userId: number | null) {
    const [row] = await tx.insert(copyRiskPolicies).values({ limits, reason, createdByUserId: userId }).returning();
    return row!;
  }

  /** Serializes policy edits (expectedVersion check). */
  async lockPolicies(tx: DbTransaction): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(7403, 0)`);
  }

  policyHistory(limit = 20) {
    return this.db.select({ version: copyRiskPolicies.version, reason: copyRiskPolicies.reason, createdByUserId: copyRiskPolicies.createdByUserId, createdAt: copyRiskPolicies.createdAt })
      .from(copyRiskPolicies).orderBy(desc(copyRiskPolicies.version)).limit(limit);
  }

  // --- controls -----------------------------------------------------------------

  async ensureControl(tx: DbTransaction, scope: "platform" | "user", scopeId: number): Promise<void> {
    await tx.insert(copyControls).values({ scope, scopeId }).onConflictDoNothing();
  }

  /** The platform row and the user's row, read in the caller's transaction.
   * `share` blocks a concurrent command until this transaction ends (and
   * waits for one in progress), so an order is never approved against a
   * control state that a committed command already replaced. */
  async readControls(userId: number, lock: "share" | "none" = "none", ex: DbExecutor = this.db) {
    const q = ex.select().from(copyControls).where(
      sql`(${copyControls.scope} = 'platform' and ${copyControls.scopeId} = 0) or (${copyControls.scope} = 'user' and ${copyControls.scopeId} = ${userId})`,
    );
    const rows = lock === "share" ? await q.for("share") : await q;
    const platform = rows.find((r) => r.scope === "platform");
    const user = rows.find((r) => r.scope === "user");
    return { platform, user };
  }

  async lockControl(tx: DbTransaction, scope: "platform" | "user", scopeId: number): Promise<ControlRow> {
    await this.ensureControl(tx, scope, scopeId);
    const [row] = await tx.select().from(copyControls).where(and(eq(copyControls.scope, scope), eq(copyControls.scopeId, scopeId))).for("update");
    return row!;
  }

  async updateControl(tx: DbTransaction, scope: "platform" | "user", scopeId: number, flags: { pauseNewRisk: boolean; reduceOnly: boolean }, actorUserId: number | null): Promise<ControlRow> {
    const [row] = await tx.update(copyControls)
      .set({ ...flags, revision: sql`${copyControls.revision} + 1`, updatedAt: new Date(), updatedByUserId: actorUserId })
      .where(and(eq(copyControls.scope, scope), eq(copyControls.scopeId, scopeId))).returning();
    return row!;
  }

  async insertControlEvent(tx: DbTransaction, values: { scope: CopyControlScope; scopeId: number; command: CopyControlCommand; revision: number; actorUserId: number | null; reason: string | null; result: Record<string, unknown> }) {
    const [row] = await tx.insert(copyControlEvents).values(values).returning();
    return row!;
  }

  recentControlEvents(limit = 30) {
    return this.db.select({ event: copyControlEvents, actorEmail: users.email }).from(copyControlEvents)
      .leftJoin(users, eq(users.id, copyControlEvents.actorUserId))
      .orderBy(desc(copyControlEvents.id)).limit(limit);
  }

  userControls() {
    return this.db.select().from(copyControls).where(eq(copyControls.scope, "user"));
  }

  async userExists(tx: DbTransaction, userId: number): Promise<boolean> {
    const [row] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId));
    return row !== undefined;
  }

  // --- paper accounts -------------------------------------------------------------

  /** Creates the account with `startingBalance` on first use, then locks it. */
  async lockPaperAccount(tx: DbTransaction, userId: number, startingBalance: string) {
    await tx.insert(paperAccounts).values({ userId, balance: startingBalance, startingBalance }).onConflictDoNothing();
    const [row] = await tx.select().from(paperAccounts).where(eq(paperAccounts.userId, userId)).for("update");
    return row!;
  }

  async paperAccount(userId: number) {
    const [row] = await this.db.select().from(paperAccounts).where(eq(paperAccounts.userId, userId));
    return row;
  }

  async adjustPaperBalance(tx: DbTransaction, userId: number, delta: string): Promise<void> {
    await tx.update(paperAccounts).set({ balance: sql`${paperAccounts.balance} + ${delta}::numeric`, updatedAt: new Date() }).where(eq(paperAccounts.userId, userId));
  }

  // --- strategies -----------------------------------------------------------------

  async insertStrategy(tx: DbTransaction, values: typeof copyStrategies.$inferInsert): Promise<StrategyRow> {
    const [row] = await tx.insert(copyStrategies).values(values).returning();
    return row!;
  }

  async insertVersion(tx: DbTransaction, strategyId: number, version: number, settings: CopyStrategySettingsJson, userId: number | null): Promise<void> {
    await tx.insert(copyStrategyVersions).values({ strategyId, version, settings, createdByUserId: userId });
  }

  async settingsOf(ex: DbExecutor, strategyId: number, version: number): Promise<CopyStrategySettingsJson> {
    const [row] = await ex.select({ settings: copyStrategyVersions.settings }).from(copyStrategyVersions)
      .where(and(eq(copyStrategyVersions.strategyId, strategyId), eq(copyStrategyVersions.version, version)));
    if (!row) throw new Error(`Strategy ${strategyId} has no version ${version}`);
    return row.settings;
  }

  versionsOf(strategyId: number) {
    return this.db.select().from(copyStrategyVersions).where(eq(copyStrategyVersions.strategyId, strategyId)).orderBy(desc(copyStrategyVersions.version));
  }

  async lockStrategy(tx: DbTransaction, id: number): Promise<StrategyRow | undefined> {
    const [row] = await tx.select().from(copyStrategies).where(eq(copyStrategies.id, id)).for("update");
    return row;
  }

  async findLive(tx: DbTransaction, userId: number, leader: string): Promise<StrategyRow | undefined> {
    const [row] = await tx.select().from(copyStrategies).where(and(eq(copyStrategies.userId, userId), eq(copyStrategies.chain, CHAIN_DEFAULT),
      eq(copyStrategies.leaderAddress, leader), ne(copyStrategies.status, "stopped")));
    return row;
  }

  async countLive(tx: DbTransaction, userId: number): Promise<number> {
    const [row] = await tx.select({ n: count() }).from(copyStrategies).where(and(eq(copyStrategies.userId, userId), ne(copyStrategies.status, "stopped")));
    return Number(row?.n ?? 0);
  }

  async updateStrategy(tx: DbTransaction, id: number, patch: Partial<typeof copyStrategies.$inferInsert>): Promise<StrategyRow> {
    const [row] = await tx.update(copyStrategies).set(patch).where(eq(copyStrategies.id, id)).returning();
    return row!;
  }

  /** Adds to the strategy's money columns (numeric strings, may be negative). */
  async addToStrategy(tx: DbTransaction, id: number, d: { cash?: string; allocated?: string; realizedPnl?: string; fees?: string; funding?: string }): Promise<void> {
    const set: Record<string, unknown> = {};
    if (d.cash) set.cash = sql`${copyStrategies.cash} + ${d.cash}::numeric`;
    if (d.allocated) set.allocated = sql`${copyStrategies.allocated} + ${d.allocated}::numeric`;
    if (d.realizedPnl) set.realizedPnl = sql`${copyStrategies.realizedPnl} + ${d.realizedPnl}::numeric`;
    if (d.fees) set.fees = sql`${copyStrategies.fees} + ${d.fees}::numeric`;
    if (d.funding) set.funding = sql`${copyStrategies.funding} + ${d.funding}::numeric`;
    if (Object.keys(set).length) await tx.update(copyStrategies).set(set).where(eq(copyStrategies.id, id));
  }

  /** A user's strategies with their current settings: live ones, and stopped
   * ones from the last `historyDays` days. */
  strategiesOfUser(userId: number, historyDays = 30) {
    return this.db.select({ strategy: copyStrategies, settings: copyStrategyVersions.settings }).from(copyStrategies)
      .innerJoin(copyStrategyVersions, and(eq(copyStrategyVersions.strategyId, copyStrategies.id), eq(copyStrategyVersions.version, copyStrategies.version)))
      .where(and(eq(copyStrategies.userId, userId), sql`(${copyStrategies.status} <> 'stopped' or ${copyStrategies.stoppedAt} > now() - make_interval(days => ${historyDays}))`))
      .orderBy(desc(copyStrategies.createdAt));
  }

  /** Every strategy (admin), optionally filtered. */
  allStrategies(filter: { status?: string; userId?: number; limit: number }) {
    const where = [
      filter.status ? eq(copyStrategies.status, filter.status as StrategyRow["status"]) : undefined,
      filter.userId ? eq(copyStrategies.userId, filter.userId) : undefined,
    ].filter(Boolean);
    return this.db.select({ strategy: copyStrategies, settings: copyStrategyVersions.settings, userEmail: users.email }).from(copyStrategies)
      .innerJoin(copyStrategyVersions, and(eq(copyStrategyVersions.strategyId, copyStrategies.id), eq(copyStrategyVersions.version, copyStrategies.version)))
      .leftJoin(users, eq(users.id, copyStrategies.userId))
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(copyStrategies.createdAt)).limit(filter.limit);
  }

  async strategyWithSettings(id: number) {
    const [row] = await this.db.select({ strategy: copyStrategies, settings: copyStrategyVersions.settings, userEmail: users.email }).from(copyStrategies)
      .innerJoin(copyStrategyVersions, and(eq(copyStrategyVersions.strategyId, copyStrategies.id), eq(copyStrategyVersions.version, copyStrategies.version)))
      .leftJoin(users, eq(users.id, copyStrategies.userId))
      .where(eq(copyStrategies.id, id));
    return row;
  }

  /** Live strategies copying any of `addresses`. */
  liveStrategiesOf(addresses: string[], ex: DbExecutor = this.db) {
    if (addresses.length === 0) return Promise.resolve([] as StrategyRow[]);
    return ex.select().from(copyStrategies).where(and(eq(copyStrategies.chain, CHAIN_DEFAULT), inArray(copyStrategies.leaderAddress, addresses),
      inArray(copyStrategies.status, [...LIVE_STRATEGY_STATUSES]))).orderBy(asc(copyStrategies.id));
  }

  liveStrategyIdsOfUser(tx: DbTransaction, userId: number | null) {
    const where = [inArray(copyStrategies.status, [...LIVE_STRATEGY_STATUSES]), userId === null ? undefined : eq(copyStrategies.userId, userId)].filter(Boolean);
    return tx.select({ id: copyStrategies.id, userId: copyStrategies.userId }).from(copyStrategies).where(and(...where)).orderBy(asc(copyStrategies.id));
  }

  stoppingStrategies() {
    return this.db.select().from(copyStrategies).where(eq(copyStrategies.status, "stopping"));
  }

  // --- leaders (watch list) ----------------------------------------------------------

  /** A copied address must be watched, or no fills arrive. Imported and
   * favorite-sourced rows are only reactivated, never re-sourced. Returns
   * true when the leader row was created. */
  async watchLeader(tx: DbTransaction, address: string): Promise<boolean> {
    const inserted = await tx.insert(leaders).values({ chain: CHAIN_DEFAULT, address, active: true, source: "copy" })
      .onConflictDoNothing({ target: [leaders.chain, leaders.address] }).returning({ address: leaders.address });
    if (inserted.length) return true;
    await tx.update(leaders).set({ active: true }).where(and(eq(leaders.chain, CHAIN_DEFAULT), eq(leaders.address, address), inArray(leaders.source, ["copy", "favorite"]), eq(leaders.active, false)));
    return false;
  }

  /** Stops watching a copy-sourced leader nobody copies or favorites any more. */
  async unwatchLeaderIfUnused(tx: DbTransaction, address: string): Promise<void> {
    await tx.update(leaders).set({ active: false }).where(and(eq(leaders.chain, CHAIN_DEFAULT), eq(leaders.address, address), eq(leaders.source, "copy"),
      sql`not exists (select 1 from ${copyStrategies} where ${copyStrategies.chain} = ${CHAIN_DEFAULT} and ${copyStrategies.leaderAddress} = ${address} and ${copyStrategies.status} <> 'stopped')`,
      sql`not exists (select 1 from ${userFavorites} where ${userFavorites.chain} = ${CHAIN_DEFAULT} and ${userFavorites.address} = ${address})`));
  }

  lockLeader(tx: DbTransaction, address: string) {
    return lockCopyLeader(tx, address);
  }

  catchUp(tx: DbTransaction, address: string, after: Date) {
    return catchUpCopySignals(tx, address, after);
  }

  // --- positions ------------------------------------------------------------------------

  positionsOf(strategyIds: number[], ex: DbExecutor = this.db) {
    if (strategyIds.length === 0) return Promise.resolve([] as PositionRow[]);
    return ex.select().from(copyPositions).where(and(inArray(copyPositions.strategyId, strategyIds), ne(copyPositions.size, "0"))).orderBy(asc(copyPositions.coin));
  }

  async lockPosition(tx: DbTransaction, strategyId: number, coin: string): Promise<PositionRow | undefined> {
    const [row] = await tx.select().from(copyPositions).where(and(eq(copyPositions.strategyId, strategyId), eq(copyPositions.coin, coin))).for("update");
    return row;
  }

  async savePosition(tx: DbTransaction, strategyId: number, coin: string, v: { size: string; entryPx: string; realizedPnl: string; opened: boolean }): Promise<void> {
    const now = new Date();
    await tx.insert(copyPositions).values({ strategyId, coin, size: v.size, entryPx: v.entryPx, realizedPnl: v.realizedPnl, openedAt: now, fundingThrough: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [copyPositions.strategyId, copyPositions.coin],
        set: {
          size: v.size, entryPx: v.entryPx, realizedPnl: sql`${copyPositions.realizedPnl} + ${v.realizedPnl}::numeric`, updatedAt: now,
          // A position reopened from flat starts a new holding period.
          ...(v.opened ? { openedAt: now, fundingThrough: now, funding: "0" } : {}),
        },
      });
  }

  /** Open positions whose funding hasn't been accrued through `hour`. */
  positionsDueFunding(hour: Date) {
    return this.db.select().from(copyPositions).where(and(ne(copyPositions.size, "0"), sql`${copyPositions.fundingThrough} < ${hour}`));
  }

  async accruePositionFunding(tx: DbTransaction, strategyId: number, coin: string, amount: string, through: Date): Promise<boolean> {
    const rows = await tx.update(copyPositions).set({ funding: sql`${copyPositions.funding} + ${amount}::numeric`, fundingThrough: through })
      .where(and(eq(copyPositions.strategyId, strategyId), eq(copyPositions.coin, coin), sql`${copyPositions.fundingThrough} < ${through}`)).returning({ coin: copyPositions.coin });
    return rows.length > 0;
  }

  // --- orders, reservations, fills, ledger ---------------------------------------------------

  async insertOrder(tx: DbTransaction, values: typeof copyOrders.$inferInsert): Promise<OrderRow> {
    const [row] = await tx.insert(copyOrders).values(values).returning();
    return row!;
  }

  async insertReservation(tx: DbTransaction, values: typeof copyReservations.$inferInsert): Promise<void> {
    await tx.insert(copyReservations).values(values);
  }

  async ordersLastMinute(tx: DbTransaction, strategyId: number): Promise<number> {
    const [row] = await tx.select({ n: count() }).from(copyOrders).where(and(eq(copyOrders.strategyId, strategyId),
      gte(copyOrders.createdAt, new Date(Date.now() - 60_000)), ne(copyOrders.status, "rejected")));
    return Number(row?.n ?? 0);
  }

  /** Signed size of not-yet-final orders per coin (buys +, sells −). */
  async pendingSizes(tx: DbTransaction, strategyId: number): Promise<Map<string, number>> {
    const rows = await tx.select({ coin: copyOrders.coin, side: copyOrders.side, size: copyOrders.size, filled: copyOrders.filledSize }).from(copyOrders)
      .where(and(eq(copyOrders.strategyId, strategyId), inArray(copyOrders.status, OPEN_ORDER_STATUSES)));
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.coin, (out.get(r.coin) ?? 0) + (r.side === "B" ? 1 : -1) * (Number(r.size) - Number(r.filled)));
    return out;
  }

  /** Signed size of pending reduce-only orders, keyed `strategyId:coin`: exposure
   * they are about to remove (a flip's close ahead of its open). */
  async pendingReduceSizes(tx: DbTransaction, strategyIds: number[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (strategyIds.length === 0) return out;
    const rows = await tx.select({ strategyId: copyOrders.strategyId, coin: copyOrders.coin, side: copyOrders.side, size: copyOrders.size, filled: copyOrders.filledSize }).from(copyOrders)
      .where(and(inArray(copyOrders.strategyId, strategyIds), eq(copyOrders.reduceOnly, true), inArray(copyOrders.status, OPEN_ORDER_STATUSES)));
    for (const r of rows) {
      const key = `${r.strategyId}:${r.coin}`;
      out.set(key, (out.get(key) ?? 0) + (r.side === "B" ? 1 : -1) * (Number(r.size) - Number(r.filled)));
    }
    return out;
  }

  /** Held reservations of the given strategies. */
  heldReservations(strategyIds: number[], ex: DbExecutor = this.db) {
    if (strategyIds.length === 0) return Promise.resolve([] as { strategyId: number; coin: string; notional: string; margin: string }[]);
    return ex.select({ strategyId: copyReservations.strategyId, coin: copyReservations.coin, notional: copyReservations.notional, margin: copyReservations.margin })
      .from(copyReservations).where(and(inArray(copyReservations.strategyId, strategyIds), eq(copyReservations.status, "held")));
  }

  /** Orders the executor should work on next, oldest first. */
  approvedOrderIds(limit: number) {
    return this.db.select({ id: copyOrders.id }).from(copyOrders).where(eq(copyOrders.status, "risk_approved")).orderBy(asc(copyOrders.id)).limit(limit);
  }

  /** `submitting` orders left by a crash or timeout. */
  staleSubmitting(olderThan: Date, limit: number) {
    return this.db.select({ id: copyOrders.id }).from(copyOrders).where(and(eq(copyOrders.status, "submitting"), lte(copyOrders.updatedAt, olderThan))).orderBy(asc(copyOrders.id)).limit(limit);
  }

  async lockOrder(tx: DbTransaction, id: bigint): Promise<OrderRow | undefined> {
    const [row] = await tx.select().from(copyOrders).where(eq(copyOrders.id, id)).for("update");
    return row;
  }

  /** Strategy and user of an order (immutable columns), read without a lock. */
  async orderOwner(id: bigint): Promise<{ strategyId: number; userId: number } | undefined> {
    const [row] = await this.db.select({ strategyId: copyOrders.strategyId, userId: copyOrders.userId }).from(copyOrders).where(eq(copyOrders.id, id));
    return row;
  }

  async updateOrder(tx: DbTransaction, id: bigint, patch: Partial<typeof copyOrders.$inferInsert>): Promise<void> {
    await tx.update(copyOrders).set({ ...patch, updatedAt: new Date() }).where(eq(copyOrders.id, id));
  }

  async settleReservation(tx: DbTransaction, orderId: bigint, status: "consumed" | "released"): Promise<void> {
    await tx.update(copyReservations).set({ status, settledAt: new Date() }).where(and(eq(copyReservations.orderId, orderId), eq(copyReservations.status, "held")));
  }

  /** Cancels orders not yet handed to an exchange, releasing their margin.
   * `onlyIncreasing` leaves reduce-only orders alone. Returns the count. */
  async cancelPending(tx: DbTransaction, strategyIds: number[], reason: string, onlyIncreasing = false): Promise<number> {
    if (strategyIds.length === 0) return 0;
    const where = and(inArray(copyOrders.strategyId, strategyIds), inArray(copyOrders.status, CANCELLABLE_ORDER_STATUSES), onlyIncreasing ? eq(copyOrders.reduceOnly, false) : undefined);
    const rows = await tx.update(copyOrders).set({ status: "cancelled", reason, updatedAt: new Date() }).where(where).returning({ id: copyOrders.id });
    if (rows.length) {
      await tx.update(copyReservations).set({ status: "released", settledAt: new Date() })
        .where(and(inArray(copyReservations.orderId, rows.map((r) => r.id)), eq(copyReservations.status, "held")));
    }
    return rows.length;
  }

  /** Coins with a pending stop-close order, per strategy (no duplicate closes). */
  async pendingStopCloses(tx: DbTransaction, strategyIds: number[]): Promise<Set<string>> {
    if (strategyIds.length === 0) return new Set();
    const rows = await tx.select({ strategyId: copyOrders.strategyId, coin: copyOrders.coin }).from(copyOrders)
      .where(and(inArray(copyOrders.strategyId, strategyIds), eq(copyOrders.leg, "stop_close"), inArray(copyOrders.status, OPEN_ORDER_STATUSES)));
    return new Set(rows.map((r) => `${r.strategyId}:${r.coin}`));
  }

  async openOrderCount(ex: DbExecutor, strategyId: number): Promise<number> {
    const [row] = await ex.select({ n: count() }).from(copyOrders).where(and(eq(copyOrders.strategyId, strategyId), inArray(copyOrders.status, OPEN_ORDER_STATUSES)));
    return Number(row?.n ?? 0);
  }

  /** Per strategy: open (pending) orders and filled / partially filled orders. */
  async orderCounts(strategyIds: number[]) {
    if (strategyIds.length === 0) return new Map<number, { pending: number; filled: number }>();
    const rows = await this.db.select({ strategyId: copyOrders.strategyId, status: copyOrders.status, n: count() }).from(copyOrders)
      .where(inArray(copyOrders.strategyId, strategyIds)).groupBy(copyOrders.strategyId, copyOrders.status);
    const out = new Map<number, { pending: number; filled: number }>();
    for (const r of rows) {
      const cur = out.get(r.strategyId) ?? { pending: 0, filled: 0 };
      if (OPEN_ORDER_STATUSES.includes(r.status)) cur.pending += Number(r.n);
      if (r.status === "filled" || r.status === "partial") cur.filled += Number(r.n);
      out.set(r.strategyId, cur);
    }
    return out;
  }

  ordersOfStrategy(strategyId: number, limit = 100) {
    return this.db.select().from(copyOrders).where(eq(copyOrders.strategyId, strategyId)).orderBy(desc(copyOrders.id)).limit(limit);
  }

  allOrders(filter: { status?: CopyOrderStatus[]; userId?: number; strategyId?: number; limit: number }) {
    const where = [
      filter.status?.length ? inArray(copyOrders.status, filter.status) : undefined,
      filter.userId ? eq(copyOrders.userId, filter.userId) : undefined,
      filter.strategyId ? eq(copyOrders.strategyId, filter.strategyId) : undefined,
    ].filter(Boolean);
    return this.db.select({ order: copyOrders, userEmail: users.email }).from(copyOrders).leftJoin(users, eq(users.id, copyOrders.userId))
      .where(where.length ? and(...where) : undefined).orderBy(desc(copyOrders.id)).limit(filter.limit);
  }

  ordersByStatusSince(since: Date) {
    return this.db.select({ status: copyOrders.status, n: count() }).from(copyOrders).where(gte(copyOrders.createdAt, since)).groupBy(copyOrders.status);
  }

  strategiesByStatus() {
    return this.db.select({ status: copyStrategies.status, n: count() }).from(copyStrategies).groupBy(copyStrategies.status);
  }

  async insertPaperFill(tx: DbTransaction, values: typeof copyPaperFills.$inferInsert): Promise<void> {
    await tx.insert(copyPaperFills).values(values);
  }

  async insertLedger(tx: DbTransaction, rows: (typeof copyLedger.$inferInsert)[]): Promise<void> {
    const nonZero = rows.filter((r) => Number(r.amount) !== 0);
    if (nonZero.length) await tx.insert(copyLedger).values(nonZero);
  }

  ledgerOf(strategyId: number, limit = 200) {
    return this.db.select().from(copyLedger).where(eq(copyLedger.strategyId, strategyId)).orderBy(desc(copyLedger.id)).limit(limit);
  }

  // --- execution outbox and signal legs ------------------------------------------------------

  /** Pending outbox rows, oldest first (no lock: the claim re-checks). */
  pendingOutbox(limit: number) {
    return this.db.select().from(copySignalOutbox).where(and(eq(copySignalOutbox.status, "pending"), lte(copySignalOutbox.availableAt, new Date())))
      .orderBy(asc(copySignalOutbox.id)).limit(limit);
  }

  /** Claims rows still pending for this transaction; another consumer skips them. */
  claimOutbox(tx: DbTransaction, ids: bigint[]) {
    if (ids.length === 0) return Promise.resolve([] as OutboxRow[]);
    return tx.select().from(copySignalOutbox).where(and(inArray(copySignalOutbox.id, ids), eq(copySignalOutbox.status, "pending")))
      .orderBy(asc(copySignalOutbox.id)).for("update", { skipLocked: true });
  }

  async markOutboxDone(tx: DbTransaction, ids: bigint[]): Promise<void> {
    if (ids.length) await tx.update(copySignalOutbox).set({ status: "done", processedAt: new Date(), lastError: null }).where(inArray(copySignalOutbox.id, ids));
  }

  /** A failed attempt: retry later with backoff, or give up after `maxAttempts`. */
  async failOutbox(ids: bigint[], error: string, maxAttempts: number): Promise<void> {
    if (ids.length === 0) return;
    await this.db.update(copySignalOutbox).set({
      attempts: sql`${copySignalOutbox.attempts} + 1`,
      lastError: error.slice(0, 500),
      status: sql`case when ${copySignalOutbox.attempts} + 1 >= ${maxAttempts} then 'failed' else 'pending' end`,
      availableAt: sql`now() + make_interval(secs => least(300, 2 ^ (${copySignalOutbox.attempts} + 1)))`,
    }).where(and(inArray(copySignalOutbox.id, ids), eq(copySignalOutbox.status, "pending")));
  }

  /** Rows that wait for market data: still pending, retried after a short
   * backoff (2 s doubling to 30 s). Never parked as `failed` by this path:
   * the wait ends when the data returns or the open goes stale. */
  async deferOutbox(tx: DbTransaction, ids: bigint[], reason: string): Promise<void> {
    if (ids.length === 0) return;
    await tx.update(copySignalOutbox).set({
      attempts: sql`${copySignalOutbox.attempts} + 1`,
      lastError: reason.slice(0, 500),
      availableAt: sql`now() + make_interval(secs => least(30, 2 ^ least(10, ${copySignalOutbox.attempts} + 1)))`,
    }).where(and(inArray(copySignalOutbox.id, ids), eq(copySignalOutbox.status, "pending")));
  }

  /** Advances the consumer checkpoint to the highest id with nothing pending below it. */
  async advanceCheckpoint(tx: DbTransaction, processed: number): Promise<void> {
    await tx.insert(copyConsumerCheckpoints).values({ consumer: CONSUMER }).onConflictDoNothing();
    await tx.update(copyConsumerCheckpoints).set({
      lastOutboxId: sql`greatest(${copyConsumerCheckpoints.lastOutboxId}, coalesce(
        (select min(${copySignalOutbox.id}) - 1 from ${copySignalOutbox} where ${copySignalOutbox.status} = 'pending'),
        (select max(${copySignalOutbox.id}) from ${copySignalOutbox}), 0))`,
      processed: sql`${copyConsumerCheckpoints.processed} + ${processed}`,
      updatedAt: new Date(),
    }).where(eq(copyConsumerCheckpoints.consumer, CONSUMER));
  }

  async checkpoint() {
    const [row] = await this.db.select().from(copyConsumerCheckpoints).where(eq(copyConsumerCheckpoints.consumer, CONSUMER));
    return row;
  }

  async outboxStats() {
    const rows = await this.db.select({ status: copySignalOutbox.status, n: count(), oldest: sql<Date | null>`min(${copySignalOutbox.createdAt})` })
      .from(copySignalOutbox).where(inArray(copySignalOutbox.status, ["pending", "failed"])).groupBy(copySignalOutbox.status);
    return rows;
  }

  /** Stored raw fills (the verified source) of `address` among `tids`. */
  async leaderFills(ex: DbExecutor, address: string, tids: bigint[]): Promise<HlUserFill[]> {
    if (tids.length === 0) return [];
    const rows = await ex.select({ raw: fills.raw }).from(fills)
      .where(and(eq(fills.chain, CHAIN_DEFAULT), eq(fills.address, address), inArray(fills.tid, tids)));
    return rows.map((r) => r.raw as unknown as HlUserFill);
  }

  /** Records a leg once; false when this (strategy, tid, leg) was already seen. */
  async claimLeg(tx: DbTransaction, v: { strategyId: number; tid: bigint; leg: CopyLeg; strategyVersion: number; coin: string; fillTime: Date }): Promise<boolean> {
    const rows = await tx.insert(copySignalLegs).values({ ...v, dedupeKey: `${v.strategyId}:${v.tid}:${v.leg}:v${v.strategyVersion}`, outcome: "pending" })
      .onConflictDoNothing().returning({ tid: copySignalLegs.tid });
    return rows.length > 0;
  }

  async resolveLegs(tx: DbTransaction, strategyId: number, legs: { tid: bigint; leg: CopyLeg }[], outcome: string, orderId: bigint | null): Promise<void> {
    for (const l of legs) {
      await tx.update(copySignalLegs).set({ outcome, orderId }).where(and(eq(copySignalLegs.strategyId, strategyId), eq(copySignalLegs.tid, l.tid), eq(copySignalLegs.leg, l.leg)));
    }
  }

  /** Un-claims legs that could not be decided this pass (market data
   * missing), so the retry claims them again. Only ever called for legs
   * claimed in the same transaction, which have no order. */
  async releaseLegs(tx: DbTransaction, strategyId: number, legs: { tid: bigint; leg: CopyLeg }[]): Promise<void> {
    for (const l of legs) {
      await tx.delete(copySignalLegs).where(and(eq(copySignalLegs.strategyId, strategyId), eq(copySignalLegs.tid, l.tid), eq(copySignalLegs.leg, l.leg), eq(copySignalLegs.outcome, "pending")));
    }
  }

  /** Whether this strategy already acted on a newer fill of `coin`
   * (an older open arriving now is superseded). */
  async hasNewerLeg(tx: DbTransaction, strategyId: number, coin: string, fillTime: Date, excludeTids: bigint[]): Promise<boolean> {
    const [row] = await tx.select({ tid: copySignalLegs.tid }).from(copySignalLegs)
      .where(and(eq(copySignalLegs.strategyId, strategyId), eq(copySignalLegs.coin, coin), gt(copySignalLegs.fillTime, fillTime),
        excludeTids.length ? notInArray(copySignalLegs.tid, excludeTids) : undefined)).limit(1);
    return row !== undefined;
  }

  // --- adoption repair ----------------------------------------------------------------------

  /** Adoption orders of active strategies that were rejected with one of
   * `reasons`, oldest first. */
  rejectedAdoptions(reasons: string[], strategyId?: number) {
    return this.db.select({ order: copyOrders }).from(copyOrders)
      .innerJoin(copyStrategies, eq(copyStrategies.id, copyOrders.strategyId))
      .where(and(eq(copyOrders.leg, "adopt"), eq(copyOrders.status, "rejected"), inArray(copyOrders.reason, reasons), eq(copyStrategies.status, "active"),
        strategyId === undefined ? undefined : eq(copyOrders.strategyId, strategyId)))
      .orderBy(asc(copyOrders.id));
  }

  /** How many adoption orders (any status) a strategy has for `coin`. */
  async adoptOrderCount(ex: DbExecutor, strategyId: number, coin: string): Promise<number> {
    const [row] = await ex.select({ n: count() }).from(copyOrders).where(and(eq(copyOrders.strategyId, strategyId), eq(copyOrders.coin, coin), eq(copyOrders.leg, "adopt")));
    return Number(row?.n ?? 0);
  }

  /** Fills of `address` the consumer has not finished yet. */
  async unfinishedOutboxCount(ex: DbExecutor, address: string): Promise<number> {
    const [row] = await ex.select({ n: count() }).from(copySignalOutbox)
      .where(and(eq(copySignalOutbox.chain, CHAIN_DEFAULT), eq(copySignalOutbox.address, address), eq(copySignalOutbox.status, "pending")));
    return Number(row?.n ?? 0);
  }

  /** Per-user exposure inputs (admin): live strategies with positions. */
  liveStrategies() {
    return this.db.select({ strategy: copyStrategies, userEmail: users.email }).from(copyStrategies).leftJoin(users, eq(users.id, copyStrategies.userId))
      .where(inArray(copyStrategies.status, [...LIVE_STRATEGY_STATUSES])).orderBy(asc(copyStrategies.userId));
  }
}
