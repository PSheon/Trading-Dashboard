import { UnitOfWork } from "../src/db/unit-of-work.js";
import { FillSyncRepository } from "../src/watcher/fill-sync.repository.js";
import { AccountStateRepository } from "../src/watcher/account-state.repository.js";
import { testConfig } from "./config-test-utils.js";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { actions, fills } from "@trading-dashboard/shared/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type { HlClearinghouseStateResponse, HlTwapSliceFill, HlUserFill } from "../src/hyperliquid/types.js";
import { AccountStateService } from "../src/watcher/account-state.service.js";
import { ACTION_CREATED_EVENT } from "../src/watcher/action-created.event.js";
import { FillSyncService, PAGE_SIZE } from "../src/watcher/fill-sync.service.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const A = "0xaaaa";
const B = "0xbbbb";

let nextTid = 1;
function fill(overrides: Partial<HlUserFill> = {}): HlUserFill {
  return {
    coin: "BTC",
    px: "100",
    sz: "1",
    side: "B",
    time: Date.now(),
    startPosition: "0",
    dir: "Open Long",
    closedPnl: "0",
    hash: "0x",
    oid: 1,
    crossed: true,
    fee: "0",
    tid: nextTid++,
    ...overrides,
  };
}

function state(coin: string, szi: string, accountValue = "1000", leverage = 5): HlClearinghouseStateResponse {
  return {
    assetPositions:
      szi === "0"
        ? []
        : [{ type: "oneWay", position: { coin, szi, leverage: { type: "cross", value: leverage }, marginUsed: "1", unrealizedPnl: "0" } }],
    marginSummary: { accountValue, totalMarginUsed: "1", totalNtlPos: "1", totalRawUsd: "1" },
    crossMarginSummary: { accountValue, totalMarginUsed: "1", totalNtlPos: "1", totalRawUsd: "1" },
    withdrawable: "0",
    time: Date.now(),
  };
}

