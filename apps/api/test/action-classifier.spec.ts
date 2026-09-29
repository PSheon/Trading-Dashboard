import { describe, expect, it } from "vitest";

import type { HlUserFill } from "../src/hyperliquid/types.js";
import { classifyFills, isOutOfScopeSpotFill, toScaled } from "../src/watcher/action-classifier.js";

const ADDRESS = "0xleader";
const T0 = 1_790_000_000_000;

let tid = 1;
function fill(overrides: Partial<HlUserFill>): HlUserFill {
  return {
    coin: "BTC",
    px: "100",
    sz: "1",
    side: "B",
    time: T0,
    startPosition: "0",
    dir: "Open Long",
    closedPnl: "0",
    hash: "0x",
    oid: 1,
    crossed: true,
    fee: "0",
    tid: tid++,
    ...overrides,
  };
}

const kinds = (fills: HlUserFill[]) =>
  classifyFills(ADDRESS, fills).map((d) => `${d.coin}:${d.kind}:${d.side}:${d.fillIds.length}`);

describe("classifyFills (startPosition-based)", () => {
  it("merges one order that crossed several resting orders into a single open", () => {
    const fills = [
      fill({ startPosition: "0", sz: "0.5", px: "100", time: T0 }),
      fill({ startPosition: "0.5", sz: "0.3", px: "101", time: T0 }),
      fill({ startPosition: "0.8", sz: "0.2", px: "102", time: T0 + 5 }),
    ];
    const [draft] = classifyFills(ADDRESS, fills);
    expect(kinds(fills)).toEqual(["BTC:open:long:3"]);
    expect(Number(draft.notionalUsd)).toBeCloseTo(50 + 30.3 + 20.4);
    expect(Number(draft.avgPx)).toBeCloseTo((50 + 30.3 + 20.4) / 1);
  });

  it("calls a first-seen fill on an existing position an add, not an open (restart case)", () => {
    expect(kinds([fill({ startPosition: "2", sz: "1", side: "B" })])).toEqual(["BTC:add:long:1"]);
  });

  it("distinguishes reduce from close by where the position ends", () => {
    expect(kinds([fill({ startPosition: "2", sz: "1", side: "A", dir: "Close Long" })])).toEqual(["BTC:reduce:long:1"]);
    expect(kinds([fill({ startPosition: "2", sz: "2", side: "A", dir: "Close Long" })])).toEqual(["BTC:close:long:1"]);
    expect(kinds([fill({ startPosition: "-3", sz: "3", side: "B", dir: "Close Short" })])).toEqual(["BTC:close:short:1"]);
  });

  it("keeps a partial reduce followed by a re-add as reduce + add, not close + open", () => {
    const fills = [
      fill({ startPosition: "5", sz: "2", side: "A", time: T0 }),
      fill({ startPosition: "3", sz: "4", side: "B", time: T0 + 200 }),
    ];
    expect(kinds(fills)).toEqual(["BTC:reduce:long:1", "BTC:add:long:1"]);
  });

  it("classifies a flip in one fill and across several fills of one order", () => {
    expect(kinds([fill({ startPosition: "1", sz: "3", side: "A", dir: "Long > Short" })])).toEqual(["BTC:flip:short:1"]);
    const multi = [
      fill({ startPosition: "1", sz: "1", side: "A", time: T0 }),
      fill({ startPosition: "0", sz: "2", side: "A", time: T0 + 1 }),
    ];
    expect(kinds(multi)).toEqual(["BTC:flip:short:2"]);
  });

  it("splits fills more than a second apart into separate actions", () => {
    const fills = [
      fill({ startPosition: "0", sz: "1", time: T0 }),
      fill({ startPosition: "1", sz: "1", time: T0 + 2_500 }),
    ];
    expect(kinds(fills)).toEqual(["BTC:open:long:1", "BTC:add:long:1"]);
  });

  it("marks fills that liquidate this address as a liquidation of the prior side", () => {
    const liq = fill({
      startPosition: "4",
      sz: "4",
      side: "A",
      dir: "Close Long",
      liquidation: { liquidatedUser: ADDRESS.toUpperCase(), markPx: 90, method: "market" },
    });
    expect(kinds([liq])).toEqual(["BTC:liquidation:long:1"]);
    const asLiquidator = fill({
      startPosition: "0",
      sz: "4",
      side: "B",
      liquidation: { liquidatedUser: "0xsomeoneelse", markPx: 90, method: "backstop" },
    });
    expect(kinds([asLiquidator])).toEqual(["BTC:open:long:1"]);
  });

  it("handles HIP-3 coins and keeps coins apart", () => {
    const fills = [
      fill({ coin: "xyz:TSLA", startPosition: "0", sz: "10", side: "A", time: T0 }),
      fill({ coin: "BTC", startPosition: "0", sz: "1", side: "B", time: T0 }),
    ];
    expect(kinds(fills).sort()).toEqual(["BTC:open:long:1", "xyz:TSLA:open:short:1"]);
  });

  it("ignores spot fills and skips fills without startPosition", () => {
    expect(isOutOfScopeSpotFill(fill({ coin: "@107", dir: "Buy" }))).toBe(true);
    expect(isOutOfScopeSpotFill(fill({ coin: "PURR/USDC", dir: "Sell" }))).toBe(true);
    expect(isOutOfScopeSpotFill(fill({ coin: "xyz:TSLA" }))).toBe(false);
    expect(kinds([fill({ coin: "@107", dir: "Buy" })])).toEqual([]);
    expect(kinds([fill({ startPosition: undefined })])).toEqual([]);
  });

  it("uses the leverage lookup only for positions still open", () => {
    const open = classifyFills(ADDRESS, [fill({ startPosition: "0", sz: "1" })], () => 7);
    const closed = classifyFills(ADDRESS, [fill({ startPosition: "1", sz: "1", side: "A" })], () => 7);
    expect(open[0].leverage).toBe("7");
    expect(closed[0].leverage).toBeNull();
  });

  it("compares sizes exactly (no floating-point residue)", () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004; closing 0.3 must be a close.
    const fills = [
      fill({ startPosition: "0.3", sz: "0.1", side: "A", time: T0 }),
      fill({ startPosition: "0.2", sz: "0.2", side: "A", time: T0 + 1 }),
    ];
    expect(kinds(fills)).toEqual(["BTC:close:long:2"]);
    expect(toScaled("-0.57719")).toBe(-577190000000n);
  });
});
