// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActivityFeed } from "@/components/trader/live-feed";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import type { TraderFill, TraderTransfersResponse } from "@/lib/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
let root: Root, el: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  notifyManager.setNotifyFunction(callback => { act(callback); });
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  el = document.createElement("div"); document.body.append(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); el.remove(); vi.restoreAllMocks(); notifyManager.setNotifyFunction(callback => callback()); });
const transfers: TraderTransfersResponse = { transfers: [], truncated: false, from: "2026-07-11T00:00:00Z", fetchedAt: "2026-10-09T00:00:00Z" };
const fill: TraderFill = { tid: "1", coin: "ETH", side: "buy", dir: "Open Long", px: 2500, sz: 1, notionalUsd: 2500, closedPnl: 0, fee: 0.1, ts: "2026-10-09T00:00:00Z", twapId: null, startPosition: 0, liquidation: false };

it.each([true, false])("blocks another retry and shows Orbie busy feedback until a failed source finishes (known fills: %s)", async (knownFills) => {
  let transferCalls = 0;
  let finish!: (data: TraderTransfersResponse) => void;
  const pending = new Promise<TraderTransfersResponse>(resolve => { finish = resolve; });
  // Keep real query hooks and TanStack state transitions; replace only HTTP reads.
  vi.spyOn(api, "get").mockImplementation((async (path: string) => {
    if (path.endsWith("/transfers")) {
      if (++transferCalls === 1) throw Object.assign(new Error("unavailable"), { status: 400 });
      return pending;
    }
    return knownFills ? [fill] : [];
  }) as typeof api.get);
  await act(async () => root.render(<I18nProvider locale="en" messages={en}><QueryClientProvider client={client}><ActivityFeed address="0xabc" /></QueryClientProvider></I18nProvider>));
  let retry!: HTMLButtonElement;
  await vi.waitFor(async () => {
    await act(async () => {});
    retry = Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === "Retry")!;
    expect(retry).toBeDefined();
  });
  await act(async () => retry.click());
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(client.getQueryState(queryKeys.trader.transfers("0xabc"))?.fetchStatus).toBe("fetching");
    expect(retry.disabled).toBe(true);
    expect(retry.querySelector("[data-orbit-spinner]")).not.toBeNull();
  });
  await act(async () => retry.click());
  expect(transferCalls).toBe(2);
  expect(el.querySelectorAll("li")).toHaveLength(knownFills ? 1 : 0);
  await act(async () => finish(transfers));
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(el.textContent).not.toContain("Some activity could not be loaded");
  });
  expect(el.querySelectorAll("li")).toHaveLength(knownFills ? 1 : 0);
});
