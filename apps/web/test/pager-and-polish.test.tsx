// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TablePager } from "../src/components/ui/table-pager";
import { ToastProvider, useToast } from "../src/components/ui/toast";
import { Tooltip } from "../src/components/ui/tooltip";
import { ProfileCard } from "../src/components/trader/profile-card";
import { profileFor } from "../src/fixtures/data";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
import { zhTW } from "../src/i18n/messages/zh-TW";
import type { TraderProfileResponse } from "../src/lib/contracts";

/** Workstream ⑩: the one pager, and the audit's remaining P2 polish
 * (2026-10-07): toasts over a phone's bottom sheet, the tooltip that took
 * the withdraw dialog's Escape, address names on one line, and 模擬訂單 /
 * 帳務紀錄 read ten at a time. */
const calls = vi.hoisted(() => [] as string[]);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("../src/components/alerts/alert-bell", () => ({ AlertBell: () => null }));
vi.mock("../src/components/traders/bits", () => ({ FavoriteButton: () => null, VaultBadge: () => null }));
vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", mode: "privy", identity: "a@example.com", wallet: null }) }));
vi.mock("../src/lib/api", async (original) => {
  const actual = await original<typeof import("../src/lib/api")>();
  return { ...actual, api: { get: async (path: string) => {
    calls.push(path);
    if (path.includes("/ledger")) return { mode: "paper", items: Array.from({ length: 10 }, (_, i) => ({ id: String(50 - i), kind: "fee", amount: "-0.1", coin: "ETH", orderId: null, createdAt: new Date(Date.UTC(2026, 9, 7)).toISOString() })), previousCursor: "41", hasMore: true };
    return { items: [], previousCursor: null, hasMore: false };
  } } };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let el: HTMLDivElement;
beforeEach(() => { calls.length = 0; el = document.createElement("div"); document.body.append(el); root = createRoot(el); });
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });
const render = (node: React.ReactNode, locale: "en" | "zh-TW" = "en") =>
  act(async () => root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><I18nProvider locale={locale} messages={locale === "en" ? en : zhTW}>{node}</I18nProvider></QueryClientProvider>));

describe("TablePager", () => {
  it("draws nothing while everything fits on the first page", async () => {
    await render(<TablePager page={0} pages={1} onPage={() => {}} />);
    expect(el.querySelector("[data-pager]")).toBeNull();
  });

  it("says 第 n / m 頁 with a count, 第 n 頁 for a cursor list, and pages with 44 px buttons", async () => {
    const onPage = vi.fn();
    await render(<TablePager page={1} pages={3} onPage={onPage} />, "zh-TW");
    expect(el.querySelector("[data-pager]")!.textContent).toBe("上一頁第 2 / 3 頁下一頁");
    const [prev, next] = el.querySelectorAll<HTMLButtonElement>("[data-pager] button");
    expect(prev.className).toContain("h-11");
    await act(async () => prev.click());
    await act(async () => next.click());
    expect(onPage.mock.calls).toEqual([[0], [2]]);
    await render(<TablePager page={0} hasNext onPage={onPage} />, "zh-TW");
    expect(el.querySelector("[data-pager]")!.textContent).toBe("上一頁第 1 頁下一頁");
  });

  it("waits on 下一頁 with the spinner while the next page is read", async () => {
    await render(<TablePager page={0} hasNext busy onPage={() => {}} />);
    const next = [...el.querySelectorAll<HTMLButtonElement>("[data-pager] button")].at(-1)!;
    expect(next.disabled).toBe(true);
    expect(next.querySelector("[data-orbit-spinner]")).not.toBeNull();
  });
});

describe("toasts on phones", () => {
  it("sit at the top, under the notch, so an open bottom sheet's buttons stay clear; clickable over a modal", async () => {
    function Fire() { const toast = useToast(); return <button type="button" onClick={() => toast.error("x")}>fire</button>; }
    await render(<ToastProvider><Fire /></ToastProvider>);
    await act(async () => el.querySelector("button")!.click());
    const box = el.querySelector('[data-testid="toasts"]')!;
    expect(box.className).toContain("top-[env(safe-area-inset-top,0px)]");
    expect(box.className).not.toMatch(/(^|\s)bottom-0(\s|$)/);
    expect(box.className).toContain("min-[481px]:bottom-4");
    expect(box.className).toContain("pointer-events-auto");
  });
});

describe("the withdraw dialog's Escape", () => {
  it("is not taken by a tooltip that has closed: tooltips leave without an exit animation", async () => {
    await render(<Tooltip content="hint"><button type="button">badge</button></Tooltip>);
    await act(async () => el.querySelector("button")!.focus());
    const content = [...document.querySelectorAll<HTMLElement>("[data-state]")].find((n) => n.textContent?.includes("hint") && n.className.includes("z-50"));
    expect(content).toBeDefined();
    expect(content!.className).not.toContain("animate-out");
  });
});

describe("the trader page's name", () => {
  it("keeps an address-only name on one line, its head cut, never 0xe779… / 6ba7", () => {
    const profile: TraderProfileResponse = { ...JSON.parse(JSON.stringify(profileFor(`0x${"e7".repeat(20)}`, false))), displayName: null, kol: null };
    const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><ProfileCard profile={profile} allTimeVolume={null} trades={undefined} tradesComputing={false} /></I18nProvider>);
    const h1 = html.slice(html.indexOf("<h1"), html.indexOf("</h1>"));
    expect(h1).toContain("whitespace-nowrap");
    expect(h1).not.toContain("whitespace-normal");
    expect(h1).not.toContain("line-clamp-2");
  });
});

describe("paper history reads ten at a time", () => {
  it("模擬訂單 asks the api for limit=10, the next page with before=", async () => {
    const { useCopyOrders } = await import("../src/lib/copy");
    function Orders({ before }: { before?: string }) { useCopyOrders(7, before); return null; }
    await render(<Orders />);
    await render(<Orders before="91" />);
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(calls).toContain("/me/copy/strategies/7/orders?limit=10");
    expect(calls).toContain("/me/copy/strategies/7/orders?limit=10&before=91");
  });
});
