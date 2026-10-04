import { act } from "react";
import { vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";

// Component tests used to "settle" with a fixed 10–30 ms sleep before asserting,
// which was not enough on CI's slower runners. settleQueries waits until React
// Query has nothing in flight, then gives React a short turn to commit.

/** A plain fixed wait inside act; under fake timers it advances them instead. */
export async function flush(ms = 20) {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
    else await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

export interface SettleOptions {
  /** The short commit wait after the client goes idle (default 20 ms). */
  ms?: number;
  /** Also wait for mutations (default true). Pass false while a test holds a mutation open on purpose. */
  mutations?: boolean;
  /** How long to wait for idle before failing (default 5000 ms). */
  timeout?: number;
}

/**
 * Waits until every query (and, unless told otherwise, every mutation) the
 * client started has answered, then lets React commit. A commit can start new
 * work (an enabled query, a mutation's follow-up), so it re-checks a few times.
 * Throws if the client is still busy after `timeout`, so a real hang is visible.
 * vi.waitFor advances fake timers by its interval on its own.
 */
export async function settleQueries(client: QueryClient, { ms = 20, mutations = true, timeout = 5000 }: SettleOptions = {}) {
  const busy = () => client.isFetching() + (mutations ? client.isMutating() : 0);
  for (let round = 0; round < 3; round++) {
    await act(async () => {
      await vi.waitFor(() => {
        const running = busy();
        if (running > 0) throw new Error(`${running} queries/mutations still running`);
      }, { timeout, interval: 10 });
    });
    await flush(ms);
    if (busy() === 0) return;
  }
}
