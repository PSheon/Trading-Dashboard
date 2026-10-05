import { describe, expect, it } from "vitest";

import { boundedLiveRead } from "../src/copy/live/live-market-resolver.js";

describe("boundedLiveRead", () => {
  it("a read that loses to the deadline and rejects afterwards is handled, not an unhandled rejection that ends the process", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const late = new Promise<never>((_, reject) => setTimeout(() => reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")), 30));
      await expect(boundedLiveRead(late, 5)).rejects.toThrow("live_read_deadline_exceeded");
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("still answers with the read when it is in time, and passes its own error through", async () => {
    await expect(boundedLiveRead(Promise.resolve(7), 50)).resolves.toBe(7);
    await expect(boundedLiveRead(Promise.reject(new Error("refused")), 50)).rejects.toThrow("refused");
  });
});
