import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
import { TraderView } from "../src/components/trader/trader-view";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }), notFound: () => { throw new Error("notFound"); } }));
vi.mock("../src/lib/queries", () => ({
  useTraderProfile: () => ({ isError: true, errorUpdateCount: 1, error: new Error("Profile unavailable"), refetch() {} }),
  isComputing: () => false,
  useTraderAnalytics: () => ({ data: undefined }),
  useTraderActivity: () => ({ data: undefined }),
  useCopyScore: () => ({ data: undefined }),
  usePortfolio: () => ({ data: { pnl: [[1, 42]] }, isPending: false }),
  useSiteSettings: () => ({ data: undefined }),
}));
vi.mock("../src/lib/use-live-trader", () => ({ useLiveTrader: () => ({ profile: undefined, fills: [], mids: {} }) }));
vi.mock("../src/components/trader/profile-card", () => ({ ProfileCard: () => null }));
vi.mock("../src/components/trader/copy-panel", () => ({ CopyPanel: () => null }));
vi.mock("../src/components/trader/activity-tabs", () => ({ ActivityTabs: () => null }));
vi.mock("../src/components/trader/performance", () => ({ KpiTiles: () => null, windowRoi: () => null,
  TRADE_WINDOW: { day: "1d", week: "7d", month: "30d", allTime: "all" },
  PerformanceChart: () => <div>Available performance history</div>,
}));
it("a profile that could not be loaded is CopyDog's one line and its retry, with nothing else on the page", () => {
  const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><TraderView address={`0x${"ab".repeat(20)}`} /></I18nProvider>);
  expect(html).toContain("Couldn&#x27;t load this trader.");
  expect(html).toMatch(/<button[^>]*>Retry<\/button>/);
  // No raw error text, no banner, no placeholders and no half page.
  expect(html).not.toContain("Profile unavailable");
  expect(html).not.toContain("Available performance history");
  expect(html).not.toContain("animate-pulse");
});