describe("FillSyncService — real Postgres, fake Hyperliquid", () => {
  const db = getTestDb();
  let byAddress: Map<string, HlUserFill[]>;
  /** TWAP slice fills: only `userTwapSliceFillsByTime` returns them. */
  let twapByAddress: Map<string, HlTwapSliceFill[]>;
  let info: {
    userFillsByTime: ReturnType<typeof vi.fn>;
    userTwapSliceFillsByTime: ReturnType<typeof vi.fn>;
    clearinghouseState: ReturnType<typeof vi.fn>;
  };
  let events: EventEmitter2;
  let emitted: unknown[];
  let sync: FillSyncService;

  beforeEach(async () => {
    await truncateAll(db);
    byAddress = new Map();
    twapByAddress = new Map();
    info = {
      userFillsByTime: vi.fn(async (address: string, start: number) =>
        (byAddress.get(address) ?? []).filter((f) => f.time >= start).slice(0, PAGE_SIZE),
      ),
      userTwapSliceFillsByTime: vi.fn(async (address: string, start: number) =>
        (twapByAddress.get(address) ?? []).filter((s) => s.fill.time >= start).slice(0, PAGE_SIZE),
      ),
      clearinghouseState: vi.fn(async (_address: string, dex?: string) =>
        dex ? state("xyz:TSLA", "-10", "500", 3) : state("BTC", "1", "1000", 5),
      ),
    };
    events = new EventEmitter2();
    emitted = [];
    events.on(ACTION_CREATED_EVENT, (row) => emitted.push(row));
    const client = info as unknown as HyperliquidInfoClient;
    sync = new FillSyncService(testConfig(), client, new FillSyncRepository(db), new UnitOfWork(db), new AccountStateService(client, new AccountStateRepository(db)), events);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("stores fills, creates one action, refreshes equity, and emits once; a re-sync of the same window adds nothing", async () => {
    const t = Date.now() - 1000;
    byAddress.set(A, [fill({ time: t, sz: "0.6" }), fill({ time: t, startPosition: "0.6", sz: "0.4" })]);

    const first = await sync.sync(A, "live", t - 10_000);
    expect(first).toMatchObject({ fetched: 2, inserted: 2, actions: 1, missingTids: [] });
    expect(info.clearinghouseState).toHaveBeenCalledWith(A, undefined, "live", undefined);
    expect(info.userFillsByTime).toHaveBeenCalledWith(A, t - 10_000, undefined, "live", undefined);

    const [action] = await db.select().from(actions);
    expect(action).toMatchObject({ kind: "open", side: "long", leverage: "5" });
    expect(emitted).toHaveLength(1);

    const second = await sync.sync(A, "sweep", t - 60_000);
    expect(second).toMatchObject({ fetched: 2, inserted: 0, actions: 0 });
    expect(await db.select().from(actions)).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });

  it("keeps both counterparties' fills of one trade (shared tid)", async () => {
    const t = Date.now();
    const shared = 424242;
    byAddress.set(A, [fill({ tid: shared, time: t, side: "B" })]);
    byAddress.set(B, [fill({ tid: shared, time: t, side: "A", dir: "Open Short" })]);

    await sync.sync(A, "live", t - 1000);
    await sync.sync(B, "live", t - 1000);

    const rows = await db.select().from(fills).where(eq(fills.tid, BigInt(shared)));
    expect(rows.map((r) => r.address).sort()).toEqual([A, B]);
    expect((await db.select().from(actions)).map((a) => `${a.address}:${a.side}`).sort()).toEqual([
      `${A}:long`,
      `${B}:short`,
    ]);
  });

  it("stores history but only alerts on recent live actions", async () => {
    const old = Date.now() - 3 * 3600_000;
    byAddress.set(A, [fill({ time: old }), fill({ time: old + 5000, startPosition: "1", side: "A", sz: "1" })]);

    await sync.sync(A, "backfill", 0);
    expect(await db.select().from(actions)).toHaveLength(2);
    expect(emitted).toHaveLength(0);
    expect(info.userFillsByTime).toHaveBeenCalledWith(A, 0, undefined, "background", undefined);

    const recent = Date.now();
    byAddress.get(A)!.push(fill({ time: recent }));
    await sync.sync(A, "sweep", old - 1);
    expect(emitted).toHaveLength(1);
  });

  it("inserts more rows than one statement can bind (a high-frequency address)", async () => {
    // 7,000 adds spaced 2 s apart → 7,000 actions × 10 params > 65,535.
    const t = Date.now() - 20_000_000;
    const many = Array.from({ length: 7000 }, (_, i) => fill({ time: t + i * 2000, startPosition: String(i) }));
    byAddress.set(A, many);
    const result = await sync.sync(A, "backfill", 0);
    expect(result).toMatchObject({ inserted: 7000, actions: 7000 });
    const replay = await sync.sync(A, "backfill", 0);
    expect(replay).toMatchObject({ inserted: 0, actions: 0 });
    expect(sync.getFastPathStats()).toEqual({ verified: 0, corrected: 0 });
  }, 60_000);

  it("does not alert on a sweep that finds a fill older than the alert horizon", async () => {
    byAddress.set(A, [fill({ time: Date.now() - 5 * 60_000 })]);
    const result = await sync.sync(A, "sweep", 0);
    expect(result.actions).toBe(1);
    expect(emitted).toHaveLength(0);
  });

  it("pages forward from the last timestamp when a page is full", async () => {
    const t = Date.now() - 100_000;
    const many = Array.from({ length: PAGE_SIZE + 5 }, (_, i) =>
      fill({ time: t + i, startPosition: String(i), sz: "1" }),
    );
    byAddress.set(A, many);

    const result = await sync.sync(A, "backfill", 0);
    expect(info.userFillsByTime).toHaveBeenCalledTimes(2);
    expect(info.userFillsByTime.mock.calls[1][1]).toBe(many[PAGE_SIZE - 1].time);
    expect(result.inserted).toBe(PAGE_SIZE + 5);
    expect(await db.select().from(fills)).toHaveLength(PAGE_SIZE + 5);
  });

  it("reports expected trade ids that Hyperliquid did not return yet", async () => {
    const t = Date.now();
    const present = fill({ time: t });
    byAddress.set(A, [present]);
    const result = await sync.sync(A, "live", t - 1000, [BigInt(present.tid), 999_999n]);
    expect(result.missingTids).toEqual([999_999n]);
  });

  it("queries the HIP-3 dex of a traded coin and sums equity across dexes", async () => {
    const accounts = new AccountStateService(info as unknown as HyperliquidInfoClient, new AccountStateRepository(db));
    const s = new FillSyncService(testConfig(), info as unknown as HyperliquidInfoClient, new FillSyncRepository(db), new UnitOfWork(db), accounts, events);
    byAddress.set(A, [fill({ coin: "xyz:TSLA", side: "A", dir: "Open Short", time: Date.now() })]);

    await s.sync(A, "live", 0);
    expect(info.clearinghouseState).toHaveBeenCalledWith(A, "xyz", "live", undefined);
    expect(accounts.getEquityUsd(A)).toBe(1500);
    const [action] = await db.select().from(actions);
    expect(action).toMatchObject({ coin: "xyz:TSLA", kind: "open", side: "short", leverage: "3" });
  });

  it("a failed sync rejects to its caller only, and the next sync of that address still runs", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    info.userFillsByTime.mockRejectedValueOnce(new Error("Hyperliquid info request failed: 429"));
    await expect(sync.sync(A, "live", 0)).rejects.toThrow("429");
    byAddress.set(A, [fill({ time: Date.now() })]);
    await expect(sync.sync(A, "live", 0)).resolves.toMatchObject({ inserted: 1 });
    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("runs overlapping syncs of one address one at a time, so the burst is classified once", async () => {
    const t = Date.now();
    byAddress.set(A, [fill({ time: t }), fill({ time: t + 1, startPosition: "1" })]);
    await Promise.all([sync.sync(A, "live", t - 1000), sync.sync(A, "sweep", t - 5000)]);
    expect(await db.select().from(actions)).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });

  describe("TWAP slice fills (not in userFillsByTime)", () => {
    const ZERO_HASH = `0x${"0".repeat(64)}`;
    /** A slice as Hyperliquid returns it: own `fill.twapId` null, the TWAP's id outside. */
    const slice = (twapId: number, overrides: Partial<HlUserFill> = {}): HlTwapSliceFill => ({
      fill: { ...fill({ coin: "CFX", hash: ZERO_HASH, ...overrides }), twapId: null },
      twapId,
    });

    it("stores the TWAP slices a confirm expected and userFillsByTime didn't return, twapId in raw", async () => {
      const t = Date.now() - 2_000;
      const regular = fill({ time: t - 500 });
      const s1 = slice(2_256_941, { time: t, sz: "196" });
      const s2 = slice(2_256_941, { time: t + 1, startPosition: "196", sz: "574" });
      byAddress.set(A, [regular]);
      twapByAddress.set(A, [s1, s2]);

      const result = await sync.sync(A, "confirm", t - 10_000, [BigInt(regular.tid), BigInt(s1.fill.tid), BigInt(s2.fill.tid)]);
      expect(result).toMatchObject({ fetched: 3, inserted: 3, missingTids: [] });
      expect(info.userTwapSliceFillsByTime).toHaveBeenCalledWith(A, t - 10_000, undefined, "background", undefined);

      const rows = await db.select().from(fills).where(eq(fills.coin, "CFX"));
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.raw).toMatchObject({ twapId: 2_256_941, coin: "CFX" });
        expect(row.hash).toBeNull(); // 0x0…0 names no transaction
      }
      expect(rows.find((r) => r.tid === BigInt(s2.fill.tid))).toMatchObject({ sz: "574", dir: "Open Long", fee: "0" });
      // They are fills like any other: they become actions too.
      const coins = new Set((await db.select().from(actions)).map((a) => a.coin));
      expect(coins).toEqual(new Set(["BTC", "CFX"]));
    });

    it("only reports tids that neither endpoint returned", async () => {
      const t = Date.now() - 2_000;
      const s = slice(7, { time: t });
      twapByAddress.set(A, [s]);
      const result = await sync.sync(A, "confirm", t - 1_000, [BigInt(s.fill.tid), 424_242n]);
      expect(result.missingTids).toEqual([424_242n]);
    });

    it("still turns the fills it stored into actions when the TWAP read fails, and reports the rest missing", async () => {
      const f = fill({ time: Date.now() - 1_000 });
      byAddress.set(A, [f]);
      info.userTwapSliceFillsByTime.mockRejectedValueOnce(new Error("Hyperliquid info request failed: 500"));
      const result = await sync.sync(A, "confirm", f.time - 1_000, [BigInt(f.tid), 77n]);
      expect(result).toMatchObject({ inserted: 1, actions: 1, missingTids: [77n] });
      expect(await db.select().from(actions)).toHaveLength(1);
    });

    it("doesn't ask for TWAP slices when userFillsByTime returned every expected tid", async () => {
      const f = fill({ time: Date.now() - 1_000 });
      byAddress.set(A, [f]);
      expect((await sync.sync(A, "confirm", f.time - 1_000, [BigInt(f.tid)])).missingTids).toEqual([]);
      await sync.sync(A, "live", f.time - 1_000);
      expect(info.userTwapSliceFillsByTime).not.toHaveBeenCalled();
    });

    it("reads TWAP slices on backfill and reconcile always, on the hourly sweep only after a recent TWAP", async () => {
      const t = Date.now() - 60_000;
      await sync.sync(A, "sweep", t);
      expect(info.userTwapSliceFillsByTime).not.toHaveBeenCalled();

      twapByAddress.set(A, [slice(9, { time: t + 1_000 })]);
      await sync.sync(A, "reconcile", t);
      expect(info.userTwapSliceFillsByTime).toHaveBeenCalledTimes(1);
      await sync.sync(A, "backfill", 0);
      expect(info.userTwapSliceFillsByTime).toHaveBeenCalledTimes(2);
      expect(await db.select().from(fills)).toHaveLength(1);

      // A slice was seen: the sweep reads them now…
      await sync.sync(A, "sweep", t);
      expect(info.userTwapSliceFillsByTime).toHaveBeenCalledTimes(3);
      // …and so does a fresh process, from the stored slice.
      const restarted = new FillSyncService(testConfig(), info as unknown as HyperliquidInfoClient, new FillSyncRepository(db), new UnitOfWork(db), new AccountStateService(info as unknown as HyperliquidInfoClient, new AccountStateRepository(db)), events);
      await restarted.sync(A, "sweep", t);
      expect(info.userTwapSliceFillsByTime).toHaveBeenCalledTimes(4);
      // B never used one.
      await restarted.sync(B, "sweep", t);
      expect(info.userTwapSliceFillsByTime).toHaveBeenCalledTimes(4);
    });

    it("pages TWAP slices like fills", async () => {
      const t = Date.now() - 100_000;
      twapByAddress.set(
        A,
        Array.from({ length: PAGE_SIZE + 3 }, (_, i) => slice(1, { time: t + i, startPosition: String(i), sz: "1" })),
      );
      const result = await sync.sync(A, "backfill", 0);
      expect(info.userTwapSliceFillsByTime).toHaveBeenCalledTimes(2);
      expect(result.inserted).toBe(PAGE_SIZE + 3);
    });
  });

  it("recovers actions after fills were committed but action creation failed", async () => {
    const t = Date.now() - 1000;
    byAddress.set(A, [fill({ time: t })]);
    const failure = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("interrupted action write"));
    await expect(sync.sync(A, "sweep", t - 1)).rejects.toThrow("interrupted action write");
    failure.mockRestore();
    expect(await db.select().from(fills)).toHaveLength(1);
    expect(await db.select().from(actions)).toHaveLength(0);
    await sync.sync(A, "sweep", t - 1);
    expect(await db.select().from(actions)).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    await sync.sync(A, "sweep", t - 1);
    expect(await db.select().from(actions)).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });

  it("recovers stored first-page fills after a later upstream page fails", async () => {
    const t = Date.now() - 10_000_000;
    const many = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => fill({ time: t + i * 2000, startPosition: String(i) }));
    byAddress.set(A, many);
    info.userFillsByTime.mockResolvedValueOnce(many.slice(0, PAGE_SIZE)).mockRejectedValueOnce(new Error("page unavailable"));
    await expect(sync.sync(A, "backfill", 0)).rejects.toThrow("page unavailable");
    expect(await db.select().from(fills)).toHaveLength(PAGE_SIZE);
    await sync.sync(A, "backfill", 0);
    const rows = await db.select().from(actions);
    expect(new Set(rows.flatMap((a) => a.fillIds)).size).toBe(PAGE_SIZE + 1);
    expect(emitted).toHaveLength(0);
  }, 30_000);

});
