import { leaders } from "@trading-dashboard/shared/database";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HlWsTrade } from "../src/hyperliquid/types.js";
import type { AccountStateService } from "../src/watcher/account-state.service.js";
import type { FeedActionsService } from "../src/watcher/feed-actions.service.js";
import type { FillSyncService, SyncResult } from "../src/watcher/fill-sync.service.js";
import type { TradeFeedService } from "../src/watcher/trade-feed.service.js";
import { CONFIRM_DELAY_MS, CONFIRM_MIN_INTERVAL_MS, WatcherService } from "../src/watcher/watcher.service.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const T0 = 1_790_000_000_000;

function trade(tid: number, time: number, users: [string, string]): HlWsTrade {
  return { coin: "BTC", side: "B", px: "1", sz: "1", time, hash: "0x", tid, users };
}

const ok = (missing: bigint[] = [], latestFillTime: number | null = null): SyncResult => ({
  fetched: 1,
  inserted: 1,
  actions: 0,
  missingTids: missing,
  latestFillTime,
});

describe("WatcherService", () => {
  const db = getTestDb();
  let sync: ReturnType<typeof vi.fn>;
  let fastPath: ReturnType<typeof vi.fn>;
  let dropBooks: ReturnType<typeof vi.fn>;
  let feed: { setWatched: ReturnType<typeof vi.fn>; status: () => unknown; stop: () => void };
  let watcher: WatcherService;

  const confirms = () => sync.mock.calls.filter((c) => c[1] === "confirm");

  beforeEach(async () => {
    await truncateAll(db);
    sync = vi.fn(async () => ok());
    fastPath = vi.fn(async () => 1);
    dropBooks = vi.fn();
    feed = { setWatched: vi.fn(), status: () => ({}), stop: () => {} };
    watcher = new WatcherService(
      feed as unknown as TradeFeedService,
      { sync, getLastFillAt: () => null, getFastPathStats: () => ({ verified: 0, corrected: 0 }) } as unknown as FillSyncService,
      { getEquityUsd: () => null, dropBooks } as unknown as AccountStateService,
      { process: fastPath } as unknown as FeedActionsService,
      db,
    );
  });

  afterEach(() => {
    watcher.stop();
    vi.useRealTimers();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("gathers one address's trades for a second, then runs the fast path once with them in feed order", async () => {
    vi.useFakeTimers();
    watcher.onTrade("0xa", trade(11, T0 + 300, ["0xa", "0xz"]));
    watcher.onTrade("0xa", trade(10, T0, ["0xz", "0xa"]));
    watcher.onTrade("0xa", trade(11, T0 + 300, ["0xa", "0xz"])); // replayed
    watcher.onTrade("0xb", trade(12, T0 + 100, ["0xb", "0xz"]));
    expect(fastPath).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(fastPath).toHaveBeenCalledTimes(2);
    const [address, trades, rank] = fastPath.mock.calls.find((c) => c[0] === "0xa")!;
    expect(address).toBe("0xa");
    expect((trades as HlWsTrade[]).map((t) => t.tid)).toEqual([11, 10]);
    expect(rank).toBe(0);
    // No fill query on the way to the alert.
    expect(sync).not.toHaveBeenCalled();
  });

  it("confirms in the background a moment later, from just before the first trade", async () => {
    vi.useFakeTimers();
    watcher.onTrade("0xa", trade(10, T0, ["0xa", "0xz"]));
    watcher.onTrade("0xa", trade(11, T0 + 300, ["0xa", "0xz"]));
    await vi.advanceTimersByTimeAsync(1000 + CONFIRM_DELAY_MS - 1);
    expect(confirms()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledWith("0xa", "confirm", T0 - 10_000, expect.anything());
    expect(new Set(sync.mock.calls[0][3] as Iterable<bigint>)).toEqual(new Set([10n, 11n]));
    // Background lane: no live rank is passed.
    expect(sync.mock.calls[0]).toHaveLength(4);
  });

  it("confirms an address that trades every second at most once per 15 s, covering every trade", async () => {
    vi.useFakeTimers({ now: T0 });
    const seen = new Set<bigint>();
    sync.mockImplementation(async (_a: string, _r: string, _s: number, tids: Iterable<bigint>) => {
      for (const tid of tids) seen.add(tid);
      return ok();
    });
    for (let i = 0; i < 60; i++) {
      watcher.onTrade("0xa", trade(100 + i, T0 + i * 1000, ["0xa", "0xz"]));
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.advanceTimersByTimeAsync(30_000);

    // One fast-path run per second (each alert is immediate)...
    expect(fastPath.mock.calls.length).toBeGreaterThanOrEqual(55);
    // ...but a confirm only every 15 s.
    expect(confirms().length).toBeLessThanOrEqual(Math.ceil(90_000 / CONFIRM_MIN_INTERVAL_MS));
    expect(confirms().length).toBeGreaterThanOrEqual(4);
    expect(seen.size).toBe(60);
  });

  it("starts confirms of one address at least 15 s apart", async () => {
    vi.useFakeTimers({ now: T0 });
    const at: number[] = [];
    sync.mockImplementation(async () => {
      at.push(Date.now());
      return ok();
    });
    watcher.onTrade("0xa", trade(1, T0, ["0xa", "0xz"]));
    await vi.advanceTimersByTimeAsync(4000);
    watcher.onTrade("0xa", trade(2, T0 + 4000, ["0xa", "0xz"]));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(at).toEqual([T0 + 3000, T0 + 18_000]);
  });

  it("looks again for fills Hyperliquid hasn't returned (5/15/60 s, but ≥15 s apart), then lists the address", async () => {
    vi.useFakeTimers({ now: T0 });
    const at: number[] = [];
    sync.mockImplementation(async () => {
      at.push(Date.now() - T0);
      return ok([10n]);
    });
    watcher.onTrade("0xa", trade(10, T0, ["0xa", "0xz"]));
    await vi.advanceTimersByTimeAsync(200_000);
    // First at 3 s; retries 5 s (→ the 15 s floor), 15 s and 60 s later.
    const expected = [3000, 18_000, 33_000, 93_000];
    expect(at).toHaveLength(expected.length);
    at.forEach((t, i) => expect(Math.abs(t - expected[i])).toBeLessThan(10));
    expect(watcher.getHeartbeat().fillsUnavailable).toMatchObject([{ address: "0xa", missedTrades: 1 }]);

    // Once a confirm finds everything again, the address is off the list.
    sync.mockResolvedValue(ok());
    watcher.onTrade("0xa", trade(11, T0 + 200_000, ["0xa", "0xz"]));
    await vi.advanceTimersByTimeAsync(5000);
    expect(watcher.getHeartbeat().fillsUnavailable).toEqual([]);
  });

  it("still confirms (and so stores and alerts on) trades whose fast path failed", async () => {
    vi.useFakeTimers();
    fastPath.mockRejectedValueOnce(new Error("Hyperliquid info request failed: 429"));
    watcher.onTrade("0xa", trade(10, T0, ["0xa", "0xz"]));
    await vi.advanceTimersByTimeAsync(1000 + CONFIRM_DELAY_MS);
    expect(confirms()).toHaveLength(1);
  });

  it("retries a confirm that failed", async () => {
    vi.useFakeTimers();
    sync.mockRejectedValueOnce(new Error("429")).mockResolvedValue(ok());
    watcher.onTrade("0xa", trade(10, T0, ["0xa", "0xz"]));
    await vi.advanceTimersByTimeAsync(1000 + CONFIRM_DELAY_MS + CONFIRM_MIN_INTERVAL_MS);
    expect(confirms()).toHaveLength(2);
  });

  it("ranks an address by when its fast path was last served, and confirms read on from where the last stopped", async () => {
    vi.useFakeTimers({ now: T0 });
    sync.mockResolvedValue(ok([], T0 + 500));
    watcher.onTrade("0xa", trade(1, T0, ["0xa", "0xz"]));
    await vi.advanceTimersByTimeAsync(6000); // fast path at 1 s, confirm at 3 s
    watcher.onTrade("0xa", trade(2, T0 + 30_000, ["0xa", "0xz"]));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fastPath.mock.calls[0][2]).toBe(0); // never served: goes first
    expect(fastPath.mock.calls[1][2]).toBe(T0 + 1000); // served at 1 s
    // 10 s lookback would reach T0+20s; what was already read ends at T0+500.
    expect(confirms()[1][2]).toBe(T0 + 30_000 - 10_000);
    // A trade soon after what was read starts 1 s before the read-through
    // point (T0+500), not a full 10 s back.
    watcher.onTrade("0xa", trade(3, T0 + 1_200, ["0xa", "0xz"]));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(confirms()[2][2]).toBe(T0 - 500);
  });

  it("drops the position books and sweeps after a feed gap", async () => {
    await db.insert(leaders).values([{ chain: "hyperliquid", address: "0xa", active: true, tier: "B" }]);
    watcher.onGap(T0);
    await vi.waitFor(() => expect(sync).toHaveBeenCalledWith("0xa", "sweep", T0 - 60_000));
    expect(dropBooks).toHaveBeenCalledTimes(1);
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
