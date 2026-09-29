import { equitySnapshots, fills, positionSnapshots } from "@trading-dashboard/shared";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type { HlClearinghouseStateResponse } from "../src/hyperliquid/types.js";
import type { NotifyService } from "../src/notify/notify.service.js";
import { SchedulerService } from "../src/scheduler/scheduler.service.js";
import { AccountStateService } from "../src/watcher/account-state.service.js";
import type { FillSyncService } from "../src/watcher/fill-sync.service.js";
import type { TradeFeedService, TradeFeedStatus } from "../src/watcher/trade-feed.service.js";
import type { WatcherService } from "../src/watcher/watcher.service.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const A = "0xsched";

function state(positions: Record<string, string>, accountValue: string): HlClearinghouseStateResponse {
  return {
    assetPositions: Object.entries(positions).map(([coin, szi]) => ({
      type: "oneWay",
      position: { coin, szi, leverage: { type: "cross", value: 2 }, marginUsed: "1", unrealizedPnl: "0" },
    })),
    marginSummary: { accountValue, totalMarginUsed: "10", totalNtlPos: "0", totalRawUsd: "0" },
    crossMarginSummary: { accountValue, totalMarginUsed: "10", totalNtlPos: "0", totalRawUsd: "0" },
    withdrawable: "7",
    time: Date.now(),
  };
}

describe("SchedulerService — real Postgres", () => {
  const db = getTestDb();
  let main: Record<string, string>;
  let info: HyperliquidInfoClient;
  let sync: ReturnType<typeof vi.fn>;
  let notify: { sendSystemMessage: ReturnType<typeof vi.fn> };
  let feedStatus: TradeFeedStatus;
  let scheduler: SchedulerService;

  beforeEach(async () => {
    await truncateAll(db);
    main = { BTC: "1" };
    info = {
      clearinghouseState: vi.fn(async (_a: string, dex?: string) =>
        dex === "xyz" ? state({ "xyz:TSLA": "-3" }, "400") : state(main, "600"),
      ),
    } as unknown as HyperliquidInfoClient;
    sync = vi.fn(async () => ({ fetched: 0, inserted: 0, actions: 0, missingTids: [] }));
    notify = { sendSystemMessage: vi.fn(async () => {}) };
    feedStatus = { socketsOpen: 2, socketsTotal: 2, markets: 300, lastTradeAt: null, disconnectedSince: null };
    scheduler = new SchedulerService(
      { activeAddresses: async () => [A] } as unknown as WatcherService,
      new AccountStateService(info, db),
      { sync } as unknown as FillSyncService,
      { status: () => feedStatus } as unknown as TradeFeedService,
      notify as unknown as NotifyService,
      db,
    );
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("snapshots every dex the address has traded on, with equity summed", async () => {
    await db.insert(fills).values({
      chain: "hyperliquid", tid: 1n, address: A, coin: "xyz:TSLA", side: "A", dir: "Open Short",
      px: "1", sz: "3", fee: "0", closedPnl: "0", hash: "0x", ts: new Date(), raw: {},
    });

    expect(await scheduler.snapshotAll()).toEqual({ written: 1, reconciled: 0, failed: 0 });
    const [equity] = await db.select().from(equitySnapshots);
    expect(Number(equity.accountValue)).toBe(1000);
    expect(equity.withdrawable).toBe("7");
    const positions = await db.select().from(positionSnapshots);
    expect(positions.map((p) => `${p.coin}=${p.szi}`).sort()).toEqual(["BTC=1", "xyz:TSLA=-3"]);
  });

  it("syncs fills when a position changed with no fill recorded, and not when one was", async () => {
    await scheduler.snapshotAll();
    main = { BTC: "2" };
    await new Promise((r) => setTimeout(r, 5));
    expect((await scheduler.snapshotAll()).reconciled).toBe(1);
    expect(sync).toHaveBeenCalledWith(A, "reconcile", expect.any(Number));

    sync.mockClear();
    await db.insert(fills).values({
      chain: "hyperliquid", tid: 2n, address: A, coin: "BTC", side: "B", dir: "Open Long",
      px: "1", sz: "1", fee: "0", closedPnl: "0", hash: "0x", ts: new Date(Date.now() + 1000), raw: {},
    });
    main = { BTC: "3" };
    expect((await scheduler.snapshotAll()).reconciled).toBe(0);
    expect(sync).not.toHaveBeenCalled();
  });

  it("alerts once when the feed has been down 10 minutes, and once when it recovers", async () => {
    const t = Date.now();
    feedStatus = { ...feedStatus, socketsOpen: 1, disconnectedSince: new Date(t) };
    await scheduler.checkFeed(t + 9 * 60_000);
    expect(notify.sendSystemMessage).not.toHaveBeenCalled();
    await scheduler.checkFeed(t + 10 * 60_000);
    await scheduler.checkFeed(t + 11 * 60_000);
    expect(notify.sendSystemMessage).toHaveBeenCalledTimes(1);

    feedStatus = { ...feedStatus, socketsOpen: 2, disconnectedSince: null };
    await scheduler.checkFeed(t + 12 * 60_000);
    expect(notify.sendSystemMessage).toHaveBeenCalledTimes(2);
    expect(notify.sendSystemMessage.mock.calls[1][0]).toMatch(/recovered/);
  });

  it("treats a feed that never came up as down", async () => {
    feedStatus = { socketsOpen: 0, socketsTotal: 0, markets: 0, lastTradeAt: null, disconnectedSince: null };
    const t = Date.now();
    await scheduler.checkFeed(t);
    await scheduler.checkFeed(t + 10 * 60_000);
    expect(notify.sendSystemMessage).toHaveBeenCalledTimes(1);
  });
});
