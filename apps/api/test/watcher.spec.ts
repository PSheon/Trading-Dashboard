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

const ok = (missing: bigint[] = [], latestFillTime: number | null = null): SyncResult => ({
  fetched: 1,
  inserted: 1,
  actions: 1,
  missingTids: missing,
  latestFillTime,
});

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
    expect(sync).toHaveBeenCalledWith("0xa", "live", T0 - 10_000, new Set([10n, 11n]), 0);
    expect(sync).toHaveBeenCalledWith("0xb", "live", T0 + 100 - 10_000, new Set([12n]), 0);
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
    expect(watcher.getHeartbeat().fillsUnavailable).toMatchObject([{ address: "0xa", missedTrades: 1 }]);

    // Once a sync finds everything again, the address is off the list.
    sync.mockResolvedValue(ok());
    watcher.onTrade("0xa", trade(11, T0 + 90_000, ["0xa", "0xz"]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(watcher.getHeartbeat().fillsUnavailable).toEqual([]);
  });

  it("keeps at most one follow-up sync while an address trades continuously", async () => {
    vi.useFakeTimers();
    sync.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(ok()), 3000)));
    for (let i = 0; i < 15; i++) {
      watcher.onTrade("0xa", trade(100 + i, T0 + i * 200, ["0xa", "0xz"]));
      await vi.advanceTimersByTimeAsync(200);
    }
    // First sync started at 1 s and runs 3 s; everything after it waits for one follow-up.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sync).toHaveBeenCalledTimes(2);
    const followUp = sync.mock.calls[1][3] as Set<bigint>;
    expect(followUp.size).toBeGreaterThan(5);
  });

  it("ranks an address by when it was last served, and reads on from where the last sync stopped", async () => {
    vi.useFakeTimers({ now: T0 });
    sync.mockResolvedValue(ok([], T0 + 500));
    watcher.onTrade("0xa", trade(1, T0, ["0xa", "0xz"]));
    await vi.advanceTimersByTimeAsync(1000);
    watcher.onTrade("0xa", trade(2, T0 + 30_000, ["0xa", "0xz"]));
    await vi.advanceTimersByTimeAsync(1000);

    const [first, second] = sync.mock.calls;
    expect(first[4]).toBe(0); // never served: goes first
    expect(second[4]).toBe(T0 + 1000); // served at 1 s
    // 10 s lookback would reach T0+20s; what was already read ends at T0+500.
    expect(second[2]).toBe(T0 + 30_000 - 10_000);
    // A trade soon after what was read starts 1 s before the read-through
    // point (T0+500), not a full 10 s back.
    watcher.onTrade("0xa", trade(3, T0 + 1_200, ["0xa", "0xz"]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(sync.mock.calls[2][2]).toBe(T0 - 500);
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
