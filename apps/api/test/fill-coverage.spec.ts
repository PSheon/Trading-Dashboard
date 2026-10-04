import { analysisHistoryJobs, fillCoverage, fills, leaders } from "@trading-dashboard/shared/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { UnitOfWork } from "../src/db/unit-of-work.js";
import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type { HlTwapSliceFill, HlUserFill } from "../src/hyperliquid/types.js";
import { AnalysisHistoryRepository } from "../src/traders/analysis-history.repository.js";
import { TradeAnalyticsRepository } from "../src/traders/trade-analytics.repository.js";
import { TradeAnalyticsService } from "../src/traders/trade-analytics.service.js";
import type { TradersService } from "../src/traders/traders.service.js";
import { AccountStateRepository } from "../src/watcher/account-state.repository.js";
import { AccountStateService } from "../src/watcher/account-state.service.js";
import type { FeedActionsService } from "../src/watcher/feed-actions.service.js";
import { toFillRow } from "../src/watcher/fill-row.js";
import { FillSyncRepository } from "../src/watcher/fill-sync.repository.js";
import { BACKFILL_LOOKBACK_MS, BACKFILL_MAX_FILLS, FillSyncService, INDEX_LAG_MS, INITIAL_LOOKBACK_MS, PAGE_SIZE } from "../src/watcher/fill-sync.service.js";
import type { TradeFeedService } from "../src/watcher/trade-feed.service.js";
import { WatcherRepository } from "../src/watcher/watcher.repository.js";
import { WatcherService } from "../src/watcher/watcher.service.js";
import { testConfig } from "./config-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const A = `0x${"c1".repeat(20)}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let nextTid = 900_000;
/** A perp fill moving `coin` from `start` by `delta`. */
function fill(coin: string, start: number, delta: number, time: number, extra: Partial<HlUserFill> = {}): HlUserFill {
  return {
    coin, px: "100", sz: String(Math.abs(delta)), side: delta > 0 ? "B" : "A", time, startPosition: String(start),
    dir: delta > 0 ? "Open Long" : "Close Long", closedPnl: delta < 0 ? "5" : "0", hash: "0x", oid: 1, crossed: true, fee: "1", tid: nextTid++, ...extra,
  };
}
/** `count` round trips of one coin, evenly spread over `[from, to]`: a continuous position chain. */
function roundTrips(coin: string, count: number, from: number, to: number): HlUserFill[] {
  const step = (to - from) / (count * 2);
  return Array.from({ length: count * 2 }, (_, i) => fill(coin, i % 2, i % 2 === 0 ? 1 : -1, Math.floor(from + i * step)));
}

