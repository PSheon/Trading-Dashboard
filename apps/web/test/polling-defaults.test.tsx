// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createSessionQueryClient } from "../src/lib/session-query-client";

/**
 * Audit #8: the session client polled every query every 10 s by default, so
 * the header search, admin lists and local journals were re-read forever.
 * The default is off; the reads of live status opt in on their own.
 */
const calls = vi.hoisted(() => [] as string[]);
vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", mode: "privy", identity: "a@example.com", wallet: null }) }));
vi.mock("../src/lib/api", async (original) => {
  const actual = await original<typeof import("../src/lib/api")>();
  return { ...actual, sessionKey: () => "1", api: { get: async (path: string) => {
    calls.push(path.split("?")[0]!);
    return path.startsWith("/me/funds/history") ? { items: [], nextCursor: null } : path.startsWith("/discover/search") ? { traders: [] } : { items: [], accounts: [], authorizations: [] };
  } } };
});

const { useDiscoverSearch } = await import("../src/lib/queries");
const { useFundsHistory } = await import("../src/lib/funds");
const { useWalletHistory } = await import("../src/lib/wallet");
const { useExecutionWallets } = await import("../src/lib/copy-execution-wallets");

function Reads() {
  useDiscoverSearch("btc");
  useFundsHistory();
  useWalletHistory();
  useExecutionWallets();
  return null;
}

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  calls.length = 0;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

it("polls nothing by default", () => {
  expect(createSessionQueryClient().getDefaultOptions().queries?.refetchInterval).toBe(false);
});

it("re-reads live money status every 10 s and never the search", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const client = createSessionQueryClient();
  const settle = () => act(async () => { await vi.waitFor(() => { if (client.isFetching() > 0) throw new Error("fetching"); }); });
  await act(async () => root.render(<QueryClientProvider client={client}><Reads /></QueryClientProvider>));
  await settle();
  expect([...calls].sort()).toEqual(["/discover/search", "/me/copy/execution-wallets", "/me/funds/history", "/me/wallet/history"]);
  calls.length = 0;
  await act(async () => { vi.advanceTimersByTime(10_000); });
  await settle();
  expect([...calls].sort()).toEqual(["/me/copy/execution-wallets", "/me/funds/history", "/me/wallet/history"]);
  client.clear();
});
