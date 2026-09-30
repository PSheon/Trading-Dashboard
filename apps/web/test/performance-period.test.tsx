import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
import { zhTW } from "../src/i18n/messages/zh-TW";
import { KpiTiles, annualized, signedPctCd, trackRecord, type KpiPeriod } from "../src/components/trader/performance";
import type { PortfolioResponse, TraderAnalyticsResponse } from "../src/lib/contracts";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 30);
const trades = (winRate: number | null, count: number) =>
  ({ summary: { winRate, trades: count } }) as unknown as TraderAnalyticsResponse;
const portfolio = (pnl: number, roi: number, extra: Partial<PortfolioResponse> = {}, firstDaysAgo = 40) =>
  ({ pnl: [[NOW - firstDaysAgo * DAY, 0], [NOW, pnl]], roi, sharpe: 4.8047, maxDrawdownPct: 0.119011, ...extra }) as unknown as PortfolioResponse;

function render(opts: { trades?: TraderAnalyticsResponse; computing?: boolean; locale?: "en" | "zh-TW"; period?: KpiPeriod; periodPortfolio?: PortfolioResponse; allTime?: PortfolioResponse }) {
  const locale = opts.locale ?? "en";
  return renderToStaticMarkup(
    <I18nProvider locale={locale} messages={locale === "en" ? en : zhTW}>
      <KpiTiles period={opts.period ?? "allTime"} onPeriod={() => {}} periodPortfolio={opts.periodPortfolio} allTime={opts.allTime}
        lowSample={false} trades={opts.trades} tradesComputing={opts.computing ?? false} now={NOW} />
    </I18nProvider>,
  );
}

describe("KPI tiles, CopyDog's", () => {
  it("表現 and ROI follow the tile's period; Sharpe and drawdown are all-time", () => {
    const allTime = portfolio(16_285_510, 3.843612);
    const html = render({ period: "month", periodPortfolio: portfolio(17_295_593, 5.359733), allTime, locale: "zh-TW" });
    expect(html).toContain("+$17.30M");
    expect(html).toContain("+536%");
    expect(html).toContain("30D");
    expect(html).toContain("4.80");
    expect(html).toContain("11.9%");
    expect(html).toContain("最大回撤");
    expect(html).toContain("1mo 交易資歷");
  });

  it("annualises All over the history's span and warns under 90 days", () => {
    const allTime = portfolio(16_285_510, 3.843612);
    const html = render({ periodPortfolio: allTime, allTime });
    // (1 + 3.843612)^(365.25 / 40) − 1.
    expect(html).toContain(signedPctCd(annualized(3.843612, 40)));
    expect(html).toContain("Track record: 40 days");
  });

  it("formats like CopyDog", () => {
    expect(signedPctCd(473.738787)).toBe("+47,374%");
    expect(signedPctCd(-0.226904)).toBe("-22.7%");
    expect(trackRecord(NOW - 40 * DAY, NOW)).toBe("1mo");
    expect(trackRecord(NOW - 2.8 * 365 * DAY, NOW)).toBe("2.8y");
    expect(trackRecord(NOW - 12.5 * DAY, NOW)).toBe("12d");
    expect(annualized(0.1, 30)).toBeCloseTo(1.1 ** (365.25 / 30) - 1, 12);
  });

  it("shows the all-time win rate to one decimal with its trade count, coloured like CopyDog", () => {
    const html = render({ trades: trades(0.2917, 24) });
    expect(html).toContain("29.2%");
    expect(html).toContain("24 Trades");
    expect(html).toContain("text-negative");
    expect(render({ trades: trades(0.551, 98) })).toContain("text-positive");
    expect(render({ trades: trades(0.4, 5) })).toContain("text-warning");
  });

  it("says it is computing while a cold address is reconstructed", () => {
    expect(render({ computing: true })).toContain("Computing…");
  });

  it("uses CopyDog's Traditional Chinese labels", () => {
    const html = render({ trades: trades(0.615, 13), locale: "zh-TW" });
    expect(html).toContain("勝率");
    expect(html).toContain("13 筆交易");
  });
});
