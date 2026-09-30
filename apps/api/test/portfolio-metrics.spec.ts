import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { HlPortfolioResponse } from "../src/hyperliquid/types.js";
import { returnMetrics, riskMetrics, toPortfolioResponse } from "../src/traders/traders.mappers.js";

const D = 24 * 3_600_000;
const T0 = Date.UTC(2026, 8, 1, 12);
const pts = (vals: number[], step: number | number[] = D): Array<[number, number]> => {
  let t = T0;
  return vals.map((v, i) => {
    if (i > 0) t += Array.isArray(step) ? step[i - 1] : step;
    return [t, v];
  });
};
const series = (av: number[], pnl: number[], step: number | number[] = D) => ({ accountValue: pts(av, step), pnl: pts(pnl, step) });

describe("ROI — CopyDog's: PnL ÷ peak net deposits", () => {
  it("divides by the most capital ever in the account, so a deposit is not return", () => {
    // +100 on 1,000; a 9,000 deposit; +101. Net deposits peak at 10,000.
    const m = returnMetrics(series([1000, 1100, 10_100, 10_201], [0, 100, 100, 201]));
    expect(m.capital).toBe(10_000);
    expect(m.roi).toBeCloseTo(0.0201, 12);
    // The % curve is PnL ÷ that capital, ending at the ROI.
    expect(m.cumulativeReturn.map(([, r]) => r)).toEqual([0, 0.01, 0.01, 0.0201]);
  });

  it("a withdrawal is not a loss; the capital stays the peak", () => {
    const m = returnMetrics(series([10_000, 11_000, 1000, 900], [0, 1000, 1000, 900]));
    expect(m.capital).toBe(10_000);
    expect(m.roi).toBeCloseTo(0.09, 12);
  });

  it("0 % when nothing was ever deposited, null without data", () => {
    expect(returnMetrics(series([0, 0], [0, 0])).roi).toBe(0);
    expect(returnMetrics({ accountValue: [], pnl: [] })).toEqual({ roi: null, cumulativeReturn: [], capital: null });
  });
});

