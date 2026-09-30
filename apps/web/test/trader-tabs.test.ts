import { describe, expect, it } from "vitest";

import { TAB_GROUPS } from "../src/components/trader/activity-tabs";
import { groupFills } from "../src/components/trader/trader-tabs";
import type { TraderFill } from "../src/lib/contracts";
import { feedTime, liqDistance, qty, usd0, usd2 } from "../src/lib/trade-format";

const fill = (tid: number, ts: number, extra: Partial<TraderFill> = {}): TraderFill => ({
  tid: String(tid), coin: "HYPE", side: "sell", dir: "Close Long", px: 40, sz: 10, notionalUsd: 400, closedPnl: 5, fee: 0.1,
  ts: new Date(ts).toISOString(), twapId: null, startPosition: 30 - (ts / 1000) * 10, liquidation: false, ...extra,
});

describe("trader tabs, CopyDog's set and order", () => {
  it("lists 持倉 / 表現 | 餘額 / 訂單 / 成交 / 交易 / TWAP / 轉帳 and nothing else (no 動作 / 警報)", () => {
    expect(TAB_GROUPS).toEqual([
      ["positions", "performance"],
      ["balances", "orders", "fills", "trades", "twap", "transfers"],
    ]);
  });
});

describe("成交: fills grouped by order stream, as CopyDog does", () => {
  it("merges consecutive fills of one stream: summed size, value and PnL, volume-weighted price, count", () => {
    const groups = groupFills([
      fill(1, 1000, { px: 40, sz: 10, notionalUsd: 400, startPosition: 30 }),
      fill(2, 2000, { px: 42, sz: 10, notionalUsd: 420, startPosition: 20 }),
      fill(3, 3000, { dir: "Open Short", side: "sell", closedPnl: 0, startPosition: 0 }),
      fill(4, 4000, { liquidation: true, startPosition: 10 }),
    ]);
    expect(groups.map((g) => [g.dir, g.count, g.liquidation])).toEqual([
      ["Close Long", 1, true],
      ["Open Short", 1, false],
      ["Close Long", 2, false],
    ]);
    expect(groups[2]).toMatchObject({ size: 20, value: 820, pnl: 10, price: 41, startPosition: 30 });
  });

  it("marks the oldest row partial when the list is capped", () => {
    const groups = groupFills([fill(1, 1000), fill(2, 2000, { coin: "BTC" })], true);
    expect(groups.map((g) => g.partial ?? false)).toEqual([false, true]);
  });
});

describe("CopyDog's number formats", () => {
  it("sizes and amounts: K/M above a thousand, 2 decimals, 5 below one", () => {
    expect([qty(1266.7), qty(3_480_000), qty(59.534), qty(0.366421)]).toEqual(["1.27K", "3.48M", "59.53", "0.36642"]);
  });

  it("distance to liquidation and its tone", () => {
    expect(liqDistance(70, 100)).toEqual({ pct: 30, tone: "safe" });
    expect(liqDistance(88, 100)?.tone).toBe("warn");
    expect(liqDistance(96, 100)?.tone).toBe("danger");
    expect(liqDistance(99, 100)?.tone).toBe("critical");
    expect(liqDistance(null, 100)).toBeNull();
  });

  it("the rail's volume, notional and long / short values", () => {
    // CopyDog shows $13.43M in every locale, never 1343萬.
    expect([usd2(13_432_038.45), usd2(977_700), usd2(469.97), usd2(0)]).toEqual(["$13.43M", "$977.70K", "$469.97", "$0.00"]);
    expect([usd0(0), usd0(469.6), usd0(183_400), usd0(13_600_000), usd0(1_234_000_000)]).toEqual(["$0", "$470", "$183K", "$14M", "$1.2B"]);
  });

  it("the live feed's time stamp", () => {
    expect(feedTime(new Date(2026, 8, 27, 21, 32))).toBe("Sep 27 9:32PM");
  });
});
