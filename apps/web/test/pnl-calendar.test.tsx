import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../src/i18n/provider";
import { zhTW } from "../src/i18n/messages/zh-TW";
import { calendarRoi, calendarShade, pnlCalendar, type MonthOf } from "../src/lib/pnl-calendar";
import { PnlCalendarView, calendarTitle, calendarUsd } from "../src/components/trader/pnl-calendar";
import { signedPctCd } from "../src/components/trader/performance";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const portfolio = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock("../src/lib/queries", () => ({
  usePortfolio: () => ({ data: portfolio.data, isPending: false, isError: false }),
}));

// CopyDog's all-time perp + spot series for 0xfc5270b50bd619afa6ef487bb7e3e580bfefee77
// (api.copydog.xyz …/chart?window=allTime&kind=combined, 2026-10-01), unix
// seconds, and the cells its 日曆 showed for them in UTC+8.
const PNL: Array<[number, number]> = [[1773874200,0],[1773877800,11582.39],[1774480200,-3142.04],[1775083800,-37528.64],[1775689800,-16870.7],[1776293400,31027.98],[1776899400,3564.53],[1777506600,-8020.16],[1778105400,16343.6],[1778715000,-16431.5],[1779321000,73407.02],[1779922200,109508.9],[1780530600,239842.27],[1781135400,233510.14],[1781740200,233510.14],[1782345000,233510.14],[1782949800,233510.14],[1783554600,233510.14],[1784159400,233510.14],[1784764200,233510.14],[1785369000,233510.14],[1785967800,239268.01],[1786577400,232508.8],[1787182200,295116.62],[1787783400,338690.77],[1788042600,314568.95],[1788214200,316925.08],[1788385800,293776.35],[1788565800,270464.69],[1788738600,296884.18],[1788994200,268192.07],[1789168200,291762.94],[1789338600,278730.88],[1789513800,248353.01],[1789689000,265051.79],[1789775400,321889.35],[1789944600,321889.35],[1790121000,321889.35],[1790290200,324774.7],[1790465400,323370.94],[1790496600,340632.76],[1790519400,326059.29],[1790693400,328665.42],[1790765400,341250.85],[1790784476,338856]];
const VALUE: Array<[number, number]> = [[1773874200,0],[1773877800,94243.11],[1774480200,79518.68],[1775083800,45132.08],[1775689800,65790.02],[1776293400,113688.7],[1776899400,86225.25],[1777506600,74640.56],[1778105400,99004.32],[1778715000,66229.22],[1779321000,156067.74],[1779922200,192169.62],[1780530600,322502.99],[1781135400,0],[1781740200,0],[1782345000,0],[1782949800,0],[1783554600,0],[1784159400,0],[1784764200,0],[1785369000,0],[1785967800,60827.54],[1786577400,154318.13],[1787182200,216925.95],[1787783400,260500.1],[1788042600,236378.28],[1788214200,238734.41],[1788385800,215585.68],[1788565800,192274.02],[1788738600,218693.51],[1788994200,90817.38],[1789168200,114388.25],[1789338600,101356.19],[1789513800,70978.32],[1789689000,87677.1],[1789775400,49998.99],[1789944600,49998.99],[1790121000,49998.99],[1790290200,52894.74],[1790465400,51490.98],[1790496600,68752.8],[1790519400,54179.33],[1790693400,46435.46],[1790765400,59020.89],[1790784476,56626.04]];
const ms = (s: Array<[number, number]>) => s.map(([t, v]) => [t * 1000, v] as [number, number]);
const taipei: MonthOf = (t) => {
  const d = new Date(t + 8 * 3_600_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
};

describe("日曆 (CopyDog's monthly PnL calendar)", () => {
  const cal = pnlCalendar(ms(PNL), ms(VALUE), taipei)!;
  const row = cal.rows[0];

  it("buckets the series into months, blank before the first point and after the last", () => {
    expect(cal.rows.map((r) => r.year)).toEqual([2026]);
    expect(row.months.slice(0, 2)).toEqual([null, null]);
    expect(row.months.slice(10)).toEqual([null, null]);
    expect(row.months.slice(2, 10).every(Boolean)).toBe(true);
  });

  it("matches CopyDog's cell titles: month PnL and PnL ÷ the month's peak net deposits", () => {
    const titles = row.months.slice(2, 10).map((c) => calendarTitle(c!));
    expect(titles).toEqual([
      "-$3.14K · -3.80%",
      "-$4.88K · -5.90%",
      "+$117.53K · +142.18%",
      "+$124.00K · +150.01%",
      "$0.00",
      "+$81.06K",
      "+$26.68K",
      "-$2.39K",
    ]);
    expect(calendarTitle(row)).toBe("+$338.86K · +409.94%");
  });

  it("shows what CopyDog's cells show, in % and in $", () => {
    const pct = row.months.slice(2, 10).map((c) => (c!.roi == null ? "—" : signedPctCd(c!.roi)));
    expect(pct).toEqual(["-3.8%", "-5.9%", "+142%", "+150%", "—", "—", "—", "—"]);
    const usd = row.months.slice(2, 10).map((c) => calendarUsd(c!.pnl));
    expect(usd).toEqual(["-$3K", "-$5K", "+$118K", "+$124K", "$0", "+$81K", "+$27K", "-$2K"]);
    expect(signedPctCd(row.roi)).toBe("+410%");
  });

  it("tints like CopyDog: 11 + 19·√(|v| ÷ max), rounded", () => {
    const shades = row.months.slice(2, 6).map((c) => calendarShade(c!.roi, cal.maxAbsRoi));
    expect(shades).toEqual([14, 15, 29, 30]);
    expect(calendarShade(0, 1)).toBeNull();
    expect(calendarShade(null, 1)).toBeNull();
    expect(calendarShade(5, 0)).toBe(21);
    // $ mode, 0xbf73… (max month +$11.91M): +$3.81M → 22, +$1.18M → 17, -$176K → 13.
    expect([3.81e6, 1.18e6, -175.74e3].map((v) => calendarShade(v, 11.91e6))).toEqual([22, 17, 13]);
  });

  it("caps a return at −100% and drops it under $100 of capital or above +10,000%", () => {
    expect(calendarRoi(-500, 200)).toBe(-1);
    expect(calendarRoi(10, 99)).toBeNull();
    expect(calendarRoi(10, null)).toBeNull();
    expect(calendarRoi(1_000_000, 100)).toBeNull();
    expect(calendarRoi(50, 100)).toBe(0.5);
  });

  it("splits years, newest first, each with its own 全年", () => {
    const utc: MonthOf = (t) => ({ year: new Date(t).getUTCFullYear(), month: new Date(t).getUTCMonth() });
    const at = (y: number, m: number, d = 15) => Date.UTC(y, m, d);
    const c = pnlCalendar(
      [[at(2024, 10), 0], [at(2024, 11), 100], [at(2025, 0), 50], [at(2025, 0, 25), 250]],
      [[at(2024, 10), 1000], [at(2024, 11), 1100], [at(2025, 0), 1050], [at(2025, 0, 25), 1250]],
      utc,
    )!;
    expect(c.rows.map((r) => r.year)).toEqual([2025, 2024]);
    expect(c.rows[1].months[10]).toEqual({ pnl: 0, roi: 0 });
    expect(c.rows[1].months[11]).toEqual({ pnl: 100, roi: 0.1 });
    expect(c.rows[0].months[0]).toEqual({ pnl: 150, roi: 0.15 });
    expect(c.rows[1].pnl).toBe(100);
    expect(c.rows[0].roi).toBe(0.15);
    expect(c.maxAbsPnl).toBe(150);
    expect(pnlCalendar([], [])).toBeNull();
    expect(pnlCalendar(undefined, undefined)).toBeNull();
  });
});

describe("日曆 view", () => {
  it("renders the grid with the 全年 column", () => {
    portfolio.data = { window: "allTime", market: "all", pnl: ms(PNL), accountValue: ms(VALUE) };
    const html = renderToStaticMarkup(
      <I18nProvider locale="zh-TW" messages={zhTW}>
        <PnlCalendarView address="0xfc5270b50bd619afa6ef487bb7e3e580bfefee77" unit="pct" />
      </I18nProvider>,
    );
    expect(html).toContain("全年");
    expect(html).toContain("2026");
    expect(html).toContain("1月");
    expect(html).toContain('data-cell="overall"');
    expect(html).toMatch(/color-mix\(in srgb, var\(--positive\) 26%/);
  });

  it("says so when there is no history", () => {
    portfolio.data = { window: "allTime", market: "all", pnl: [], accountValue: [] };
    const html = renderToStaticMarkup(
      <I18nProvider locale="zh-TW" messages={zhTW}>
        <PnlCalendarView address="0x0000000000000000000000000000000000000001" unit="usd" />
      </I18nProvider>,
    );
    expect(html).toContain(zhTW.trader.chart.noData);
  });
});
