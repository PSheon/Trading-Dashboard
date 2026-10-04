// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { focusManager, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createSessionQueryClient } from "../src/lib/session-query-client";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", mode: "privy", identity: "a@example.com", wallet: null }) }));
// Every read answers 404: no retries (4xx is final for every policy) and
// no parsing to satisfy; a failed query is stale like an old one.
vi.mock("../src/lib/api", async (original) => {
  const actual = await original<typeof import("../src/lib/api")>();
  return { ...actual, api: { get: async (path: string) => { calls.push(path.split("?")[0]!); throw new actual.ApiError(404, "Not found"); } } };
});

const { usePortfolio, useTraderProfile, useTraderTransfers, useBoard } = await import("../src/lib/queries");
const { useWallet, useWalletHistory } = await import("../src/lib/wallet");
const { useCopyOverview, useCopyPortfolio } = await import("../src/lib/copy");
const { useCopyFunding } = await import("../src/lib/copy-funding");

const A = `0x${"ab".repeat(20)}`;
function Figures() {
  usePortfolio(A, "allTime", "perp");
  useTraderProfile(A);
  useTraderTransfers(A);
  useWallet();
  useWalletHistory();
  useCopyOverview();
  useCopyPortfolio();
  useCopyFunding();
  // A costly public list keeps the global default (no refetch on focus).
  useBoard({ market: "crypto", board: "top100", sort: "pnl", window: "all" });
  return null;
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  calls.length = 0;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); focusManager.setFocused(undefined); });

it("rereads the figures the user reads when a tab comes back after a while, and not the costly lists", async () => {
  const client = createSessionQueryClient();
  await act(async () => root.render(<QueryClientProvider client={client}><Figures /></QueryClientProvider>));
  await act(async () => { await vi.waitFor(() => { if (client.isFetching() > 0) throw new Error("fetching"); }); });
  const first = [...calls].sort();
  expect(first).toHaveLength(9);
  calls.length = 0;
  // Hours in a background tab: everything is stale.
  const later = Date.now() + 3 * 3_600_000;
  vi.spyOn(Date, "now").mockReturnValue(later);
  await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); });
  await act(async () => { await vi.waitFor(() => { if (client.isFetching() > 0) throw new Error("fetching"); }); });
  expect([...calls].sort()).toEqual([
    "/me/copy", "/me/copy/funding", "/me/copy/portfolio", "/me/wallet", "/me/wallet/history",
    `/traders/${A}`, `/traders/${A}/portfolio`, `/traders/${A}/transfers`,
  ].sort());
  client.clear();
});
