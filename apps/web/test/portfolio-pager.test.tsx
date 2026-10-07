// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CopyCards, CopyDetail, CopyTable } from "@/components/copy/copy-portfolio";
import { RecentActivity } from "@/components/copy/recent-activity";
import { fixtureCopyOverview } from "@/fixtures/copy";
import { I18nProvider } from "@/i18n/provider";
import { catalogs } from "@/i18n/messages";
import type { CopyStrategyView } from "@/lib/contracts";

/**
 * Paul, 2026-10-07 (audit §七, §八): every list on /portfolio is ten rows a
 * page with the site's one pager (上一頁 / 第 n 頁 / 下一頁) at the card's
 * foot; 模擬訂單 is the trader page's dense table, paged by the api.
 */
const idle = { mutate() {}, mutateAsync: async () => ({}), isPending: false, isError: false };
const s = vi.hoisted(() => ({
  ordersCalls: [] as Array<string | undefined>,
  events: [] as unknown[],
  loadOlder: (() => {}) as () => void,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/zh-TW/portfolio", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/copy", async () => ({ ...(await vi.importActual<typeof import("@/lib/copy")>("@/lib/copy")),
  useCopyCommand: () => idle, usePatchCopy: () => idle, useAddCopyFunds: () => idle, useWithdrawCopyFunds: () => ({ ...idle, pendingOperations: [] }),
  useCopyOrders: (_id: number, before?: string) => {
    s.ordersCalls.push(before);
    const page = before ? 1 : 0;
    const items = Array.from({ length: 10 }, (_, i) => ({ id: String(100 - page * 10 - i), coin: "ETH", side: "B", leg: "open", status: "filled", size: 1, filledSize: 1, avgPx: 2500, reason: null, createdAt: new Date(Date.UTC(2026, 9, 7, 10, 0) - i * 60_000).toISOString() }));
    return { data: { items, previousCursor: items.at(-1)!.id, hasMore: page === 0 }, isPending: false, isPlaceholderData: false, isError: false };
  },
  useCopyEvents: () => ({ data: { items: s.events, hasMore: true }, isPending: false, loadOlder: s.loadOlder, isLoadingOlder: false }),
}));
vi.mock("@/components/copy/copy-compare", () => ({ CopyCompare: () => null }));
vi.mock("@/components/copy/copy-accounting-history", () => ({ CopyAccountingHistory: () => null }));
vi.mock("@/lib/favorite-groups", () => ({ useTraderCards: () => ({ data: { items: [] } }) }));
vi.mock("@/components/copy/live-copy-setup-dialogs", () => ({ useCopyTexts: () => ({ live: { errors: {} }, extra: { codes: {} } }) }));
vi.mock("@/lib/site-mode", () => ({ useSiteMode: () => "paper" }));

let root: Root, container: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); s.ordersCalls = []; container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.replaceChildren(); });
const render = (node: React.ReactNode) => act(async () => root.render(<I18nProvider locale="zh-TW" messages={catalogs["zh-TW"]}>{node}</I18nProvider>));
const button = (scope: ParentNode, name: string) => [...scope.querySelectorAll<HTMLButtonElement>("[data-pager] button")].find((b) => b.textContent?.includes(name))!;

const base = () => fixtureCopyOverview().strategies[0]! as unknown as CopyStrategyView;
const strategies = (n: number) => Array.from({ length: n }, (_, i) => ({ ...base(), id: 1000 + i, leaderAddress: `0x${String(i).padStart(40, "a")}` })) as CopyStrategyView[];

describe("模擬訂單", () => {
  it("is the dense data table, ten from the api, with 上一頁 / 第 n 頁 / 下一頁 at the card's foot", async () => {
    const strategy = { ...base(), status: "active" as const } as CopyStrategyView;
    await render(<CopyDetail strategy={strategy} leader={{ address: strategy.leaderAddress, displayName: "Kinetiq", avatarUrl: null }} balance={1000} onBack={() => {}} />);
    const table = container.querySelector('[data-testid="paper-orders"]')!;
    expect(table.closest(".table-dense")).not.toBeNull();
    expect(table.querySelectorAll("tbody.data-rows tr")).toHaveLength(10);
    const card = table.closest("section")!;
    const pager = card.querySelector("[data-pager]")!;
    expect(pager.textContent).toContain("上一頁");
    expect(pager.textContent).toContain("第 1 頁");
    expect(button(card, "上一頁").disabled).toBe(true);
    // No 返回 / 較舊訂單 buttons outside the card any more.
    expect(container.textContent).not.toContain("較舊訂單");
    await act(async () => button(card, "下一頁").click());
    expect(s.ordersCalls.at(-1)).toBe("91");
    expect(card.querySelector("[data-pager]")!.textContent).toContain("第 2 頁");
    expect(button(card, "下一頁").disabled).toBe(true);
    await act(async () => button(card, "上一頁").click());
    expect(s.ordersCalls.at(-1)).toBeUndefined();
  });
});

describe("lists bounded by a count page only above ten", () => {
  it("跟單中 (desktop table and phone cards): 12 copies are 10 and a pager; 3 are 3 and none", async () => {
    await render(<CopyTable strategies={strategies(12)} leaders={new Map()} onSelect={() => {}} />);
    expect(container.querySelectorAll("button.truncate")).toHaveLength(10);
    expect(container.querySelector("[data-pager]")?.textContent).toContain("第 1 / 2 頁");
    await render(<CopyCards strategies={strategies(12)} leaders={new Map()} onSelect={() => {}} />);
    expect(container.querySelectorAll(".orbit-card > button.w-full")).toHaveLength(10);
    expect(container.querySelector("[data-pager]")).not.toBeNull();
    await render(<CopyTable strategies={strategies(3)} leaders={new Map()} onSelect={() => {}} />);
    expect(container.querySelector("[data-pager]")).toBeNull();
  });
});

describe("最近動態", () => {
  it("查看全部 is ten a page; the page after the events read asks for older ones", async () => {
    const loadOlder = vi.fn();
    s.loadOlder = loadOlder;
    s.events = Array.from({ length: 15 }, (_, i) => ({ id: String(i + 1), type: "funds_added", strategyId: 1000, payload: { amount: 10 }, createdAt: new Date(Date.UTC(2026, 9, 7) + i * 60_000).toISOString() }));
    await render(<RecentActivity names={new Map([[1000, "Kinetiq"]])} />);
    const all = [...container.querySelectorAll("button")].find((b) => b.textContent === "查看全部")!;
    await act(async () => all.click());
    const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)!;
    expect(dialog.querySelectorAll("ol > li")).toHaveLength(10);
    await act(async () => button(dialog, "下一頁").click());
    expect(dialog.querySelectorAll("ol > li")).toHaveLength(5);
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });
});
