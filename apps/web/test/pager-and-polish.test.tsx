// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TablePager } from "../src/components/ui/table-pager";
import { ToastProvider, useToast } from "../src/components/ui/toast";
import { Modal } from "../src/components/ui/dialog";
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
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); });
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
  it.each([
    [390, "top", "center"], [480, "top", "center"],
    [481, "bottom", "left"], [1440, "bottom", "left"],
  ])("positions notifications for a %ipx viewport and keeps modal close controls usable", async (width, vertical, horizontal) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query === "(max-width: 480px)" && width <= 480,
      media: query, onchange: null, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    }));
    function Fire() { const toast = useToast(); return <button type="button" onClick={() => toast.error("操作失敗", { autoClose: false })}>fire</button>; }
    await render(<ToastProvider><Modal open onOpenChange={() => {}} title="設定"><Fire /></Modal></ToastProvider>, "zh-TW");
    const fire = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === "fire")!;
    await act(async () => fire.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const box = el.querySelector<HTMLOListElement>('[data-sonner-toaster]')!;
    expect(box.dataset.yPosition).toBe(vertical);
    expect(box.dataset.xPosition).toBe(horizontal);
    if (width <= 480) {
      expect(box.style.getPropertyValue("--mobile-offset-top")).toBe("calc(env(safe-area-inset-top, 0px) + 8px)");
      expect(box.style.getPropertyValue("--mobile-offset-left")).toBe("8px");
      expect(box.style.getPropertyValue("--mobile-offset-right")).toBe("8px");
    } else {
      expect(box.style.getPropertyValue("--offset-bottom")).toBe("16px");
      expect(box.style.getPropertyValue("--offset-left")).toBe("16px");
    }
    const notice = box.querySelector<HTMLElement>('[role="status"]')!;
    expect(notice.dataset.type).toBe("error");
    expect(notice.textContent).toBe("操作失敗");
    expect(notice.closest('section')?.getAttribute("aria-live")).toBe("polite");
    expect(notice.closest('[aria-hidden="true"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    await act(async () => notice.querySelector<HTMLButtonElement>('button[aria-label="關閉"]')!.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(el.querySelector('[data-sonner-toast]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("設定");
  });
});

describe("notification pointer interactions above a modal", () => {
  it.each(["body", "close"])("a pointer on notification %s closes only the notice and leaves normal modal dismissal usable", async (target) => {
    function Fixture() {
      const [open, setOpen] = useState(false);
      const toast = useToast();
      return <><button type="button" onClick={() => setOpen(true)}>open deposit</button>
        <Modal open={open} onOpenChange={setOpen} title="Deposit">
          <button type="button" onClick={() => toast.success("Address copied", { autoClose: false })}>copy address</button>
        </Modal></>;
    }
    await render(<ToastProvider><Fixture /></ToastProvider>);
    const opener = [...el.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "open deposit")!;
    await act(async () => { opener.focus(); opener.click(); });
    await act(async () => new Promise(resolve => setTimeout(resolve, 1)));
    const copy = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === "copy address")!;
    await act(async () => copy.click());
    await act(async () => new Promise(resolve => setTimeout(resolve, 1)));
    const notice = document.querySelector<HTMLElement>('[role="status"]')!;
    const close = target === "close" ? notice.querySelector<HTMLButtonElement>('button[aria-label="Close"]')! : notice;
    await act(async () => {
      close.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }));
      close.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse", button: 0 }));
      close.click();
    });
    await act(async () => new Promise(resolve => setTimeout(resolve, 260)));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Deposit");
    await vi.waitFor(() => expect(document.querySelector('[data-sonner-toast]')).toBeNull());
    expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true);
    // A real pointer on the ordinary modal backdrop still dismisses it.
    const backdrop = document.querySelector<HTMLElement>('div[data-state="open"].bg-overlay')!;
    await act(async () => {
      backdrop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }));
      backdrop.click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

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
