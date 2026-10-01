import { testConfig } from "./config-test-utils.js";
import { expect, it, vi } from "vitest";
import { SchedulerService } from "../src/scheduler/scheduler.service.js";
import type { WatcherService } from "../src/watcher/watcher.service.js";
import type { AccountStateService } from "../src/watcher/account-state.service.js";
import type { FillSyncService } from "../src/watcher/fill-sync.service.js";
import type { TradeFeedService } from "../src/watcher/trade-feed.service.js";
import type { NotifyService } from "../src/notify/notify.service.js";
import type { SchedulerRepository } from "../src/scheduler/scheduler.repository.js";
import type { WatcherRepository } from "../src/watcher/watcher.repository.js";
import type { UnitOfWork } from "../src/db/unit-of-work.js";

it("coalesces overlapping snapshots, limits concurrency and does not mark failures as successes", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let active = 0; let peak = 0;
  const refresh = vi.fn(async () => {
    peak = Math.max(peak, ++active);
    await barrier;
    active--;
    throw new Error("offline");
  });
  const scheduler = new SchedulerService(
    { activeAddresses: async () => Array.from({ length: 10 }, (_, i) => String(i)) } as unknown as WatcherService,
    { get: () => undefined, refresh } as unknown as AccountStateService,
    {} as FillSyncService, {} as TradeFeedService, {} as NotifyService, {} as SchedulerRepository, {} as UnitOfWork,
  );
  const first = scheduler.snapshotAll();
  const second = scheduler.snapshotAll();
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  await Promise.all([first, second]);
  expect(peak).toBeLessThanOrEqual(4);
  expect(refresh).toHaveBeenCalledTimes(10);
  expect(scheduler.lastSnapshotAt).toBeNull();
  expect(scheduler.lastSnapshotAttemptAt).toBeInstanceOf(Date);
  expect(scheduler.lastSnapshotFailureAt).toBeInstanceOf(Date);
});

it("revisits already-processed addresses when a new catch-up arrives during a sweep", async () => {
  const { WatcherService } = await import("../src/watcher/watcher.service.js");
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const sync = vi.fn(async (address: string) => {
    if (address === "b" && sync.mock.calls.length <= 2) await barrier;
    return { inserted: 0, complete: true };
  });
  const watcher = new WatcherService(testConfig(), {} as TradeFeedService, { catchUp: sync } as unknown as FillSyncService,
    {} as AccountStateService, {} as import("../src/watcher/feed-actions.service.js").FeedActionsService, {} as WatcherRepository);
  vi.spyOn(watcher, "activeAddresses").mockResolvedValue(["a", "b"]);
  const first = watcher.sweep();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = watcher.sweep();
  release(); await Promise.all([first, second]);
  expect(sync.mock.calls.filter(([address]) => address === "a")).toHaveLength(2);
});
