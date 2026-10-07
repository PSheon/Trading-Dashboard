// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyActivityItems } from "@/components/copy/copy-activity";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mergeCopyEvents, useCopyEvents } from "@/lib/copy";
import type { WireCopyEvents } from "@trading-dashboard/shared/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const state = vi.hoisted(() => ({ status: "signedIn", identity: "user-a", mode: "fixture", generation: "1", get: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => state }));
vi.mock("@/lib/api", () => ({ api: { get: state.get }, sessionKey: () => state.generation, apiErrorCode: () => undefined, isBusy: () => false }));
const event = (id: string): WireCopyEvents["items"][number] => ({ id, strategyId: 1, type: "order_filled", payload: { mode: "paper", coin: "BTC" }, createdAt: "2026-10-03T00:00:00.000Z" });
const page = (...ids: string[]): WireCopyEvents => ({ items: ids.map(event), nextCursor: ids.at(-1) ?? "0" });
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let latest: ReturnType<typeof useCopyEvents>;
let visibility = "visible";
function Probe() { const query = useCopyEvents(); useEffect(() => { latest = query; }, [query]); return <span>{query.data?.items.map((event) => event.id).join(",")}</span>; }
async function render() {
  await act(async () => { root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
beforeEach(() => {
  vi.useFakeTimers();
  state.status = "signedIn"; state.identity = "user-a"; state.generation = "1"; visibility = "visible"; state.get.mockReset();
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility as DocumentVisibilityState);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("dedupes replayed bigint event IDs, retains only 100 events and keeps a monotonic cursor", () => {
  const previous = page(...Array.from({ length: 100 }, (_, i) => String(BigInt("9007199254740992") + BigInt(i))));
  const newer = String(BigInt(previous.nextCursor) + BigInt(1));
  const merged = mergeCopyEvents(previous, page(previous.nextCursor, newer));
  expect(merged.items).toHaveLength(100);
  expect(merged.items.at(-1)?.id).toBe(newer);
  expect(mergeCopyEvents(merged, page(previous.nextCursor)).nextCursor).toBe(newer);
});

it("advances the cursor on bounded polling and dedupes reconnect replay", async () => {
  state.get.mockResolvedValueOnce(page("1", "2")).mockResolvedValueOnce(page("2", "3"));
  await render();
  expect(container.textContent).toBe("1,2");
  await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
  expect(state.get.mock.calls[1][0]).toBe("/me/copy/events?after=2&limit=100");
  expect(container.textContent).toBe("1,2,3");
});

it("cancels the active request when hidden and starts no hidden or signed-out polling", async () => {
  let signal: AbortSignal | undefined;
  state.get.mockImplementation((_url, requestSignal) => { signal = requestSignal; return new Promise(() => {}); });
  await render();
  expect(signal?.aborted).toBe(false);
  visibility = "hidden";
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(signal?.aborted).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
  expect(state.get).toHaveBeenCalledTimes(1);
  state.status = "signedOut";
  await render();
  visibility = "visible";
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(30_000); });
  expect(state.get).toHaveBeenCalledTimes(1);
  expect(latest.data).toBeUndefined();
});

it("starts from zero for another identity and does not show the previous owner’s events", async () => {
  state.get.mockResolvedValueOnce(page("91")).mockResolvedValueOnce(page("1"));
  await render();
  expect(container.textContent).toBe("91");
  state.identity = "user-b"; state.generation = "2";
  await render();
  expect(state.get.mock.calls[1][0]).toBe("/me/copy/events?after=0&limit=100");
  expect(container.textContent).toBe("1");
});

it("renders the owner’s confirmed event details and strategy link rather than leader activity", () => {
  const items = [{ ...event("1"), type: "funds_withdrawn", payload: { mode: "paper", amount: "125.50" } }, event("2")];
  const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><CopyActivityItems items={items} /></I18nProvider>);
  expect(html).toContain('data-slot="data-list"');
  expect(html).toContain("Funds withdrawn");
  expect(html).toContain("$125.50");
  expect(html).toContain("/portfolio?copy=1");
  expect(html).toContain("Order filled");
  expect(html).toContain("BTC");
  expect(html).not.toContain("leader");
});

it("loads older activity without moving the reconnect cursor backwards", async () => {
  state.get.mockResolvedValueOnce({ ...page("9999", "10000"), previousCursor: "9999", hasMore: true })
    .mockResolvedValueOnce({ ...page("9997", "9998"), previousCursor: "9997", hasMore: false })
    .mockResolvedValueOnce(page("10001"));
  await render();
  await act(async () => { latest.loadOlder(); await vi.advanceTimersByTimeAsync(0); });
  expect(state.get.mock.calls[1][0]).toBe("/me/copy/events?before=9999&limit=100");
  expect(container.textContent).toBe("9997,9998,9999,10000");
  expect(latest.data?.nextCursor).toBe("10000");
  await act(async () => { await latest.refetch(); await vi.advanceTimersByTimeAsync(0); });
  expect(state.get.mock.calls[2][0]).toBe("/me/copy/events?after=10000&limit=100");
  expect(container.textContent).toBe("9997,9998,9999,10000,10001");
});

it("drains missed event pages immediately on reconnect rather than one page per poll", async () => {
  state.get.mockResolvedValueOnce({ ...page("10000"), hasMore: true })
    .mockResolvedValueOnce({ ...page("10001"), hasMore: true })
    .mockResolvedValueOnce({ ...page("10002"), hasMore: false });
  await render();
  expect(state.get).toHaveBeenCalledTimes(1); // initial hasMore is older history
  await act(async () => { await latest.refetch(); await vi.advanceTimersByTimeAsync(0); });
  expect(state.get).toHaveBeenCalledTimes(3);
  expect(state.get.mock.calls[2][0]).toBe("/me/copy/events?after=10001&limit=100");
  expect(container.textContent).toBe("10000,10001,10002");
});

it("labels rejected and cancelled orders and never exposes unrecognized provider reasons", () => {
  const items: WireCopyEvents["items"] = [
    { ...event("90"), type: "order_rejected", payload: { orderId: "9007199254740993", reason: "no_price_before_submit" } },
    { ...event("91"), type: "order_cancelled", payload: { orderId: "92", reason: "provider: secret token" } },
    { ...event("92"), type: "strategy_command", payload: { command: "cancel_pending" } },
  ];
  const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><CopyActivityItems items={items} /></I18nProvider>);
  expect(html).toContain("Order rejected");
  expect(html).toContain("Order cancelled");
  expect(html).toContain("#9007199254740993");
  expect(html).toContain("No price available");
  expect(html).toContain("Cancel pending orders");
  expect(html).not.toContain("secret token");
});
