import { describe, expect, it } from "vitest";

import { ReconnectBackoff } from "../src/runtime/reconnect-backoff.js";

describe("LISTEN reconnects", () => {
  it("back off 1 s → 30 s while the database stays away, warn once, and start over once connected", () => {
    const backoff = new ReconnectBackoff();
    const waits = Array.from({ length: 8 }, () => backoff.failed());
    expect(waits.map((w) => w.delayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(waits.filter((w) => w.transition)).toHaveLength(1);
    expect(backoff.connected()).toBe(true);
    expect(backoff.connected()).toBe(false);
    expect(backoff.failed()).toEqual({ delayMs: 1000, transition: true });
  });
});
