// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { useTraderTrades } from "../src/lib/queries";
import { fixtureTradePage } from "../src/fixtures/trades";
const upstream = vi.hoisted(() => ({ funding: null as number | null }));
vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ status: "signedOut" }) }));
vi.mock("../src/lib/api", () => ({ isBusy: () => false, api: { get: async () => {
  const page = fixtureTradePage(`0x${"ab".repeat(20)}`, "closed", 1, undefined);
  page.items[0].funding = upstream.funding;
  return JSON.parse(JSON.stringify(page));
} } }));
function Ledger() {
  const query = useTraderTrades(`0x${"ab".repeat(20)}`, "closed");
  return <div>{query.data?.pages[0].items[0]?.funding ?? "pending"}</div>;
}
it("refreshes a mounted ledger after background funding becomes available", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const container = document.createElement("div");
  const root = createRoot(container);
  const flush = () => new Promise(resolve => setTimeout(resolve, 20));
  // Wait until the ledger read has answered, then let React commit. (setTimeout is
  // real here, so this does not use the fake-timer-aware settle helper.)
  const settle = async () => {
    await act(async () => { await vi.waitFor(() => { if (client.isFetching() > 0) throw new Error("still fetching"); }, { timeout: 5000, interval: 10 }); });
    await act(flush);
  };
  upstream.funding = null;
  try {
    await act(async () => { root.render(<QueryClientProvider client={client}><Ledger /></QueryClientProvider>); });
    await settle();
    expect(container.textContent).toBe("pending");
    upstream.funding = -0.75;
    await act(async () => { vi.advanceTimersByTime(120000); await flush(); });
    await settle();
    expect(container.textContent).toBe("-0.75");
  } finally { await act(async () => root.unmount()); client.clear(); vi.useRealTimers(); }
});
