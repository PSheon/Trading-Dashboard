import type { INestApplication } from "@nestjs/common";
import { wireTraderAnalyticsSchema, wireTraderTradesSchema } from "@trading-dashboard/shared/contracts";
import { fills, traderAnalytics, traderTrades } from "@trading-dashboard/shared/database";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type { HlUserFill, HlUserFundingEntry } from "../src/hyperliquid/types.js";
import { TradeAnalyticsController } from "../src/traders/trade-analytics.controller.js";
import { TradeAnalyticsRepository } from "../src/traders/trade-analytics.repository.js";
import { STALE_MS, TradeAnalyticsService } from "../src/traders/trade-analytics.service.js";
import { PAGE_DEADLINE_MS } from "../src/traders/traders.controller.js";
import type { TradersService } from "../src/traders/traders.service.js";
import { toFillRow } from "../src/watcher/fill-row.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

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
    userTwapSliceFillsByTime: vi.fn(async (_address: string, start: number) =>
      history.filter((f) => f.twapId && f.time >= start).map((f) => ({ fill: { ...f, twapId: null }, twapId: f.twapId! })),
    ),
    clearinghouseState: vi.fn(async (_address: string, dex?: string) => ({
      time: Date.now(),
      marginSummary: { accountValue: "1250000" },
      assetPositions: dex ? [] : livePositions.map(([coin, szi]) => ({ position: { coin, szi } })),
    })),
    userFunding: vi.fn(async (_address: string, start: number) =>
      fundingEvents.filter((e) => e.time >= start).sort((a, b) => a.time - b.time),
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
    profileCache: { peek: () => undefined },
    userFillsCache: { peek: () => undefined },
    twapFillsCache: { peek: () => undefined },
    dexCache: { peek: () => undefined },
    leaderboardAllTimePnl: vi.fn(async (): Promise<number | null> => null),
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
    await app.close();
    await closeTestDb();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);

  it("answers 503 busy while a cold address computes, then serves it from the store", async () => {
    controller.pageDeadlineMs = 30;
    let release!: () => void;
    latestGate = new Promise((r) => (release = r));
    const busy = await get(`/traders/${X}/analytics`);
    expect(busy.status).toBe(503);
    expect(busy.headers["retry-after"]).toBe("5");
    expect(busy.body).toMatchObject({ code: "busy" });
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
    expect((await get(`/traders/${X}/analytics?window=7d`).expect(200)).body.summary).toMatchObject({ trades: 2 });
    // ETH closed 20 hours ago.
    expect((await get(`/traders/${X}/analytics?window=1d`).expect(200)).body.summary.trades).toBe(1);
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
    const next = await get(`/traders/${X}/trades?limit=2&cursor=${first.body.data.nextCursor}`).expect(200);
    expect(next.body.items.map((t: { coin: string }) => t.coin)).toEqual(["BTC"]);
    expect(next.body.nextCursor).toBeNull();
    expect((await get(`/traders/${X}/trades?status=open`)).body.items.map((t: { coin: string }) => t.coin)).toEqual(["SOL"]);
    expect((await get(`/traders/${X}/trades?status=closed`)).body.items).toHaveLength(2);
    expect((await get(`/traders/${X}/trades?cursor=abc`)).status).toBe(400);
  });

  it("refreshes incrementally: only fills after the cursor, continuing open trades", async () => {
    await service.compute(X, true);
    await waitFor(async () => (await db.select().from(traderAnalytics))[0]?.fundingCursor != null);
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
    expect(stale.body.summary.trades).toBe(2);
    await waitFor(async () => (await db.select().from(traderAnalytics))[0].fillCursor!.getTime() === T(0.5));
    expect(traders.latestFills).not.toHaveBeenCalled();
    expect(info.userFillsByTime.mock.calls.every(([, start]) => start === cursor)).toBe(true);

    await waitFor(async () => (await db.select().from(traderAnalytics))[0].fundingCursor!.getTime() === T(2));
    const res = await get(`/traders/${X}/analytics`).expect(200);
    expect(res.body.summary).toMatchObject({ trades: 3, wins: 2, openTrades: 1 });
    const sol = (await get(`/traders/${X}/trades?status=closed`)).body.items.find((t: { coin: string }) => t.coin === "SOL");
    // Funding of the SOL hold: −0.5 read cold, −0.25 on the refresh.
    expect(sol).toMatchObject({ realizedPnl: 10, funding: -0.75, exitPx: 12 });
    // ETH opened within funding coverage and received +0.25.
    const eth = (await get(`/traders/${X}/trades?status=closed`)).body.items.find((t: { coin: string }) => t.coin === "ETH");
    expect(eth.funding).toBe(0.25);
    expect(res.body.coverage.fundingFrom).not.toBeNull();
  });

  it("drops an open trade the account no longer holds (closed by fills we can't read)", async () => {
    livePositions = [];
    await service.compute(X, true);
    const res = await get(`/traders/${X}/trades?status=open`).expect(200);
    expect(res.body.items).toEqual([]);
    expect((await get(`/traders/${X}/analytics`)).body.summary).toMatchObject({ trades: 2, openTrades: 0 });
  });

  it("marks coverage truncated when history starts mid-position, and counts the partial trade", async () => {
    history.unshift(fill("DOGE", 100, -100, 0.1, T(60), { closedPnl: "3" }));
    traders.leaderboardAllTimePnl.mockResolvedValueOnce(2_000_000);
    await service.compute(X, true);
    const res = await get(`/traders/${X}/analytics`).expect(200);
    expect(res.body.coverage).toMatchObject({ truncated: true, fills: 7 });
    expect(res.body.summary).toMatchObject({ trades: 3, wins: 2 });
    expect(res.body.classification).toMatchObject({ allTimePnl: 2_000_000, pnlTier: "extremely_profitable" });
    const doge = (await get(`/traders/${X}/trades?status=closed`)).body.items.find((t: { coin: string }) => t.coin === "DOGE");
    expect(doge).toMatchObject({ partial: true, entryApprox: false, size: 100, netPnl: 2 });
    expect(doge.entryPx).toBeCloseTo(0.07);
  });

  it("rebuilds a tracked address from our fills table without reading Hyperliquid's fills", async () => {
    tracked.add(TRACKED);
    await db.insert(fills).values(history.map((f) => toFillRow(TRACKED, f)));
    await service.compute(TRACKED, true);
    expect(info.userFillsByTime).not.toHaveBeenCalled();
    expect(traders.latestFills).not.toHaveBeenCalled();
    const res = await get(`/traders/${TRACKED}/analytics`).expect(200);
    expect(res.body).toMatchObject({ coverage: { source: "tracked", fills: 6 }, summary: { trades: 2, winRate: 0.5 } });
    const stored = await db.select().from(traderTrades).where(eq(traderTrades.address, TRACKED));
    expect(stored).toHaveLength(3);
    expect(stored.find((t) => t.coin === "ETH")?.twap).toBe(true);
    // A rebuild keeps the same trades.
    await waitFor(async () => (await db.select().from(traderAnalytics))[0]?.fundingCursor != null);
    await db.execute(sql`update trader_analytics set computed_at = now() - interval '1 hour'`);
    await service.compute(TRACKED, false);
    expect(await db.select().from(traderTrades).where(eq(traderTrades.address, TRACKED))).toHaveLength(3);
  });
});
