import { RoundTripRepository } from "../src/analytics/round-trip.repository.js";
import { actions, fills } from "@trading-dashboard/shared/database";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { RoundTripService } from "../src/analytics/round-trip.service.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const ADDRESS = "0xroundtriptest";
const CHAIN = "hyperliquid";

let nextTid = 1n;
function fillRow(overrides: { closedPnl?: string | null; coin?: string } = {}) {
  const tid = nextTid++;
  return {
    chain: CHAIN,
    tid,
    address: ADDRESS,
    coin: overrides.coin ?? "BTC",
    side: "B",
    dir: "Open Long",
    px: "60000",
    sz: "1",
    fee: "1",
    closedPnl: overrides.closedPnl ?? null,
    hash: "0xabc",
    ts: new Date(),
    raw: {},
  };
}

interface ActionSpec {
  coin?: string;
  kind: "open" | "add" | "reduce" | "close" | "flip" | "liquidation";
  side: "long" | "short";
  ts: Date;
  fillIds: bigint[];
}

function actionRow(spec: ActionSpec) {
  return {
    chain: CHAIN,
    address: ADDRESS,
    coin: spec.coin ?? "BTC",
    kind: spec.kind,
    side: spec.side,
    notionalUsd: "60000",
    avgPx: "60000",
    leverage: "10",
    fillIds: spec.fillIds,
    ts: spec.ts,
  };
}

const T0 = new Date("2026-01-01T00:00:00Z");
function at(hoursOffset: number): Date {
  return new Date(T0.getTime() + hoursOffset * 3_600_000);
}