describe("Sharpe and max drawdown — CopyDog's, on the whole account", () => {
  it("returns are ΔPnL ÷ peak account value; Sharpe annualised by the returns' median spacing", () => {
    const av = [1000, 1100, 1045, 1149.5, 919.6];
    const m = riskMetrics(series(av, av.map((v) => v - 1000)));
    // ΔPnL 100, −55, 104.5, −229.9 (÷ 1,149.5): mean −20.1, sample stdev
    // 158.3069; daily spacing → × √365.
    expect(m.sharpe).toBeCloseTo(-2.4257310984, 8);
    expect(m.volatility).toBeCloseTo(2.6310996104, 8);
    // Equity 1 + Σr peaks at 1.130057 and falls by 0.2: 0.2 ÷ 1.130057.
    expect(m.maxDrawdownPct).toBeCloseTo(0.2 / (1 + 149.5 / 1149.5), 12);
    expect(m.maxDrawdownUsd).toBeCloseTo(229.9, 9);
    expect(m.basis).toEqual({ peakAccountValue: 1149.5, returns: 4, skippedIntervals: 0, periodsPerYear: 365 });
  });

  it("skips intervals that start from an empty account, as CopyDog's sample count does", () => {
    // Funded, traded, emptied for two intervals, refunded.
    const m = riskMetrics(series([0, 1000, 1100, 0, 0, 500, 520], [0, 0, 100, 100, 100, 100, 120]));
    expect(m.basis.returns).toBe(3); // 1→2, 2→3, 5→6
    expect(m.basis.skippedIntervals).toBe(3);
  });

  it("annualises by the median spacing of the returns' time index, not the intervals'", () => {
    // Intervals of 24 h, 24 h, 9 h, 9 h: the returns' index has spacings of
    // 24 h, 9 h, 9 h → median 9 h → 365 × 24 ÷ 9 periods a year.
    const m = riskMetrics(series([1000, 1010, 1005, 1020, 1015], [0, 10, 5, 20, 15], [D, D, 9 * 3_600_000, 9 * 3_600_000]));
    expect(m.basis.periodsPerYear).toBeCloseTo((365 * 24) / 9, 9);
  });

  it("caps the drawdown at 100% and has no Sharpe without variance or data", () => {
    expect(riskMetrics(series([1000, 400, 10], [0, -600, -1590])).maxDrawdownPct).toBe(1);
    const flat = riskMetrics(series([100, 100, 100, 100], [0, 0, 0, 0]));
    expect(flat).toMatchObject({ sharpe: null, maxDrawdownPct: 0 });
    expect(riskMetrics({ accountValue: [], pnl: [] })).toMatchObject({ sharpe: null, volatility: null, maxDrawdownPct: null, maxDrawdownUsd: 0 });
  });

  it("uses the whole account for every market; ROI and the % curve stay the market's", () => {
    const whole = { accountValueHistory: [[T0, "1000"], [T0 + D, "1100"], [T0 + 2 * D, "990"]], pnlHistory: [[T0, "0"], [T0 + D, "100"], [T0 + 2 * D, "-10"]], vlm: "0" };
    const perp = { accountValueHistory: [[T0, "500"], [T0 + D, "560"], [T0 + 2 * D, "450"]], pnlHistory: [[T0, "0"], [T0 + D, "60"], [T0 + 2 * D, "-50"]], vlm: "0" };
    const raw = [["week", whole], ["perpWeek", perp]] as unknown as HlPortfolioResponse;
    const p = toPortfolioResponse(raw, "week", "perp");
    const a = toPortfolioResponse(raw, "week", "all");
    expect(p.roi).toBeCloseTo(-50 / 500, 12);
    expect(a.roi).toBeCloseTo(-10 / 1000, 12);
    expect(p.cumulativeReturn.at(-1)![1]).toBe(p.roi);
    expect(p.maxDrawdownPct).toBe(a.maxDrawdownPct);
    expect(p.sharpe).toBe(a.sharpe);
    expect(p.basis).toMatchObject({ version: "copydog-v1", capital: 500, peakAccountValue: 1100 });
    // Without the whole-account series, the market's own is used.
    expect(toPortfolioResponse([["perpWeek", perp]] as unknown as HlPortfolioResponse, "week", "perp").maxDrawdownPct).not.toBeNull();
  });
});

describe("reproduces CopyDog's published figures (0xd70c…, fetched 3 min after CopyDog computed them)", () => {
  const f = JSON.parse(readFileSync(new URL("./fixtures/portfolio-copydog-d70c.json", import.meta.url), "utf8")) as {
    portfolio: HlPortfolioResponse;
    copydog: { roi: number; roi30d: number; sharpe: number; maxDrawdown: number; volatility: number; return_sample_count: number;
      perfWindows: Record<"month" | "week", { sharpe: number; maxDrawdown: number }> };
  };
  const cd = f.copydog;
  it("all time: ROI, Sharpe, volatility, max drawdown and the sample count", () => {
    const r = toPortfolioResponse(f.portfolio, "allTime", "perp");
    expect(r.roi).toBeCloseTo(cd.roi, 6);
    expect(r.sharpe!).toBeCloseTo(cd.sharpe, 2);
    expect(r.volatility!).toBeCloseTo(cd.volatility, 3);
    expect(r.maxDrawdownPct!).toBeCloseTo(cd.maxDrawdown, 5);
    expect(r.basis?.returns).toBe(cd.return_sample_count);
  });
  it("30 and 7 days", () => {
    const month = toPortfolioResponse(f.portfolio, "month", "perp");
    expect(month.roi!).toBeCloseTo(cd.roi30d, 5);
    expect(Math.abs(month.sharpe! / cd.perfWindows.month.sharpe - 1)).toBeLessThan(0.01);
    expect(month.maxDrawdownPct!).toBeCloseTo(cd.perfWindows.month.maxDrawdown, 4);
    const week = toPortfolioResponse(f.portfolio, "week", "perp");
    expect(Math.abs(week.sharpe! / cd.perfWindows.week.sharpe - 1)).toBeLessThan(0.01);
    expect(week.maxDrawdownPct!).toBeCloseTo(cd.perfWindows.week.maxDrawdown, 4);
  });
});