describe("verified fill coverage — real Postgres, fake Hyperliquid", () => {
  const db = getTestDb();
  /** What Hyperliquid's REST API currently returns for the address. */
  let upstream: HlUserFill[];
  let upstreamTwap: HlTwapSliceFill[];
  let info: { userFillsByTime: ReturnType<typeof vi.fn>; userTwapSliceFillsByTime: ReturnType<typeof vi.fn>; clearinghouseState: ReturnType<typeof vi.fn>; userFunding: ReturnType<typeof vi.fn> };
  let repository: FillSyncRepository;
  const page = <T>(list: T[], time: (item: T) => number, start: number, end?: number) =>
    list.filter((item) => time(item) >= start && (end === undefined || time(item) <= end)).sort((x, y) => time(x) - time(y)).slice(0, PAGE_SIZE);
  const service = () => {
    const client = info as unknown as HyperliquidInfoClient;
    return new FillSyncService(testConfig(), client, repository, new UnitOfWork(db), new AccountStateService(client, new AccountStateRepository(db)));
  };
  const coverage = async () => (await db.select().from(fillCoverage).where(eq(fillCoverage.address, A)))[0];
  const storedTids = async () => (await db.select({ tid: fills.tid }).from(fills).where(eq(fills.address, A))).map((row) => Number(row.tid));
  const span = (from: number, through: number, extra: Partial<typeof fillCoverage.$inferInsert> = {}) =>
    db.insert(fillCoverage).values({ address: A, verifiedFrom: new Date(from), verifiedThrough: new Date(through), backfillFloor: new Date(from), backfillStatus: "complete", ...extra });

  beforeEach(async () => {
    await truncateAll(db);
    upstream = [];
    upstreamTwap = [];
    repository = new FillSyncRepository(db);
    info = {
      userFillsByTime: vi.fn(async (_address: string, start: number, end?: number) => page(upstream, (f) => f.time, start, end)),
      userTwapSliceFillsByTime: vi.fn(async (_address: string, start: number, end?: number) => page(upstreamTwap, (s) => s.fill.time, start, end)),
      clearinghouseState: vi.fn(async () => ({ assetPositions: [], marginSummary: { accountValue: "1000", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "0" },
        crossMarginSummary: { accountValue: "1000", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "0" }, withdrawable: "0", time: Date.now() })),
      userFunding: vi.fn(async () => []),
    };
    await db.insert(leaders).values({ address: A, active: true, tier: "A" });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("creates the span from the first completed read and reads the next one from its end", async () => {
    const now = Date.now();
    upstream = roundTrips("BTC", 2, now - 30 * 60_000, now - 20 * 60_000);
    const sync = service();
    const first = await sync.catchUp(A);
    expect(first).toMatchObject({ inserted: 4, complete: true });
    const row = await coverage();
    expect(row.verifiedFrom!.getTime()).toBeGreaterThanOrEqual(now - INITIAL_LOOKBACK_MS);
    // Certified up to a minute before the request, not up to "now": the fill index lags.
    expect(row.verifiedThrough!.getTime()).toBeLessThanOrEqual(Date.now() - INDEX_LAG_MS);
    expect(row.backfillFloor.getTime()).toBeLessThanOrEqual(now - BACKFILL_LOOKBACK_MS + 1000);
    await sync.catchUp(A);
    expect(info.userFillsByTime.mock.calls.at(-1)![1]).toBe(row.verifiedThrough!.getTime());
    expect(info.userTwapSliceFillsByTime.mock.calls.at(-1)![1]).toBe(row.verifiedThrough!.getTime());
  });

  it("does not move the cursor when a read fails, and the next read starts from the same place", async () => {
    const now = Date.now();
    const cursor = now - 6 * HOUR;
    await span(now - DAY, cursor);
    upstream = roundTrips("BTC", 3, now - 5 * HOUR, now - 2 * HOUR);
    const sync = service();

    // Regular fills arrive, the TWAP endpoint times out: half a read proves nothing.
    info.userTwapSliceFillsByTime.mockRejectedValueOnce(new Error("connection timeout"));
    await expect(sync.catchUp(A)).rejects.toThrow("connection timeout");
    expect((await coverage()).verifiedThrough!.getTime()).toBe(cursor);
    expect((await coverage()).lastError).toBe("upstream_unavailable");

    info.userFillsByTime.mockRejectedValueOnce(new Error("503 busy"));
    await expect(sync.catchUp(A)).rejects.toThrow("503 busy");
    expect((await coverage()).verifiedThrough!.getTime()).toBe(cursor);

    info.userFillsByTime.mockClear();
    const result = await sync.catchUp(A);
    expect(info.userFillsByTime.mock.calls[0][1]).toBe(cursor);
    expect(result).toMatchObject({ inserted: 6, complete: true });
    expect((await coverage()).verifiedThrough!.getTime()).toBeGreaterThan(now - 2 * HOUR);
    expect((await coverage()).lastError).toBeNull();
  });

  it("advances only over full pages when a read stops at the page cap", async () => {
    const now = Date.now();
    const cursor = now - 3 * DAY;
    await span(cursor - DAY, cursor);
    // 7 pages of backlog; one catch-up reads six.
    upstream = roundTrips("BTC", (PAGE_SIZE * 7) / 2, cursor + HOUR, now - HOUR);
    const result = await service().catchUp(A);
    expect(result.complete).toBe(false);
    const row = await coverage();
    const stored = await db.select({ ts: fills.ts }).from(fills).where(eq(fills.address, A));
    const newest = Math.max(...stored.map((r) => r.ts.getTime()));
    // The cursor stops strictly before the last millisecond read (it may be cut by the page).
    expect(row.verifiedThrough!.getTime()).toBe(newest - 1);
    expect(row.verifiedThrough!.getTime()).toBeLessThan(now - HOUR);
  });

  it("after a restart catches up the whole downtime, however long, from the stored cursor", async () => {
    const now = Date.now();
    // The process died three days ago; the old start-up sweep read only the last 75 minutes.
    const cursor = now - 3 * DAY;
    await span(cursor - DAY, cursor);
    upstream = [...roundTrips("BTC", 6_600, cursor + 60_000, now - 2 * HOUR), ...roundTrips("ETH", 3, now - 30 * 60_000, now - 10 * 60_000)];
    upstreamTwap = [{ twapId: 7, fill: fill("SOL", 0, 4, cursor + 5 * HOUR) }];

    const restarted = service();
    const watcher = new WatcherService(testConfig(), {} as TradeFeedService, restarted,
      {} as AccountStateService, {} as FeedActionsService, new WatcherRepository(db));
    const result = await watcher.sweep();
    expect(result).toMatchObject({ addresses: 1, failed: 0, inserted: upstream.length + 1 });
    expect(new Set(await storedTids())).toEqual(new Set([...upstream, upstreamTwap[0].fill].map((f) => f.tid)));
    const row = await coverage();
    expect(row.verifiedFrom!.getTime()).toBe(cursor - DAY);
    expect(row.verifiedThrough!.getTime()).toBeGreaterThan(now - 2 * INDEX_LAG_MS);
    expect(row.breaks).toEqual([]);
    expect(row.checkedThrough!.getTime()).toBe(row.verifiedThrough!.getTime());
  }, 120_000);

  it("the gap detector re-reads exactly the interval of a position break and stores what was missing", async () => {
    const now = Date.now();
    const chain = [fill("BTC", 0, 1, now - 10 * HOUR), fill("BTC", 1, 1, now - 8 * HOUR), fill("BTC", 2, 1, now - 6 * HOUR), fill("ETH", 0, 3, now - 7 * HOUR)];
    upstream = chain;
    // The middle BTC fill never reached our table, inside a span marked verified.
    await db.insert(fills).values([chain[0], chain[2], chain[3]].map((f) => toFillRow(A, f)));
    await span(now - DAY, now - HOUR);
    const revised = vi.fn();
    const sync = service();
    (sync as unknown as { events: { emit: typeof revised } }).events = { emit: revised };

    const result = await sync.checkContinuity(A, true);
    expect(result).toEqual({ breaks: 1, repaired: 1, unexplained: 0 });
    // A targeted read: both endpoints, bounded by the two fills around the hole.
    expect(info.userFillsByTime).toHaveBeenCalledWith(A, chain[0].time, chain[2].time, "background", undefined);
    expect(info.userTwapSliceFillsByTime).toHaveBeenCalledWith(A, chain[0].time, chain[2].time, "background", undefined);
    expect((await storedTids()).sort()).toEqual(chain.map((f) => f.tid).sort());
    const row = await coverage();
    expect(row.breaks).toEqual([]);
    expect(row.revisedAt).not.toBeNull();
    expect(row.checkedThrough!.getTime()).toBe(row.verifiedThrough!.getTime());
    expect(revised).toHaveBeenCalledWith("fills.revised", { address: A });
  });

  it("finds a hole left by a TWAP slice and records a break upstream cannot explain instead of retrying forever", async () => {
    const now = Date.now();
    const open = fill("BTC", 0, 1, now - 10 * HOUR);
    const slice = fill("BTC", 1, 1, now - 9 * HOUR);
    const close = fill("BTC", 2, -2, now - 8 * HOUR);
    // ETH jumps from 1 to 5 and neither endpoint has a fill in between.
    const eth = [fill("ETH", 0, 1, now - 7 * HOUR), fill("ETH", 5, -1, now - 5 * HOUR)];
    upstream = [open, close, ...eth];
    upstreamTwap = [{ twapId: 9, fill: slice }];
    await db.insert(fills).values([open, close, ...eth].map((f) => toFillRow(A, f)));
    await span(now - DAY, now - HOUR);
    const sync = service();

    expect(await sync.checkContinuity(A, true)).toEqual({ breaks: 2, repaired: 1, unexplained: 1 });
    const [stored] = await db.select().from(fills).where(eq(fills.tid, BigInt(slice.tid)));
    expect((stored.raw as { twapId?: number }).twapId).toBe(9);
    const row = await coverage();
    expect(row.breaks).toMatchObject([{ coin: "ETH", tid: eth[1].tid, after: eth[0].time, expected: "1000000000000", actual: "5000000000000" }]);

    info.userFillsByTime.mockClear();
    expect(await sync.checkContinuity(A, true)).toEqual({ breaks: 0, repaired: 0, unexplained: 0 });
    expect(info.userFillsByTime).not.toHaveBeenCalled();
  });

  it("backfills backward from the span in contiguous windows and stops where REST retention starts", async () => {
    const now = Date.now();
    // Upstream retains fills from 20 days ago; the account is older (first retained fill starts mid-position).
    const retained = now - 20 * DAY;
    upstream = [fill("BTC", 3, -1, retained), ...roundTrips("BTC", 500, retained + HOUR, now - 2 * HOUR)];
    const sync = service();
    await sync.catchUp(A);
    const first = await coverage();
    expect(first.backfillStatus).toBe("pending");

    let status = "pending";
    for (let step = 0; step < 40 && status === "pending"; step++) {
      ({ status } = await sync.backfillStep(A));
      // Every intermediate state is one span without a hole: all upstream fills inside it are stored.
      const row = await coverage();
      const inside = upstream.filter((f) => f.time >= row.verifiedFrom!.getTime() && f.time <= row.verifiedThrough!.getTime()).map((f) => f.tid);
      expect(new Set(await storedTids())).toEqual(new Set(inside));
    }
    expect(status).toBe("retention");
    const row = await coverage();
    expect(row.verifiedFrom!.getTime()).toBe(retained);
    expect(row.backfillFloor.getTime()).toBe(retained);
    expect(await storedTids()).toHaveLength(upstream.length);
    expect(await repository.nextBackfill()).toBeUndefined();
  });

  it("does not claim a range upstream pruned while the backfill was running", async () => {
    const now = Date.now();
    const retained = now - 20 * DAY;
    // More than a page before and after the pruning: an endpoint at its retention limit.
    upstream = roundTrips("BTC", 1_400, retained, now - 2 * HOUR);
    const sync = service();
    await sync.catchUp(A);
    await sync.backfillStep(A);
    expect((await coverage()).backfillFloor.getTime()).toBe(retained);
    // The retention window moves on: the oldest five days are gone before the backfill reaches them.
    upstream = upstream.filter((f) => f.time >= retained + 5 * DAY);
    const moved = upstream[0].time;
    let status = "pending";
    for (let step = 0; step < 40 && status === "pending"; step++) ({ status } = await sync.backfillStep(A));
    expect(status).toBe("retention");
    // The span starts where upstream starts now, not at the start read earlier.
    expect((await coverage()).verifiedFrom!.getTime()).toBe(moved);
    expect(new Set(await storedTids())).toEqual(new Set(upstream.map((f) => f.tid)));
  });

  it("the floor is not the later of the two endpoints' first fills: a recent first TWAP does not cut off a year of ordinary fills (review 45)", async () => {
    const now = Date.now();
    // 200 days of ordinary fills from a flat start, fewer than a page: the endpoint returns its whole history.
    const first = now - 200 * DAY;
    upstream = roundTrips("BTC", 300, first, now - 2 * HOUR);
    // The address used a TWAP for the first time last week, out of an open position.
    const slice = (time: number, start: number): HlTwapSliceFill => ({ twapId: 77, fill: fill("ETH", start, -1, time, { hash: "0x0000" }) });
    upstreamTwap = [slice(now - 7 * DAY, 5), slice(now - 7 * DAY + 60_000, 4)];
    const sync = service();
    await sync.catchUp(A);
    await sync.backfillStep(A);
    // Before: the floor jumped to the first TWAP slice (7 days ago) and 193 days of fills were never read.
    expect((await coverage()).backfillFloor.getTime()).toBeLessThan(first);
    let status = "pending";
    for (let step = 0; step < 80 && status === "pending"; step++) ({ status } = await sync.backfillStep(A));
    expect(status).toBe("complete");
    const stored = new Set(await storedTids());
    expect(upstream.filter((f) => !stored.has(f.tid))).toEqual([]);
    expect((await coverage()).verifiedFrom!.getTime()).toBeLessThanOrEqual(first);
  });

  it("an endpoint that returns a full page from the beginning still bounds the span, and so does an ordinary first fill that starts mid-position", async () => {
    const now = Date.now();
    const retained = now - 12 * DAY;
    // Exactly at the limit: one full page; older fills may have been dropped.
    upstream = roundTrips("BTC", PAGE_SIZE / 2 + 50, retained, now - 2 * HOUR);
    const sync = service();
    await sync.catchUp(A);
    await sync.backfillStep(A);
    expect((await coverage()).backfillFloor.getTime()).toBe(retained);

    await truncateAll(db);
    await db.insert(leaders).values({ address: A, active: true, tier: "A" });
    // Few fills, but the first one reduces a position this endpoint never shows being opened.
    upstream = [fill("BTC", 3, -1, retained), ...roundTrips("ETH", 20, retained + HOUR, now - 2 * HOUR)];
    const again = service();
    await again.catchUp(A);
    await again.backfillStep(A);
    expect((await coverage()).backfillFloor.getTime()).toBe(retained);
  });

  it("the forward cursor steps over a millisecond that holds more than a page instead of staying on it for ever (review 45)", async () => {
    const now = Date.now();
    const cursor = now - 3 * HOUR;
    await span(now - DAY, cursor);
    // One block with 2,300 fills of the address (a sweep through a deep book), then normal trading.
    const dense = cursor + HOUR;
    const burst = Array.from({ length: PAGE_SIZE + 300 }, (_, i) => fill("BTC", i, 1, dense));
    const after = roundTrips("ETH", 3, dense + 60_000, now - 2 * 60_000 - INDEX_LAG_MS);
    upstream = [...burst, ...after];
    const sync = service();
    const result = await sync.catchUp(A);
    // The first page of that millisecond is stored, the cursor is past it, and what follows is read.
    expect(result.complete).toBe(true);
    const row = await coverage();
    expect(row.verifiedThrough!.getTime()).toBeGreaterThan(dense);
    expect(row.lastError).toBe("dense_millisecond");
    const stored = new Set(await storedTids());
    expect(after.every((f) => stored.has(f.tid))).toBe(true);
    expect(burst.filter((f) => stored.has(f.tid))).toHaveLength(PAGE_SIZE);
    // The next sweep starts after it: no more re-reading of the same page.
    info.userFillsByTime.mockClear();
    await sync.catchUp(A);
    expect(info.userFillsByTime.mock.calls.every((call) => (call[1] as number) > dense)).toBe(true);
    expect(info.userFillsByTime.mock.calls.length).toBeLessThanOrEqual(2);
    // Backward backfill keeps its own rule: a window it cannot page through is `blocked`, not skipped.
  });

  it("retries a window that is too dense with a shorter one and stores nothing from the failed attempt", async () => {
    const now = Date.now();
    await span(now - HOUR, now - 2 * 60_000, { backfillStatus: "pending", backfillFloor: new Date(now - 30 * DAY), backfillSpanMs: 6 * HOUR });
    // More than a step may read (12 pages) inside the planned six hours.
    upstream = roundTrips("BTC", PAGE_SIZE * 7, now - 7 * HOUR, now - HOUR - 1000);
    const sync = service();
    expect(await sync.backfillStep(A)).toEqual({ status: "pending", inserted: 0 });
    const row = await coverage();
    expect(await storedTids()).toHaveLength(0);
    expect(row.verifiedFrom!.getTime()).toBe(now - HOUR);
    expect(row.backfillSpanMs).toBeLessThanOrEqual(3 * HOUR);
    const second = await sync.backfillStep(A);
    expect(second.inserted).toBeGreaterThan(0);
    expect((await coverage()).verifiedFrom!.getTime()).toBeLessThan(now - HOUR);
  });

  describe("analytics of a watched address", () => {
    const traders = {
      isTracked: vi.fn(async () => true),
      latestFills: vi.fn(async (): Promise<[HlUserFill[], HlUserFill[]]> => [[...upstream].sort((a, b) => b.time - a.time), []]),
      rawPortfolio: vi.fn(async () => []),
      portfolioCache: { peek: () => undefined }, userFillsCache: { peek: () => undefined }, twapFillsCache: { peek: () => undefined }, dexCache: { peek: () => undefined },
      profileCache: { peek: () => undefined },
      perpDexes: vi.fn(async () => [""]),
    };
    const analytics = () => new TradeAnalyticsService(new TradeAnalyticsRepository(db), traders as unknown as TradersService, info as unknown as HyperliquidInfoClient);

    it("claims coverage only for the verified span: rows on the far side of a hole are not counted", async () => {
      const now = Date.now();
      // What the old oldest-first backfill left: an old segment, a hole, then live fills.
      const old = roundTrips("BTC", 3, now - 40 * DAY, now - 30 * DAY);
      const live = [fill("BTC", 7, -1, now - 5 * HOUR), fill("ETH", 0, 2, now - 4 * HOUR), fill("ETH", 2, -2, now - 3 * HOUR)];
      const ahead = fill("SOL", 0, 1, now - 60_000);
      await db.insert(fills).values([...old, ...live, ahead].map((f) => toFillRow(A, f)));
      await span(now - DAY, now - HOUR, { backfillStatus: "retention" });
      const service = analytics();
      const result = await service.analytics(A, "all");
      await service.settled();
      expect(result.coverage).toMatchObject({ source: "tracked", fills: 3, truncated: true, completeness: "partial" });
      expect(result.coverage.from!.getTime()).toBe(live[0].time);
      expect(result.coverage.partialSince!.getTime()).toBe(live[0].time);
      // Complete through the verified cursor, not through the newest stored row.
      expect(result.coverage.through!.getTime()).toBe((await coverage()).verifiedThrough!.getTime());
      // The ETH round trip; the BTC reduce belongs to a position opened before the span.
      expect(result.summary).toMatchObject({ trades: 1 });
      expect(info.userFillsByTime).not.toHaveBeenCalled();
    });

    it("does not present figures as complete while a break in the span is unexplained", async () => {
      const now = Date.now();
      const chain = [fill("BTC", 0, 1, now - 10 * HOUR), fill("BTC", 1, -1, now - 9 * HOUR)];
      await db.insert(fills).values(chain.map((f) => toFillRow(A, f)));
      await span(now - DAY, now - HOUR);
      const service = analytics();
      expect((await service.analytics(A, "all")).coverage).toMatchObject({ source: "tracked", truncated: false, completeness: "complete" });
      await service.settled();
      await db.update(fillCoverage).set({ revisedAt: new Date(), breaks: [{ coin: "ETH", tid: 1, time: now - 2 * HOUR, after: now - 3 * HOUR, expected: "1", actual: "5" }] });
      // The worker's next turn picks up the revision.
      await db.insert(leaders).values({ address: A }).onConflictDoNothing();
      expect(await service.refreshTracked()).toEqual([A]);
      expect((await service.analytics(A, "all")).coverage).toMatchObject({ truncated: true, completeness: "partial" });
      await service.settled();
    });

    it("uses the REST read, not a sliver of our table, while the backward backfill is still running", async () => {
      const now = Date.now();
      upstream = roundTrips("BTC", 4, now - 10 * DAY, now - 2 * HOUR);
      await db.insert(fills).values(upstream.slice(-2).map((f) => toFillRow(A, f)));
      await span(now - 3 * HOUR, now - HOUR, { backfillStatus: "pending" });
      const service = analytics();
      const result = await service.analytics(A, "all");
      await service.settled();
      expect(result.coverage).toMatchObject({ source: "hyperliquid", fills: 8 });
    });

    it("a page view mid-backfill is answered from the stored figures: no recompute that could not use the new fills (review 44)", async () => {
      const now = Date.now();
      upstream = [...roundTrips("BTC", 20, now - 9 * DAY, now - 2 * DAY), ...roundTrips("ETH", 2, now - 5 * HOUR, now - 2 * HOUR)];
      const sync = service();
      await sync.catchUp(A);
      const service1 = analytics();
      const first = await service1.analytics(A, "all");
      await service1.settled();
      expect(first.coverage.source).toBe("hyperliquid");

      // The backward backfill stores a window: revised_at moves past the figures' time, and it is still pending.
      await db.update(fillCoverage).set({ backfillFloor: new Date(now - 30 * DAY) });
      expect((await sync.backfillStep(A)).status).toBe("pending");
      const row = await coverage();
      expect(row.backfillStatus).toBe("pending");
      expect(row.revisedAt!.getTime()).toBeGreaterThan(first.computedAt.getTime());

      // Three page views: the same figures at once, and nothing computed.
      const compute = vi.spyOn(service1, "compute");
      traders.latestFills.mockClear();
      for (let i = 0; i < 3; i++) {
        const again = await service1.analytics(A, "all");
        expect(again.computedAt.getTime()).toBe(first.computedAt.getTime());
        expect(again.refreshing).toBe(false);
      }
      expect((await service1.trades(A, { status: "all", limit: 20 } as never)).computedAt.getTime()).toBe(first.computedAt.getTime());
      expect(compute).not.toHaveBeenCalled();
      expect(traders.latestFills).not.toHaveBeenCalled();
      compute.mockRestore();

      // Mid-backfill the worker leaves it too; when the backfill ends, its
      // next turn recomputes from our fills, once. A view never computes.
      await db.insert(leaders).values({ address: A }).onConflictDoNothing();
      expect(await service1.refreshTracked()).toEqual([]);
      let status = "pending";
      for (let step = 0; step < 40 && status === "pending"; step++) ({ status } = await sync.backfillStep(A));
      expect(status).not.toBe("pending");
      expect((await service1.analytics(A, "all")).computedAt.getTime()).toBe(first.computedAt.getTime());
      expect(await service1.refreshTracked()).toEqual([A]);
      await service1.settled();
      const after = await service1.analytics(A, "all");
      expect(after.computedAt.getTime()).toBeGreaterThan(first.computedAt.getTime());
      expect(after.coverage.source).toBe("tracked");
      expect(await service1.refreshTracked()).toEqual([]);
    });

    it("recomputes the figures once backfilled fills land", async () => {
      const now = Date.now();
      upstream = [...roundTrips("BTC", 20, now - 9 * DAY, now - 2 * DAY), ...roundTrips("ETH", 2, now - 5 * HOUR, now - 2 * HOUR)];
      const sync = service();
      await sync.catchUp(A);
      // The span is the last 75 minutes: nothing in it yet, and marked finished for the first computation.
      await db.update(fillCoverage).set({ backfillStatus: "complete", verifiedFrom: new Date(now - 6 * HOUR) });
      await db.insert(fills).values(upstream.slice(-4).map((f) => toFillRow(A, f))).onConflictDoNothing();
      const service1 = analytics();
      const before = await service1.analytics(A, "all");
      await service1.settled();
      expect(before.summary).toMatchObject({ trades: 2 });
      expect(before.coverage.fills).toBe(4);

      // The backfill resumes and stores nine days of older fills.
      await db.update(fillCoverage).set({ backfillStatus: "pending", backfillFloor: new Date(now - 30 * DAY) });
      let status = "pending";
      for (let step = 0; step < 40 && status === "pending"; step++) ({ status } = await sync.backfillStep(A));
      expect((await coverage()).revisedAt!.getTime()).toBeGreaterThan(before.computedAt.getTime());

      // The stored row is minutes old (not stale by age): the revision alone
      // makes it due for the worker's next turn.
      await db.insert(leaders).values({ address: A }).onConflictDoNothing();
      expect(await service1.refreshTracked()).toEqual([A]);
      await service1.settled();
      const after = await service1.analytics(A, "all");
      expect(after.computedAt.getTime()).toBeGreaterThan(before.computedAt.getTime());
      expect(after.summary).toMatchObject({ trades: 22 });
      expect(after.coverage.fills).toBe(upstream.length);
      expect(after.coverage.from!.getTime()).toBe(upstream[0].time);
    });
  });

  describe("history depth (audit A2)", () => {
    it("a span the old 50,000-fill cap stopped short of REST's retention carries on to it", async () => {
      const now = Date.now();
      const retained = now - 20 * DAY;
      upstream = [fill("BTC", 3, -1, retained), ...roundTrips("BTC", 500, retained + HOUR, now - 2 * HOUR)];
      const sync = service();
      await sync.catchUp(A);
      // Where the old cap left it: a recent span marked capped, REST holding twenty days more.
      const stoppedAt = (await coverage()).verifiedFrom!.getTime();
      await db.update(fillCoverage).set({ backfillStatus: "capped", backfillFloor: new Date(retained) });
      expect(BACKFILL_MAX_FILLS).toBeGreaterThanOrEqual(500_000);
      for (let step = 0; step < 40 && (await coverage()).backfillStatus !== "retention"; step++) await sync.backfillTick();
      const row = await coverage();
      expect(row.backfillStatus).toBe("retention");
      expect(row.verifiedFrom!.getTime()).toBe(retained);
      expect(row.verifiedFrom!.getTime()).toBeLessThan(stoppedAt);
      expect(await storedTids()).toHaveLength(upstream.length);
    });

    it("a span at the cap stays capped", async () => {
      const now = Date.now();
      await db.insert(fills).values(roundTrips("BTC", 3, now - 5 * HOUR, now - 2 * HOUR).map((f) => toFillRow(A, f)));
      await span(now - DAY, now - HOUR, { backfillStatus: "capped" });
      expect(await repository.reopenCapped(6)).toEqual([]);
      expect(await repository.reopenCapped(7)).toEqual([A]);
      expect((await coverage()).backfillStatus).toBe("pending");
    });

    it("a full continuity check walks the span in pages, never splits a millisecond and still sees a break across pages", async () => {
      const now = Date.now();
      const t = (minutes: number) => now - DAY + minutes * 60_000;
      const eth = fill("ETH", 0, 1, t(1));
      // Eight BTC fills in one millisecond (more than a page), a chain of their own.
      const burst = Array.from({ length: 8 }, (_, i) => fill("BTC", i + 1, 1, t(3)));
      const btc = [fill("BTC", 0, 1, t(2)), ...burst, ...Array.from({ length: 12 }, (_, i) => fill("BTC", 9 + (i % 2), i % 2 === 0 ? 1 : -1, t(4 + i)))];
      // ETH comes back pages later from 3, not from the 1 it was left at.
      const jump = fill("ETH", 3, -3, t(30));
      await db.insert(fills).values([eth, ...btc, jump].map((f) => toFillRow(A, f)));
      await span(now - DAY, now - HOUR);
      repository.spanPageFills = 5;
      const sync = service();
      const pages: number[][] = [];
      for await (const page of repository.fillPagesForCheck(A, new Date(now - DAY), new Date(now - DAY), new Date(now - HOUR))) pages.push(page.map((f) => f.time));
      expect(pages.length).toBeGreaterThan(3);
      // The burst is in one page, whole.
      expect(pages.filter((times) => times.includes(t(3))).every((times) => times.filter((x) => x === t(3)).length === 8)).toBe(true);
      expect(await sync.checkContinuity(A, true)).toEqual({ breaks: 1, repaired: 0, unexplained: 1 });
      expect((await coverage()).breaks.map((b) => b.tid)).toEqual([jump.tid]);
    });

    it("a tracked rebuild over a span larger than a page gives the figures of one read", async () => {
      const now = Date.now();
      const chain = [...roundTrips("BTC", 20, now - 9 * DAY, now - 2 * DAY), ...roundTrips("ETH", 2, now - 5 * HOUR, now - 2 * HOUR)];
      await db.insert(fills).values(chain.map((f) => toFillRow(A, f)));
      await span(now - 10 * DAY, now - HOUR);
      const store = new TradeAnalyticsRepository(db);
      store.spanPageFills = 3;
      const traders = { isTracked: vi.fn(async () => true), rawPortfolio: vi.fn(async () => []), perpDexes: vi.fn(async () => [""]),
        latestFills: vi.fn(async (): Promise<[HlUserFill[], HlUserFill[]]> => [[], []]),
        portfolioCache: { peek: () => undefined }, dexCache: { peek: () => undefined },
        profileCache: { peek: () => undefined }, userFillsCache: { peek: () => undefined }, twapFillsCache: { peek: () => undefined } };
      const paged = new TradeAnalyticsService(store, traders as unknown as TradersService, info as unknown as HyperliquidInfoClient);
      const result = await paged.analytics(A, "all");
      await paged.settled();
      expect(result.summary).toMatchObject({ trades: 22 });
      expect(result.coverage).toMatchObject({ source: "tracked", fills: chain.length, truncated: false });
      expect(result.coverage.from!.getTime()).toBe(chain[0].time);
    });
  });

  it("history jobs that were never attempted are claimed before caught-up ones", async () => {
    const history = new AnalysisHistoryRepository(db);
    const now = Date.now();
    await history.ensure("0xdone", now);
    await db.update(analysisHistoryJobs).set({ status: "caught_up", attemptedAt: new Date(now - 10 * 60_000), publishedThrough: new Date(now) });
    await history.ensure("0xnew1", now);
    await history.ensure("0xnew2", now, now - DAY);
    const claimed = [await history.claim(now), await history.claim(now), await history.claim(now)].map((job) => job?.address);
    expect(claimed.slice(0, 2).sort()).toEqual(["0xnew1", "0xnew2"]);
    expect(claimed[2]).toBe("0xdone");
    // A job over a claimed range starts reading at that range, not at the start of upstream history.
    const [ranged] = await db.select().from(analysisHistoryJobs).where(eq(analysisHistoryJobs.address, "0xnew2"));
    expect(ranged.checkpoint.sources.regular.cursor).toBe(now - DAY);
    expect((await db.execute(sql`select count(*)::int as n from analysis_history_jobs`)).rows[0].n).toBe(3);
  });
});
