// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBridgeDeposit } from "@/lib/wallet";

/** Web audit M5: the deposit bridge's result belongs to the mutation, so a
 * dialog closed during Privy's transaction prompt still tells the user. */
const state = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", wallet: { address: `0x${"11".repeat(20)}`, sendTransaction: state.send } }) }));

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); client = new QueryClient(); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); });

it("a bridge that fails after its dialog closed still reports the failure", async () => {
  let fail!: (error: Error) => void;
  state.send.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
  const onError = vi.fn();
  const summary = { network: "testnet", address: `0x${"11".repeat(20)}`, arbitrum: { usdc: 20, eth: 1 } } as never;
  function Dialog() {
    const bridge = useBridgeDeposit({ onError });
    useEffect(() => { bridge.mutate({ summary, sponsor: false }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return null;
  }
  await act(async () => root.render(<QueryClientProvider client={client}><Dialog /></QueryClientProvider>));
  // The dialog closes during Privy's prompt.
  await act(async () => root.render(<QueryClientProvider client={client}>{null}</QueryClientProvider>));
  await act(async () => { fail(new Error("insufficient funds for gas")); await Promise.resolve(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(onError).toHaveBeenCalledTimes(1);
});
