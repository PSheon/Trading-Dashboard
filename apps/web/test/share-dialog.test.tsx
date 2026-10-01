// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShareDialog } from "../src/components/trader/share-dialog";
import { I18nProvider } from "../src/i18n/provider";
import { zhTW } from "../src/i18n/messages/zh-TW";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

const A = "0xbf732ea04197942783e34730ed6e0f6099575d58";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<I18nProvider locale="zh-TW" messages={zhTW}><ShareDialog open onOpenChange={() => {}} address={A} name="solanadoomer" /></I18nProvider>));
  return { root, container };
}
const image = () => document.querySelector<HTMLImageElement>('[data-testid="share-image"]')!;
const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.replace("𝕏", "").trim() === text)!;

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
    expect([...document.querySelectorAll('[role="radio"][aria-label]')].map((b) => b.getAttribute("aria-label"))).toEqual(["16:9", "4:5"]);
    for (const p of ["24H", "7D", "30D", "ALL"]) expect(button(p)).toBeTruthy();
    for (const b of ["複製", "下載"]) expect(button(b)).toBeTruthy();
    // CopyDog's dialog has no X button.
    expect(button("分享到 X")).toBeUndefined();
    await act(async () => root.unmount());
  });

  it("switches period and format, and remembers the format", async () => {
    const { root } = await mount();
    await act(async () => button("7D").click());
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="4:5"]')!.click());
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
    await act(async () => root.unmount());
  });

});
