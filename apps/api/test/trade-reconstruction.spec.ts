import type { RoundTrip } from "@trading-dashboard/shared/contracts";
import { describe, expect, it } from "vitest";

import { FILL_PAGE, readRecentHistory, type FillSource } from "../src/analytics/fill-history.js";
import { pnlTier, sizeTier, summarize, tradingStyle } from "../src/analytics/trade-metrics.js";
import {
  applyFills,
  attributeFunding,
  entryPx,
  exitPx,
  netPnl,
  reconstructTrades,
  toRoundTrip,
  type Trade,
} from "../src/analytics/trade-reconstruction.js";
import type { HlUserFill } from "../src/hyperliquid/types.js";

const ME = "0x00000000000000000000000000000000000000aa";
const T0 = Date.UTC(2026, 8, 1);
const MIN = 60_000;
const HOUR = 3_600_000;

let nextTid = 1_000;
/** A fill from `start` (signed position before it); + size buys. */
function fill(
  start: number,
  delta: number,
  px: number,
  time: number,
  extra: Partial<HlUserFill> & { liquidated?: boolean } = {},
): HlUserFill {
  const { liquidated, ...rest } = extra;
  return {
    coin: "BTC",
    px: String(px),
    sz: String(Math.abs(delta)),
    side: delta > 0 ? "B" : "A",
    time,
    startPosition: String(start),
    dir: "",
    closedPnl: "0",
    hash: "0x1",
    oid: 1,
    crossed: true,
    fee: "1",
    tid: nextTid++,
    ...(liquidated ? { liquidation: { liquidatedUser: ME, markPx: px, method: "market" as const } } : {}),
    ...rest,
  };
}

