// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TOAST_AUTO_CLOSE_MS, TOAST_LIMIT, ToastProvider, useToast, type Toast } from "../src/components/ui/toast";
import { I18nProvider } from "../src/i18n/provider";
import { zhTW } from "../src/i18n/messages/zh-TW";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let toast: Toast;
function Grab() {
  const current = useToast();
  useEffect(() => {
    toast = current;
  }, [current]);
  return null;
}

let root: Root;
async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <I18nProvider locale="zh-TW" messages={zhTW}>
        <ToastProvider>
          <Grab />
        </ToastProvider>
      </I18nProvider>,
    ),
  );
}
const toasts = () => [...document.querySelectorAll<HTMLElement>('[role="alert"]')];
const texts = () => toasts().map((el) => el.textContent?.replace("關閉", "").trim());

beforeEach(async () => {
  vi.useFakeTimers();
  await mount();
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("CopyDog's toasts", () => {
  it("renders in a polite live region as alerts with a type icon and a close button", async () => {
    await act(async () => void toast.success("圖片已複製到剪貼簿"));
    const region = document.querySelector('section[aria-live="polite"]')!;
    expect(region.getAttribute("aria-label")).toBe("通知");
    const [el] = toasts();
    expect(el.dataset.type).toBe("success");
    expect(el.textContent).toContain("圖片已複製到剪貼簿");
    expect(el.querySelector("svg path")).toBeTruthy();
    expect(el.querySelector('button[aria-label="關閉"]')).toBeTruthy();
    expect(el.className).toContain("toast-enter");
  });

  it("closes itself after 3 s, playing the exit animation first", async () => {
    await act(async () => void toast.error("無法複製圖片"));
    await act(async () => void vi.advanceTimersByTime(TOAST_AUTO_CLOSE_MS - 1));
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].className).toContain("toast-enter");
    await act(async () => void vi.advanceTimersByTime(1));
    expect(toasts()[0].className).toContain("toast-exit");
    await act(async () => void vi.advanceTimersByTime(500));
    expect(toasts()).toHaveLength(0);
  });

  it("closes on click anywhere on it, and on ×", async () => {
    await act(async () => void toast.info("a"));
    await act(async () => void toast.warning("b"));
    await act(async () => toasts()[0].click());
    await act(async () => void vi.advanceTimersByTime(500));
    expect(texts()).toEqual(["a"]);
    await act(async () => toasts()[0].querySelector("button")!.click());
    await act(async () => void vi.advanceTimersByTime(500));
    expect(toasts()).toHaveLength(0);
  });

  it("puts the newest on top and keeps at most four, queueing the rest", async () => {
    for (const m of ["1", "2", "3", "4", "5", "6"]) await act(async () => void toast.success(m));
    expect(texts()).toEqual(["4", "3", "2", "1"]);
    expect(toasts()).toHaveLength(TOAST_LIMIT);
    // The four leave together after 3 s + exit; the queued two come in on top.
    await act(async () => void vi.advanceTimersByTime(TOAST_AUTO_CLOSE_MS + 500));
    expect(texts()).toEqual(["6", "5"]);
  });

  it("can be told to stay, to drop its icon, and to go away by id", async () => {
    const id = toast.info("正在提領 $10.00…", { autoClose: false, icon: false });
    await act(async () => undefined);
    expect(toasts()[0].querySelector("svg")?.closest("button")).toBeTruthy(); // only the × has an svg
    expect(toasts()[0].querySelectorAll("svg")).toHaveLength(1);
    await act(async () => void vi.advanceTimersByTime(10_000));
    expect(toasts()).toHaveLength(1);
    await act(async () => toast.dismiss(id));
    await act(async () => void vi.advanceTimersByTime(500));
    expect(toasts()).toHaveLength(0);
  });

  it("is a no-op without a provider", () => {
    let outside: Toast | undefined;
    function Outside() {
      const current = useToast();
      useEffect(() => {
        outside = current;
      }, [current]);
      return null;
    }
    const container = document.createElement("div");
    const r = createRoot(container);
    act(() => r.render(<Outside />));
    expect(outside!.success("x")).toBe(0);
    act(() => r.unmount());
  });
});
