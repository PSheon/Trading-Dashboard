import { EventEmitter2 } from "@nestjs/event-emitter";
import { actions, fills } from "@trading-dashboard/shared/database";
import { asc } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type { HlUserFill } from "../src/hyperliquid/types.js";
import { AccountStateService } from "../src/watcher/account-state.service.js";
import { ACTION_CREATED_EVENT } from "../src/watcher/action-created.event.js";
import { FeedActionsService } from "../src/watcher/feed-actions.service.js";
import { FillSyncService } from "../src/watcher/fill-sync.service.js";
import type { TradeFeedService } from "../src/watcher/trade-feed.service.js";
import { WatcherService } from "../src/watcher/watcher.service.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";
import { FakeExchange } from "./fast-path-fixtures.js";

const A = "0x510w";

describe("Slow path: FillSyncService after the fast path — real Postgres, fake Hyperliquid", () => {
  const db = getTestDb();
  let exchange: FakeExchange;
  let stateTime: number;
  /** Fills the info API doesn't return yet (indexing lag). */
  let unindexed: Set<number>;
  /** Fills that are TWAP slices: only the TWAP endpoint returns them. */
  let twap: Set<number>;
  let info: {
    clearinghouseState: ReturnType<typeof vi.fn>;
    userFillsByTime: ReturnType<typeof vi.fn>;
    userTwapSliceFillsByTime: ReturnType<typeof vi.fn>;
  };
  let emitted: Array<typeof actions.$inferSelect>;
  let fast: FeedActionsService;
  let sync: FillSyncService;

  beforeEach(async () => {
    await truncateAll(db);
    exchange = new FakeExchange(A);
    stateTime = 0;
    unindexed = new Set();
    twap = new Set();
    info = {
      clearinghouseState: vi.fn(async (_address: string, dex?: string) => exchange.stateAt(dex, stateTime)),
      userFillsByTime: vi.fn(async (_address: string, start: number) =>
        exchange.fills.filter((f) => f.time >= start && !unindexed.has(f.tid) && !twap.has(f.tid)),
      ),
      userTwapSliceFillsByTime: vi.fn(async (_address: string, start: number) =>
        exchange.fills
          .filter((f) => f.time >= start && !unindexed.has(f.tid) && twap.has(f.tid))
          .map((f) => ({ fill: { ...f, hash: `0x${"0".repeat(64)}`, twapId: null }, twapId: 4242 })),
      ),
    };
    const client = info as unknown as HyperliquidInfoClient;
    const accounts = new AccountStateService(client, db);
    const events = new EventEmitter2();
    emitted = [];
    events.on(ACTION_CREATED_EVENT, (row) => emitted.push(row));
    fast = new FeedActionsService(db, accounts, events);
    sync = new FillSyncService(client, db, accounts, events);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const tidsOf = (list: HlUserFill[]) => list.map((f) => BigInt(f.tid));

  it("stores the fills in the background and makes no second action for them", async () => {
    const t = Date.now() - 5_000;
    stateTime = t + 10;
    const open = exchange.order("BTC", "B", ["0.3", "0.7"], t);
    await fast.process(A, open.trades);
    expect(emitted).toHaveLength(1);

    const result = await sync.sync(A, "confirm", t - 10_000, tidsOf(open.fills));
    expect(result).toMatchObject({ inserted: 2, actions: 0, missingTids: [] });
    expect(info.userFillsByTime).toHaveBeenCalledWith(A, t - 10_000, undefined, "background", undefined);
    expect(await db.select().from(fills)).toHaveLength(2);
    expect(await db.select().from(actions)).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(sync.getFastPathStats()).toEqual({ verified: 1, corrected: 0 });

    await sync.sync(A, "sweep", t - 10_000);
    expect(sync.getFastPathStats()).toEqual({ verified: 1, corrected: 0 });
    expect(emitted).toHaveLength(1);
  });

  it("corrects an action the book got wrong, in place and without a second alert", async () => {
    const t = Date.now() - 5_000;
    stateTime = t - 100_000; // flat, and never read again below
    await fast.process(A, exchange.order("SOL", "B", ["1"], t - 90_000).trades); // the book exists
    exchange.order("BTC", "B", ["2"], t - 60_000); // the feed missed this one
    const sell = exchange.order("BTC", "A", ["1"], t);
    await fast.process(A, sell.trades);
    const wrong = (await db.select().from(actions)).find((r) => r.coin === "BTC")!;
    expect(wrong).toMatchObject({ kind: "open", side: "short" });
    expect(emitted).toHaveLength(2);

    await sync.sync(A, "confirm", t - 10_000, tidsOf(sell.fills));
    const btc = (await db.select().from(actions)).filter((r) => r.coin === "BTC");
    expect(btc).toHaveLength(1);
    expect(btc[0]).toMatchObject({ id: wrong.id, kind: "reduce", side: "long", fillIds: wrong.fillIds });
    expect(emitted).toHaveLength(2);
    expect(sync.getFastPathStats()).toEqual({ verified: 1, corrected: 1 });
  });

  it("corrects a close the feed couldn't know was a liquidation", async () => {
    const t = Date.now() - 5_000;
    exchange.order("ETH", "B", ["4"], t - 60_000);
    stateTime = t - 1;
    const liquidation = exchange.order("ETH", "A", ["4"], t, "90", {
      liquidation: { liquidatedUser: A, markPx: 90, method: "market" },
    });
    await fast.process(A, liquidation.trades);
    expect((await db.select().from(actions))[0]).toMatchObject({ kind: "close", side: "long" });

    await sync.sync(A, "confirm", t - 1000, tidsOf(liquidation.fills));
    expect((await db.select().from(actions))[0]).toMatchObject({ kind: "liquidation", side: "long" });
    expect(emitted).toHaveLength(1);
  });

  it("re-derives an action only once all its fills are stored", async () => {
    const t = Date.now() - 5_000;
    stateTime = t - 1;
    const open = exchange.order("SOL", "A", ["10", "5"], t);
    await fast.process(A, open.trades);
    unindexed.add(open.fills[1].tid);

    const first = await sync.sync(A, "confirm", t - 1000, tidsOf(open.fills));
    expect(first.missingTids).toEqual([BigInt(open.fills[1].tid)]);
    expect(sync.getFastPathStats()).toEqual({ verified: 0, corrected: 0 });

    unindexed.clear();
    await sync.sync(A, "confirm", t - 1000, tidsOf(open.fills));
    expect(sync.getFastPathStats()).toEqual({ verified: 1, corrected: 0 });
    expect(await db.select().from(actions)).toHaveLength(1);
  });

  it("still makes (and alerts on) an action for fills the feed missed", async () => {
    const t = Date.now() - 5_000;
    stateTime = t - 1;
    const seen = exchange.order("BTC", "B", ["1"], t);
    await fast.process(A, seen.trades);
    const missed = exchange.order("HYPE", "A", ["50"], t + 1_500); // never on the feed

    await sync.sync(A, "confirm", t - 1000, tidsOf(seen.fills));
    const rows = await db.select().from(actions).orderBy(asc(actions.ts));
    expect(rows.map((r) => `${r.coin}:${r.kind}:${r.side}`)).toEqual(["BTC:open:long", "HYPE:open:short"]);
    expect(rows[1].fillIds).toEqual(tidsOf(missed.fills));
    expect(emitted.map((r) => r.coin)).toEqual(["BTC", "HYPE"]);
  });

  it("classifies real fills of one millisecond in execution order, whatever order they come in", async () => {
    const t = Date.now() - 5_000;
    exchange.order("BTC", "B", ["1"], t - 60_000);
    // One sell crosses two levels in the same millisecond, 1 → -0.5 → -2.
    // Listed out of execution order, the startPosition chain still decides.
    const flip = exchange.order("BTC", "A", ["1.5", "1.5"], t);
    const shuffled = [flip.fills[1], flip.fills[0]];
    info.userFillsByTime.mockResolvedValueOnce([exchange.fills[0], ...shuffled]);
    await sync.sync(A, "sweep", t - 120_000);
    const rows = await db.select().from(actions).orderBy(asc(actions.ts));
    expect(rows.map((r) => `${r.kind}:${r.side}`)).toEqual(["open:long", "flip:short"]);
  });

  describe("TWAP slices (on the feed, missing from userFillsByTime)", () => {
    it("stores them from the TWAP endpoint and verifies (and corrects) the fast path's actions from them", async () => {
      const t = Date.now() - 5_000;
      stateTime = t - 100_000; // flat, and never read again below
      await fast.process(A, exchange.order("SOL", "B", ["1"], t - 90_000).trades); // the book exists
      exchange.order("BTC", "B", ["2"], t - 60_000); // a slice the feed missed
      const slice = exchange.order("BTC", "A", ["1"], t); // the book thinks this opens a short
      for (const f of exchange.fills) twap.add(f.tid);
      await fast.process(A, slice.trades);
      expect(emitted).toHaveLength(2);

      const result = await sync.sync(A, "confirm", t - 1_000, tidsOf(slice.fills));
      expect(result.missingTids).toEqual([]);
      const stored = await db.select().from(fills);
      expect(stored.map((f) => f.raw.twapId)).toEqual([4242]);
      // Re-derived from the stored slice: a reduce of the long, in place, no alert.
      const btc = (await db.select().from(actions)).filter((r) => r.coin === "BTC");
      expect(btc).toHaveLength(1);
      expect(btc[0]).toMatchObject({ kind: "reduce", side: "long" });
      expect(emitted).toHaveLength(2);
      expect(sync.getFastPathStats()).toEqual({ verified: 1, corrected: 1 });
    });

    it("never lists a TWAP trader as fillsUnavailable (watcher → confirm → TWAP endpoint)", async () => {
      const results: Array<Awaited<ReturnType<FillSyncService["sync"]>>> = [];
      const real = sync.sync.bind(sync);
      vi.spyOn(sync, "sync").mockImplementation(async (...args) => {
        const r = await real(...args);
        results.push(r);
        return r;
      });
      const watcher = new WatcherService(
        { setWatched: () => {}, status: () => ({}), stop: () => {} } as unknown as TradeFeedService,
        sync,
        new AccountStateService(info as unknown as HyperliquidInfoClient, db),
        fast,
        db,
      );
      try {
        const t = Date.now();
        stateTime = t - 1;
        const slice = exchange.order("ETH", "B", ["0.4"], t);
        twap.add(slice.fills[0].tid);
        for (const trade of slice.trades) watcher.onTrade(A, trade);
        // The fast path runs after ~1 s, the confirm ~2 s later.
        await vi.waitFor(() => expect(results).toHaveLength(1), { timeout: 8_000, interval: 100 });
        expect(results[0]).toMatchObject({ inserted: 1, missingTids: [] });
        // Nothing left to look for: no retry pending, nothing listed.
        expect((watcher as unknown as { timers: Set<unknown> }).timers.size).toBe(0);
        expect(watcher.getHeartbeat().fillsUnavailable).toEqual([]);
        expect(await db.select().from(actions)).toHaveLength(1);
      } finally {
        watcher.stop();
      }
    }, 15_000);
  });
});
