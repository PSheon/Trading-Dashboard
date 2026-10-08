// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActivityFeed } from "@/components/trader/live-feed";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
import type { TraderFill, TraderTransfersResponse } from "@/lib/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const reads = vi.hoisted(() => ({
  fills: { data: undefined as TraderFill[] | undefined, isError: false, isFetching: false, refetch: vi.fn() },
  transfers: { data: undefined as TraderTransfersResponse | undefined, isError: false, isFetching: false, refetch: vi.fn() },
}));
// Only the external reads are substituted; event merging, rows and controls are real.
vi.mock("@/lib/queries", () => ({ useTraderFills: () => reads.fills, useTraderTransfers: () => reads.transfers }));
let root: Root, el: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  reads.fills = { data: [], isError: false, isFetching: false, refetch: vi.fn() };
  reads.transfers = { data: undefined, isError: false, isFetching: false, refetch: vi.fn() };
  el = document.createElement("div"); document.body.append(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); });
const render = () => act(async () => root.render(<I18nProvider locale="en" messages={en}><ActivityFeed address="0xabc" /></I18nProvider>));
const emptyTransfers: TraderTransfersResponse = { transfers: [], truncated: false, from: "2026-07-11T00:00:00Z", fetchedAt: "2026-10-09T00:00:00Z" };
const fill: TraderFill = { tid: "1", coin: "ETH", side: "buy", dir: "Open Long", px: 2500, sz: 1, notionalUsd: 2500, closedPnl: 0, fee: 0.1, ts: "2026-10-09T00:00:00Z" };

it("waits for transfers before declaring an empty combined feed", async () => {
  await render();
  expect(el.querySelector('[role="status"][aria-label="Loading…"]')).not.toBeNull();
  expect(el.textContent).not.toContain("No recent activity");
  reads.transfers.data = emptyTransfers;
  await render();
  expect(el.textContent).toContain("No recent activity");
});

it("offers recovery for failed transfers rather than declaring no activity", async () => {
  reads.transfers.isError = true;
  await render();
  expect(el.textContent).not.toContain("No recent activity");
  const retry = Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === "Retry");
  expect(retry).toBeDefined();
  await act(async () => retry!.click());
  expect(reads.transfers.refetch).toHaveBeenCalledOnce();
  expect(reads.fills.refetch).not.toHaveBeenCalled();
});

it("preserves known fills and discloses a transfer failure with a retry", async () => {
  reads.fills.data = [fill]; reads.transfers.isError = true;
  await render();
  expect(el.querySelectorAll("li")).toHaveLength(1);
  expect(el.textContent).toContain("ETH Long Opened");
  expect(el.querySelector('[role="status"]')?.textContent).toContain("Some activity could not be loaded");
  expect(el.textContent).toContain("Retry");
  expect(el.textContent).not.toContain("Live");
});

it("marks a failed transfer refresh as partial even with a cached empty read", async () => {
  reads.transfers.data = emptyTransfers; reads.transfers.isError = true;
  reads.fills.data = [fill];
  await render();
  expect(el.querySelectorAll("li")).toHaveLength(1);
  expect(el.querySelector('[role="status"]')?.textContent).toContain("Some activity could not be loaded");
});

it("preserves known transfers when fills fail and retries the failed source", async () => {
  reads.fills.data = undefined; reads.fills.isError = true;
  reads.transfers.data = { ...emptyTransfers, transfers: [{ time: "2026-10-09T00:00:00Z", hash: "0x123", kind: "deposit", direction: "in", token: "USDC", amount: 50, usd: true, from: null, to: "0xabc" }] };
  await render();
  expect(el.querySelectorAll("li")).toHaveLength(1);
  expect(el.textContent).toContain("USDC Deposited");
  expect(el.querySelector('[role="status"]')?.textContent).toContain("Some activity could not be loaded");
  const retry = Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === "Retry");
  await act(async () => retry!.click());
  expect(reads.fills.refetch).toHaveBeenCalledOnce();
  expect(reads.transfers.refetch).not.toHaveBeenCalled();
});

it("handles fills failing independently, retrying both sources only when both failed", async () => {
  reads.fills.data = undefined; reads.fills.isError = true; reads.transfers.isError = true;
  await render();
  const retry = Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === "Retry");
  expect(retry).toBeDefined();
  await act(async () => retry!.click());
  expect(reads.fills.refetch).toHaveBeenCalledOnce();
  expect(reads.transfers.refetch).toHaveBeenCalledOnce();
});
