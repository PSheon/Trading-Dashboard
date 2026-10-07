// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTradingMode } from "@/lib/site-mode";

const state = vi.hoisted(() => ({ identity: "alice", deployment: { available: true, network: "mainnet" } as { available: boolean; network: string } | null }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ identity: state.identity, status: "signedIn" }) }));
vi.mock("@/lib/copy-live-setup", () => ({ useLiveCopyDeployment: () => state.deployment }));
let client: QueryClient;
let root: Root, host: HTMLDivElement, selection: ReturnType<typeof useTradingMode>;
function Probe() { const value = useTradingMode(); useLayoutEffect(() => { selection = value; }); return <span>{value.mode}</span>; }
async function render() { await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>)); }
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); localStorage.clear(); client = new QueryClient(); state.identity = "alice"; state.deployment = { available: true, network: "mainnet" }; host = document.createElement("div"); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); localStorage.clear(); });
it("starts with virtual funds and permits only the configured execution network", async () => {
  await render(); expect(selection.mode).toBe("paper");
  await act(async () => { expect(selection.select("testnet")).toBe(false); });
  expect(selection.mode).toBe("paper");
  await act(async () => { expect(selection.select("live")).toBe(true); });
  expect(selection.mode).toBe("live");
  expect(localStorage.getItem("orbie:trading-mode:alice")).toBe("live");
});
it("separates users and retains a saved mode when capabilities are loading", async () => {
  localStorage.setItem("orbie:trading-mode:alice", "live"); state.deployment = null;
  await render(); expect(selection.mode).toBe("live"); expect(selection.available).toBe(false);
  state.identity = "bob"; await render(); expect(selection.mode).toBe("paper");
});
it("migrates the legacy actual preference to mainnet, rather than treating its testnet spelling as a destination", async () => {
  localStorage.setItem("orbie:copy-mode:alice", "testnet"); await render();
  expect(selection.mode).toBe("live");
  expect(localStorage.getItem("orbie:trading-mode:alice")).toBe("live");
});
it("does not fall through to real money when a saved testnet mode is unavailable", async () => {
  localStorage.setItem("orbie:trading-mode:alice", "testnet"); await render();
  expect(selection.mode).toBe("testnet"); expect(selection.available).toBe(false);
});

it("pins the current funds during a mutation, including another tab and legacy URL selectors", async () => {
  localStorage.setItem("orbie:trading-mode:alice", "live"); await render();
  let finish!: () => void;
  const mutation = client.getMutationCache().build(client, { mutationFn: () => new Promise<void>(resolve => { finish = resolve; }) });
  let operation!: Promise<void>;
  await act(async () => { operation = mutation.execute(undefined); await new Promise(resolve => setTimeout(resolve, 10)); });
  await act(async () => {
    localStorage.setItem("orbie:trading-mode:alice", "paper");
    window.dispatchEvent(new StorageEvent("storage", { key: "orbie:trading-mode:alice", newValue: "paper" }));
  });
  expect(selection.mode).toBe("live");
  await act(async () => { expect(selection.select("paper")).toBe(false); });
  await act(async () => { finish(); await operation; await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(selection.mode).toBe("paper");
});
it("keeps a shared in-memory choice when reading storage works but writes are denied", async () => {
  await render();
  const write = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new DOMException("Quota exceeded", "QuotaExceededError"); });
  await act(async () => { expect(selection.select("live")).toBe(true); });
  expect(write).toHaveBeenCalled();
  expect(selection.mode).toBe("live");
  write.mockRestore();
  await act(async () => { selection.select("paper"); });
});
