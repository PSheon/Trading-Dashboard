import { describe, expect, it } from "vitest";

import { fixtureCopyOverview } from "@/fixtures/copy";
import type { CopyOverview, CopyStrategyView } from "@/lib/contracts";
import { exposure, hedgeWarning, insightsOverview, netInvested, paperLegend, periodRoi, sharePct, todayChange, windowStart } from "@/lib/copy-portfolio";

const overview = (): CopyOverview => JSON.parse(JSON.stringify(fixtureCopyOverview()));
const strategy = (o: Partial<CopyStrategyView>): CopyStrategyView => ({ ...overview().strategies[0], ...o }) as CopyStrategyView;

describe("the portfolio page's figures (CopyDog's definitions)", () => {
  it("today: change since 00:00 UTC and its share of the paper total at the day's start (CopyDog: T ÷ (M − T))", () => {
    const o = overview();
    o.paper.totalValue = 10_100;
    expect(todayChange(o, 100)).toEqual({ pnl: 100, pct: 0.01 });
    expect(todayChange(o, null)).toBeNull();
    o.paper.totalValue = null;
    expect(todayChange(o, 5)).toEqual({ pnl: 5, pct: null });
  });

  it("legend: available is the paper balance, copied the live copies' equity, unknown when a copy is unpriced", () => {
    const o = overview();
    const legend = paperLegend(o);
    const live = o.strategies.filter((s) => s.status !== "stopped");
    expect(legend.available).toBe(o.paper.balance);
    expect(legend.copied).toBeCloseTo(live.reduce((a, s) => a + (s.equity ?? 0), 0), 9);
    expect(legend.unrealized).toBeCloseTo(live.reduce((a, s) => a + (s.unrealizedPnl ?? 0), 0), 9);
    o.strategies[0].equity = null;
    o.strategies[0].unrealizedPnl = null;
    expect(paperLegend(o)).toMatchObject({ copied: null, unrealized: null });
  });

  it("insights overview: invested = net deposits of copies with a known P&L; value = their equity, so value − invested = P&L", () => {
    const list = [
      strategy({ id: 1, status: "active", allocated: 1_000, withdrawn: 200, equity: 900, totalPnl: 100 }),
      strategy({ id: 2, status: "paused", allocated: 500, withdrawn: 0, equity: 450, totalPnl: -50 }),
      strategy({ id: 3, status: "stopped", allocated: 9_999, withdrawn: 0, equity: 0, totalPnl: 1 }),
    ];
    const o = insightsOverview(list);
    expect(o).toEqual({ invested: 1_300, value: 1_350, totalPnl: 50, roiPct: (50 / 1_300) * 100 });
    expect(o.value! - o.invested).toBeCloseTo(o.totalPnl!, 9);
    expect(netInvested(list)).toBe(1_300);
    // An unpriced copy: its P&L is left out of both sides, the value is unknown.
    list[1] = { ...list[1]!, equity: null, totalPnl: null };
    expect(insightsOverview(list)).toEqual({ invested: 800, value: null, totalPnl: 100, roiPct: 12.5 });
    expect(insightsOverview([])).toEqual({ invested: 0, value: 0, totalPnl: 0, roiPct: null });
  });

  it("exposure: gross per coin, hedged when one copy is long and another short, leverage = gross ÷ equity", () => {
    const base = overview().strategies[0].positions[0]!;
    const list = [
      strategy({ id: 1, leaderAddress: "0xa", status: "active", equity: 1_000, positions: [{ ...base, coin: "BTC", size: 0.01, entryPx: 100_000, notionalUsd: 1_000, unrealizedPnl: 10 }, { ...base, coin: "ETH", size: 1, entryPx: 4_000, notionalUsd: 4_000, unrealizedPnl: -20 }] }),
      strategy({ id: 2, leaderAddress: "0xb", status: "active", equity: 1_000, positions: [{ ...base, coin: "BTC", size: -0.02, entryPx: 100_000, notionalUsd: 2_000, unrealizedPnl: 5 }] }),
      strategy({ id: 3, leaderAddress: "0xc", status: "stopped", equity: 0, positions: [{ ...base, coin: "SOL", size: 5, notionalUsd: 1_000, unrealizedPnl: 1 }] }),
    ];
    const e = exposure(list)!;
    expect(e.assets.map((a) => a.coin)).toEqual(["ETH", "BTC"]);
    const btc = e.assets.find((a) => a.coin === "BTC")!;
    expect(btc).toMatchObject({ grossNotional: 3_000, pnl: 15, copyCount: 2, hedged: true, isLong: false });
    expect(btc.lines.map((l) => l.leaderAddress)).toEqual(["0xa", "0xb"]);
    expect(btc.lines[0]!.roiPct).toBeCloseTo(1, 9);
    expect(e.assets.find((a) => a.coin === "ETH")!.hedged).toBe(false);
    expect(e).toMatchObject({ long: 5_000, short: 2_000, gross: 7_000, equity: 2_000, leverage: 3.5 });
    expect(e.longPct).toBeCloseTo((5 / 7) * 100, 9);
    list[0]!.positions[0]!.notionalUsd = null;
    expect(exposure(list)).toBeNull();
    expect(sharePct(0.004)).toBe("<1%");
    expect(sharePct(0.426)).toBe("43%");
    expect(sharePct(0)).toBe("0%");
  });

  it("hedge warning: coins where the new copy's side opposes another live copy's position; a counter copy flips the leader's side", () => {
    const base = overview().strategies[0].positions[0]!;
    const others = [
      strategy({ id: 1, leaderAddress: "0xaaa", status: "active", positions: [{ ...base, coin: "BTC", size: 0.1 }, { ...base, coin: "ETH", size: -1 }] }),
      strategy({ id: 2, leaderAddress: "0xbbb", status: "stopped", positions: [{ ...base, coin: "SOL", size: 3 }] }),
    ];
    const leader = [{ coin: "BTC", szi: -2 }, { coin: "ETH", szi: -5 }, { coin: "SOL", szi: -1 }, { coin: "HYPE", szi: 0 }];
    expect(hedgeWarning(leader, "same", others, "0xNEW")).toEqual({ coins: ["BTC"], opposingLeaders: ["0xaaa"] });
    expect(hedgeWarning(leader, "reverse", others, "0xNEW")).toEqual({ coins: ["ETH"], opposingLeaders: ["0xaaa"] });
    expect(hedgeWarning([], "same", others, "0xNEW")).toBeNull();
    // Its own earlier copy of the same leader is not "another trader".
    expect(hedgeWarning(leader, "same", others, "0xAAA")).toBeNull();
  });

  it("same-period ROI: PnL change ÷ the period's highest net deposits (account value − PnL), as the trader page", () => {
    const pnl = [[0, 0], [10, 50], [20, 80], [30, 120]] as const;
    const value = [[0, 1_000], [10, 1_050], [20, 1_580], [30, 1_620]] as const;
    // From t = 10: change 70, net deposits 1,000 then 1,500 → peak 1,500.
    expect(periodRoi(pnl, value, 10)).toEqual({ pnl: 70, roi: 70 / 1_500 });
    // A start between points uses the last point at or before it.
    expect(periodRoi(pnl, value, 15)).toEqual({ pnl: 70, roi: 70 / 1_500 });
    expect(periodRoi([], value, 0)).toBeNull();
    expect(periodRoi([[0, 0], [1, 5]], [[0, 0.5], [1, 5.5]], 0)).toEqual({ pnl: 5, roi: null });
    expect(windowStart("7d", 10 * 86_400_000, 0)).toBe(3 * 86_400_000);
    expect(windowStart("7d", 10 * 86_400_000, 5 * 86_400_000)).toBe(5 * 86_400_000);
    expect(windowStart("all", 10 * 86_400_000, 2)).toBe(2);
  });
});
