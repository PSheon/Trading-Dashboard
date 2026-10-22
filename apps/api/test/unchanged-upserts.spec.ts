import { cohortMembers, discoveryTraders, traderStats } from "@trading-dashboard/shared/database";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { AdminSourcesRepository } from "../src/admin/admin-sources.repository.js";
import { AdminSystemRepository } from "../src/admin/admin-system.repository.js";
import { DiscoveryRepository } from "../src/discovery/discovery.repository.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { CohortRepository, type CohortCandidate } from "../src/insights/cohort.repository.js";
import { COHORT_TIERS } from "../src/insights/cohorts.js";
import { parseLeaderboard } from "../src/traders/leaderboard.js";
import { LeaderboardIngestRepository } from "../src/traders/leaderboard-ingest.repository.js";
import { TradersRepository } from "../src/traders/traders.repository.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

/**
 * Cost reduction 2026-10-22 (§1 #8): the periodic re-imports of the
 * leaderboard (~19k rows every 15 min), the discovery pool and the cohort
 * members wrote a new version of every row, changed or not. A row whose
 * values are unchanged is now left alone: its tuple (xmin) stays the same.
 * The leaderboard's "as of" time, which every row carried in `updated_at`,
 * moves to `leaderboard_imports` and reads the same as before.
 */
const db = getTestDb();
const uow = new UnitOfWork(db);
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const T1 = new Date("2026-10-22T00:00:00Z");
const T2 = new Date("2026-10-22T00:15:00Z");
const T3 = new Date("2026-10-22T00:30:00Z");

/** Each row's tuple version: unchanged unless the row was written. */
async function versions(table: string): Promise<Record<string, string>> {
  const { rows } = await db.execute<{ address: string; v: string }>(sql.raw(`select address, xmin::text as v from ${table}`));
  return Object.fromEntries(rows.map((r) => [r.address, r.v]));
}
const board = (rows: Array<[number, number, string | null]>, at: Date) => parseLeaderboard({
  leaderboardRows: rows.map(([n, pnl, name]) => ({ ethAddress: addr(n), accountValue: "1000", displayName: name,
    windowPerformances: [["day", { pnl: "1", roi: "0.1", vlm: "10" }], ["week", { pnl: "2", roi: "0.2", vlm: "20" }],
      ["month", { pnl: String(pnl), roi: "0.3", vlm: "30" }], ["allTime", { pnl: "4", roi: "0.4", vlm: "40" }]] })),
}, at, new Set([addr(9)]));

beforeEach(() => truncateAll(db));
afterAll(closeTestDb);

