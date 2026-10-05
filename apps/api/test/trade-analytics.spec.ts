import type { INestApplication } from "@nestjs/common";
import { wireTraderAnalyticsSchema, wireTraderTradesSchema } from "@trading-dashboard/shared/contracts";
import { analysisHistoryJobs, archiveCoverage, fillCoverage, fills, leaders, traderAnalytics, traderTrades, userFavorites } from "@trading-dashboard/shared/database";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type { HlUserFill, HlUserFundingEntry } from "../src/hyperliquid/types.js";
import { TradeAnalyticsController } from "../src/traders/trade-analytics.controller.js";
import { AnalysisHistoryRepository } from "../src/traders/analysis-history.repository.js";
import { HistoryFillStore } from "../src/traders/history-fill.store.js";
import { AnalysisHistoryService } from "../src/traders/analysis-history.service.js";
import { TradeAnalyticsRepository } from "../src/traders/trade-analytics.repository.js";
import { UNRANKED_BASE } from "../src/hyperliquid/request-budgeter.service.js";
import { STALE_MS, MAX_CONCURRENT, MAX_WAITING, TRACKED_FALLBACK_MS, TradeAnalyticsService } from "../src/traders/trade-analytics.service.js";
import { PAGE_DEADLINE_MS } from "../src/traders/traders.controller.js";
import type { TradersService } from "../src/traders/traders.service.js";
import { toFillRow } from "../src/watcher/fill-row.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, insertUser, storedFills, truncateAll } from "./db-test-utils.js";

const X = `0x${"7a".repeat(20)}`;
const TRACKED = `0x${"7b".repeat(20)}`;
const HOUR = 3_600_000;
const NOW = Date.now();
const T = (hoursAgo: number) => NOW - hoursAgo * HOUR;

let nextTid = 50_000;
function fill(coin: string, start: number, delta: number, px: number, time: number, extra: Partial<HlUserFill> = {}): HlUserFill {
  return {
    coin,
    px: String(px),
    sz: String(Math.abs(delta)),
    side: delta > 0 ? "B" : "A",
    time,
    startPosition: String(start),
    dir: "",
    closedPnl: "0",
    hash: "0x1",
    oid: 1,
    crossed: true,
    fee: "1",
    tid: nextTid++,
    ...extra,
  };
}

const funding = (time: number, coin: string, usdc: number): HlUserFundingEntry => ({
  time,
  hash: "0x0",
  delta: { type: "funding", coin, usdc: String(usdc), szi: "1", fundingRate: "0.0001", nSamples: null },
});

const portfolio = [
  ["day", { accountValueHistory: [[NOW, "2500000"]], pnlHistory: [[NOW, "0"]], vlm: "0" }],
  ["allTime", { accountValueHistory: [[NOW, "2400000"]], pnlHistory: [[T(1000), "0"], [NOW, "-150000"]], vlm: "0" }],
  ["perpAllTime", { accountValueHistory: [[NOW, "2300000"]], pnlHistory: [[T(1000), "0"], [NOW, "-150000"]], vlm: "0" }],
];

