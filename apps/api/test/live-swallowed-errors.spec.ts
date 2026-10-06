import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HyperliquidLiveAccountObserver } from "../src/copy/live/live-account-observer.js";
import { PerReadAllDexsAccountSource, type LiveAllDexsAccountSource } from "../src/copy/live/live-account-ws-source.js";
import { LiveBoundaryError } from "../src/copy/live/wallet-authorization.js";

afterEach(() => vi.restoreAllMocks());

describe("the order path's swallowed errors are logged, their outcome unchanged", () => {
  it("an observation that fails unexpectedly is still live_account_observation_unavailable, and the log says what it was", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const observer = new HyperliquidLiveAccountObserver("testnet", async () => { throw new TypeError("secret provider text"); }, vi.fn(), Date.now, 5000,
      { read: vi.fn() } as unknown as LiveAllDexsAccountSource);
    const error = await observer.observe(`0x${"11".repeat(20)}`).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LiveBoundaryError);
    expect((error as LiveBoundaryError).code).toBe("live_account_observation_unavailable");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^observation unavailable: TypeError/));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret provider text");
  });

  it("a per-read socket that fails to close still returns the read, and the log says why", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const evidence = { network: "testnet" as const, accountAddress: "0x", observedAt: 1, data: {} };
    const source = new PerReadAllDexsAccountSource(() => ({ read: async () => evidence, close: async () => { throw new LiveBoundaryError("hyperliquid_quota_lease_lost"); } }));
    await expect(source.read(`0x${"11".repeat(20)}`, 5000)).resolves.toEqual(evidence);
    expect(warn).toHaveBeenCalledWith("account socket not closed cleanly: hyperliquid_quota_lease_lost");
  });
});
