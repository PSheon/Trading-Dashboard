import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { KpiTiles, trackRecord } from "../src/components/trader/performance";
import { PerformanceTab } from "../src/components/trader/trade-analytics";
import { I18nProvider } from "../src/i18n/provider";
import { zhTW } from "../src/i18n/messages/zh-TW";
import { ApiError } from "../src/lib/api";
import { isComputing, isUnavailable } from "../src/lib/queries";
import type { PortfolioResponse } from "../src/lib/contracts";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

/**
 * A trader's analytics the api keeps answering 503 busy for (audit
 * 2026-10-07 P1-7): after the page's few retries it says 暫時無法取得，稍後再試
 * with 重試, never 「計算中…」 or 「尚無紀錄」 for as long as the api is busy.
 * And no English on the zh-TW tiles (P1-12): 全部 / 30天 / 7天, 5 個月.
 */
const DAY = 86_400_000, NOW = Date.UTC(2026, 8, 30);
const busy = new ApiError(503, "Busy", { code: "busy" });
const query = (failureCount: number) => ({ data: undefined, failureReason: busy, failureCount, isPending: true, isError: false });
const zh = (node: React.ReactNode) => renderToStaticMarkup(<I18nProvider locale="zh-TW" messages={zhTW}>{node}</I18nProvider>);

it("busy for the first answers is computing; past them it is unavailable, not a placeholder without end", () => {
  expect(isComputing(query(1))).toBe(true);
  expect(isUnavailable(query(1))).toBe(false);
  expect(isComputing(query(4))).toBe(false);
  expect(isUnavailable(query(4))).toBe(true);
  expect(isUnavailable({ ...query(4), data: {} })).toBe(false);
});

it("表現 says 暫時無法取得，稍後再試 with 重試", () => {
  const html = zh(<PerformanceTab analytics={undefined} computing={false} unavailable error={null} onRetry={() => {}} view="best" onView={() => {}} />);
  expect(html).toContain("暫時無法取得，稍後再試");
  expect(html).toContain(">重試</button>");
  expect(html).not.toContain("計算中");
});

it("the 勝率 tile says it too, with 重試, instead of 尚無紀錄; its period and history read in Chinese", () => {
  const allTime = { pnl: [[NOW - 160 * DAY, 0], [NOW, 1]], roi: 1, sharpe: 1, maxDrawdownPct: 0.1 } as unknown as PortfolioResponse;
  const html = zh(<KpiTiles period="allTime" onPeriod={() => {}} periodPortfolio={allTime} allTime={allTime} trades={undefined} tradesComputing={false} tradesUnavailable onRetryTrades={() => {}} lowSample={false} now={NOW} />);
  expect(html).toContain("暫時無法取得，稍後再試");
  expect(html).toContain(">重試</button>");
  expect(html).not.toContain("尚無紀錄");
  expect(html).toContain(">全部<");
  expect(html).not.toMatch(/>All<|\dmo\b/);
  expect(html).toContain("5 個月 交易資歷");
  expect(trackRecord(NOW - 12.5 * DAY, NOW, "zh-TW")).toBe("12 天");
  expect(trackRecord(NOW - 40 * DAY, NOW)).toBe("1mo");
});
