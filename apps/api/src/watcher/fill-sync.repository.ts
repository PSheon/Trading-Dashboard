import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { actions, copyStrategies, fillCoverage, fills, leaders, type FillCoverageBreak } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";
import type { HlUserFill } from "../hyperliquid/types.js";
import type { ActionDraft } from "./action-classifier.js";
import { actionsCovering, chunks, draftToRow, insertActions, lockActions, storedFills } from "./action-store.js";
import { toFillRow } from "./fill-row.js";
import { lastMillisecondPerCoin, SPAN_PAGE_FILLS, storedFillPages } from "./stored-fill-pages.js";
import { LIVE_STRATEGY_STATUSES, enqueueCopySignals, lockCopyLeader } from "../copy/copy-outbox.js";

export type { ActionRow } from "./action-store.js";
export type FillCoverageRow = typeof fillCoverage.$inferSelect;
const covered = (address: string) => and(eq(fillCoverage.chain, CHAIN_DEFAULT), eq(fillCoverage.address, address));

/** Raw fills may commit before derivation; replay under the shared action lock repairs gaps. */
@Injectable()
export class FillSyncRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  /** Fills per page of a full continuity check; settable for tests. */
  spanPageFills = SPAN_PAGE_FILLS;

  /** Whether a live copy follows `address`: its stored fills become copy signals. */
  async isCopied(address: string): Promise<boolean> {
    const [row] = await this.db.select({ id: copyStrategies.id }).from(copyStrategies)
      .where(and(eq(copyStrategies.mode, "paper"), eq(copyStrategies.chain, CHAIN_DEFAULT), eq(copyStrategies.leaderAddress, address), inArray(copyStrategies.status, [...LIVE_STRATEGY_STATUSES]))).limit(1);
    return row !== undefined;
  }

  async recentTwap(address: string, cutoff: Date) {
    const [row] = await this.db
      .select({ ts: fills.ts })
      .from(fills)
      .where(
        and(
          eq(fills.chain, CHAIN_DEFAULT),
          eq(fills.address, address),
          gte(fills.ts, cutoff),
          sql`${fills.raw}->>'twapId' is not null`,
        ),
      )
      .limit(1);
    return row;
  }

  /** Chunk inserts to respect bind limits; return tids inserted by this call only.
   * Each chunk commits together with its copy-execution outbox rows (fills
   * of a copied leader), under the copy leader lock. */
  async insertFills(address: string, perps: HlUserFill[]): Promise<Set<bigint>> {
    const insertedTids = new Set<bigint>();
    for (const chunk of chunks(perps)) {
      const inserted = await this.db.transaction(async (tx) => {
        await lockCopyLeader(tx, address);
        const rows = await tx
          .insert(fills)
          .values(chunk.map((f) => toFillRow(address, f)))
          .onConflictDoNothing()
          .returning({ tid: fills.tid, ts: fills.ts });
        await enqueueCopySignals(tx, address, rows);
        return rows;
      });
      for (const r of inserted) insertedTids.add(r.tid);
    }
    return insertedTids;
  }

  /** Same advisory lock as the feed fast path; acquire before checking action coverage. */
  lock(tx: DbTransaction, address: string): Promise<void> {
    return lockActions(tx, address);
  }

  covering(tx: DbTransaction, address: string, tids: bigint[], minTime: number) {
    return actionsCovering(tx, address, tids, minTime);
  }

  storedFills(tx: DbTransaction, address: string, tids: bigint[]) {
    return storedFills(tx, address, tids);
  }

  /** Persist actions and optional delivery intent under the caller's address lock. */
  insertActions(tx: DbTransaction, address: string, drafts: ActionDraft[], enqueue = false,
    equityUsd: number | null = null, maxActionAgeSeconds?: number) {
    return insertActions(tx, address, drafts, enqueue, equityUsd, maxActionAgeSeconds);
  }

  /** Correct the derived shape while preserving the original leverage; do not enqueue alerts. */
  correct(tx: DbTransaction, address: string, id: bigint, draft: ActionDraft) {
    const { leverage: _leverage, ...shape } = draftToRow(address, draft);
    return tx.update(actions).set(shape).where(eq(actions.id, id)).returning();
  }

  // --- coverage: the span of `fills` proven complete ------------------------

  async coverage(address: string): Promise<FillCoverageRow | undefined> {
    return (await this.db.select().from(fillCoverage).where(covered(address)))[0];
  }

  /**
   * Grows the verified span after a completed read. Compare-and-set on the
   * edge being moved: a concurrent writer (a second process, the repair
   * command) that already moved it makes this a no-op, never a regression.
   * `forward` moves `verified_through` from `expected` to `to` (creating
   * the row, with the span starting at `expected`, when there is none);
   * otherwise `verified_from` moves back from `expected` to `to`.
   */
  async extend(address: string, forward: boolean, expected: number, to: number, floor: number, patch: Partial<Pick<FillCoverageRow, "backfillStatus" | "backfillSpanMs" | "revisedAt">> = {}): Promise<boolean> {
    const now = new Date();
    if (forward) {
      const rows = await this.db.insert(fillCoverage)
        .values({ address, verifiedFrom: new Date(expected), verifiedThrough: new Date(to), backfillFloor: new Date(floor), ...patch })
        .onConflictDoUpdate({
          target: [fillCoverage.chain, fillCoverage.address],
          set: { verifiedThrough: new Date(to), lastError: null, updatedAt: now, ...patch },
          setWhere: eq(fillCoverage.verifiedThrough, new Date(expected)),
        }).returning({ address: fillCoverage.address });
      return rows.length > 0;
    }
    const rows = await this.db.update(fillCoverage)
      .set({ verifiedFrom: new Date(to), lastError: null, updatedAt: now, ...patch })
      .where(and(covered(address), eq(fillCoverage.verifiedFrom, new Date(expected))))
      .returning({ address: fillCoverage.address });
    return rows.length > 0;
  }

  async patchCoverage(address: string, patch: Partial<Pick<FillCoverageRow, "verifiedFrom" | "backfillFloor" | "backfillStatus" | "backfillSpanMs" | "revisedAt" | "checkedThrough" | "breaks" | "lastError" | "failedAt">>): Promise<void> {
    await this.db.update(fillCoverage).set({ ...patch, updatedAt: new Date() }).where(covered(address));
  }

  /** The least recently touched active address whose backward backfill is unfinished. */
  async nextBackfill(): Promise<string | undefined> {
    const [row] = await this.db.select({ address: fillCoverage.address }).from(fillCoverage)
      .innerJoin(leaders, and(eq(leaders.chain, fillCoverage.chain), eq(leaders.address, fillCoverage.address), eq(leaders.active, true)))
      .where(and(eq(fillCoverage.chain, CHAIN_DEFAULT), eq(fillCoverage.backfillStatus, "pending")))
      .orderBy(asc(fillCoverage.updatedAt)).limit(1);
    return row?.address;
  }

  /** Coverage rows the backfill stopped at an earlier, smaller fill cap
   * whose span still holds fewer than `maxFills`: back to `pending`, so the
   * backfill carries on to REST's retention or the lookback. Returns them. */
  async reopenCapped(maxFills: number): Promise<string[]> {
    const rows = await this.db.update(fillCoverage).set({ backfillStatus: "pending", updatedAt: new Date() })
      .where(and(eq(fillCoverage.chain, CHAIN_DEFAULT), eq(fillCoverage.backfillStatus, "capped"),
        sql`(select count(*) from ${fills} where ${fills.chain} = ${fillCoverage.chain} and ${fills.address} = ${fillCoverage.address} and ${fills.ts} >= ${fillCoverage.verifiedFrom}) < ${maxFills}`))
      .returning({ address: fillCoverage.address });
    return rows.map((row) => row.address);
  }

  async countFillsSince(address: string, since: Date): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(fills)
      .where(and(eq(fills.chain, CHAIN_DEFAULT), eq(fills.address, address), gte(fills.ts, since)));
    return row?.n ?? 0;
  }

  /**
   * Stored fills in `[from, through]` as Hyperliquid sent them, preceded
   * (when `from` is after `spanFrom`) by each coin's last stored
   * millisecond of fills inside `[spanFrom, from)`, so a continuity check
   * of the window starts every coin from its known position.
   */
  async fillsForCheck(address: string, spanFrom: Date, from: Date, through: Date): Promise<HlUserFill[]> {
    const mine = and(eq(fills.chain, CHAIN_DEFAULT), eq(fills.address, address));
    const window = await this.db.select({ raw: fills.raw }).from(fills).where(and(mine, gte(fills.ts, from), lte(fills.ts, through)));
    const seeds = from > spanFrom
      ? await this.db.execute<{ raw: HlUserFill }>(sql`
          SELECT f.raw FROM ${fills} f JOIN (
            SELECT coin, max(ts) AS ts FROM ${fills}
            WHERE chain = ${CHAIN_DEFAULT} AND address = ${address} AND ts >= ${spanFrom.toISOString()}::timestamptz AND ts < ${from.toISOString()}::timestamptz GROUP BY coin
          ) last ON last.coin = f.coin AND last.ts = f.ts
          WHERE f.chain = ${CHAIN_DEFAULT} AND f.address = ${address}`)
      : { rows: [] as Array<{ raw: HlUserFill }> };
    return [...seeds.rows.map((r) => r.raw), ...window.map((r) => r.raw as unknown as HlUserFill)];
  }

  /** `fillsForCheck` in pages (see `storedFillPages`): each page is
   * preceded by every coin's last millisecond before it (in the span), so
   * a check of each page continues every coin from its known position and
   * a whole span is never in memory at once. */
  async *fillPagesForCheck(address: string, spanFrom: Date, from: Date, through: Date): AsyncGenerator<HlUserFill[]> {
    let tail = from > spanFrom ? await this.fillsForCheck(address, spanFrom, from, new Date(from.getTime() - 1)) : [];
    tail = lastMillisecondPerCoin(tail.filter((f) => f.time < from.getTime()));
    for await (const page of storedFillPages(this.db, address, from, through, { pageSize: this.spanPageFills })) {
      yield [...tail, ...page];
      tail = lastMillisecondPerCoin([...tail, ...page]);
    }
  }
}

export type { FillCoverageBreak };
