import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { HlPortfolioResponse } from "../src/hyperliquid/types.js";
import { MAX_ROI, MIN_ROI_CAPITAL, returnMetrics, riskMetrics, toPortfolioResponse } from "../src/traders/traders.mappers.js";

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

  it("no return when nothing was ever deposited, null without data", () => {
    expect(returnMetrics(series([0, 0], [0, 0]))).toMatchObject({ roi: null, capital: null, cumulativeReturn: [[T0, 0], [T0 + D, 0]] });
    expect(returnMetrics({ accountValue: [], pnl: [] })).toEqual({ roi: null, cumulativeReturn: [], capital: null });
  });

  it("only capital that was in the account counts: a 0 account value with a negative PnL is a loss, not a deposit", () => {
    // Hyperliquid's perp series of a unified account: value 0 at every
    // point while the perp PnL moves. 0 − (−66,730) is not capital.
    const m = returnMetrics(series([0, 0, 0], [0, -30_000, -66_730]));
    expect(m).toMatchObject({ roi: null, capital: null });
    expect(m.cumulativeReturn.map(([, r]) => r)).toEqual([0, 0, 0]);
    // The same account with real capital at one point has a return.
    expect(returnMetrics(series([1000, 0, 0], [0, -300, -500])).roi).toBeCloseTo(-0.5, 12);
  });

  it(`no return under $${MIN_ROI_CAPITAL} of capital or above +${MAX_ROI * 100}%, and a loss is capped at −100%`, () => {
    expect(returnMetrics(series([0.0014, 0], [0, -0.0014]))).toMatchObject({ roi: null, capital: 0.0014 });
    expect(returnMetrics(series([99, 120], [0, 21])).roi).toBeNull();
    expect(returnMetrics(series([100, 121], [0, 21])).roi).toBeCloseTo(0.21, 12);
    expect(returnMetrics(series([100, 20_100], [0, 20_000])).roi).toBeNull();
    expect(returnMetrics(series([100, 10_100], [0, 10_000])).roi).toBe(100);
    // Fees can take the PnL a little past the capital: still −100 %.
    const m = returnMetrics(series([1000, 0], [0, -1000.5]));
    expect(m.roi).toBe(-1);
    expect(m.cumulativeReturn.at(-1)![1]).toBe(-1);
  });
});

describe("ROI on live Hyperliquid portfolios where the denominator is not capital (read 2026-10-02)", () => {
  const f = JSON.parse(readFileSync(new URL("./fixtures/portfolio-roi-degenerate-live.json", import.meta.url), "utf8")) as {
    cases: Array<{ address: string; copydog: { roi30d: number; roi: number }; portfolio: HlPortfolioResponse }>;
  };
  const byAddress = Object.fromEntries(f.cases.map((c) => [c.address.slice(0, 6), c]));

  it("0x8bf3… (J): a −$0.0014 perp month on a $0.0014 denominator is no longer −100%", () => {
    const c = byAddress["0x8bf3"];
    expect(toPortfolioResponse(c.portfolio, "month", "perp").roi).toBeNull();
    // The whole account (spot) has real capital and a return.
    expect(toPortfolioResponse(c.portfolio, "month", "all").roi).not.toBeNull();
    // All-time perp: real capital, CopyDog's figure.
    expect(toPortfolioResponse(c.portfolio, "allTime", "perp").roi!).toBeCloseTo(c.copydog.roi, 4);
  });

  it("0x1aa7…: a −$66,730 perp month with the perp value at 0 throughout is not −100% (CopyDog shows −100%)", () => {
    const c = byAddress["0x1aa7"];
    const month = toPortfolioResponse(c.portfolio, "month", "perp");
    expect(month.roi).toBeNull();
    expect(month.basis?.capital).toBeNull();
    expect(c.copydog.roi30d).toBe(-1);
    expect(toPortfolioResponse(c.portfolio, "month", "all").roi!).toBeCloseTo(-0.13018, 4);
    expect(toPortfolioResponse(c.portfolio, "allTime", "perp").roi!).toBeCloseTo(c.copydog.roi, 4);
  });

  it("0xeecc…: a −$66 perp month on a $3.69 denominator has no return; the all-time −100% is real (the perp deposit was lost)", () => {
    const c = byAddress["0xeecc"];
    expect(toPortfolioResponse(c.portfolio, "month", "perp").roi).toBeNull();
    // All time the perp account did hold capital (peak net deposits
    // $9,261.53, above the floor) and lost all of it: −100 % is the figure,
    // as CopyDog's.
    const all = toPortfolioResponse(c.portfolio, "allTime", "perp");
    expect(all.basis?.capital).toBeGreaterThan(MIN_ROI_CAPITAL);
    expect(all.roi).toBe(-1);
    expect(c.copydog.roi).toBe(-1);
  });

  it("0x4f76…: a flat perp month (value and PnL 0) has no return, while its all-time ROI is CopyDog's", () => {
    const c = byAddress["0x4f76"];
    expect(toPortfolioResponse(c.portfolio, "month", "perp").roi).toBeNull();
    expect(toPortfolioResponse(c.portfolio, "allTime", "perp").roi!).toBeCloseTo(c.copydog.roi, 4);
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