describe("re-imports leave unchanged rows alone", () => {
  it("trader_stats: only new or changed rows are written, absent ones still go, and the as-of time is the import's", async () => {
    const ingest = new LeaderboardIngestRepository(db);
    await uow.run((tx) => ingest.replaceAll(tx, board([[1, 10, "One"], [2, 20, null], [3, 30, null], [9, 90, null]], T1), T1, true));
    const before = await versions("trader_stats");

    // 1 and 9 unchanged, 2 changed, 3 gone, 4 new.
    const removed = await uow.run((tx) => ingest.replaceAll(tx, board([[1, 10, "One"], [2, 25, null], [4, 40, null], [9, 90, null]], T2), T2, true));
    expect(removed).toBe(1);
    const after = await versions("trader_stats");
    expect(Object.keys(after).sort()).toEqual([addr(1), addr(2), addr(4), addr(9)]);
    expect(after[addr(1)]).toBe(before[addr(1)]);
    expect(after[addr(9)]).toBe(before[addr(9)]);
    expect(after[addr(2)]).not.toBe(before[addr(2)]);
    const stored = Object.fromEntries((await db.select().from(traderStats)).map((r) => [r.address, r]));
    expect(stored[addr(1)]!.updatedAt).toEqual(T1);
    expect(stored[addr(2)]).toMatchObject({ pnlMonth: "25", updatedAt: T2 });

    // Every reader still sees the leaderboard as of its last import.
    expect(await ingest.lastImportAt()).toEqual(T2);
    const traders = new TradersRepository(db);
    expect((await traders.findStats(addr(1)))[0]!.updatedAt).toEqual(T2);
    const discovery = new DiscoveryRepository(db);
    expect((await discovery.identitiesOf([addr(1)]))[0]!.statsUpdatedAt).toEqual(T2);
    await db.insert(discoveryTraders).values({ address: addr(1), poolRank: 1 });
    expect((await discovery.poolRowsOf([addr(1)]))[0]!.leaderboardUpdatedAt).toEqual(T2);
    const system = await new AdminSystemRepository((db as unknown as { $client: never }).$client).data();
    expect(new Date(system.leaderboardUpdatedAt!)).toEqual(T2);
    expect((await new AdminSourcesRepository(db).list()).items.find((i) => i.id === "leaderboard")!.latestAt).toBe(T2.toISOString());

    // A failed vault list keeps flags: a flag that differs is then not a change.
    const unflagged = board([[1, 10, "One"], [2, 25, null], [4, 40, null], [9, 90, null]], T3).map((r) => ({ ...r, isVault: false }));
    await uow.run((tx) => ingest.replaceAll(tx, unflagged, T3, false));
    expect((await versions("trader_stats"))[addr(9)]).toBe(before[addr(9)]);
    expect(await ingest.lastImportAt()).toEqual(T3);
    // ...and a fresh list that changes it is.
    await uow.run((tx) => ingest.replaceAll(tx, unflagged, new Date(T3.getTime() + 1), true));
    expect((await db.select().from(traderStats)).find((r) => r.address === addr(9))!.isVault).toBe(false);
  });

  it("an empty table has no import time, whatever the marker says", async () => {
    const ingest = new LeaderboardIngestRepository(db);
    expect(await ingest.lastImportAt()).toBeNull();
    await db.execute(sql`insert into leaderboard_imports (chain, imported_at) values ('hyperliquid', ${T1})`);
    expect(await ingest.lastImportAt()).toBeNull();
  });

  it("discovery_traders.syncPool: a member whose rank is unchanged is not rewritten", async () => {
    const discovery = new DiscoveryRepository(db);
    await uow.run((tx) => discovery.syncPool(tx, [{ address: addr(1), poolRank: 1 }, { address: addr(2), poolRank: 2 }, { address: addr(3), poolRank: 3 }]));
    const before = await versions("discovery_traders");
    const result = await uow.run((tx) => discovery.syncPool(tx, [{ address: addr(1), poolRank: 1 }, { address: addr(2), poolRank: 5 }, { address: addr(4), poolRank: 4 }]));
    expect(result).toEqual({ added: 1, removed: 1 });
    const after = await versions("discovery_traders");
    expect(after[addr(1)]).toBe(before[addr(1)]);
    expect(after[addr(2)]).not.toBe(before[addr(2)]);
    expect((await db.select().from(discoveryTraders).orderBy(discoveryTraders.address)).map((r) => [r.address, r.poolRank, r.inPool])).toEqual(
      [[addr(1), 1, true], [addr(2), 5, true], [addr(4), 4, true]]);
    // A row that had left the pool comes back.
    await db.update(discoveryTraders).set({ inPool: false }).where(sql`address = ${addr(1)}`);
    await uow.run((tx) => discovery.syncPool(tx, [{ address: addr(1), poolRank: 1 }, { address: addr(2), poolRank: 5 }, { address: addr(4), poolRank: 4 }]));
    expect((await db.select().from(discoveryTraders)).find((r) => r.address === addr(1))!.inPool).toBe(true);
  });

  it("cohort_members.sync: unchanged members are not rewritten; a new dex or any changed figure is", async () => {
    const cohorts = new CohortRepository(db);
    const tier = COHORT_TIERS[0];
    const member = (n: number, rank: number, dexes: string[] = [], pnlAll: string | null = "10"): CohortCandidate =>
      ({ address: addr(n), tier, source: "pool", rank, pnlAll, roiAll: "0.1", dexes });
    await cohorts.sync([member(1, 1, ["xyz"]), member(2, 2), member(3, 3), member(5, 5)]);
    const before = await versions("cohort_members");
    const result = await cohorts.sync([member(1, 1, ["xyz"]), member(2, 2, ["abc"]), member(3, 4), member(5, 5, [], "11"), member(6, 6)]);
    expect(result).toEqual({ added: 1, removed: 0 });
    const after = await versions("cohort_members");
    expect(after[addr(1)]).toBe(before[addr(1)]);
    for (const n of [2, 3, 5]) expect(after[addr(n)], `member ${n}`).not.toBe(before[addr(n)]);
    const rows = Object.fromEntries((await db.select().from(cohortMembers)).map((r) => [r.address, r]));
    expect(rows[addr(1)]!.dexes).toEqual(["xyz"]);
    expect(rows[addr(2)]!.dexes).toEqual(["abc"]);
    expect(rows[addr(3)]!.rank).toBe(4);
    expect(rows[addr(5)]!.pnlAll).toBe("11");
    // Known dexes only grow: a refresh that lists fewer changes nothing.
    await cohorts.sync([member(1, 1), member(2, 2, ["abc"]), member(3, 4), member(5, 5, [], "11"), member(6, 6)]);
    expect((await versions("cohort_members"))[addr(1)]).toBe(after[addr(1)]);
  });
});
