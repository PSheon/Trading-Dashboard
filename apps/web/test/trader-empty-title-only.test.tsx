import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PerformanceTab, TradesTab } from "../src/components/trader/trade-analytics";
import { BalancesTab, FillsTab, OrdersTab, TransfersTab } from "../src/components/trader/trader-tabs";
import type { TraderAnalyticsResponse } from "../src/lib/contracts";
import { catalogs } from "../src/i18n/messages";
import { I18nProvider } from "../src/i18n/provider";

/**
 * Paul, 2026-10-26: a trader tab with nothing to show is its title only,
 * as TWAP already is: no grey sentence under it, no hover added.
 */
const state = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("../src/lib/queries", () => ({
  isComputing: () => false,
  isUnavailable: () => false,
  useTraderOrders: () => state.result,
  useTraderTwap: () => state.result,
  useTraderTransfers: () => state.result,
  useTraderTrades: () => state.result,
}));

const zh = catalogs["zh-TW"];
const ADDRESS = `0x${"ab".repeat(20)}`;
const render = (node: React.ReactNode) => renderToStaticMarkup(<I18nProvider locale="zh-TW" messages={zh}>{node}</I18nProvider>);
/** The empty state's paragraphs: the title, and nothing else. */
const paragraphs = (html: string) => [...html.matchAll(/<p[^>]*>(.*?)<\/p>/g)].map((m) => m[1]);
const noop = () => {};

describe("trader tab empty states are the title only", () => {
  beforeEach(() => { state.result = {}; });

  it("表現", () => {
    const analytics = { summary: { best: [], worst: [], coins: [] } } as unknown as TraderAnalyticsResponse;
    expect(paragraphs(render(<PerformanceTab analytics={analytics} computing={false} error={null} onRetry={noop} view="best" onView={noop} />))).toEqual([zh.trader.perfEmptyTitle]);
  });

  it("交易", () => {
    state.result = { data: { pages: [{ address: ADDRESS, items: [], nextCursor: null, total: 0, coverage: { truncated: false, from: null }, computedAt: new Date() }] }, isError: false, hasNextPage: false };
    expect(paragraphs(render(<TradesTab address={ADDRESS} />))).toEqual([zh.trader.tradesEmptyTitle]);
  });

  it("餘額, 訂單, 成交, 轉帳", () => {
    expect(paragraphs(render(<BalancesTab balances={[]} />))).toEqual([zh.trader.empty.balancesTitle]);
    state.result = { data: { orders: [], dexes: [""], fetchedAt: new Date() }, isError: false };
    expect(paragraphs(render(<OrdersTab address={ADDRESS} />))).toEqual([zh.trader.empty.ordersTitle]);
    expect(paragraphs(render(<FillsTab rows={[]} />))).toEqual([zh.trader.empty.fillsTitle]);
    state.result = { data: { transfers: [], from: new Date(), truncated: false, fetchedAt: new Date() }, isError: false };
    expect(paragraphs(render(<TransfersTab address={ADDRESS} />))).toEqual([zh.trader.empty.transfersTitle]);
  });

  it("the six descriptions are gone from every catalog", () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect(catalog.trader, locale).not.toHaveProperty("perfEmptyDesc");
      expect(catalog.trader, locale).not.toHaveProperty("tradesEmptyDesc");
      for (const key of ["balancesDesc", "ordersDesc", "fillsDesc", "transfersDesc"]) expect(catalog.trader.empty, `${locale} ${key}`).not.toHaveProperty(key);
    }
  });
});