async function waitFor(check: () => Promise<boolean>, ms = 3_000) {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("trade analytics for any address", () => {
  const db = getTestDb();
  let app: INestApplication;
  let service: TradeAnalyticsService;
  let controller: TradeAnalyticsController;
  /** Hyperliquid's view of X: every fill it would return. */
  let history: HlUserFill[];
  let fundingEvents: HlUserFundingEntry[];
  const tracked = new Set<string>();
  let latestGate: Promise<void> | null = null;
  /** Main-dex positions Hyperliquid reports now. */
  let livePositions: Array<[string, string]> = [];

  const info = {
    userFillsByTime: vi.fn(async (_address: string, start: number, end?: number) =>
      history.filter((f) => !f.twapId && f.time >= start && (end === undefined || f.time <= end)).sort((a, b) => a.time - b.time),
    ),
    userTwapSliceFillsByTime: vi.fn(async (_address: string, start: number, end?: number) =>
      history.filter((f) => f.twapId && f.time >= start && (end === undefined || f.time <= end)).map((f) => ({ fill: { ...f, twapId: null }, twapId: f.twapId! })),
    ),
    clearinghouseState: vi.fn(async (_address: string, dex?: string) => ({
      time: Date.now(),
      marginSummary: { accountValue: "1250000" },
      assetPositions: dex ? [] : livePositions.map(([coin, szi]) => ({ position: { coin, szi } })),
    })),
    userFunding: vi.fn(async (_address: string, start: number, end?: number) =>
      fundingEvents.filter((e) => e.time >= start && (end === undefined || e.time <= end)).sort((a, b) => a.time - b.time),
    ),
  };
  const traders = {
    isTracked: vi.fn(async (address: string) => tracked.has(address)),
    latestFills: vi.fn(async (): Promise<[HlUserFill[], HlUserFill[]]> => {
      if (latestGate) await latestGate;
      const newest = [...history].sort((a, b) => b.time - a.time);
      return [newest.filter((f) => !f.twapId), newest.filter((f) => f.twapId)];
    }),
    rawPortfolio: vi.fn(async () => portfolio),
    portfolioCache: { peek: () => undefined },
    profileCache: { peek: vi.fn<() => unknown>(() => undefined) },
    userFillsCache: { peek: () => undefined },
    twapFillsCache: { peek: () => undefined },
    dexCache: { peek: () => undefined },
    perpDexes: vi.fn(async () => ["", "xyz"]),
  };

  beforeAll(async () => {
    const repository = new TradeAnalyticsRepository(db);
    service = new TradeAnalyticsService(repository, traders as unknown as TradersService, info as unknown as HyperliquidInfoClient);
    ({ app } = await createAuthedApp({
      db,
      privy: stubPrivy({}),
      controllers: [TradeAnalyticsController],
      providers: [{ provide: TradeAnalyticsService, useValue: service }],
    }));
    controller = app.get(TradeAnalyticsController);
  });

  beforeEach(async () => {
    // The previous test's background steps (funding) finish first.
    await service.settled();
    await truncateAll(db);
    vi.clearAllMocks();
    traders.profileCache.peek.mockReset().mockReturnValue(undefined);
    tracked.clear();
    latestGate = null;
    livePositions = [["SOL", "5"]];
    controller.pageDeadlineMs = PAGE_DEADLINE_MS;
    history = [
      // BTC long: +10 realized, 2 fees → a win.
      fill("BTC", 0, 1, 100, T(50)),
      fill("BTC", 1, -1, 110, T(48), { closedPnl: "10" }),
      // ETH short, partly by TWAP: −10 → a loss.
      fill("ETH", 0, -1, 50, T(30), { twapId: 3 }),
      fill("ETH", -1, -1, 50, T(29.9), { twapId: 3 }),
      fill("ETH", -2, 2, 55, T(20), { closedPnl: "-10" }),
      // SOL long, still open.
      fill("SOL", 0, 5, 10, T(10)),
    ];
    fundingEvents = [funding(T(9), "SOL", -0.5), funding(T(25), "ETH", 0.25)];
  });

  afterAll(async () => {
    await service.settled();
    await app.close();
    await closeTestDb();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);

  it("does not admit TWAP history across an empty but incomplete regular-fill boundary", async () => {
    const originalRange = info.userFillsByTime.getMockImplementation()!;
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const regular = Array.from({ length: 2001 }, () => fill("BTC", 0, 1, 100, NOW - 30000));
    const newer = Array.from({ length: 2000 }, () => fill("BTC", 0, 1, 100, NOW + 60000));
    const twap = [
      fill("ETH", 0, 1, 100, NOW - 40000, { twapId: 1 }),
      fill("ETH", 1, -1, 110, NOW - 35000, { twapId: 1, closedPnl: "10" }),
    ];
    history = [...twap, ...regular, ...newer];
    traders.latestFills.mockResolvedValueOnce([newer, twap]);
    info.userFillsByTime.mockImplementation(async (address, start, end) =>
      (await originalRange(address, start, end)).slice(0, 2000));
    try {
      const state = await service.refresh(X);
      expect(state.truncated).toBe(true);
      expect(state.fillsRead).toBe(0);
      expect(await db.select().from(traderTrades)).toHaveLength(0);
    } finally {
      clock.mockRestore();
      info.userFillsByTime.mockImplementation(originalRange);
    }
  });

  it("answers 503 busy while a cold address computes, then serves it from the store", async () => {
    controller.pageDeadlineMs = 30;
    let release!: () => void;
    latestGate = new Promise((r) => (release = r));
    const busy = await get(`/traders/${X}/analytics`);
    expect(busy.status).toBe(503);
    expect(busy.headers["retry-after"]).toBe("5");
    expect(busy.body.error).toMatchObject({ code: "busy" });
    // A second caller joins the same computation.
    expect((await get(`/traders/${X}/trades`)).status).toBe(503);
    release();
    await waitFor(async () => (await db.select().from(traderAnalytics)).length === 1);

    const res = await get(`/traders/${X}/analytics`).set("x-api-contract", "1").expect(200);
    const parsed = wireTraderAnalyticsSchema.safeParse(res.body.data);
    expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(true);
    expect(res.body.data).toMatchObject({
      address: X,
      window: "all",
      summary: { trades: 2, wins: 1, losses: 1, winRate: 0.5, openTrades: 1, netPnl: 8 - 13 },
      // PnL from the portfolio (not on the leaderboard); perp value over 2 dexes.
      classification: { style: "intraday", pnlTier: "very_unprofitable", sizeTier: "whale", allTimePnl: -150000, perpAccountValue: 2500000 },
      coverage: { source: "hyperliquid", truncated: false, fills: 6 },
    });
    expect(res.body.data.summary.best[0]).toMatchObject({ coin: "BTC", netPnl: 8, entryPx: 100, exitPx: 110, status: "closed" });
    expect(res.body.data.summary.worst[0]).toMatchObject({ coin: "ETH", side: "short", twap: true });
    expect(res.body.data.summary.coins.map((c: { coin: string }) => c.coin)).toEqual(["BTC", "ETH"]);
    expect(traders.latestFills).toHaveBeenCalledTimes(1);

    // Both closed within 7 days.
    expect((await get(`/traders/${X}/analytics?window=7d`).expect(200)).body.data.summary).toMatchObject({ trades: 2 });
    // ETH closed 20 hours ago.
    expect((await get(`/traders/${X}/analytics?window=1d`).expect(200)).body.data.summary.trades).toBe(1);
    expect((await get(`/traders/${X}/analytics?window=90d`)).status).toBe(400);
    expect((await get(`/traders/0x12/analytics`)).status).toBe(400);
  });

  it("pages the round-trip ledger newest first with status filters, through the wire contract", async () => {
    await service.compute(X, true);
    const first = await get(`/traders/${X}/trades?limit=2`).set("x-api-contract", "1").expect(200);
    const parsed = wireTraderTradesSchema.safeParse(first.body.data);
    expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(true);
    expect(first.body.data.items.map((t: { coin: string }) => t.coin)).toEqual(["SOL", "ETH"]);
    expect(first.body.data.items[0]).toMatchObject({ status: "open", exitTime: null, exitPx: null });
    expect(first.body.data.total).toBe(3);
    expect(first.body.meta.pagination).toEqual({ type: "cursor", limit: 2, total: 3, nextCursor: first.body.data.nextCursor, hasMore: true });
    const next = await get(`/traders/${X}/trades?limit=2&cursor=${first.body.data.nextCursor}`).expect(200);
    expect(next.body.data.items.map((t: { coin: string }) => t.coin)).toEqual(["BTC"]);
    expect(next.body.data.nextCursor).toBeNull();
    expect((await get(`/traders/${X}/trades?status=open`)).body.data.items.map((t: { coin: string }) => t.coin)).toEqual(["SOL"]);
    expect((await get(`/traders/${X}/trades?status=closed`)).body.data.items).toHaveLength(2);
    expect((await get(`/traders/${X}/trades?cursor=abc`)).status).toBe(400);
  });

  it("refreshes incrementally: only fills after the cursor, continuing open trades", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T(3));
    try { await service.compute(X, true); await service.settled(); }
    finally { clock.mockRestore(); }
    const [state] = await db.select().from(traderAnalytics);
    const cursor = state.fillCursor!.getTime();
    expect(cursor).toBe(T(10));

    history.push(fill("SOL", 5, -5, 12, T(1), { closedPnl: "10" }), fill("BTC", 0, -1, 100, T(0.5)));
    fundingEvents.push(funding(T(2), "SOL", -0.25));
    livePositions = [["BTC", "-1"]];
    info.userFillsByTime.mockClear();
    traders.latestFills.mockClear();
    // Stale: a read serves the stored answer and starts a refresh.
    await db.update(traderAnalytics).set({ computedAt: new Date(Date.now() - STALE_MS - 1000) });
    const stale = await get(`/traders/${X}/analytics`).expect(200);
    expect(stale.body.data.summary.trades).toBe(2);
    await waitFor(async () => (await db.select().from(traderAnalytics))[0].fillCursor!.getTime() === T(0.5));
    expect(traders.latestFills).not.toHaveBeenCalled();
    expect(info.userFillsByTime.mock.calls.every(([, start]) => start === cursor)).toBe(true);

    await waitFor(async () => (await db.select().from(traderAnalytics))[0].fundingCursor!.getTime() >= NOW);
    const res = await get(`/traders/${X}/analytics`).expect(200);
    expect(res.body.data.summary).toMatchObject({ trades: 3, wins: 2, openTrades: 1 });
    const sol = (await get(`/traders/${X}/trades?status=closed`)).body.data.items.find((t: { coin: string }) => t.coin === "SOL");
    // Funding of the SOL hold: −0.5 read cold, −0.25 on the refresh.
    expect(sol).toMatchObject({ realizedPnl: 10, funding: -0.75, exitPx: 12 });
    // ETH opened within funding coverage and received +0.25.
    const eth = (await get(`/traders/${X}/trades?status=closed`)).body.data.items.find((t: { coin: string }) => t.coin === "ETH");
    expect(eth.funding).toBe(0.25);
    expect(res.body.data.coverage.fundingFrom).not.toBeNull();
  });

  it("refreshes a stale row behind every page call: nobody waits for it (Stage, 2026-10-05)", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T(3));
    try { await service.compute(X, true); await service.settled(); }
    finally { clock.mockRestore(); }
    history.push(fill("SOL", 5, -5, 12, T(1), { closedPnl: "10" }));
    info.userFillsByTime.mockClear();
    info.clearinghouseState.mockClear();
    await db.update(traderAnalytics).set({ computedAt: new Date(Date.now() - STALE_MS - 1000) });
    await get(`/traders/${X}/analytics`).expect(200);
    await waitFor(async () => (await db.select().from(traderAnalytics))[0].fillCursor!.getTime() === T(1));
    await service.settled();
    const ranks = [...info.userFillsByTime.mock.calls, ...info.clearinghouseState.mock.calls].map((call) => (call as unknown[]).at(-1));
    expect(ranks.length).toBeGreaterThan(0);
    expect(ranks.every((rank) => typeof rank === "number" && rank >= UNRANKED_BASE)).toBe(true);
  });

  it("does not use a partial profile as evidence that positions closed", async () => {
    traders.profileCache.peek.mockReturnValue({ value: {
      fetchedAt: new Date().toISOString(), perpEquity: null, positions: [],
      dataQuality: { partial: true },
    } });
    await service.compute(X, true);
    const res = await get(`/traders/${X}/trades?status=open`).expect(200);
    expect(res.body.data.items.map((t: { coin: string }) => t.coin)).toContain("SOL");
    expect((await get(`/traders/${X}/analytics`)).body.data.classification.perpAccountValue).toBe(2500000);
  });

  it("uses upstream observation time instead of a newer profile assembly time", async () => {
    traders.profileCache.peek.mockReturnValue({ value: {
      fetchedAt: new Date().toISOString(), perpEquity: 2500000, positions: [],
    } });
    info.clearinghouseState.mockImplementationOnce(async () => ({ time: T(20), marginSummary: { accountValue: "1250000" }, assetPositions: [] }));
    await service.compute(X, true);
    expect((await get(`/traders/${X}/trades?status=open`)).body.data.items).toHaveLength(1);
  });

  it("rolls back trade writes if the state checkpoint fails, so retry does not lose or replay fills", async () => {
    await service.refresh(X);
    const repository = new TradeAnalyticsRepository(db);
    const before = await repository.allTrades(X);
    history.push(fill("SOL", 5, -5, 12, T(1), { closedPnl: "10" }));
    const save = vi.spyOn(TradeAnalyticsRepository.prototype, "saveState").mockRejectedValueOnce(new Error("checkpoint failed"));
    try {
      await expect(service.refresh(X)).rejects.toThrow("checkpoint failed");
      expect(await repository.allTrades(X)).toEqual(before);
    } finally { save.mockRestore(); }
    await service.compute(X, false);
    expect((await get(`/traders/${X}/analytics`)).body.data.summary.trades).toBe(3);
  });

  it("bounds admission even when many stale addresses arrive in the same tick", async () => {
    let release!: () => void;
    latestGate = new Promise<void>(resolve => { release = resolve; });
    const work = Array.from({ length: MAX_CONCURRENT + MAX_WAITING + 3 }, (_, i) =>
      service.compute(`0x${i.toString(16).padStart(40, "0")}`, false).then(() => "ok", () => "busy"));
    try {
      await new Promise(resolve => setImmediate(resolve));
      const early = await Promise.race([work.at(-1)!, Promise.resolve("pending")]);
      expect(early).toBe("busy");
    } finally {
      release();
      await Promise.all(work);
      await service.settled();
    }
  });

  it("preserves the checkpoint when a fill stream exceeds the refresh page budget", async () => {
    await service.refresh(X);
    const repository = new TradeAnalyticsRepository(db);
    const before = await repository.state(X);
    const beforeTrades = await repository.allTrades(X);
    const impl = info.userFillsByTime.getMockImplementation()!;
    info.userFillsByTime.mockImplementation(async (_address, start) =>
      Array.from({ length: 2000 }, (_, i) => fill("BTC", 0, 1, 100, start + i + 1)));
    try {
      await expect(service.refresh(X)).rejects.toThrow();
      expect(await repository.state(X)).toEqual(before);
      expect(await repository.allTrades(X)).toEqual(beforeTrades);
    } finally { info.userFillsByTime.mockImplementation(impl); }
  });

  it("reports funding progress without making old fills look freshly observed", async () => {
    await service.refresh(X);
    await db.execute(sql`update trader_analytics set computed_at = now() - interval '1 hour'`);
    const repository = new TradeAnalyticsRepository(db);
    const before = await repository.state(X);
    await service.fundingStep(X);
    const after = await repository.state(X);
    expect(after?.computedAt).toEqual(before?.computedAt);
    const res = await get(`/traders/${X}/trades`).expect(200);
    expect(new Date(res.body.data.coverage.fundingThrough).getTime()).toBeGreaterThan(T(0) - 1000);
  });

  it("rejects out-of-range pagination cursors before querying storage", async () => {
    for (const cursor of ["999999999999999999999_1", "1_9223372036854775808"]) {
      await get(`/traders/${X}/trades?cursor=${cursor}`).expect(400);
    }
  });

  it("reads both cold tails before advancing a shared cursor", async () => {
    const cached = [...history];
    traders.latestFills.mockResolvedValueOnce([cached.filter(f => !f.twapId), cached.filter(f => f.twapId)]);
    history.push(fill("SOL", 5, -5, 12, T(1), { closedPnl: "10", twapId: 8 }));
    history.push(fill("BTC", 0, 1, 100, T(0.5)));
    await service.refresh(X);
    const trades = await new TradeAnalyticsRepository(db).allTrades(X);
    expect(trades.find(t => t.coin === "SOL")?.exitTime).toBe(T(1));
  });

  it("does not prune an opening when a close arrives during the live state read", async () => {
    info.clearinghouseState.mockImplementationOnce(async () => {
      history.push(fill("SOL", 5, -5, 12, T(1), { closedPnl: "10" }));
      return { time: Date.now(), marginSummary: { accountValue: "1250000" }, assetPositions: [] };
    });
    await service.refresh(X);
    const sol = (await new TradeAnalyticsRepository(db).allTrades(X)).find(t => t.coin === "SOL");
    expect(sol).toMatchObject({ entryTime: T(10), exitTime: T(1), fees: 2 });
  });

  it("drops an open trade the account no longer holds (closed by fills we can't read)", async () => {
    livePositions = [];
    await service.compute(X, true);
    const res = await get(`/traders/${X}/trades?status=open`).expect(200);
    expect(res.body.data.items).toEqual([]);
    expect((await get(`/traders/${X}/analytics`)).body.data.summary).toMatchObject({ trades: 2, openTrades: 0 });
  });

  it("marks coverage truncated when history starts mid-position, and counts the partial trade", async () => {
    history.unshift(fill("DOGE", 100, -100, 0.1, T(60), { closedPnl: "3" }));
    await service.compute(X, true);
    const res = await get(`/traders/${X}/analytics`).expect(200);
    expect(res.body.data.coverage).toMatchObject({ truncated: true, fills: 7 });
    expect(res.body.data.summary).toMatchObject({ trades: 3, wins: 2 });
    expect(res.body.data.classification).toMatchObject({ allTimePnl: -150_000, pnlTier: "very_unprofitable" });
    const doge = (await get(`/traders/${X}/trades?status=closed`)).body.data.items.find((t: { coin: string }) => t.coin === "DOGE");
    expect(doge).toMatchObject({ partial: true, entryApprox: false, size: 100, netPnl: 2 });
    expect(doge.entryPx).toBeCloseTo(0.07);
  });

  it("tiers on one definition each: PnL on all-time perp PnL, size on the whole account's value (audit A4, A5)", async () => {
    // The whole account made $2M (perp $500K plus spot) and is worth $6M,
    // while its perp equity is $2.5M (1.25M on each of two dexes).
    traders.rawPortfolio.mockResolvedValueOnce([
      ["allTime", { accountValueHistory: [[T(1000), "0"], [NOW, "6000000"]], pnlHistory: [[T(1000), "0"], [NOW, "2000000"]], vlm: "0" }],
      ["perpAllTime", { accountValueHistory: [[T(1000), "0"], [NOW, "2500000"]], pnlHistory: [[T(1000), "0"], [NOW, "500000"]], vlm: "0" }],
    ] as never);
    await service.compute(X, true);
    const res = await get(`/traders/${X}/analytics`).expect(200);
    expect(res.body.data.classification).toMatchObject({
      allTimePnl: 500_000, pnlTier: "very_profitable",
      perpAccountValue: 2_500_000, accountValue: 6_000_000, sizeTier: "apex",
    });
    // The page's profile total wins when it was just read.
    await service.settled();
    await db.execute(sql`update trader_analytics set computed_at = now() - interval '1 hour'`);
    traders.profileCache.peek.mockReturnValue({ value: { accountValue: 50_000 } });
    await service.compute(X, false);
    expect((await get(`/traders/${X}/analytics`)).body.data.classification).toMatchObject({ accountValue: 50_000, sizeTier: "medium" });
  });

  it("rebuilds a tracked address from our fills table without reading Hyperliquid's fills", async () => {
    tracked.add(TRACKED);
    await db.insert(fills).values(history.map((f) => toFillRow(TRACKED, f)));
    // The watcher has verified the whole stored range and finished its backfill.
    await db.insert(fillCoverage).values({ address: TRACKED, verifiedFrom: new Date(T(60)), verifiedThrough: new Date(NOW), backfillFloor: new Date(T(60)), backfillStatus: "complete" });
    await service.compute(TRACKED, true);
    expect(info.userFillsByTime).not.toHaveBeenCalled();
    expect(traders.latestFills).not.toHaveBeenCalled();
    const res = await get(`/traders/${TRACKED}/analytics`).expect(200);
    expect(res.body.data).toMatchObject({ coverage: { source: "tracked", fills: 6 }, summary: { trades: 2, winRate: 0.5 } });
    const stored = await db.select().from(traderTrades).where(eq(traderTrades.address, TRACKED));
    expect(stored).toHaveLength(3);
    expect(stored.find((t) => t.coin === "ETH")?.twap).toBe(true);
    // A rebuild keeps the same trades.
    await waitFor(async () => (await db.select().from(traderAnalytics))[0]?.fundingCursor != null);
    await db.execute(sql`update trader_analytics set computed_at = now() - interval '1 hour'`);
    await service.compute(TRACKED, false);
    expect(await db.select().from(traderTrades).where(eq(traderTrades.address, TRACKED))).toHaveLength(3);
  });
  it("a watched address nobody views is refreshed by the worker; a read only serves the stored row", async () => {
    tracked.add(TRACKED);
    await db.insert(leaders).values({ address: TRACKED });
    await db.insert(fills).values(history.map((f) => toFillRow(TRACKED, f)));
    await db.insert(fillCoverage).values({ address: TRACKED, verifiedFrom: new Date(T(60)), verifiedThrough: new Date(NOW), backfillFloor: new Date(T(60)), backfillStatus: "complete" });
    await service.compute(TRACKED, true);
    await service.settled();
    // 15 minutes later, nobody has opened the page: stale, and the worker's to refresh (audit A2).
    await db.execute(sql`update trader_analytics set computed_at = now() - interval '15 minutes'`);
    const before = (await db.select().from(traderAnalytics))[0].computedAt;
    vi.clearAllMocks();
    const read = await service.analytics(TRACKED, "all");
    await service.settled();
    expect(read.refreshing).toBe(true);
    expect(info.clearinghouseState).not.toHaveBeenCalled();
    expect((await db.select().from(traderAnalytics))[0].computedAt).toEqual(before);
    // The worker's turn picks it up, and not again while it is fresh.
    expect(await service.refreshTracked()).toEqual([TRACKED]);
    const after = (await db.select().from(traderAnalytics))[0];
    expect(Date.now() - after.computedAt.getTime()).toBeLessThan(STALE_MS);
    expect(await service.refreshTracked()).toEqual([]);
    expect((await service.analytics(TRACKED, "all")).refreshing).toBe(false);
    // New fills after the cursor: the next turn extends the stored trades.
    const opened = fill("DOGE", 0, 100, 0.1, NOW + 1_000);
    await db.insert(fills).values(toFillRow(TRACKED, opened));
    await db.update(fillCoverage).set({ verifiedThrough: new Date(NOW + 2_000) });
    await db.execute(sql`update trader_analytics set computed_at = now() - interval '11 minutes'`);
    expect(await service.refreshTracked()).toEqual([TRACKED]);
    const rows = await db.select().from(traderTrades).where(eq(traderTrades.address, TRACKED));
    expect(rows.map((t) => t.coin).sort()).toEqual(["BTC", "DOGE", "ETH", "SOL"].filter((c) => rows.some((t) => t.coin === c)).sort());
    expect(rows.some((t) => t.coin === "DOGE" && t.exitTime === null)).toBe(true);
    expect((await db.select().from(traderAnalytics))[0]).toMatchObject({ fillsRead: history.length + 1, historyThrough: new Date(NOW + 2_000) });
    tracked.delete(TRACKED);
  });

  it("a watched address's figures older than three worker periods are refreshed by the read itself: no worker is doing it", async () => {
    tracked.add(TRACKED);
    try {
      await db.insert(leaders).values({ address: TRACKED });
      await db.insert(fills).values(history.map((f) => toFillRow(TRACKED, f)));
      await db.insert(fillCoverage).values({ address: TRACKED, verifiedFrom: new Date(T(60)), verifiedThrough: new Date(NOW), backfillFloor: new Date(T(60)), backfillStatus: "complete" });
      await service.compute(TRACKED, true);
      await service.settled();
      // Just inside the fallback age: still left to the worker.
      await db.execute(sql`update trader_analytics set computed_at = now() - ${TRACKED_FALLBACK_MS - 60_000} * interval '1 millisecond'`);
      const waiting = await service.analytics(TRACKED, "all");
      await service.settled();
      expect(waiting.refreshing).toBe(true);
      expect(Date.now() - (await db.select().from(traderAnalytics))[0].computedAt.getTime()).toBeGreaterThan(STALE_MS);
      // The worker is down: 23 hours later the page's read refreshes them.
      await db.execute(sql`update trader_analytics set computed_at = now() - interval '23 hours'`);
      const read = await service.analytics(TRACKED, "all");
      expect(read.refreshing).toBe(true);
      await service.settled();
      expect(Date.now() - (await db.select().from(traderAnalytics))[0].computedAt.getTime()).toBeLessThan(STALE_MS);
      const after = await service.analytics(TRACKED, "all");
      expect(after.refreshing).toBe(false);
      expect(after.coverage.source).toBe("tracked");
    } finally { tracked.delete(TRACKED); }
  });

  it("an untracked address's stale read still refreshes it in the background", async () => {
    await service.compute(X, true);
    await service.settled();
    await db.execute(sql`update trader_analytics set computed_at = now() - interval '1 hour'`);
    const before = (await db.select().from(traderAnalytics))[0].computedAt;
    await service.analytics(X, "all");
    await service.settled();
    expect((await db.select().from(traderAnalytics))[0].computedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  describe("who may create a durable history job (review 27): the routes are public and take any address", () => {
    const withHistory = () => new TradeAnalyticsService(new TradeAnalyticsRepository(db), traders as unknown as TradersService, info as unknown as HyperliquidInfoClient, undefined,
      new AnalysisHistoryService(new AnalysisHistoryRepository(db), info as unknown as HyperliquidInfoClient));
    const stored = async () => ({ jobs: (await db.select().from(analysisHistoryJobs)).length, fills: (await storedFills(db)).length });

    it("an anonymous request for an address the product does not follow is answered, and leaves no job and no stored fills", async () => {
      const production = withHistory();
      const result = await production.analytics(X, "all", "anonymous");
      await production.settled();
      expect(result.summary).toMatchObject({ trades: 2, wins: 1 });
      expect(await production.trades(X, { status: "closed", limit: 50 } as never, "anonymous")).toMatchObject({ total: 2 });
      expect(await stored()).toEqual({ jobs: 0, fills: 0 });
    });

    it("the same request for a favorited address, or from a signed-in person, gets the job and keeps the fills", async () => {
      const production = withHistory();
      const user = await insertUser(db);
      await db.insert(userFavorites).values({ userId: user.id, address: X });
      await production.analytics(X, "all", "anonymous");
      await production.settled();
      expect(await stored()).toEqual({ jobs: 1, fills: 6 });

      const other = `0x${"7c".repeat(20)}`;
      await production.analytics(other, "all", "user");
      await production.settled();
      expect((await db.select().from(analysisHistoryJobs)).map((j) => j.address).sort()).toEqual([X, other].sort());
    });
  });

  it("an archive-covered address skips the cold read: its first build is the stored span plus REST's tail, and coverage says what is certified", async () => {
    const archiveRepository = new AnalysisHistoryRepository(db);
    const archive = new AnalysisHistoryService(archiveRepository, info as unknown as HyperliquidInfoClient);
    const production = new TradeAnalyticsService(new TradeAnalyticsRepository(db), traders as unknown as TradersService, info as unknown as HyperliquidInfoClient, undefined, archive);
    // The archive holds hours T(30)…T(4); REST would return the same fills.
    const hour = (hoursAgo: number) => Math.floor(T(hoursAgo) / HOUR) * HOUR;
    const inside = [fill("BTC", 0, 1, 100, T(20)), fill("BTC", 1, -1, 110, T(10), { closedPnl: "10" })];
    const tail = fill("ETH", 0, 2, 50, T(1));
    history = [...inside, tail];
    await db.insert(archiveCoverage).values({ address: X, coveredFrom: new Date(hour(30)), coveredThrough: new Date(hour(4)) });
    await new HistoryFillStore(db).insert(inside.map((f) => ({ address: X, source: "regular" as const, origin: "s3" as const, fill: f })));
    info.userFillsByTime.mockClear();
    info.userTwapSliceFillsByTime.mockClear();
    traders.latestFills.mockClear();
    // The account still holds what the tail fill opened.
    livePositions = [["ETH", "2"]];

    await production.compute(X, true, { funding: false });
    await production.settled();
    // No cold read (range windows back from now) and no page before the
    // span: one REST range, from the end of the certified span.
    const ranges = info.userFillsByTime.mock.calls.map(([, start]) => start);
    expect(ranges).toEqual([hour(4) - 5 * 60_000]);
    // TWAP slices are not trusted to the archive by default: the latest
    // list (shared with the page's tabs), which here is short, so no range.
    expect(traders.latestFills).toHaveBeenCalledTimes(1);
    expect(info.userTwapSliceFillsByTime).not.toHaveBeenCalled();
    expect(production.lastLog.get(X)!.at(-1)).toMatchObject({ kind: "archive", fills: 3, trades: 2 });

    const result = await production.analytics(X, "all");
    expect(result.summary).toMatchObject({ trades: 1, wins: 1 });
    expect(result.coverage).toMatchObject({
      source: "hyperliquid", fills: 3, truncated: true, completeness: "partial", partialSince: new Date(inside[0].time),
      archiveFrom: new Date(hour(30) + 5 * 60_000), archiveThrough: new Date(hour(4) - 5 * 60_000),
      // What precedes the span is the durable job's work, in the worker.
      backfill: { status: "pending" },
    });
    const rows = await storedFills(db, X);
    expect(rows.map((row) => row.origin).sort()).toEqual(["rest", "s3", "s3"]);

    // The job then completes around the span (two ranges), and the next build is its snapshot.
    info.userFillsByTime.mockClear();
    expect(await archive.catchUp(X, 8)).toBe(true);
    expect(info.userFillsByTime.mock.calls.map(([, start, end]) => [start, end])[0]).toEqual([0, hour(30) + 5 * 60_000 - 1]);
    expect(info.userFillsByTime.mock.calls[1][1]).toBe(hour(4) - 5 * 60_000);
  });

  it("a tracked address adds archive fills older than our own fills table", async () => {
    tracked.add(TRACKED);
    const hour = (hoursAgo: number) => Math.floor(T(hoursAgo) / HOUR) * HOUR;
    // Our table starts mid-position; the archive holds the opening.
    const opening = fill("BTC", 0, 2, 100, T(50));
    const ours = fill("BTC", 2, -2, 120, T(5), { closedPnl: "40" });
    await db.insert(fills).values(toFillRow(TRACKED, ours));
    // REST no longer retains anything before T(10); the archive does.
    await db.insert(fillCoverage).values({ address: TRACKED, verifiedFrom: new Date(T(10)), verifiedThrough: new Date(NOW), backfillFloor: new Date(T(10)), backfillStatus: "retention" });
    await db.insert(archiveCoverage).values({ address: TRACKED, coveredFrom: new Date(hour(100)), coveredThrough: new Date(hour(8)) });
    await new HistoryFillStore(db).insert([{ address: TRACKED, source: "regular", origin: "s3", fill: opening }]);
    const archive = new AnalysisHistoryService(new AnalysisHistoryRepository(db), info as unknown as HyperliquidInfoClient);
    const production = new TradeAnalyticsService(new TradeAnalyticsRepository(db), traders as unknown as TradersService, info as unknown as HyperliquidInfoClient, undefined, archive);
    await production.compute(TRACKED, true, { funding: false });
    await production.settled();
    const result = await production.analytics(TRACKED, "all");
    // Whole trade, opened from flat: not partial, hence complete.
    expect(result.coverage).toMatchObject({ source: "tracked", fills: 2, truncated: false, completeness: "complete", partialSince: null });
    expect(result.summary).toMatchObject({ trades: 1, wins: 1 });
    const [trade] = await new TradeAnalyticsRepository(db).allTrades(TRACKED);
    expect(trade.entryTime).toBe(opening.time);
    tracked.delete(TRACKED);
  });

  it("a tracked address's history starts at the archive's first hour, past the REST backfill's 365-day reach, read page by page", async () => {
    tracked.add(TRACKED);
    const DAY = 24 * HOUR;
    const hour = (hoursAgo: number) => Math.floor(T(hoursAgo) / HOUR) * HOUR;
    // Opened 400 days ago (archive only), closed inside our verified span.
    const opening = fill("BTC", 0, 2, 100, NOW - 400 * DAY);
    const adds = Array.from({ length: 5 }, (_, i) => fill("BTC", 2 + i, 1, 100, NOW - 300 * DAY + i * HOUR));
    const ours = fill("BTC", 7, -7, 120, T(5), { closedPnl: "140" });
    await db.insert(fills).values(toFillRow(TRACKED, ours));
    await db.insert(fillCoverage).values({ address: TRACKED, verifiedFrom: new Date(T(10)), verifiedThrough: new Date(NOW), backfillFloor: new Date(T(10)), backfillStatus: "capped" });
    await db.insert(archiveCoverage).values({ address: TRACKED, coveredFrom: new Date(Math.floor((NOW - 401 * DAY) / HOUR) * HOUR), coveredThrough: new Date(hour(8)) });
    await new HistoryFillStore(db).insert([opening, ...adds].map((f) => ({ address: TRACKED, source: "regular" as const, origin: "s3" as const, fill: f })));
    const archiveRepository = new AnalysisHistoryRepository(db);
    const archive = new AnalysisHistoryService(archiveRepository, info as unknown as HyperliquidInfoClient);
    const pages = vi.spyOn(archive, "archivedFillPages");
    const production = new TradeAnalyticsService(new TradeAnalyticsRepository(db), traders as unknown as TradersService, info as unknown as HyperliquidInfoClient, undefined, archive);
    await production.compute(TRACKED, true, { funding: false });
    const result = await production.analytics(TRACKED, "all");
    expect(result.summary).toMatchObject({ trades: 1, wins: 1 });
    expect(result.coverage).toMatchObject({ source: "tracked", fills: 7, truncated: false, from: new Date(opening.time) });
    const [trade] = await new TradeAnalyticsRepository(db).allTrades(TRACKED);
    expect(trade.entryTime).toBe(opening.time);
    expect(pages).toHaveBeenCalledTimes(1);
    // A walk in pages of two: no millisecond is split, nothing read twice.
    const twin = fill("ETH", 0, 1, 10, adds[2].time);
    await new HistoryFillStore(db).insert([{ address: TRACKED, source: "regular", origin: "s3", fill: twin }]);
    const walked: number[][] = [];
    for await (const page of archiveRepository.archivedFillPages(TRACKED, NOW - 401 * DAY, T(10), 2)) walked.push(page.map((f) => f.tid));
    expect(walked.flat()).toEqual([opening, adds[0], adds[1], ...[adds[2], twin].sort((a, b) => a.tid - b.tid), adds[3], adds[4]].map((f) => f.tid));
    expect(walked.every((page) => page.length <= 2 || new Set(page.map((tid) => [opening, ...adds, twin].find((f) => f.tid === tid)!.time)).size === 1)).toBe(true);
    // The next refresh at the same depth does not walk the archive again.
    await db.execute(sql`update trader_analytics set computed_at = now() - interval '11 minutes'`);
    await production.compute(TRACKED, false, { funding: false });
    expect(pages).toHaveBeenCalledTimes(1);
    tracked.delete(TRACKED);
  });

  it("replaces a partial legacy entry with the archived opening and resets funding", async () => {
    const closing = fill("BTC", 1, -1, 110, T(2), { closedPnl: "10" });
    history = [closing];
    const archiveRepository = new AnalysisHistoryRepository(db);
    const archive = new AnalysisHistoryService(archiveRepository, info as unknown as HyperliquidInfoClient);
    const production = new TradeAnalyticsService(new TradeAnalyticsRepository(db), traders as unknown as TradersService, info as unknown as HyperliquidInfoClient, undefined, archive);
    await production.compute(X, true, { funding: false });
    await production.settled();
    const prior = await new TradeAnalyticsRepository(db).allTrades(X);
    expect(prior[0].openTid).toBeLessThan(0n);
    history.unshift(fill("BTC", 0, 1, 100, T(20)));
    await archive.advance((await archiveRepository.state(X))!);
    await production.compute(X, false, { funding: false });
    await production.settled();
    const result = await production.analytics(X, "all");
    expect(result.coverage).toMatchObject({ truncated: true, backfill: { status: "caught_up", retentionLimited: true } });
    expect(result.coverage.through).toBeInstanceOf(Date);
    expect(result.coverage.fundingFrom).toBeNull();
    const trades = await new TradeAnalyticsRepository(db).allTrades(X);
    expect(trades).toHaveLength(1);
    expect(trades[0].openTid).toBe(BigInt(history[0].tid));
    expect(trades[0].entryTime).toBe(T(20));
    expect(trades[0].fees).toBe(2);
  });

  it("keeps an archived open position at its cutoff even if it closed afterwards", async () => {
    history = [fill("BTC", 0, 1, 100, T(20))];
    const archiveRepository = new AnalysisHistoryRepository(db);
    await archiveRepository.ensure(X, T(10));
    const archive = new AnalysisHistoryService(archiveRepository, info as unknown as HyperliquidInfoClient);
    await archive.advance((await archiveRepository.state(X))!);
    history.push(fill("BTC", 1, -1, 110, T(2), { closedPnl: "10" }));
    livePositions = [];
    const production = new TradeAnalyticsService(new TradeAnalyticsRepository(db), traders as unknown as TradersService, info as unknown as HyperliquidInfoClient, undefined, archive);
    await production.compute(X, true, { funding: false });
    await production.settled();
    const trades = await production.trades(X, { status: "all", limit: 20 });
    expect(trades.coverage.through?.getTime()).toBe(T(10));
    expect(trades.items).toHaveLength(1);
    expect(trades.items[0].exitTime).toBeNull();
    await production.fundingStep(X);
    expect(info.userFunding.mock.calls.at(-1)?.[2]).toBe(T(10));
  });

  it("does not replace a longer existing ledger with shorter retained upstream history", async () => {
    await service.refresh(X);
    const before = await new TradeAnalyticsRepository(db).allTrades(X);
    const archiveRepository = new AnalysisHistoryRepository(db);
    await archiveRepository.ensure(X);
    const archive = new AnalysisHistoryService(archiveRepository, info as unknown as HyperliquidInfoClient);
    history = history.filter(f => f.time >= T(10));
    await archive.advance((await archiveRepository.state(X))!);
    const production = new TradeAnalyticsService(new TradeAnalyticsRepository(db), traders as unknown as TradersService, info as unknown as HyperliquidInfoClient, undefined, archive);
    await production.refresh(X);
    const after = await new TradeAnalyticsRepository(db).allTrades(X);
    expect(after.map(t => t.openTid)).toEqual(before.map(t => t.openTid));
    expect((await new TradeAnalyticsRepository(db).state(X))!.historyThrough).toBeNull();
  });

});
