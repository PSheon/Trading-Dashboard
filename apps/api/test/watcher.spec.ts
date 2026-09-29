import { leaders } from "@trading-dashboard/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HlWsTrade } from "../src/hyperliquid/types.js";
import type { AccountStateService } from "../src/watcher/account-state.service.js";
import type { FillSyncService, SyncResult } from "../src/watcher/fill-sync.service.js";
import type { TradeFeedService } from "../src/watcher/trade-feed.service.js";
import { WatcherService } from "../src/watcher/watcher.service.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const T0 = 1_790_000_000_000;

function trade(tid: number, time: number, users: [string, string]): HlWsTrade {
  return { coin: "BTC", side: "B", px: "1", sz: "1", time, hash: "0x", tid, users };
}

const ok = (missing: bigint[] = []): SyncResult => ({ fetched: 1, inserted: 1, actions: 1, missingTids: missing });

describe("WatcherService", () => {
  const db = getTestDb();
  let sync: ReturnType<typeof vi.fn>;
  let feed: { setWatched: ReturnType<typeof vi.fn>; status: () => unknown; stop: () => void };
  let watcher: WatcherService;

  beforeEach(async () => {
    await truncateAll(db);
    sync = vi.fn(async () => ok());
    feed = { setWatched: vi.fn(), status: () => ({}), stop: () => {} };
    watcher = new WatcherService(
      feed as unknown as TradeFeedService,
      { sync, getLastFillAt: () => null } as unknown as FillSyncService,
      { getEquityUsd: () => null } as unknown as AccountStateService,
      db,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("gathers one address's trades for a second, then runs one live sync from just before the first", async () => {
    vi.useFakeTimers();
    watcher.onTrade("0xa", trade(11, T0 + 300, ["0xa", "0xz"]));
    watcher.onTrade("0xa", trade(10, T0, ["0xz", "0xa"]));
    watcher.onTrade("0xb", trade(12, T0 + 100, ["0xb", "0xz"]));
    expect(sync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenCalledWith("0xa", "live", T0 - 10_000, new Set([10n, 11n]));
    expect(sync).toHaveBeenCalledWith("0xb", "live", T0 + 100 - 10_000, new Set([12n]));
  });

  it("retries trades Hyperliquid hasn't returned yet, then gives up to the sweep", async () => {
    vi.useFakeTimers();
    sync.mockResolvedValue(ok([10n]));
    watcher.onTrade("0xa", trade(10, T0, ["0xa", "0xz"]));

    await vi.advanceTimersByTimeAsync(1000);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(15000);
    expect(sync).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sync).toHaveBeenCalledTimes(4);
    expect(sync.mock.calls[3][3]).toEqual(new Set([10n]));
  });

  it("retries after a sync error too", async () => {
    vi.useFakeTimers();
    sync.mockRejectedValueOnce(new Error("429")).mockResolvedValue(ok());
    watcher.onTrade("0xa", trade(10, T0, ["0xa", "0xz"]));
    await vi.advanceTimersByTimeAsync(1000 + 2000);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("watches only active leaders and sweeps each of them", async () => {
    await db.insert(leaders).values([
      { chain: "hyperliquid", address: "0xa", active: true, tier: "B" },
      { chain: "hyperliquid", address: "0xb", active: false, tier: "B" },
      { chain: "hyperliquid", address: "0xc", active: true, tier: "A" },
    ]);
    await watcher.refreshWatched();
    expect([...feed.setWatched.mock.calls[0][0]].sort()).toEqual(["0xa", "0xc"]);

    const result = await watcher.sweep(T0);
    expect(result).toEqual({ addresses: 2, inserted: 2, failed: 0 });
    expect(sync.mock.calls.map((c) => `${c[0]}:${c[1]}:${c[2]}`).sort()).toEqual([`0xa:sweep:${T0}`, `0xc:sweep:${T0}`]);
    expect(watcher.getHeartbeat().lastSweepAt).not.toBeNull();
  });
});
