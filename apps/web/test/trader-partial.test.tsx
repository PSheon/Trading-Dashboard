import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
import { TraderView } from "../src/components/trader/trader-view";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("../src/lib/queries", () => ({
  useTraderProfile: () => ({ isError: true, error: new Error("Profile unavailable"), refetch() {} }),
  useTraderActivity: () => ({ data: undefined }),
  usePortfolio: () => ({ data: { pnl: [[1, 42]] }, isPending: false }),
  useSiteSettings: () => ({ data: undefined }),
}));
vi.mock("../src/lib/use-live-trader", () => ({ useLiveTrader: () => ({ profile: undefined, fills: [], mids: {} }) }));
vi.mock("../src/components/trader/profile-card", () => ({ ProfileCard: () => null }));
vi.mock("../src/components/trader/copy-panel", () => ({ CopyPanel: () => null }));
vi.mock("../src/components/trader/activity-tabs", () => ({ ActivityTabs: () => null }));
vi.mock("../src/components/trader/performance", () => ({ KpiTiles: () => null, windowRoi: () => null,
  PerformanceChart: () => <div>Available performance history</div>,
}));
it("keeps independent performance history visible when required profile data fails", () => {
  const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><TraderView address={`0x${"ab".repeat(20)}`} /></I18nProvider>);
  expect(html).toContain("Profile unavailable");
  expect(html).toContain("Available performance history");
});
