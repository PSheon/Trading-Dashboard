import { equitySnapshots, leaders, positionSnapshots } from "@trading-dashboard/shared/database";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { InsightsController } from "../src/insights/insights.controller.js";
import { InsightsService, snapshotNotional } from "../src/insights/insights.service.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const L1 = `0x${"11".repeat(20)}`;
const L2 = `0x${"22".repeat(20)}`;
const L3 = `0x${"33".repeat(20)}`; // snapshot too old
const L4 = `0x${"44".repeat(20)}`; // inactive leader
const L5 = `0x${"55".repeat(20)}`; // flat now

const NOW = new Date("2026-09-29T12:00:00Z");
const MIN = 60_000;
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * MIN);
const DAY_MIN = 24 * 60;

describe("snapshotNotional", () => {
  it("is |szi| × the snapshot's mark, recovered from entry price and unrealized PnL", () => {
    // Long 2 @ 60,000 with +2,000 uPnL → mark 61,000 → 122,000.
    expect(snapshotNotional(2, 60_000, 2_000)).toBe(122_000);
    // Short 10 @ 3,000 with +1,000 uPnL → mark 2,900 → 29,000.
    expect(snapshotNotional(-10, 3_000, 1_000)).toBe(29_000);
    expect(snapshotNotional(100, 150, null)).toBe(15_000);
    expect(snapshotNotional(1, null, 5)).toBeNull();
  });
});

describe("InsightsService.crowd — real Postgres", () => {
  const db = getTestDb();
  let service: InsightsService;

  async function snapshot(
    address: string,
    ts: Date,
    positions: Array<{ coin: string; szi: string; entryPx: string | null; uPnl: string | null }>,
  ) {
    await db.insert(equitySnapshots).values({ address, ts, accountValue: "1000" });
    if (positions.length > 0) {
      await db.insert(positionSnapshots).values(
        positions.map((p) => ({ address, ts, coin: p.coin, szi: p.szi, entryPx: p.entryPx, unrealizedPnl: p.uPnl })),
      );
    }
  }

  beforeEach(async () => {
    await truncateAll(db);
    service = new InsightsService(db);
    await db.insert(leaders).values([
      { address: L1 },
      { address: L2, source: "favorite" },
      { address: L3 },
      { address: L4, active: false },
      { address: L5 },
    ]);
    // Current sets.
    await snapshot(L1, at(8), [{ coin: "BTC", szi: "-50", entryPx: "60000", uPnl: "0" }]); // superseded
    await snapshot(L1, at(3), [
      { coin: "BTC", szi: "2", entryPx: "60000", uPnl: "2000" },
      { coin: "ETH", szi: "-10", entryPx: "3000", uPnl: "1000" },
    ]);
    await snapshot(L2, at(4), [
      { coin: "BTC", szi: "-1", entryPx: "61000", uPnl: "-500" },
      { coin: "SOL", szi: "100", entryPx: "150", uPnl: null },
    ]);
    await snapshot(L3, at(20), [{ coin: "BTC", szi: "100", entryPx: "60000", uPnl: "0" }]);
    await snapshot(L4, at(2), [{ coin: "BTC", szi: "100", entryPx: "60000", uPnl: "0" }]);
    await snapshot(L5, at(9), [{ coin: "BTC", szi: "5", entryPx: "60000", uPnl: "0" }]); // closed since
    await snapshot(L5, at(4), []);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("aggregates each active leader's latest fresh snapshot per coin, sorted by gross notional", async () => {
    const res = await service.computeCrowd(NOW);
    expect(res.trackedTraders).toBe(3); // L1, L2, L5 (flat)
    expect(res.updatedAt).toEqual(at(3));
    expect(res.coins.map((c) => c.coin)).toEqual(["BTC", "ETH", "SOL"]);
    expect(res.coins[0]).toEqual({
      coin: "BTC",
      longNotional: 122_000, // L1: 2 × 61,000
      shortNotional: 61_500, // L2: 1 × 61,500
      longTraders: 1,
      shortTraders: 1,
      netBias: (122_000 - 61_500) / 183_500,
      netNotional24hAgo: null,
    });
    expect(res.coins[1]).toMatchObject({ coin: "ETH", longNotional: 0, shortNotional: 29_000, netBias: -1, shortTraders: 1 });
    expect(res.coins[2]).toMatchObject({ coin: "SOL", longNotional: 15_000, netBias: 1, longTraders: 1 });
  });

  it("compares with the snapshots closest to 24 h earlier", async () => {
    await snapshot(L1, at(DAY_MIN - 2), [{ coin: "BTC", szi: "1", entryPx: "50000", uPnl: "0" }]);
    await snapshot(L1, at(DAY_MIN - 10), [{ coin: "BTC", szi: "10", entryPx: "50000", uPnl: "0" }]); // farther
    await snapshot(L2, at(DAY_MIN + 5), [{ coin: "ETH", szi: "5", entryPx: "2000", uPnl: "100" }]);
    await snapshot(L1, at(DAY_MIN + 40), [{ coin: "SOL", szi: "1000", entryPx: "100", uPnl: "0" }]); // out of range

    const byCoin = new Map((await service.computeCrowd(NOW)).coins.map((c) => [c.coin, c.netNotional24hAgo]));
    expect(byCoin.get("BTC")).toBe(50_000);
    expect(byCoin.get("ETH")).toBe(10_100);
    expect(byCoin.get("SOL")).toBe(0);
  });

  it("is empty without fresh snapshots", async () => {
    const res = await service.computeCrowd(new Date(NOW.getTime() + 60 * MIN));
    expect(res).toEqual({ trackedTraders: 0, coins: [], updatedAt: null });
  });

  it("GET /insights/crowd is cached for 60 s", async () => {
    const spy = vi.spyOn(service, "computeCrowd");
    const controller = new InsightsController(service);
    const [a, b] = await Promise.all([controller.crowd(), controller.crowd()]);
    await controller.crowd();
    expect(a).toBe(b);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
