import { describe, expect, it, vi } from "vitest";

import {
  classifyFillsIntoActions,
  isOutOfScopeSpotFill,
  type PositionStateLookup,
} from "../src/watcher/action-classifier.js";
import type { HlUserFill } from "../src/hyperliquid/types.js";

let nextTid = 1;
let nextTime = 1_700_000_000_000;

function fill(overrides: Partial<HlUserFill>): HlUserFill {
  return {
    coin: "BTC",
    px: "60000",
    sz: "1",
    side: "B",
    time: nextTime++,
    dir: "Open Long",
    closedPnl: "0",
    hash: "0xabc",
    oid: 1,
    crossed: true,
    fee: "1",
    tid: nextTid++,
    ...overrides,
  };
}

function alwaysFlat(): PositionStateLookup {
  return {
    hadPositionBefore: () => false,
    leverageBefore: () => null,
    hasPositionAfter: () => true,
    leverageAfter: () => 10,
  };
}

describe("classifyFillsIntoActions", () => {
  it("merges a big order split into 8 fills into a single 'open' action (W3)", () => {
    const fills = Array.from({ length: 8 }, () =>
      fill({ dir: "Open Long", coin: "BTC", px: "60000", sz: "1" }),
    );

    const drafts = classifyFillsIntoActions(fills, alwaysFlat());

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ coin: "BTC", kind: "open", side: "long" });
    expect(drafts[0].fillIds).toHaveLength(8);
    expect(Number(drafts[0].notionalUsd)).toBeCloseTo(8 * 60000, 5);
    expect(Number(drafts[0].avgPx)).toBeCloseTo(60000, 5);
  });

  it("classifies 'Open Long' as 'add' when a long position already existed", () => {
    const fills = [fill({ dir: "Open Long" })];
    const state: PositionStateLookup = {
      hadPositionBefore: () => true,
      leverageBefore: () => 5,
      hasPositionAfter: () => true,
      leverageAfter: () => 5,
    };

    const drafts = classifyFillsIntoActions(fills, state);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe("add");
  });

  it("classifies 'Close Long' as 'close' when the position is flat afterwards", () => {
    const fills = [fill({ dir: "Close Long", px: "61000", sz: "1" })];
    const state: PositionStateLookup = {
      hadPositionBefore: () => true,
      leverageBefore: () => 5,
      hasPositionAfter: () => false,
      leverageAfter: () => null,
    };

    const drafts = classifyFillsIntoActions(fills, state);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe("close");
    expect(drafts[0].leverage).toBe("5"); // falls back to pre-close leverage
  });

  it("classifies 'Close Long' as 'reduce' when a smaller position remains open", () => {
    const fills = [fill({ dir: "Close Long", px: "61000", sz: "0.5" })];
    const state: PositionStateLookup = {
      hadPositionBefore: () => true,
      leverageBefore: () => 5,
      hasPositionAfter: () => true,
      leverageAfter: () => 5,
    };

    const drafts = classifyFillsIntoActions(fills, state);
    expect(drafts[0].kind).toBe("reduce");
  });

  it("classifies 'Long > Short' as a flip with the resulting side", () => {
    const fills = [fill({ dir: "Long > Short", px: "60000", sz: "2" })];
    const drafts = classifyFillsIntoActions(fills, alwaysFlat());
    expect(drafts[0]).toMatchObject({ kind: "flip", side: "short" });
  });

  it("walks a multi-run batch through open -> close -> open correctly", () => {
    const fills = [
      fill({ dir: "Open Long", sz: "1" }),
      fill({ dir: "Open Long", sz: "1" }),
      fill({ dir: "Close Long", sz: "2" }), // fully closes
      fill({ dir: "Open Short", sz: "1" }), // fresh open, opposite side
    ];
    const state: PositionStateLookup = {
      hadPositionBefore: () => false,
      leverageBefore: () => null,
      hasPositionAfter: (coin) => coin === "BTC", // ends with a short open
      leverageAfter: () => 3,
    };

    const drafts = classifyFillsIntoActions(fills, state);
    expect(drafts.map((d) => d.kind)).toEqual(["open", "close", "open"]);
    expect(drafts[2].side).toBe("short");
  });

  it("skips spot fills (Buy/Sell/Spot Dust Conversion) — out of §11 market scope", () => {
    const fills = [
      fill({ dir: "Buy", coin: "PURR/USDC" }),
      fill({ dir: "Sell", coin: "PURR/USDC" }),
      fill({ dir: "Spot Dust Conversion", coin: "PURR/USDC" }),
      fill({ dir: "Open Long", coin: "ETH" }),
    ];

    const drafts = classifyFillsIntoActions(fills, alwaysFlat());
    expect(drafts).toHaveLength(1);
    expect(drafts[0].coin).toBe("ETH");
  });

  it("logs and skips an unrecognized dir instead of guessing", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fills = [fill({ dir: "Something New Hyperliquid Invented" })];

    const drafts = classifyFillsIntoActions(fills, alwaysFlat());
    expect(drafts).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it("isOutOfScopeSpotFill flags both dir-based and coin-name-based spot fills", () => {
    expect(isOutOfScopeSpotFill(fill({ dir: "Buy", coin: "PURR/USDC" }))).toBe(true);
    expect(isOutOfScopeSpotFill(fill({ dir: "Open Long", coin: "BTC" }))).toBe(false);
  });

  it("keeps two coins' runs independent when their fills are interleaved in time", () => {
    const fills = [
      fill({ coin: "BTC", dir: "Open Long", sz: "1" }),
      fill({ coin: "ETH", dir: "Open Short", sz: "1" }),
      fill({ coin: "BTC", dir: "Open Long", sz: "1" }),
      fill({ coin: "ETH", dir: "Open Short", sz: "1" }),
    ];

    const drafts = classifyFillsIntoActions(fills, alwaysFlat());
    expect(drafts).toHaveLength(2);
    const btc = drafts.find((d) => d.coin === "BTC");
    const eth = drafts.find((d) => d.coin === "ETH");
    expect(btc?.fillIds).toHaveLength(2);
    expect(eth?.fillIds).toHaveLength(2);
  });
});
