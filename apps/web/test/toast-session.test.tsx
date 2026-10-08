// @vitest-environment happy-dom
import { act, StrictMode, useEffect, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppProviders } from "@/components/app-providers";
import { ToastProvider, ToastSessionBoundary, useToast, type Toast } from "@/components/ui/toast";
import { I18nProvider } from "@/i18n/provider";
import { useActionToast } from "@/lib/use-action-toast";
import { useAuth } from "@/lib/auth";
import { api, sessionKey } from "@/lib/api";
import { writeLocalStorage } from "@/lib/use-local-storage";
import { zhTW } from "@/i18n/messages/zh-TW";

vi.hoisted(() => { process.env.NEXT_PUBLIC_API_FIXTURES = "1"; });
vi.mock("@/lib/config", async () => ({ ...(await vi.importActual<typeof import("@/lib/config")>("@/lib/config")), PRIVY_APP_ID: "", API_FIXTURES: true }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, replace() {}, push() {} }), usePathname: () => "/zh-TW", useSearchParams: () => new URLSearchParams() }));
let root: Root, container: HTMLDivElement;
let toast: Toast, track: ReturnType<typeof useActionToast>, auth: ReturnType<typeof useAuth>;
function Probe() {
  const notice = useToast(), action = useActionToast(), currentAuth = useAuth();
  useLayoutEffect(() => { toast = notice; track = action; auth = currentAuth; });
  return null;
}
const texts = () => [...document.querySelectorAll('[data-testid="toasts"] [role="status"]')].map((node) => node.textContent);
async function flush(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function switchOwner(owner: "1" | "2" | null) {
  await act(async () => writeLocalStorage("fixture-signed-in", owner));
  await flush(32); await flush(250);
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  vi.spyOn(api, "get").mockResolvedValue({ id: 1, locale: "zh-TW" });
  localStorage.setItem("fixture-signed-in", "1");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<StrictMode><AppProviders locale="zh-TW" messages={zhTW}><Probe /></AppProviders></StrictMode>));
  await flush();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("uses the real fixture identity generation to clear old active/queued notices and suppress late pending results", async () => {
  const originalKey = sessionKey(), oldToast = toast;
  expect(auth.identity).toBe("demo@example.com");
  await act(async () => { for (const line of ["A1", "A2", "A3", "A4", "A queued"]) toast.info(line, { autoClose: false }); });
  let resolve!: (value: number) => void;
  const work = new Promise<number>((done) => { resolve = done; });
  let tracked!: Promise<number | undefined>;
  await act(async () => { tracked = track(work, { pending: "A pending", success: "A outcome" }); });
  await switchOwner("2");
  expect(sessionKey()).not.toBe(originalKey);
  expect(auth.identity).toBe("second@example.com");
  await act(async () => void toast.success("B notice", { autoClose: false })); await flush();
  await flush(1200);
  await act(async () => { resolve(1); await tracked; oldToast.dismiss(); }); await flush();
  expect(texts()).toEqual(["B notice"]);
  await flush(4000);
  expect(texts()).toEqual(["B notice"]);
});

it("removes the previous identity's message and live status immediately without waiting for animation frames", async () => {
  await act(async () => void toast.info("A private notification", { autoClose: false }));
  await flush();
  expect(texts()).toEqual(["A private notification"]);
  await act(async () => writeLocalStorage("fixture-signed-in", "2"));
  expect(auth.identity).toBe("second@example.com");
  expect(texts()).toEqual([]);
  expect(document.body.textContent).not.toContain("A private notification");
});

it("keeps a once-only session notification visible through StrictMode scope replay", async () => {
  function NotifyOnce() {
    const current = useToast(), sent = useRef(false);
    useEffect(() => {
      if (!sent.current) { sent.current = true; current.info("目前身份的通知", { autoClose: false }); }
    }, [current]);
    return null;
  }
  await act(async () => root.render(<StrictMode><AppProviders key="new-session-tree" locale="zh-TW" messages={zhTW}><NotifyOnce /></AppProviders></StrictMode>));
  await flush();
  expect(texts()).toEqual(["目前身份的通知"]);
  await flush(32); await flush(250);
  expect(texts()).toEqual(["目前身份的通知"]);
});

it("clears an already visible pending notice and suppresses rejection after logout and re-login", async () => {
  let reject!: (error: Error) => void;
  const work = new Promise<number>((_, fail) => { reject = fail; });
  let tracked!: Promise<number | undefined>;
  await act(async () => { tracked = track(work, { pending: "A pending", error: () => "A failed" }); });
  await flush(1100); await flush();
  expect(texts()).toEqual(["A pending"]);
  const originalKey = sessionKey();
  await act(async () => { await auth.logout(); }); await flush(32); await flush(250);
  expect(auth.status).toBe("signedOut");
  await switchOwner("1");
  expect(sessionKey()).not.toBe(originalKey);
  await act(async () => void toast.success("New A notice", { autoClose: false })); await flush();
  await act(async () => { reject(new Error("old request")); await tracked; }); await flush();
  expect(texts()).toEqual(["New A notice"]);
});

it("keeps system notifications on the same renderer while retiring only the previous session", async () => {
  let system!: Toast;
  function SystemProbe() {
    const current = useToast();
    useLayoutEffect(() => { system = current; });
    return null;
  }
  const render = async (scope: string) => act(async () => root.render(<StrictMode><I18nProvider locale="zh-TW" messages={zhTW}><ToastProvider>
    <SystemProbe /><ToastSessionBoundary key={scope}><Probe /></ToastSessionBoundary>
  </ToastProvider></I18nProvider></StrictMode>));
  await render("A");
  const previous = toast;
  let systemId = 0;
  await act(async () => { systemId = system.info("登入服務暫時無法使用", { autoClose: false }); toast.info("A notice", { autoClose: false }); });
  await flush();
  await render("B");
  expect(texts()).toEqual(["登入服務暫時無法使用"]);
  await flush(32); await flush(250);
  await act(async () => { previous.dismiss(); toast.dismiss(systemId); toast.info("B notice", { autoClose: false }); });
  await flush();
  expect(texts()).toEqual(["B notice", "登入服務暫時無法使用"]);
  expect(document.querySelectorAll('[data-testid="toasts"] section[aria-live="polite"]')).toHaveLength(1);
});
