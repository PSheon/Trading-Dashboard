// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";
import { I18nProvider } from "@/i18n/provider";
import { zhTW } from "@/i18n/messages/zh-TW";
import { ApiError } from "@/lib/api";
import { useActionToast } from "@/lib/use-action-toast";
import { useToggleFavorite } from "@/lib/queries";
import { useSetFavoriteAlert } from "@/lib/alerts";

const state = vi.hoisted(() => ({ put: vi.fn(), del: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", mode: "privy", identity: "owner", login() {} }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/api", async () => ({ ...(await vi.importActual<typeof import("@/lib/api")>("@/lib/api")), api: { put: state.put, delete: state.del, patch: state.patch, get: vi.fn(), post: vi.fn() } }));

let root: Root, container: HTMLDivElement, client: QueryClient;
const probe: { track: ReturnType<typeof useActionToast> | null; favorite: ReturnType<typeof useToggleFavorite> | null; alert: ReturnType<typeof useSetFavoriteAlert> | null } = { track: null, favorite: null, alert: null };
function Probe() {
  const track = useActionToast(), favorite = useToggleFavorite(), alert = useSetFavoriteAlert();
  useLayoutEffect(() => { Object.assign(probe, { track, favorite, alert }); });
  return null;
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="zh-TW" messages={zhTW}><ToastProvider><Probe /></ToastProvider></I18nProvider></QueryClientProvider>));
});
afterEach(async () => { vi.useRealTimers(); await act(async () => root.unmount()); client.clear(); container.remove(); });
const toasts = () => [...document.querySelectorAll('[data-testid="toasts"] [role="alert"]')].map((el) => `${el.getAttribute("data-type")}:${el.textContent}`);

it("says an action that runs past a second is in progress, then replaces it with the outcome", async () => {
  vi.useFakeTimers();
  let finish!: (value: string) => void;
  const work = new Promise<string>((resolve) => { finish = resolve; });
  let done: Promise<string | undefined> | null = null;
  act(() => { done = probe.track!(work, { pending: "提領處理中…", success: "已送出提領 10 USDC" }); });
  await act(async () => { vi.advanceTimersByTime(900); });
  expect(toasts()).toEqual([]);
  await act(async () => { vi.advanceTimersByTime(200); });
  expect(toasts()).toEqual(["info:提領處理中…"]);
  await act(async () => { finish("ok"); await done; });
  await act(async () => { vi.advanceTimersByTime(600); });
  expect(toasts()).toEqual(["success:已送出提領 10 USDC"]);
});

it("a quick action shows only its outcome; a failure is said in words, never as a raw code or status", async () => {
  await act(async () => { await probe.track!(Promise.resolve(1), { success: "已暫停跟單" }); });
  expect(toasts()).toEqual(["success:已暫停跟單"]);
  await act(async () => { await probe.track!(Promise.reject(new ApiError(503, "Service Unavailable", { code: "upstream_unavailable" }))); });
  const failed = toasts().find((line) => line.startsWith("error:"))!;
  expect(failed).toBe(`error:${zhTW.common.errors.busy}`);
  expect(failed).not.toMatch(/503|Service Unavailable|upstream_unavailable/);
});

it("favorites and alerts confirm success with a toast", async () => {
  state.put.mockResolvedValue({});
  await act(async () => { probe.favorite!.toggle(`0x${"ab".repeat(20)}`, true); });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  expect(toasts()).toContain("success:已加入收藏");
  state.patch.mockResolvedValue({ address: `0x${"ab".repeat(20)}` });
  await act(async () => { await probe.alert!.mutateAsync({ address: `0x${"ab".repeat(20)}`, patch: { enabled: false } }); });
  expect(toasts()).toContain("success:提醒已關閉");
});
