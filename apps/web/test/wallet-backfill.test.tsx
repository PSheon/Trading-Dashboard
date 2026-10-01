// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryKeys } from "../src/lib/query-keys";
import { useWalletBackfill, WALLET_BACKFILL_RETRY_MS } from "../src/lib/use-wallet-backfill";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ address }: { address: string | null }) {
  useWalletBackfill(address);
  return null;
}

let root: Root;
let client: QueryClient;
let invalidate: ReturnType<typeof vi.spyOn>;
const keys = () => invalidate.mock.calls.map((c: unknown[]) => (c[0] as { queryKey: readonly string[] }).queryKey.join("."));

async function render(address: string | null) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe address={address} />
      </QueryClientProvider>,
    ),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient();
  invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("useWalletBackfill: the api learns a freshly created embedded wallet", () => {
  it("does nothing while there is no address", async () => {
    await render(null);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("refetches /me/wallet and /me when the address appears, and again after the api's retry window", async () => {
    await render(null);
    await render("0x" + "ab".repeat(20));
    expect(keys()).toEqual([queryKeys.wallet.all.join("."), queryKeys.me.join(".")]);
    await act(async () => void vi.advanceTimersByTime(WALLET_BACKFILL_RETRY_MS - 1));
    expect(invalidate).toHaveBeenCalledTimes(2);
    await act(async () => void vi.advanceTimersByTime(1));
    expect(invalidate).toHaveBeenCalledTimes(4);
    expect(keys().slice(2)).toEqual([queryKeys.wallet.all.join("."), queryKeys.me.join(".")]);
  });

  it("runs once per address, not on every render", async () => {
    const address = "0x" + "cd".repeat(20);
    await render(address);
    await render(address);
    await act(async () => void vi.advanceTimersByTime(WALLET_BACKFILL_RETRY_MS));
    expect(invalidate).toHaveBeenCalledTimes(4);
  });
});
