import { describe, expect, it } from "vitest";

import type { HlClearinghouseStateResponse } from "../src/hyperliquid/types.js";
import { fromScaled, toScaled } from "../src/watcher/action-classifier.js";
import { BOOK_BUFFER_MS, PositionBook, type BookTrade } from "../src/watcher/position-book.js";

const T0 = 1_790_000_000_000;

function state(time: number, positions: Record<string, string>): HlClearinghouseStateResponse {
  const summary = { accountValue: "1", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "0" };
  return {
    assetPositions: Object.entries(positions).map(([coin, szi]) => ({
      type: "oneWay",
      position: { coin, szi, leverage: { type: "cross", value: 3 }, marginUsed: "0", unrealizedPnl: "0" },
    })),
    marginSummary: summary,
    crossMarginSummary: summary,
    withdrawable: "0",
    time,
  };
}

const t = (tid: number, time: number, signed: string, coin = "BTC"): BookTrade => ({
  tid: BigInt(tid),
  coin,
  time,
  signed: toScaled(signed),
});

const pos = (book: PositionBook, coin = "BTC") => {
  const p = book.position(coin);
  return p === undefined ? undefined : fromScaled(p);
};

describe("PositionBook", () => {
  it("knows nothing about a dex until a state is installed", () => {
    const book = new PositionBook();
    expect(book.position("BTC")).toBeUndefined();
    expect(book.startPositions([t(1, T0, "1")])).toBeNull();
    book.install("", state(T0, { BTC: "2.5" }));
    expect(pos(book)).toBe("2.5");
    expect(pos(book, "ETH")).toBe("0");
    expect(book.position("xyz:TSLA")).toBeUndefined();
  });

  it("adds a trade once, and never one the state already includes", () => {
    const book = new PositionBook();
    book.install("", state(T0, { BTC: "1" }), T0);
    book.apply([t(1, T0 - 5, "1"), t(2, T0, "1")], T0); // both inside the state
    expect(pos(book)).toBe("1");
    book.apply([t(3, T0 + 10, "0.5")], T0);
    book.apply([t(3, T0 + 10, "0.5")], T0); // replayed tid
    expect(pos(book)).toBe("1.5");
    book.apply([t(4, T0 + 20, "-1.5")], T0);
    expect(pos(book)).toBe("0");
  });

  it("gives each burst trade its start position when the state holds some of the burst and not the rest", () => {
    const book = new PositionBook();
    // Position was 2 before the burst; the state (asOf T0+100) holds the
    // first two trades (+1, -0.5) but not the last two.
    const burst = [t(1, T0, "1"), t(2, T0 + 100, "-0.5"), t(3, T0 + 200, "-2.5"), t(4, T0 + 200, "-1")];
    book.install("", state(T0 + 100, { BTC: "2.5" }));
    const starts = book.startPositions(burst)!;
    expect(burst.map((x) => fromScaled(starts.get(x.tid)!))).toEqual(["2", "3", "2.5", "0"]);

    // After applying, a later burst starts from the end of this one; the
    // already-applied trades are not subtracted twice if replayed.
    book.apply(burst, T0 + 300);
    expect(pos(book)).toBe("-1");
    const replay = book.startPositions([t(4, T0 + 200, "-1"), t(5, T0 + 400, "1")])!;
    expect(fromScaled(replay.get(4n)!)).toBe("0");
    expect(fromScaled(replay.get(5n)!)).toBe("-1");
  });

  it("replays buffered trades newer than a newly installed state", () => {
    const book = new PositionBook();
    book.install("", state(T0, { BTC: "1" }), T0);
    book.apply([t(1, T0 + 10, "1"), t(2, T0 + 20, "1"), t(3, T0 + 30, "1")], T0 + 30);
    expect(pos(book)).toBe("4");
    // A fresh state that already has the first two: only the third is
    // re-applied on top.
    book.install("", state(T0 + 25, { BTC: "3" }), T0 + 40);
    expect(pos(book)).toBe("4");
    expect(book.asOf("")).toBe(T0 + 25);
    // A state older than the installed one (answers crossed) is ignored.
    expect(book.install("", state(T0 + 5, { BTC: "1" }), T0 + 40)).toBe(false);
    expect(pos(book)).toBe("4");
  });

  it("buffers trades on a dex with no state yet, for when its state arrives", () => {
    const book = new PositionBook();
    book.apply([t(1, T0 + 10, "-3", "xyz:TSLA")], T0 + 10);
    expect(book.position("xyz:TSLA")).toBeUndefined();
    book.install("xyz", state(T0, { "xyz:TSLA": "-1" }), T0 + 20);
    expect(pos(book, "xyz:TSLA")).toBe("-4");
    // Main dex untouched.
    expect(book.position("BTC")).toBeUndefined();
  });

  it("forgets buffered trades after two minutes", () => {
    const book = new PositionBook();
    book.apply([t(1, T0, "1")], T0);
    book.install("", state(T0 - 1000, {}), T0 + BOOK_BUFFER_MS + 1);
    expect(pos(book)).toBe("0");
  });
});
