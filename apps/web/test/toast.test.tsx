// @vitest-environment happy-dom
import { act, StrictMode, useEffect, useRef } from "react";
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
// Sonner schedules publication outside the action's React batch.
async function flushNotifications() {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
const toasts = () => [...document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"]')];
const texts = () => toasts().map((el) => el.textContent?.replace("關閉", "").trim());

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame", "cancelAnimationFrame"] });
  await mount();
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("Orbie notifications", () => {
  it("keeps a mount notification through StrictMode's effect replay", async () => {
    function NotifyOnce() {
      const current = useToast();
      const notified = useRef(false);
      useEffect(() => {
        if (!notified.current) { notified.current = true; current.success("已刪除帳號"); }
      }, [current]);
      return null;
    }
    await act(async () => root.render(<StrictMode><I18nProvider locale="zh-TW" messages={zhTW}><ToastProvider><NotifyOnce /></ToastProvider></I18nProvider></StrictMode>));
    await flushNotifications();
    await act(async () => void vi.advanceTimersByTime(32));
    await act(async () => void vi.advanceTimersByTime(500));
    expect(texts()).toEqual(["已刪除帳號"]);
  });
  it("updates a persistent notice in place and starts the outcome's expiry", async () => {
    let id = 0;
    await act(async () => { id = toast.info("處理中", { autoClose: false, icon: false }); });
    await flushNotifications();
    const original = toasts()[0].closest("[data-sonner-toast]");
    await act(async () => void vi.advanceTimersByTime(10_000));
    await act(async () => { expect(toast.success("已提交", { id })).toBe(id); });
    await flushNotifications();
    expect(texts()).toEqual(["已提交"]);
    expect(toasts()[0].closest("[data-sonner-toast]")).toBe(original);
    expect(toasts()[0].querySelectorAll("svg")).toHaveLength(2);
    await act(async () => void vi.advanceTimersByTime(TOAST_AUTO_CLOSE_MS));
    await act(async () => void vi.advanceTimersByTime(500));
    expect(toasts()).toHaveLength(0);
  });

  it("ignores handles from an unmounted provider and leaves a new provider's notice intact", async () => {
    const previous = toast;
    await act(async () => root.unmount());
    await mount();
    await act(async () => void toast.info("目前的通知", { autoClose: false }));
    await flushNotifications();
    await act(async () => { previous.dismiss(); expect(previous.success("上一個 provider 的結果")).toBe(0); });
    await flushNotifications();
    expect(texts()).toEqual(["目前的通知"]);
  });

  it("does not resurrect a dismissed pending toast when notification slots are full", async () => {
    for (const message of ["1", "2", "3", "4"]) await act(async () => void toast.success(message));
    let pendingId = 0;
    await act(async () => { pendingId = toast.info("仍在處理", { autoClose: false }); });
    await act(async () => toast.dismiss(pendingId));
    await act(async () => void vi.advanceTimersByTime(TOAST_AUTO_CLOSE_MS + 600));
    await flushNotifications();
    expect(texts()).not.toContain("仍在處理");
  });
  it("renders in a polite live region as status messages with a type icon and a close button", async () => {
    await act(async () => void toast.success("圖片已複製到剪貼簿"));
    const region = document.querySelector('section[aria-live="polite"]')!;
    expect(region.getAttribute("aria-label")).toBe("通知");
    await flushNotifications();
    const [el] = toasts();
    expect(el.dataset.type).toBe("success");
    expect(el.textContent).toContain("圖片已複製到剪貼簿");
    expect(el.querySelector("svg path")).toBeTruthy();
    expect(el.querySelector('button[aria-label="關閉"]')).toBeTruthy();
    expect(el.closest("[data-sonner-toast]")).toBeTruthy();
  });

  it("closes itself after 3 s, playing the exit animation first", async () => {
    await act(async () => void toast.error("無法複製圖片"));
    await act(async () => void vi.advanceTimersByTime(TOAST_AUTO_CLOSE_MS - 1));
    await flushNotifications();
    expect(toasts()).toHaveLength(1);
    await flushNotifications();
    expect(toasts()[0].closest("[data-sonner-toast]")?.getAttribute("data-removed")).toBe("false");
    await act(async () => void vi.advanceTimersByTime(1));
    await flushNotifications();
    expect(toasts()[0].closest("[data-sonner-toast]")?.getAttribute("data-removed")).toBe("true");
    await act(async () => void vi.advanceTimersByTime(32));
    await act(async () => void vi.advanceTimersByTime(500));
    await flushNotifications();
    expect(toasts()).toHaveLength(0);
  });

  it("closes on click anywhere on it, and on ×", async () => {
    await act(async () => void toast.info("a"));
    await act(async () => void toast.warning("b"));
    await flushNotifications();
    await act(async () => toasts()[0].click());
    await act(async () => void vi.advanceTimersByTime(32));
    await act(async () => void vi.advanceTimersByTime(500));
    await flushNotifications();
    expect(texts()).toEqual(["a"]);
    await flushNotifications();
    await act(async () => toasts()[0].querySelector("button")!.click());
    await act(async () => void vi.advanceTimersByTime(32));
    await act(async () => void vi.advanceTimersByTime(500));
    await flushNotifications();
    expect(toasts()).toHaveLength(0);
  });

  it("puts the newest on top and keeps at most four, queueing the rest", async () => {
    for (const m of ["1", "2", "3", "4", "5", "6"]) await act(async () => void toast.success(m));
    await flushNotifications();
    expect(texts()).toEqual(["4", "3", "2", "1"]);
    await flushNotifications();
    expect(toasts()).toHaveLength(TOAST_LIMIT);
    // The four leave together after 3 s + exit; the queued two come in on top.
    await act(async () => void vi.advanceTimersByTime(TOAST_AUTO_CLOSE_MS + 500));
    await flushNotifications();
    expect(texts()).toEqual(["6", "5"]);
  });

  it("can be told to stay, to drop its icon, and to go away by id", async () => {
    const id = toast.info("正在提領 $10.00…", { autoClose: false, icon: false });
    await act(async () => undefined);
    await flushNotifications();
    expect(toasts()[0].querySelector("svg")?.closest("button")).toBeTruthy(); // only the × has an svg
    await flushNotifications();
    expect(toasts()[0].querySelectorAll("svg")).toHaveLength(1);
    await act(async () => void vi.advanceTimersByTime(10_000));
    await flushNotifications();
    expect(toasts()).toHaveLength(1);
    await act(async () => toast.dismiss(id));
    await act(async () => void vi.advanceTimersByTime(32));
    await act(async () => void vi.advanceTimersByTime(500));
    await flushNotifications();
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