describe("round-trip reconstruction", () => {
  it("open, add, reduce, close: weighted prices, Σ closedPnl, fees, max size, hold", () => {
    const trades = reconstructTrades(ME, [
      fill(0, 1, 100, T0),
      fill(1, 1, 110, T0 + MIN),
      fill(2, -1, 120, T0 + 2 * MIN, { closedPnl: "15" }),
      fill(1, -1, 130, T0 + 3 * MIN, { closedPnl: "25" }),
    ]);
    expect(trades).toHaveLength(1);
    const [t] = trades;
    expect(t).toMatchObject({ side: "long", entryTime: T0, exitTime: T0 + 3 * MIN, realizedPnl: 40, fees: 4, fills: 4 });
    expect(entryPx(t)).toBe(105);
    expect(exitPx(t)).toBe(125);
    expect(netPnl(t)).toBe(36);
    expect(t.maxNotional).toBe(220);
    const dto = toRoundTrip(t, T0 + HOUR);
    expect(dto).toMatchObject({ status: "closed", maxSize: 2, volume: 460, holdSeconds: 180, funding: null, netPnl: 36 });
  });

  it("a flip closes the old side and opens the new one on the same fill", () => {
    const flip = fill(2, -5, 90, T0 + HOUR, { closedPnl: "-20", fee: "5" });
    const trades = reconstructTrades(ME, [fill(0, 2, 100, T0), flip, fill(-3, 3, 80, T0 + 2 * HOUR, { closedPnl: "30" })]);
    expect(trades).toHaveLength(2);
    const [long, short] = trades;
    // 2 of the flip's 5 close the long, with 2/5 of its fee and all its closedPnl.
    expect(long).toMatchObject({ side: "long", exitTime: T0 + HOUR, realizedPnl: -20, fees: 1 + 2, exitSz: 2 });
    expect(short).toMatchObject({ side: "short", openTid: BigInt(flip.tid), entryTime: T0 + HOUR, entrySz: 3, realizedPnl: 30 });
    expect(short.fees).toBeCloseTo(3 + 1);
    expect(entryPx(short)).toBe(90);
    expect(short.exitTime).toBe(T0 + 2 * HOUR);
  });

  it("TWAP slices are fills like any other and mark the trade", () => {
    const trades = reconstructTrades(ME, [
      fill(0, 1, 100, T0, { twapId: 7 }),
      fill(1, 1, 101, T0 + 30_000, { twapId: 7 }),
      fill(2, -2, 110, T0 + HOUR, { closedPnl: "19" }),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ twap: true, fills: 3, realizedPnl: 19 });
  });

  it("a liquidation closes the trade and flags it", () => {
    const [t] = reconstructTrades(ME, [fill(0, -4, 100, T0), fill(-4, 4, 150, T0 + HOUR, { closedPnl: "-200", liquidated: true })]);
    expect(t).toMatchObject({ side: "short", liquidated: true, realizedPnl: -200, exitTime: T0 + HOUR });
  });

  it("a position still open is an open trade with no exit", () => {
    const trades = reconstructTrades(ME, [fill(0, 3, 100, T0), fill(3, -1, 120, T0 + MIN, { closedPnl: "20" })]);
    expect(trades).toHaveLength(1);
    const dto = toRoundTrip(trades[0], T0 + 2 * HOUR);
    expect(dto).toMatchObject({ status: "open", exitTime: null, exitPx: 120, realizedPnl: 20, holdSeconds: 7200 });
  });

  it("chains same-millisecond partial fills by startPosition whatever order they arrive in", () => {
    const a = fill(0, 1, 100, T0);
    const b = fill(1, 2, 100, T0);
    const c = fill(3, -3, 105, T0 + MIN, { closedPnl: "15" });
    // An open and an add in one millisecond, delivered in reverse.
    const d = fill(0, -1, 104, T0 + 2 * MIN);
    const e = fill(-1, -2, 103, T0 + 2 * MIN);
    const f = fill(-3, 3, 100, T0 + 3 * MIN, { closedPnl: "9" });
    const trades = reconstructTrades(ME, [e, f, c, b, d, a]);
    expect(trades.map((t) => [t.side, t.entrySz, t.exitTime, t.openTid])).toEqual([
      ["long", 3, T0 + MIN, BigInt(a.tid)],
      ["short", 3, T0 + 3 * MIN, BigInt(d.tid)],
    ]);
  });

  it("history that starts mid-position is skipped until flat; a flip out of it opens a trade", () => {
    const trades = reconstructTrades(ME, [
      fill(5, -5, 100, T0, { closedPnl: "50" }), // closes a trade opened before coverage
      fill(0, 1, 100, T0 + HOUR),
      fill(1, -1, 101, T0 + 2 * HOUR),
      { ...fill(2, -3, 99, T0), coin: "ETH" }, // flip from an unseen long
    ]);
    expect(trades.map((t) => [t.coin, t.side, t.entryTime])).toEqual([
      ["ETH", "short", T0],
      ["BTC", "long", T0 + HOUR],
    ]);
    const open = new Map<string, Trade>();
    expect(applyFills(ME, open, [fill(5, -5, 100, T0)]).skipped).toBe(1);
  });

  it("continues open trades incrementally, and drops one whose next fill doesn't fit", () => {
    const open = new Map<string, Trade>();
    applyFills(ME, open, [fill(0, 2, 100, T0)]);
    const later = applyFills(ME, open, [fill(2, -2, 110, T0 + HOUR, { closedPnl: "20" })]);
    expect(later.touched).toHaveLength(1);
    expect(later.touched[0]).toMatchObject({ exitTime: T0 + HOUR, realizedPnl: 20, entrySz: 2 });
    expect(open.size).toBe(0);

    applyFills(ME, open, [fill(0, 1, 100, T0 + 2 * HOUR)]);
    // Flat in between (a missing close), then a new short.
    const gap = applyFills(ME, open, [fill(0, -1, 100, T0 + 3 * HOUR)]);
    expect(gap.dropped).toHaveLength(1);
    expect(gap.touched.map((t) => t.side)).toEqual(["short"]);
  });

  it("attributes funding to the trade holding the coin, leaving pre-coverage trades null", () => {
    const trades = reconstructTrades(ME, [fill(0, 1, 100, T0), fill(1, -1, 100, T0 + 5 * HOUR), fill(0, 1, 100, T0 + 6 * HOUR)], T0);
    const old = { ...trades[0], coin: "ETH", funding: null };
    const matched = attributeFunding([...trades, old], [
      { time: T0 + HOUR, coin: "BTC", usdc: -2 },
      { time: T0 + 5 * HOUR, coin: "BTC", usdc: -3 },
      { time: T0 + 7 * HOUR, coin: "BTC", usdc: 1.5 },
      { time: T0 + HOUR, coin: "ETH", usdc: -9 },
      { time: T0 + HOUR, coin: "SOL", usdc: -9 },
    ]);
    expect(matched).toBe(4);
    expect(trades.map((t) => t.funding)).toEqual([-5, 1.5]);
    expect(old.funding).toBeNull();
  });
});

function trip(netPnl: number, holdSeconds: number, exitAgoMs: number | null, coin = "BTC", volume = 1000): RoundTrip {
  const now = T0;
  return {
    id: String(nextTid++),
    coin,
    side: "long",
    status: exitAgoMs === null ? "open" : "closed",
    entryTime: new Date(now - (exitAgoMs ?? 0) - holdSeconds * 1000),
    exitTime: exitAgoMs === null ? null : new Date(now - exitAgoMs),
    entryPx: 1,
    exitPx: 1,
    maxSize: 1,
    maxNotional: volume / 2,
    volume,
    holdSeconds,
    realizedPnl: netPnl + 1,
    fees: 1,
    funding: null,
    netPnl,
    liquidated: false,
    twap: false,
    fills: 2,
  };
}

