// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShareDialog } from "../src/components/trader/share-dialog";
import { ToastProvider } from "../src/components/ui/toast";
import { I18nProvider } from "../src/i18n/provider";
import { zhTW } from "../src/i18n/messages/zh-TW";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

const A = "0xbf732ea04197942783e34730ed6e0f6099575d58";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<I18nProvider locale="zh-TW" messages={zhTW}><ToastProvider><ShareDialog open onOpenChange={() => {}} address={A} name="solanadoomer" /></ToastProvider></I18nProvider>));
  return { root, container };
}
const image = () => document.querySelector<HTMLImageElement>('[data-testid="share-image"]')!;
const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.replace("𝕏", "").trim() === text)!;
const notification = () => document.querySelector<HTMLElement>('[data-testid="toasts"] [role="status"]');
const outsideNotifications = () => [...document.querySelectorAll('[role="status"], [role="alert"]')].filter((node) => !node.closest('[data-testid="toasts"]'));
const flushNotifications = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("分享交易員主頁, CopyDog's share flow", () => {
  it("opens on the 16:9 card for ALL, with 4:5 and 24H / 7D / 30D next to it", async () => {
    const { root } = await mount();
    expect(document.body.textContent).toContain("分享交易員主頁");
    expect(image().getAttribute("src")).toBe(`/trader/${A}/share-image?period=allTime&format=landscape`);
    expect([...document.querySelectorAll('[role="radio"][aria-label]')].map((b) => b.getAttribute("aria-label"))).toEqual(["聚焦卡 · 16:9", "聚焦卡 · 4:5"]);
    for (const p of ["24H", "7D", "30D", "ALL"]) expect(button(p)).toBeTruthy();
    for (const b of ["複製", "下載"]) expect(button(b)).toBeTruthy();
    // CopyDog's dialog has no X button.
    expect(button("分享到 X")).toBeUndefined();
    await act(async () => root.unmount());
  });

  it("switches period and format, and remembers the format", async () => {
    const { root } = await mount();
    await act(async () => button("7D").click());
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="聚焦卡 · 4:5"]')!.click());
    expect(image().getAttribute("src")).toBe(`/trader/${A}/share-image?period=week&format=portrait`);
    expect(JSON.parse(localStorage.getItem("orbie_share_style")!)).toEqual({ format: "portrait" });
    await act(async () => root.unmount());
    const again = await mount();
    expect(image().getAttribute("src")).toContain("format=portrait");
    await act(async () => again.root.unmount());
  });

  it("downloads the PNG under CopyDog's file name pattern", async () => {
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(blob));
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    });
    const { root } = await mount();
    await act(async () => button("下載").click());
    expect(fetchMock).toHaveBeenCalledWith(`/trader/${A}/share-image?period=allTime&format=landscape`);
    expect(clicks).toEqual(["orbie-solanadoomer-all-landscape.png"]);
    // CopyDog says nothing after a download that worked.
    await flushNotifications();
    expect(notification()).toBeNull();
    expect(document.querySelector('[data-testid="toasts"] [data-sonner-toast]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("confirms a copy with a polite success notification, inline text nowhere", async () => {
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(blob));
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { write }, configurable: true });
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = class { constructor(public items: unknown) {} };
    const { root } = await mount();
    await act(async () => button("複製").click());
    await flushNotifications();
    expect(write).toHaveBeenCalledTimes(1);
    const notice = notification()!;
    expect(notice.dataset.type).toBe("success");
    expect(notice.textContent).toContain("圖片已複製到剪貼簿");
    expect(notice.closest("section")?.getAttribute("aria-live")).toBe("polite");
    expect(outsideNotifications().map((node) => node.textContent).join(" ")).not.toContain("圖片已複製到剪貼簿");
    await act(async () => root.unmount());
  });

  it("reports a failed copy with an error toast", async () => {
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(blob));
    Object.defineProperty(navigator, "clipboard", { value: { write: vi.fn().mockRejectedValue(new Error("nope")) }, configurable: true });
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = class { constructor(public items: unknown) {} };
    const { root } = await mount();
    await act(async () => button("複製").click());
    await flushNotifications();
    const notice = notification()!;
    expect(notice.dataset.type).toBe("error");
    expect(notice.textContent).toContain("無法複製圖片");
    expect(notice.closest("section")?.getAttribute("aria-live")).toBe("polite");
    expect(outsideNotifications().map((node) => node.textContent).join(" ")).not.toContain("無法複製圖片");
    await act(async () => root.unmount());
  });
});
