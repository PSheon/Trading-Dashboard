import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HyperliquidLiveRiskProvider } from "../src/copy/live/live-risk-provider.js";
import { boundedLiveRead } from "../src/copy/live/live-market-resolver.js";

// The crash class (audit F3): `boundedLiveRead(acquire(w), remaining())` started
// the read, then `remaining()` threw because the evidence window had passed,
// so the helper was never entered and nobody handled the read's later
// rejection: Node ended the process (unhandledRejection).
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
beforeEach(() => { unhandled = []; process.on("unhandledRejection", onUnhandled); });
afterEach(() => { process.off("unhandledRejection", onUnhandled); });
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe("boundedLiveRead", () => {
  it("computes the timeout before starting the work: a timeout that throws starts nothing", async () => {
    const start = vi.fn(() => new Promise<never>((_, reject) => setTimeout(() => reject(new DOMException("aborted", "TimeoutError")), 10)));
    await expect(boundedLiveRead(start, () => { throw new Error("account_mode_evidence_stale"); })).rejects.toThrow("account_mode_evidence_stale");
    expect(start).not.toHaveBeenCalled();
    await settle();
    expect(unhandled).toEqual([]);
  });

  it("a read that loses to the deadline and rejects afterwards is handled", async () => {
    const late = () => new Promise<never>((_, reject) => setTimeout(() => reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")), 30));
    await expect(boundedLiveRead(late, 5)).rejects.toThrow("live_read_deadline_exceeded");
    await settle();
    expect(unhandled).toEqual([]);
  });

  it("answers with the read when it is in time and passes its own error through, synchronous throws included", async () => {
    await expect(boundedLiveRead(() => Promise.resolve(7), 50)).resolves.toBe(7);
    await expect(boundedLiveRead(() => Promise.reject(new Error("refused")), () => 50)).rejects.toThrow("refused");
    await expect(boundedLiveRead(() => { throw new Error("sync"); }, 50)).rejects.toThrow("sync");
  });

  it("a call site whose evidence window closes while a response is in flight leaves no orphaned body read", async () => {
    // The risk provider (audit F3, widest window): its fetch answers just after
    // the market evidence turned 5 s old. The body read must not be started:
    // its stream fails later, and nobody would be waiting for it.
    let clock = 1_800_000_000_000;
    const market = { network: "testnet" as const, coin: "BTC", dex: "", asset: 0, universeIndex: 0, perpDexIndex: 0, sizeDecimals: 5, maxLeverage: 50, observedAt: clock - 4_990 };
    const pulls = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      clock += 20;
      const body = new ReadableStream<Uint8Array>({ pull: (controller) => { pulls(); return new Promise<void>((resolve) => setTimeout(() => { controller.error(new DOMException("aborted", "AbortError")); resolve(); }, 10)); } }, { highWaterMark: 0 });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    });
    const provider = new HyperliquidLiveRiskProvider("testnet", async () => undefined, fetcher, () => clock);
    await expect(provider.observe(`0x${"22".repeat(20)}`, market, { extraRiskBufferBps: "0", restingOrderBuilderFeeCapTenthsBps: 0 })).rejects.toThrow();
    await settle();
    expect(fetcher).toHaveBeenCalled();
    expect(pulls).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });
});
