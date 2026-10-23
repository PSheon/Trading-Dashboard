import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { archiveIngestState, copyStrategies, discoveryTraders, equitySnapshots, leaders, traderStats, traderSuggestedBudgets } from "@trading-dashboard/shared/database";

import type { HlUserFill } from "../src/hyperliquid/types.js";
import { HistoryFillStore } from "../src/traders/history-fill.store.js";
import { SuggestedBudgetRepository, suggestedMinBudgets } from "../src/traders/suggested-budget.repository.js";
import { DAY_MS, HOUR_MS } from "../src/config/constants/time.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

/**
 * Decision D7 (2026-10-23): suggested = ceil(10 × leader perp equity ÷ median notional of the leader's
 * position-increasing orders over the last 30 days), whole USD, hourly, from stored fills and equity.
 * Fewer than 5 adds: null. The window never reads below the history retention cut.
 */
const NOW = new Date("2026-10-23T12:00:00Z");
const A = `0x${"a1".repeat(20)}`, B = `0x${"b2".repeat(20)}`, C = `0x${"c3".repeat(20)}`;
let tid = 1;
/** A fill `daysAgo` days before NOW; `dir` and `startPosition` as Hyperliquid writes them. */
const fill = (daysAgo: number, dir: string, px: number, sz: number, extra: Partial<HlUserFill> = {}): HlUserFill => ({
  coin: "BTC", px: String(px), sz: String(sz), side: dir.includes("Long") && !dir.startsWith("Close") ? "B" : "A", time: NOW.getTime() - daysAgo * DAY_MS,
  dir, closedPnl: "0", hash: `0x${(tid + 100).toString(16).padStart(64, "0")}`, oid: 1000 + tid, crossed: true, fee: "0", tid: tid++, ...extra });
const rows = (address: string, fills: HlUserFill[]) => fills.map(f => ({ address, source: f.twapId == null ? "regular" as const : "twap" as const, origin: "rest" as const, fill: f }));

describe("suggested minimum budget per leader", () => {
  const db = getTestDb(), store = new HistoryFillStore(db), repository = new SuggestedBudgetRepository(db);
  const stored = async (address: string) => (await db.select().from(traderSuggestedBudgets)).find(row => row.address === address);
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
    expect(await repository.refresh(NOW)).toMatchObject({ skipped: false, leaders: 3, suggested: 1, batches: 1 });
    // Adds 200, 300, 400, 500, 600: median 400; 10 × 20,000 ÷ 400 = 500.
    expect(await stored(A)).toMatchObject({ suggestedMinBudgetUsd: 500, adds: 5, medianAddNotionalUsd: "400", leaderPerpEquityUsd: "20000" });
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

  it("writes the leaders in bounded batches, each its own statement, to the same rows as one statement; a refresh that finds one running is skipped", async () => {
    await db.insert(equitySnapshots).values([{ address: A, ts: NOW, accountValue: "20000" }, { address: B, ts: NOW, accountValue: "3000" }]);
    await store.insert(rows(A, [200, 300, 400, 500, 600].map((sz, i) => fill(i + 1, "Open Long", 1, sz))));
    await store.insert(rows(B, [10, 20, 30, 40, 50, 60].map((sz, i) => fill(i + 1, "Open Short", 1, sz))));
    await store.insert(rows(C, [10, 20, 30].map((sz, i) => fill(i + 1, "Open Long", 1, sz))));
    const snapshot = async () => (await db.select().from(traderSuggestedBudgets)).map(({ computedAt: _at, ...row }) => row).sort((x, y) => x.address.localeCompare(y.address));
    expect(await repository.refresh(NOW, 100)).toMatchObject({ skipped: false, leaders: 3, suggested: 2, batches: 1 });
    const whole = await snapshot();
    expect(whole.map(row => [row.address, row.suggestedMinBudgetUsd, row.adds])).toEqual([[A, 500, 5], [B, 858, 6], [C, null, 3]]);
    await db.execute(sql`delete from trader_suggested_budgets`);
    expect(await repository.refresh(NOW, 1)).toMatchObject({ skipped: false, leaders: 3, suggested: 2, batches: 3 });
    expect(await snapshot()).toEqual(whole);
    expect(await repository.refresh(NOW, 2)).toMatchObject({ leaders: 3, batches: 2 });
    expect(await snapshot()).toEqual(whole);
    // Two refreshes at once: the second is skipped, the first runs to the end.
    const [first, second] = await Promise.all([repository.refresh(NOW), repository.refresh(NOW)]);
    expect(first).toMatchObject({ skipped: false, leaders: 3 });
    expect(second).toEqual({ skipped: true });
    expect(await repository.refresh(NOW)).toMatchObject({ skipped: false });
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
    expect((await db.select({ address: traderSuggestedBudgets.address }).from(traderSuggestedBudgets)).map(r => r.address).sort()).toEqual([D, E].sort());
    expect(await stored(E)).toMatchObject({ suggestedMinBudgetUsd: null, adds: 0, leaderPerpEquityUsd: "500" });
  });
});
