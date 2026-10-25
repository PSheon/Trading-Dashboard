// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { MobileTrader } from "../src/components/trader/mobile-trader";
import { ActivityTabs } from "../src/components/trader/activity-tabs";
import { I18nProvider } from "../src/i18n/provider";
import { zhTW } from "../src/i18n/messages/zh-TW";
import { profileFor } from "../src/fixtures/data";
import type { TraderProfileResponse } from "../src/lib/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("../src/components/alerts/alert-bell", () => ({ AlertBell: () => null }));
vi.mock("../src/components/traders/bits", () => ({ FavoriteButton: () => null, RoiPill: () => null }));
vi.mock("../src/components/charts/area-chart", () => ({ AreaChart: () => null }));
vi.mock("../src/components/trader/copy-panel", () => ({ CopyPanel: () => null }));
vi.mock("../src/components/trader/share-dialog", () => ({ ShareButton: () => null }));
vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ status: "signedOut", login() {} }) }));
vi.mock("../src/lib/copy", () => ({ useCopyOf: () => undefined }));
vi.mock("../src/lib/site-mode", () => ({ useSiteMode: () => "paper" }));
vi.mock("../src/lib/copy-live-portfolio", () => ({ useLiveCopyPortfolio: () => ({ data: undefined }) }));
vi.mock("../src/lib/queries", () => ({
  isComputing: () => false,
  isUnavailable: () => false,
  useTraderAnalytics: () => ({ data: undefined, error: null, refetch() {} }),
  useChartSnapshots: () => ({ data: undefined }),
}));

const empty = (): TraderProfileResponse => ({ ...(profileFor(`0x${"ab".repeat(20)}`, false) as unknown as TraderProfileResponse), positions: [] });
const html = (node: React.ReactNode) => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<I18nProvider locale="zh-TW" messages={zhTW}>{node}</I18nProvider>);
  return host;
};
const classes = (el: Element | null) => (el?.getAttribute("class") ?? "").split(/\s+/);

/** QA on Stage, 2026-10-25 (390×844): the fixed 跟單 bar covered the tab row
 * (持倉 / 洞察 / 表現 / 交易 / 動態) on first view; it only showed after a
 * scroll. On phones the row is sticky to the bottom, 8px above the bar
 * (under it in z-order), and its section steps aside so the row may rise
 * over the whole page column; the stats card above stays as it is. */
it("keeps the phone tab row above the 跟單 bar: sticky to the bar's top, below it in z-order, its section display: contents", () => {
  const page = html(<MobileTrader profile={empty()} marks={{}} portfolio={undefined} allTime={undefined} window="allTime" onWindow={() => {}} loading={false} copyScore={null} />);
  const tablist = page.querySelector('[role="tablist"][aria-label="交易活動"]');
  expect(tablist).not.toBeNull();
  const row = classes(tablist);
  expect(row).toContain("max-md:sticky");
  expect(row).toContain("max-md:bottom-[calc(var(--phone-bar-clearance)-8px+env(safe-area-inset-bottom,0px))]");
  expect(row).toContain("max-md:z-20");
  expect(row).toContain("max-md:bg-background");
  expect(classes(page.querySelector('[data-testid="trader-copy-bar"]'))).toContain("z-40");
  expect(classes(tablist!.closest('[data-testid="trader-activity-tabs"]'))).toContain("max-md:contents");
  // The section is a direct child of the page column, so the column is the row's containing block.
  expect(tablist!.closest('[data-testid="trader-activity-tabs"]')!.parentElement!.querySelector(":scope > section[aria-label]")).not.toBeNull();
});

/** The short phone page (暫無持倉) left the footer jumping up under a ~116px
 * line: the panel keeps a least height on every size, the empty line
 * centred in it, the same on desktop and phones. */
it("gives the tab panel and the empty positions state the same least height on desktop and phones", () => {
  for (const phone of [false, true]) {
    const tabs = html(<ActivityTabs profile={empty()} phone={phone} />);
    const panel = tabs.querySelector('[role="tabpanel"]');
    expect(classes(panel), String(phone)).toContain("min-h-48");
    const line = [...panel!.querySelectorAll("p")].find((p) => p.textContent === zhTW.trader.noPositions)!;
    expect(classes(line.parentElement), String(phone)).toEqual(expect.arrayContaining(["min-h-48", "justify-center", "items-center"]));
    // Desktop's row stays in the flow.
    if (!phone) expect(classes(tabs.querySelector('[role="tablist"]')).some((c) => c.includes("sticky"))).toBe(false);
  }
});
