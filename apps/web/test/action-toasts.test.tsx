// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";
import { I18nProvider } from "@/i18n/provider";
import { zhTW } from "@/i18n/messages/zh-TW";
import { ApiError } from "@/lib/api";
import { useActionToast, useSaveToast } from "@/lib/use-action-toast";
import { useToggleFavorite } from "@/lib/queries";
import { useSetFavoriteAlert } from "@/lib/alerts";

const state = vi.hoisted(() => ({ put: vi.fn(), del: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", mode: "privy", identity: "owner", login() {} }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/api", async () => ({ ...(await vi.importActual<typeof import("@/lib/api")>("@/lib/api")), api: { put: state.put, delete: state.del, patch: state.patch, get: vi.fn(), post: vi.fn() } }));

let root: Root, container: HTMLDivElement, client: QueryClient;
const probe: { track: ReturnType<typeof useActionToast> | null; saved: ReturnType<typeof useSaveToast> | null; favorite: ReturnType<typeof useToggleFavorite> | null; alert: ReturnType<typeof useSetFavoriteAlert> | null } = { track: null, saved: null, favorite: null, alert: null };
function Probe() {
  const track = useActionToast(), saved = useSaveToast(), favorite = useToggleFavorite(), alert = useSetFavoriteAlert();
  useLayoutEffect(() => { Object.assign(probe, { track, saved, favorite, alert }); });
  return null;
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="zh-TW" messages={zhTW}><ToastProvider><Probe /></ToastProvider></I18nProvider></QueryClientProvider>));
});
afterEach(async () => { vi.useRealTimers(); await act(async () => root.unmount()); client.clear(); container.remove(); });
// Sonner schedules publication outside the action's React batch.
async function flushNotifications() {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
const toasts = () => [...document.querySelectorAll('[data-testid="toasts"] [role="status"], [data-testid="toasts"] [role="alert"]')].map((el) => `${el.getAttribute("data-type")}:${el.textContent}`);

it("lets inline errors own save failures while preserving callbacks and success notifications", async () => {
  const error = new ApiError(409, "Conflict");
  let observed: unknown;
  const options = probe.saved!({ error: false, onError: (failure) => { observed = failure; } });
  await act(async () => options.onError(error));
  await flushNotifications();
  expect(observed).toBe(error);
  expect(toasts()).toEqual([]);
  await act(async () => options.onSuccess({}));
  await flushNotifications();
  expect(toasts()).toEqual(["success:已儲存"]);
});

it.each(["success", "error"] as const)("dismisses a visible pending notice when the %s formatter throws without inventing another action outcome", async (kind) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  let resolve!: (value: number) => void;
  let reject!: (error: Error) => void;
  const work = new Promise<number>((done, fail) => { resolve = done; reject = fail; });
  const formatterError = new Error("notification formatting failed");
  const format = () => { throw formatterError; };
  let tracked!: Promise<number | undefined>;
  await act(async () => { tracked = probe.track!(work, { pending: "處理中", success: kind === "success" ? format : undefined, error: kind === "error" ? format : undefined }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
  await flushNotifications();
  expect(toasts()).toEqual(["info:處理中"]);
  const failed = expect(tracked).rejects.toBe(formatterError);
  await act(async () => { if (kind === "success") resolve(7); else reject(new Error("operation failed")); await failed; });
  await act(async () => { await vi.advanceTimersByTimeAsync(32); });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(toasts()).toEqual([]);
});

it("says an action that runs past a second is in progress, then replaces it with the outcome", async () => {
  vi.useFakeTimers();
  let finish!: (value: string) => void;
  const work = new Promise<string>((resolve) => { finish = resolve; });
  let done: Promise<string | undefined> | null = null;
  act(() => { done = probe.track!(work, { pending: "提領處理中…", success: "已送出提領 10 USDC" }); });
  await act(async () => { vi.advanceTimersByTime(900); });
  await flushNotifications();
  expect(toasts()).toEqual([]);
  await act(async () => { vi.advanceTimersByTime(200); });
  await flushNotifications();
  expect(toasts()).toEqual(["info:提領處理中…"]);
  await act(async () => { finish("ok"); await done; });
  // Settling changes the same notification immediately; the stale pending
  // message must not overlap with the confirmed outcome during an exit.
  await flushNotifications();
  expect(toasts()).toEqual(["success:已送出提領 10 USDC"]);
  await act(async () => { vi.advanceTimersByTime(600); });
  await flushNotifications();
  expect(toasts()).toEqual(["success:已送出提領 10 USDC"]);
});

it("a quick action shows only its outcome; a failure is said in words, never as a raw code or status", async () => {
  await act(async () => { await probe.track!(Promise.resolve(1), { success: "已暫停跟單" }); });
  await flushNotifications();
  expect(toasts()).toEqual(["success:已暫停跟單"]);
  await act(async () => { await probe.track!(Promise.reject(new ApiError(503, "Service Unavailable", { code: "upstream_unavailable" }))); });
  await flushNotifications();
  const failed = toasts().find((line) => line.startsWith("error:"))!;
  expect(failed).toBe(`error:${zhTW.common.errors.busy}`);
  expect(failed).not.toMatch(/503|Service Unavailable|upstream_unavailable/);
});

it("favorites and alerts confirm success with a toast", async () => {
  state.put.mockResolvedValue({});
  await act(async () => { probe.favorite!.toggle(`0x${"ab".repeat(20)}`, true); });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  await flushNotifications();
  expect(toasts()).toContain("success:已加入收藏");
  state.patch.mockResolvedValue({ address: `0x${"ab".repeat(20)}` });
  await act(async () => { await probe.alert!.mutateAsync({ address: `0x${"ab".repeat(20)}`, patch: { enabled: false } }); });
  await flushNotifications();
  expect(toasts()).toContain("success:提醒已關閉");
});
