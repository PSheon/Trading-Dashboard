// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActivityTabs } from "../src/components/trader/activity-tabs";
import { ActivityFeed } from "../src/components/trader/live-feed";
import { PerformanceTab, TradesTab } from "../src/components/trader/trade-analytics";
import { PositionsTab } from "../src/components/trader/trader-tabs";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
import { profileFor } from "../src/fixtures/data";
import type { LivePosition, RoundTrip, TraderAnalyticsResponse, TraderFill, TraderProfileResponse } from "../src/lib/contracts";

/**
 * Workstream ⑩ (Paul, 2026-10-07): the trader page's tabs are 持倉 / 洞察 /
 * 表現 / 交易 / 動態 on desktop and phones, in one shell, every list ten
 * rows a page with the one pager; the positions table's nine columns fit
 * the main column, its share button in a trailing row-action cell.
 */
const q = vi.hoisted(() => ({
  trades: {} as Record<string, unknown>,
  fills: { data: undefined as unknown, isError: false, refetch() {} },
  transfers: { data: undefined as unknown },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("../src/components/trader/trade-share-dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/components/trader/trade-share-dialog")>()),
  TradeShareDialog: () => <div role="dialog" />,
}));
vi.mock("../src/lib/queries", () => ({
  isComputing: () => false,
  isUnavailable: () => false,
  useTraderAnalytics: () => ({ data: undefined, error: null, refetch() {} }),
  useTraderTrades: () => q.trades,
  useTraderFills: () => q.fills,
  useTraderTransfers: () => q.transfers,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ADDRESS = "0x89da4baec446f35a1cbe17a9d1ee5c70b05ee43f";
let root: Root;
let el: HTMLDivElement;
beforeEach(() => {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  history.replaceState(null, "", "/");
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
});
const render = (node: React.ReactNode) => act(async () => root.render(<I18nProvider locale="en" messages={en}>{node}</I18nProvider>));
const pagerText = () => el.querySelector("[data-pager]")?.textContent ?? "";
const pagerButton = (name: string) => [...el.querySelectorAll<HTMLButtonElement>("[data-pager] button")].find((b) => b.textContent?.includes(name))!;

function profileWith(n: number): TraderProfileResponse {
  const profile: TraderProfileResponse = JSON.parse(JSON.stringify(profileFor(ADDRESS, false)));
  const base = profile.positions[0];
  profile.positions = Array.from({ length: n }, (_, i): LivePosition => ({ ...base, coin: `C${i}`, positionValue: 1000 - i, unrealizedPnl: 10 + i, entryPx: 2, szi: 500 }));
  return profile;
}

const trip = (i: number): RoundTrip => ({
  id: String(i), coin: "BTC", side: i % 2 ? "long" : "short", status: "closed", entryTime: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(), exitTime: new Date(Date.UTC(2026, 8, 2) + i * 60_000).toISOString(),
  entryPx: 100, exitPx: 110, size: 1, notional: 210, volume: 100, holdSeconds: 86_400, realizedPnl: 10, fees: 1, funding: 0, netPnl: 9, liquidated: false, twap: false, fills: 2, partial: false, entryApprox: false,
});

describe("the tab row", () => {
  it("is 持倉 / 洞察 / 表現 / 交易 / 動態, with no pulse button; 動態 opens the feed in the panel", async () => {
    q.fills = { data: [], isError: false, refetch() {} };
    q.transfers = { data: { transfers: [] } };
    await render(<ActivityTabs profile={profileWith(1)} />);
    const tabs = [...el.querySelectorAll('[role="tablist"] [role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(["Positions", "Insights", "Performance", "Trades", "Activity"]);
    expect(el.querySelector('button[aria-pressed]')).toBeNull();
    const activity = [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) => t.textContent === "Activity")!;
    await act(async () => activity.click());
    expect(el.querySelector('[role="tabpanel"] [data-testid="activity-feed"]')).not.toBeNull();
  });

  it("表現 sits in the same shell as the other tabs (no 12 px inset) with the site's segmented switch", async () => {
    const analytics = { summary: { best: [trip(1)], worst: [], coins: [] } } as unknown as TraderAnalyticsResponse;
    await render(<PerformanceTab analytics={analytics} computing={false} error={null} onRetry={() => {}} view="best" onView={() => {}} />);
    expect(el.innerHTML).not.toContain("sm:px-3");
    const radios = el.querySelectorAll('[role="radiogroup"] [role="radio"]');
    expect(radios).toHaveLength(3);
    expect(el.querySelectorAll('[role="radiogroup"]')).toHaveLength(1);
  });
});

describe("持倉", () => {
  it("shows ten positions a page with the shared pager", async () => {
    await render(<PositionsTab profile={profileWith(12)} marks={{}} />);
    expect(el.querySelectorAll('[data-testid="positions-table"] tbody tr')).toHaveLength(10);
    expect(el.querySelectorAll("ul > li")).toHaveLength(10);
    expect(pagerText()).toContain("Page 1 of 2");
    await act(async () => pagerButton("Next").click());
    expect(el.querySelectorAll('[data-testid="positions-table"] tbody tr')).toHaveLength(2);
  });

  it("puts the share button in a trailing row-action cell, the % under the PnL, the leverage under the coin", async () => {
    await render(<PositionsTab profile={profileWith(1)} marks={{}} />);
    const row = el.querySelector('[data-testid="positions-table"] tbody tr')!;
    const cells = row.querySelectorAll("td");
    expect(cells).toHaveLength(10);
    const last = cells[cells.length - 1];
    expect(last.classList.contains("row-action")).toBe(true);
    expect(last.querySelector('button[aria-label="Share position"]')).not.toBeNull();
    const pnl = row.querySelector('[data-testid="pnl"]')!;
    expect(pnl.querySelector("button")).toBeNull();
    expect(pnl.querySelector("div")?.textContent).toMatch(/%$/);
    // Always shown (Paul): a 36 px round button, muted until hovered.
    const share = last.querySelector("button")!;
    expect(share.className).toContain("size-9");
    expect(share.className).toContain("rounded-full");
    expect(share.className).not.toContain("opacity-0");
    expect(el.querySelector("thead th.row-action")).not.toBeNull();
    expect(cells[0].querySelector(".flex-col")?.textContent).toMatch(/^C0\d+×/);
  });

  it("gives the phone card's share button a 44 px tap target, labelled 分享持倉", async () => {
    await render(<PositionsTab profile={profileWith(1)} marks={{}} />);
    const card = el.querySelector("ul > li")!;
    const share = card.querySelector<HTMLButtonElement>('button[aria-label="Share position"]')!;
    expect(share.className).toContain("size-11");
    const { zhTW } = await import("../src/i18n/messages/zh-TW");
    expect(zhTW.trader.sharePosition).toBe("分享持倉");
  });
});

describe("交易", () => {
  it("is ten a page over the api's total, and a page past the ones read asks for the next 50", async () => {
    const fetchNextPage = vi.fn();
    const items = Array.from({ length: 50 }, (_, i) => trip(i));
    q.trades = { data: { pages: [{ items, total: 120, nextCursor: "c", coverage: { truncated: false, from: null } }] }, hasNextPage: true, isFetchingNextPage: false, fetchNextPage, isError: false };
    await render(<TradesTab address={ADDRESS} />);
    expect(el.querySelectorAll("tbody tr")).toHaveLength(10);
    expect(pagerText()).toContain("Page 1 of 12");
    expect(el.textContent).not.toMatch(/Show more/);
    for (let i = 0; i < 4; i++) await act(async () => pagerButton("Next").click());
    expect(pagerText()).toContain("Page 5 of 12");
    expect(fetchNextPage).not.toHaveBeenCalled();
    await act(async () => pagerButton("Next").click());
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });
});

describe("動態", () => {
  it("lists the fills and transfers ten a page", async () => {
    const fills: TraderFill[] = Array.from({ length: 25 }, (_, i) => ({
      tid: String(i), coin: i % 2 ? "BTC" : "ETH", side: "buy", dir: "Open Long", px: 100, sz: 1, notionalUsd: 100, closedPnl: 0, fee: 0,
      ts: new Date(Date.UTC(2026, 9, 1) - i * 60_000).toISOString(), twapId: null, startPosition: 0, liquidation: false,
    }));
    q.fills = { data: fills, isError: false, refetch() {} };
    q.transfers = { data: { transfers: [] } };
    await render(<ActivityFeed address={ADDRESS} />);
    expect(el.querySelectorAll('[data-testid="activity-feed"] ul > li')).toHaveLength(10);
    expect(pagerText()).toContain("Page 1 of 3");
  });
});