describe("RoundTripService — real Postgres", () => {
  const db = getTestDb();
  const service = new RoundTripService(new RoundTripRepository(db));

  beforeEach(async () => {
    await truncateAll(db);
    nextTid = 1n;
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("returns null win rate and 0 PnL when there are zero round trips", async () => {
    expect(await service.winRate(ADDRESS, "BTC", new Date(0))).toBeNull();
    expect(await service.realizedPnl(ADDRESS, new Date(0))).toBe(0);
    expect(await service.avgHoldTimeSeconds(ADDRESS)).toBeNull();
  });

  it("reconstructs a simple open -> close round trip and sums the closing fill's closed_pnl", async () => {
    const openFill = fillRow({ closedPnl: null });
    const closeFill = fillRow({ closedPnl: "100" });
    await db.insert(fills).values([openFill, closeFill]);
    await db.insert(actions).values([
      actionRow({ kind: "open", side: "long", ts: at(0), fillIds: [openFill.tid] }),
      actionRow({ kind: "close", side: "long", ts: at(1), fillIds: [closeFill.tid] }),
    ]);

    const trips = await service.reconstructRoundTrips(ADDRESS, "BTC");
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ pnl: 100, side: "long" });
    expect(trips[0].holdTimeSeconds).toBe(3600);

    expect(await service.winRate(ADDRESS, "BTC", at(-1))).toBe(1);
  });

  it("ignores the counterparty's fill that shares a tid with ours", async () => {
    const openFill = fillRow({ closedPnl: null });
    const closeFill = fillRow({ closedPnl: "-50" });
    // The other side of our closing trade: same tid, opposite PnL.
    const counterparty = { ...closeFill, address: "0xcounterparty", closedPnl: "900" };
    await db.insert(fills).values([openFill, closeFill, counterparty]);
    await db.insert(actions).values([
      actionRow({ kind: "open", side: "long", ts: at(0), fillIds: [openFill.tid] }),
      actionRow({ kind: "close", side: "long", ts: at(1), fillIds: [closeFill.tid] }),
    ]);

    const trips = await service.reconstructRoundTrips(ADDRESS, "BTC");
    expect(trips[0].pnl).toBe(-50);
    expect(await service.winRate(ADDRESS, "BTC", at(-1))).toBe(0);
  });

  it("sums closed_pnl across every leg (open/add/reduce/close), not only the final closing fill", async () => {
    const openFill = fillRow({ closedPnl: null });
    const addFill = fillRow({ closedPnl: null });
    const reduceFill = fillRow({ closedPnl: "50" });
    const closeFill = fillRow({ closedPnl: "-20" });
    await db.insert(fills).values([openFill, addFill, reduceFill, closeFill]);
    await db.insert(actions).values([
      actionRow({ kind: "open", side: "long", ts: at(0), fillIds: [openFill.tid] }),
      actionRow({ kind: "add", side: "long", ts: at(1), fillIds: [addFill.tid] }),
      actionRow({ kind: "reduce", side: "long", ts: at(2), fillIds: [reduceFill.tid] }),
      actionRow({ kind: "close", side: "long", ts: at(3), fillIds: [closeFill.tid] }),
    ]);

    const trips = await service.reconstructRoundTrips(ADDRESS, "BTC");
    expect(trips).toHaveLength(1);
    // 0 (open) + 0 (add) + 50 (reduce) + -20 (close) = 30, a win.
    expect(trips[0].pnl).toBe(30);
    expect(await service.winRate(ADDRESS, "BTC", at(-1))).toBe(1);
  });

  it("treats a flip as terminal for the old side and the opening leg of a new round trip, without double-counting the flip's own closed_pnl", async () => {
    const openFill = fillRow({ closedPnl: null });
    const flipFill = fillRow({ closedPnl: "-10" }); // closes the long at a loss
    const closeFill = fillRow({ closedPnl: "40" }); // closes the new short at a profit
    await db.insert(fills).values([openFill, flipFill, closeFill]);
    await db.insert(actions).values([
      actionRow({ kind: "open", side: "long", ts: at(0), fillIds: [openFill.tid] }),
      actionRow({ kind: "flip", side: "short", ts: at(1), fillIds: [flipFill.tid] }),
      actionRow({ kind: "close", side: "short", ts: at(2), fillIds: [closeFill.tid] }),
    ]);

    const trips = await service.reconstructRoundTrips(ADDRESS, "BTC");
    expect(trips).toHaveLength(2);
    expect(trips[0]).toMatchObject({ side: "long", pnl: -10 });
    expect(trips[1]).toMatchObject({ side: "short", pnl: 40 });
    // The flip fill's -10 must not also appear in the new round trip's PnL.
    expect(trips[1].pnl).not.toBe(30);

    expect(await service.winRate(ADDRESS, "BTC", at(-1))).toBe(0.5);
  });

  it("skips a close/flip with no matching prior open in the data (position opened before recorded history)", async () => {
    const closeFill = fillRow({ closedPnl: "999" });
    await db.insert(fills).values([closeFill]);
    await db.insert(actions).values([actionRow({ kind: "close", side: "long", ts: at(0), fillIds: [closeFill.tid] })]);

    const trips = await service.reconstructRoundTrips(ADDRESS, "BTC");
    expect(trips).toHaveLength(0);
    expect(await service.winRate(ADDRESS, "BTC", at(-1))).toBeNull();
  });

  it("only counts round trips whose close falls within the requested window", async () => {
    const oldOpen = fillRow({ closedPnl: null });
    const oldClose = fillRow({ closedPnl: "-5" }); // a loss, far in the past
    const newOpen = fillRow({ closedPnl: null });
    const newClose = fillRow({ closedPnl: "5" }); // a win, recent
    await db.insert(fills).values([oldOpen, oldClose, newOpen, newClose]);
    await db.insert(actions).values([
      actionRow({ kind: "open", side: "long", ts: at(-1000), fillIds: [oldOpen.tid] }),
      actionRow({ kind: "close", side: "long", ts: at(-999), fillIds: [oldClose.tid] }),
      actionRow({ kind: "open", side: "long", ts: at(0), fillIds: [newOpen.tid] }),
      actionRow({ kind: "close", side: "long", ts: at(1), fillIds: [newClose.tid] }),
    ]);

    // Window only wide enough to catch the recent round trip.
    const winRate = await service.winRate(ADDRESS, "BTC", at(-1));
    expect(winRate).toBe(1);
    const pnl = await service.realizedPnl(ADDRESS, at(-1));
    expect(pnl).toBe(5);
  });

  it("computes an address-wide win rate across coins when coin is omitted", async () => {
    const btcOpen = fillRow({ closedPnl: null, coin: "BTC" });
    const btcClose = fillRow({ closedPnl: "10", coin: "BTC" });
    const ethOpen = fillRow({ closedPnl: null, coin: "ETH" });
    const ethClose = fillRow({ closedPnl: "-10", coin: "ETH" });
    await db.insert(fills).values([btcOpen, btcClose, ethOpen, ethClose]);
    await db.insert(actions).values([
      actionRow({ kind: "open", side: "long", ts: at(0), fillIds: [btcOpen.tid], coin: "BTC" }),
      actionRow({ kind: "close", side: "long", ts: at(1), fillIds: [btcClose.tid], coin: "BTC" }),
      actionRow({ kind: "open", side: "long", ts: at(0), fillIds: [ethOpen.tid], coin: "ETH" }),
      actionRow({ kind: "close", side: "long", ts: at(1), fillIds: [ethClose.tid], coin: "ETH" }),
    ]);

    expect(await service.winRate(ADDRESS, "BTC", at(-1))).toBe(1);
    expect(await service.winRate(ADDRESS, "ETH", at(-1))).toBe(0);
    expect(await service.winRate(ADDRESS, undefined, at(-1))).toBe(0.5);
  });

  it("computes average hold time across all-time round trips", async () => {
    const open1 = fillRow({ closedPnl: null });
    const close1 = fillRow({ closedPnl: "1" });
    const open2 = fillRow({ closedPnl: null });
    const close2 = fillRow({ closedPnl: "1" });
    await db.insert(fills).values([open1, close1, open2, close2]);
    await db.insert(actions).values([
      actionRow({ kind: "open", side: "long", ts: at(0), fillIds: [open1.tid] }),
      actionRow({ kind: "close", side: "long", ts: at(1), fillIds: [close1.tid] }), // 1h hold
      actionRow({ kind: "open", side: "long", ts: at(2), fillIds: [open2.tid] }),
      actionRow({ kind: "close", side: "long", ts: at(5), fillIds: [close2.tid] }), // 3h hold
    ]);

    expect(await service.avgHoldTimeSeconds(ADDRESS)).toBe(2 * 3600); // avg(1h, 3h)
  });
});