describe("trade metrics and classification", () => {
  const DAY = 86_400_000;
  const trades = [
    trip(100, 60, DAY, "BTC", 5000),
    trip(-50, 120, 2 * DAY, "ETH", 3000),
    trip(300, 600, 10 * DAY, "BTC", 5000),
    trip(-25, 3600, 40 * DAY, "SOL", 100),
    trip(0, 30, 3 * DAY, "ETH", 10),
    trip(999, 10, null),
  ];

  it("summarizes each window over closed trades by exit time", () => {
    const all = summarize(trades, "all", T0);
    expect(all).toMatchObject({ trades: 5, wins: 2, losses: 2, winRate: 0.4, openTrades: 1, netPnl: 325, fees: 5 });
    expect(all.profitFactor).toBeCloseTo(400 / 75);
    expect(all.medianHoldSeconds).toBe(120);
    expect(all.avgHoldSeconds).toBeCloseTo((60 + 120 + 600 + 3600 + 30) / 5);
    expect(all.best.map((t) => t.netPnl)).toEqual([300, 100]);
    expect(all.worst.map((t) => t.netPnl)).toEqual([-50, -25]);
    expect(all.topCoins.map((c) => [c.coin, c.volume, c.trades, c.wins])).toEqual([
      ["BTC", 10000, 2, 2],
      ["ETH", 3010, 2, 0],
      ["SOL", 100, 1, 0],
    ]);
    expect(summarize(trades, "30d", T0)).toMatchObject({ trades: 4, wins: 2, winRate: 0.5 });
    expect(summarize(trades, "7d", T0)).toMatchObject({ trades: 3, wins: 1, losses: 1 });
    const none = summarize([], "7d", T0);
    expect(none).toMatchObject({ trades: 0, winRate: null, medianHoldSeconds: null, profitFactor: null });
    expect(summarize([trip(5, 1, DAY)], "all", T0).profitFactor).toBeNull();
  });

  it("trading style: < 15 min scalp, < 24 h intraday, < 14 d swing, else position", () => {
    expect(tradingStyle(null)).toBeNull();
    expect(tradingStyle(14 * 60 + 59)).toBe("scalp");
    expect(tradingStyle(15 * 60)).toBe("intraday");
    // CopyDog: 0x30af median 19.8 h intraday; 0xeadc 7.76 d swing.
    expect(tradingStyle(71_449)).toBe("intraday");
    expect(tradingStyle(24 * 3600)).toBe("swing");
    expect(tradingStyle(670_154)).toBe("swing");
    expect(tradingStyle(14 * 86400 - 1)).toBe("swing");
    expect(tradingStyle(14 * 86400)).toBe("position");
  });

  it("PnL tiers on all-time PnL, with ±$100 break even", () => {
    expect([2e6, 1e6, 999_999, 1e5, 150, 100, 99.9, 0, -99.9, -100, -1e5 + 1, -1e5, -1e6 + 1, -1e6, -5e6].map(pnlTier)).toEqual([
      "extremely_profitable",
      "extremely_profitable",
      "very_profitable",
      "very_profitable",
      "profitable",
      "profitable",
      "break_even",
      "break_even",
      "break_even",
      "unprofitable",
      "unprofitable",
      "very_unprofitable",
      "very_unprofitable",
      "rekt",
      "rekt",
    ]);
    expect(pnlTier(null)).toBeNull();
  });

  it("size tiers on total account value", () => {
    expect([6e6, 5e6, 4_999_999, 1e6, 1e5, 99_999, 1e4, 9_999, 0].map(sizeTier)).toEqual([
      "apex",
      "apex",
      "whale",
      "whale",
      "large",
      "medium",
      "medium",
      "small",
      "small",
    ]);
    expect(sizeTier(null)).toBeNull();
  });
});

/** A fake list: `count` fills evenly spaced up to `now`, time-ascending. */
function fakeSource(count: number, spacing: number, now: number) {
  const all = Array.from({ length: count }, (_, i) => fill(0, 1, 1, now - (count - i) * spacing));
  const calls: Array<[number, number]> = [];
  const source: FillSource = {
    latest: async () => all.slice(-FILL_PAGE).reverse(),
    range: async (start, end) => {
      calls.push([start, end]);
      return all.filter((f) => f.time >= start && f.time <= end).slice(0, FILL_PAGE);
    },
  };
  return { all, calls, source };
}

describe("reading recent history backwards", () => {
  const now = T0 + 400 * 86_400_000;

  it("a short list is complete in one page", async () => {
    const { source, calls } = fakeSource(150, HOUR, now);
    const history = await readRecentHistory(source, { now, lookbackStart: now - 365 * 86_400_000, target: 10_000, maxCalls: 10 });
    expect(history).toMatchObject({ truncated: false, calls: 0 });
    expect(history.fills).toHaveLength(150);
    expect(calls).toHaveLength(0);
  });

  it("stops at the target with coverage truncated, keeping the newest fills with no holes", async () => {
    const { source, all } = fakeSource(25_000, MIN, now);
    const history = await readRecentHistory(source, { now, lookbackStart: 0, target: 10_000, maxCalls: 20 });
    expect(history.truncated).toBe(true);
    expect(history.fills.length).toBeGreaterThanOrEqual(10_000);
    const from = history.from!;
    // Every fill from `from` to now, and nothing older.
    expect(history.fills.length).toBe(all.filter((f) => f.time >= from).length);
  });

  it("reads to the lookback start when there is less history than the target", async () => {
    const { source, all } = fakeSource(5_000, 10 * MIN, now);
    const history = await readRecentHistory(source, { now, lookbackStart: now - 365 * 86_400_000, target: 10_000, maxCalls: 20 });
    expect(history.truncated).toBe(false);
    expect(history.fills).toHaveLength(all.length);
    expect(history.from).toBe(all[0].time);
  });
});
