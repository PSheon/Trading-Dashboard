import { describe, expect, it } from "vitest";

import { ReconnectBackoff } from "../src/runtime/reconnect-backoff.js";
import { expBackoff } from "../src/runtime/retry-policy.js";

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
describe("expBackoff", () => {
  it("is min(max, base * 2 ** n), as the inline copies wrote it", () => {
    for (const [base, max] of [[1000, 30_000], [3000, 60_000], [5000, 300_000], [250, 250], [1000, 0]])
      for (const n of [0, 1, 2, 3, 4, 5, 10, 16, 17, 64, 1100, 1e6])
        expect(expBackoff(base, max, n)).toBe(Math.min(max, base * 2 ** n));
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => expBackoff(1000, 30_000, n))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
  it("gives the trade feed the waits its own counter gave: 1 s → 30 s, reset on open", () => {
    // trade-feed.service.ts before: delay = min(30_000, 1000 * 2 ** attempt); attempt++; attempt = 0 on open.
    let attempt = 0;
    const old = () => Math.min(30_000, 1000 * 2 ** attempt++);
    const backoff = new ReconnectBackoff();
    for (let i = 0; i < 1100; i++) expect(backoff.failed().delayMs).toBe(old());
    attempt = 0; backoff.connected();
    for (let i = 0; i < 8; i++) expect(backoff.failed().delayMs).toBe(old());
  });
});
