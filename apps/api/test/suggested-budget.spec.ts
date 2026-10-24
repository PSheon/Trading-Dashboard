import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDialect } from "drizzle-orm/pg-core";
import { archiveIngestState, copyStrategies, discoveryTraders, equitySnapshots, leaders, traderStats, traderSuggestedBudgets } from "@trading-dashboard/shared/database";

import type { HlUserFill } from "../src/hyperliquid/types.js";
import { HistoryFillStore } from "../src/traders/history-fill.store.js";
import { SuggestedBudgetRepository, suggestedMinBudgets } from "../src/traders/suggested-budget.repository.js";
import { SUGGESTED_BUDGET_FILLS_CAP } from "../src/config/constants/limits.js";
import { DAY_MS, HOUR_MS } from "../src/config/constants/time.js";
import type { DrizzleDb } from "../src/db/drizzle.provider.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

/**
 * Decision D7 (2026-10-23): suggested = ceil(10 × leader perp equity ÷ median notional of the leader's
 * position-increasing orders over the last 30 days), whole USD, hourly, from stored fills and equity.
 * Fewer than 5 adds: null. The window never reads below the history retention cut.
 * Stage 2026-10-24: one leader a statement (the `(account_id, time)` index), a per-run time budget with a cursor,
 * the newest SUGGESTED_BUDGET_FILLS_CAP fills of a heavy leader, and one leader's failure skips that leader only.
 */
const NOW = new Date("2026-10-23T12:00:00Z");
const A = `0x${"a1".repeat(20)}`, B = `0x${"b2".repeat(20)}`, C = `0x${"c3".repeat(20)}`;
/** The pool's statement_timeout (drizzle.provider.ts): the heavy path must finish well under it. */
const STATEMENT_TIMEOUT_MS = 15_000;
let tid = 1;
/** A fill `daysAgo` days before NOW; `dir` and `startPosition` as Hyperliquid writes them. */
const fill = (daysAgo: number, dir: string, px: number, sz: number, extra: Partial<HlUserFill> = {}): HlUserFill => ({
  coin: "BTC", px: String(px), sz: String(sz), side: dir.includes("Long") && !dir.startsWith("Close") ? "B" : "A", time: NOW.getTime() - daysAgo * DAY_MS,
  dir, closedPnl: "0", hash: `0x${(tid + 100).toString(16).padStart(64, "0")}`, oid: 1000 + tid, crossed: true, fee: "0", tid: tid++, ...extra });
const rows = (address: string, fills: HlUserFill[]) => fills.map(f => ({ address, source: f.twapId == null ? "regular" as const : "twap" as const, origin: "rest" as const, fill: f }));

describe("suggested minimum budget per leader", () => {
  const db = getTestDb(), store = new HistoryFillStore(db), repository = new SuggestedBudgetRepository(db);
  const stored = async (address: string) => (await db.select().from(traderSuggestedBudgets)).find(row => row.address === address);
  const addresses = async () => (await db.select({ address: traderSuggestedBudgets.address }).from(traderSuggestedBudgets)).map(r => r.address).sort();
  /**
   * `count` "Open Long" fills of `address` straight into history_fills (one order each, one a second, the newest
   * first): the newest `cap` are half notional 10 and half 20 (median 15), every older one notional 1, so a median
   * of 15 proves the sample is exactly the newest `cap` fills and 10 that an older fill got in.
   */
  const heavyFills = async (address: string, count: number, cap: number) => {
    const [account] = (await db.execute<{ id: number }>(sql`insert into history_accounts (address) values (${address}) returning id`)).rows;
    const [dir] = (await db.execute<{ id: number }>(sql`insert into history_terms (term) values ('Open Long') on conflict (term) do update set term = excluded.term returning id`)).rows;
    await db.execute(sql`
      insert into history_fills (tid, time, oid, twap_id, account_id, dir_id, twap, px, sz, origin)
      select g, ${NOW}::timestamptz - g * interval '1 second', g, -1, ${account!.id}, ${dir!.id}, false, 1,
        case when g <= ${cap / 2} then 10 when g <= ${cap} then 20 else 1 end, 'rest'
      from generate_series(1, ${count}) g`);
  };
  beforeEach(async () => { await truncateAll(db); tid = 1; await db.insert(leaders).values([{ address: A }, { address: B }, { address: C }]); });
  afterAll(async () => { await closeTestDb(); });

  it("median of the leader's adds (opens whole, a flip's part past zero, an order's fills summed, a tid once), × equity ÷ 10, rounded up", async () => {
    // Equity 20,000 from the latest snapshot (an older, different one is ignored).
    await db.insert(equitySnapshots).values([{ address: A, ts: new Date(NOW.getTime() - 2 * HOUR_MS), accountValue: "20000" }, { address: A, ts: new Date(NOW.getTime() - 5 * HOUR_MS), accountValue: "99999" }]);
    const fills = [
      fill(1, "Open Long", 100, 2),                       // 200
      fill(2, "Open Short", 100, 3),                      // 300
      fill(3, "Open Long", 100, 1, { oid: 7777 }), fill(3, "Open Long", 100, 3, { oid: 7777 }),  // one order: 400
      fill(4, "Long > Short", 100, 8, { startPosition: "3" }), // the part past zero: 5 × 100 = 500
      fill(5, "Open Long", 100, 6),                       // 600
      fill(6, "Close Long", 100, 9), fill(7, "Close Short", 100, 9), fill(8, "Short > Long", 100, 2, { startPosition: "-5" }), // closes and a flip that never passes zero: not adds
    ];
    await store.insert(rows(A, fills));
    // The same tid from the TWAP stream is the same fill, not a second add.
    await store.insert(rows(A, [{ ...fills[0]!, twapId: 55 }]));
    expect(await repository.refresh(NOW)).toMatchObject({ skipped: false, leaders: 3, suggested: 1, sampled: 0, failed: [], remaining: 0 });
    // Adds 200, 300, 400, 500, 600: median 400; 10 × 20,000 ÷ 400 = 500.
    expect(await stored(A)).toMatchObject({ suggestedMinBudgetUsd: 500, adds: 5, medianAddNotionalUsd: "400", leaderPerpEquityUsd: "20000", sampled: false });
    expect((await stored(A))!.windowFrom.getTime()).toBe(NOW.getTime() - 30 * DAY_MS);
    // Four adds are no sample: null, and the row says so. Nothing stored: null too.
    expect(await stored(B)).toMatchObject({ suggestedMinBudgetUsd: null, adds: 0 });
    expect(await suggestedMinBudgets(db, [A, B.toUpperCase(), `0x${"dd".repeat(20)}`])).toEqual(new Map([[A, 500], [B, null], [`0x${"dd".repeat(20)}`, null]]));
  });

  it("rounds up to whole USD; fewer than 5 adds, or no equity, is null", async () => {
    await db.insert(traderStats).values({ address: A, accountValue: "1234.5", pnlDay: "0", pnlWeek: "0", pnlMonth: "0", pnlAllTime: "0", roiDay: "0", roiWeek: "0", roiMonth: "0", roiAllTime: "0",
      volumeDay: "0", volumeWeek: "0", volumeMonth: "0", volumeAllTime: "0", updatedAt: NOW });
    // Five adds of 300: 10 × 1234.5 ÷ 300 = 41.15 → 42 (the leaderboard's account value when no snapshot is fresh).
    await store.insert(rows(A, Array.from({ length: 5 }, (_, i) => fill(i + 1, "Open Long", 100, 3))));
    // Four adds for B, with an equity: no sample.
    await db.insert(equitySnapshots).values({ address: B, ts: NOW, accountValue: "1000" });
    await store.insert(rows(B, Array.from({ length: 4 }, (_, i) => fill(i + 1, "Open Long", 100, 3))));
    // Five adds for C, no equity anywhere: nothing to scale.
    await store.insert(rows(C, Array.from({ length: 5 }, (_, i) => fill(i + 1, "Open Long", 100, 3))));
    await repository.refresh(NOW);
    expect(await stored(A)).toMatchObject({ suggestedMinBudgetUsd: 42, adds: 5 });
    expect(await stored(B)).toMatchObject({ suggestedMinBudgetUsd: null, adds: 4, leaderPerpEquityUsd: "1000" });
    expect(await stored(C)).toMatchObject({ suggestedMinBudgetUsd: null, adds: 5, leaderPerpEquityUsd: null });
  });

  it("reads 30 days back, and never below the history retention cut (the window shrinks, the sample with it)", async () => {
    await db.insert(equitySnapshots).values({ address: A, ts: NOW, accountValue: "1000" });
    // Three adds in the last 10 days, two between 10 and 30 days, one 31 days back.
    await store.insert(rows(A, [fill(1, "Open Long", 100, 1), fill(5, "Open Long", 100, 1), fill(9, "Open Long", 100, 1), fill(15, "Open Long", 100, 1), fill(29, "Open Long", 100, 1), fill(31, "Open Long", 100, 1)]));
    await repository.refresh(NOW);
    expect(await stored(A)).toMatchObject({ suggestedMinBudgetUsd: 100, adds: 5 });
    // Retention pruned below 10 days ago: the fills older than that are not this leader's record any more.
    const cut = new Date(NOW.getTime() - 10 * DAY_MS);
    await db.insert(archiveIngestState).values({ retainedFrom: cut });
    await repository.refresh(NOW);
    expect(await stored(A)).toMatchObject({ suggestedMinBudgetUsd: null, adds: 3, windowFrom: cut });
    expect(await repository.windowFrom(NOW)).toEqual(cut);
  });

  it("a leader with more fills than the cap is read through its newest `cap` fills only, and its row says so; one with none is written too", async () => {
    const cap = SUGGESTED_BUDGET_FILLS_CAP;
    await db.insert(equitySnapshots).values([{ address: A, ts: NOW, accountValue: "1500" }, { address: B, ts: NOW, accountValue: "1500" }, { address: C, ts: NOW, accountValue: "1500" }]);
    // A: exactly the cap (whole, median 15). B: the cap and 1,000 more (a market maker's month: the newest cap, median still 15;
    // the whole set would be 10). C: none.
    await heavyFills(A, cap, cap);
    await heavyFills(B, cap + 1_000, cap);
    const started = Date.now();
    const result = await repository.refresh(NOW);
    const ms = Date.now() - started;
    expect(result).toMatchObject({ skipped: false, leaders: 3, suggested: 2, sampled: 1, failed: [], remaining: 0 });
    expect(await stored(A)).toMatchObject({ suggestedMinBudgetUsd: 1000, adds: cap, medianAddNotionalUsd: "15", sampled: false });
    expect(await stored(B)).toMatchObject({ suggestedMinBudgetUsd: 1000, adds: cap, medianAddNotionalUsd: "15", sampled: true });
    expect(await stored(C)).toMatchObject({ suggestedMinBudgetUsd: null, adds: 0, leaderPerpEquityUsd: "1500", sampled: false });
    // Two heavy leaders and one empty, well under the pool's statement timeout each.
    expect(ms).toBeLessThan(STATEMENT_TIMEOUT_MS);
  });

  it("stops at the run's time budget (after at least one leader) and the next tick continues from where it stopped; a refresh that finds one running is skipped", async () => {
    await db.insert(equitySnapshots).values([{ address: A, ts: NOW, accountValue: "20000" }, { address: B, ts: NOW, accountValue: "3000" }]);
    await store.insert(rows(A, [200, 300, 400, 500, 600].map((sz, i) => fill(i + 1, "Open Long", 1, sz))));
    await store.insert(rows(B, [10, 20, 30, 40, 50, 60].map((sz, i) => fill(i + 1, "Open Short", 1, sz))));
    await store.insert(rows(C, [10, 20, 30].map((sz, i) => fill(i + 1, "Open Long", 1, sz))));
    // A departed leader's row goes on every tick, budget or not.
    await db.insert(traderSuggestedBudgets).values({ address: `0x${"d4".repeat(20)}`, adds: 9, suggestedMinBudgetUsd: 77, windowFrom: NOW, computedAt: NOW });
    const snapshot = async () => (await db.select().from(traderSuggestedBudgets)).map(({ computedAt: _at, ...row }) => row).sort((x, y) => x.address.localeCompare(y.address));
    // A budget of 0 ms: one leader a tick, in address order.
    expect(await repository.refresh(NOW, 0)).toMatchObject({ skipped: false, leaders: 1, suggested: 1, remaining: 2 });
    expect(await addresses()).toEqual([A]);
    expect(await repository.refresh(NOW, 0)).toMatchObject({ skipped: false, leaders: 1, suggested: 1, remaining: 1 });
    expect(await addresses()).toEqual([A, B]);
    expect(await repository.refresh(NOW, 0)).toMatchObject({ skipped: false, leaders: 1, suggested: 0, remaining: 0 });
    const paced = await snapshot();
    expect(paced.map(row => [row.address, row.suggestedMinBudgetUsd, row.adds])).toEqual([[A, 500, 5], [B, 858, 6], [C, null, 3]]);
    // The pass complete, the next tick starts over; a whole run writes the same rows.
    await db.execute(sql`delete from trader_suggested_budgets`);
    expect(await repository.refresh(NOW)).toMatchObject({ skipped: false, leaders: 3, suggested: 2, remaining: 0 });
    expect(await snapshot()).toEqual(paced);
    // Two refreshes at once: the second is skipped, the first runs to the end.
    const [first, second] = await Promise.all([repository.refresh(NOW), repository.refresh(NOW)]);
    expect(first).toMatchObject({ skipped: false, leaders: 3 });
    expect(second).toEqual({ skipped: true });
    expect(await repository.refresh(NOW)).toMatchObject({ skipped: false });
  });

  it("one leader's failed statement skips that leader only: the others are written, the run reports it, the next pass retries it", async () => {
    await db.insert(equitySnapshots).values([{ address: A, ts: NOW, accountValue: "20000" }, { address: B, ts: NOW, accountValue: "3000" }, { address: C, ts: NOW, accountValue: "1000" }]);
    for (const address of [A, B, C]) await store.insert(rows(address, [200, 300, 400, 500, 600].map((sz, i) => fill(i + 1, "Open Long", 1, sz))));
    // B's own statement fails (as a statement_timeout would); every other statement runs.
    const dialect = (db as unknown as { dialect: PgDialect }).dialect;
    let failing = true;
    const faulty = Object.create(db) as DrizzleDb;
    faulty.execute = ((query: Parameters<DrizzleDb["execute"]>[0]) => {
      const { sql: text, params } = dialect.sqlToQuery(query as never);
      if (failing && text.includes("insert into trader_suggested_budgets") && params.includes(B)) return Promise.reject(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }));
      return db.execute(query as never);
    }) as DrizzleDb["execute"];
    const result = await new SuggestedBudgetRepository(faulty).refresh(NOW);
    expect(result).toMatchObject({ skipped: false, leaders: 2, suggested: 2, remaining: 0, failed: [{ address: B, error: expect.stringContaining("57014") }] });
    expect(await addresses()).toEqual([A, C]);
    expect(await stored(A)).toMatchObject({ suggestedMinBudgetUsd: 500 });
    failing = false;
    expect(await new SuggestedBudgetRepository(faulty).refresh(NOW)).toMatchObject({ leaders: 3, failed: [] });
    expect(await stored(B)).toMatchObject({ suggestedMinBudgetUsd: 75 });
  });

  it("covers watched, copied and pool leaders, and drops the row of one that is none of these any more", async () => {
    await db.execute(sql`delete from leaders`);
    await db.insert(leaders).values({ address: A, active: false });
    const D = `0x${"d4".repeat(20)}`, E = `0x${"e5".repeat(20)}`;
    const user = await insertUser(db);
    await db.insert(copyStrategies).values([{ userId: user.id, leaderAddress: D, allocated: "100", cash: "100", status: "paused", activatedAt: NOW },
      { userId: user.id, leaderAddress: `0x${"f6".repeat(20)}`, allocated: "100", cash: "100", status: "stopped", activatedAt: NOW, stoppedAt: NOW }]);
    await db.insert(discoveryTraders).values({ address: E, inPool: true, accountValue: "500" });
    await db.insert(traderSuggestedBudgets).values({ address: B, adds: 9, suggestedMinBudgetUsd: 77, windowFrom: NOW, computedAt: NOW });
    const result = await repository.refresh(NOW);
    expect(result).toMatchObject({ skipped: false, leaders: 2 });
    expect(await addresses()).toEqual([D, E].sort());
    expect(await stored(E)).toMatchObject({ suggestedMinBudgetUsd: null, adds: 0, leaderPerpEquityUsd: "500" });
  });
});
