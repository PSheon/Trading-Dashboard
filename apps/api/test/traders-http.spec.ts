import { UnitOfWork } from "../src/db/unit-of-work.js";
import { LeaderboardIngestRepository } from "../src/traders/leaderboard-ingest.repository.js";
import { RoundTripRepository } from "../src/analytics/round-trip.repository.js";
import { InsightsRepository } from "../src/insights/insights.repository.js";
import { testConfig } from "./config-test-utils.js";
import { TradersRepository } from "../src/traders/traders.repository.js";
import type { INestApplication } from "@nestjs/common";
import { wireTraderProfileSchema } from "@trading-dashboard/shared/contracts";
import { traderStats, userFavorites, users } from "@trading-dashboard/shared/database";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RoundTripService } from "../src/analytics/round-trip.service.js";
import type { AuthService } from "../src/common/auth/auth.service.js";
import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";

import { InsightsController } from "../src/insights/insights.controller.js";
import { CohortService } from "../src/insights/cohort.service.js";
import { InsightsService } from "../src/insights/insights.service.js";
import { SettingsService } from "../src/settings/settings.service.js";
import { parseLeaderboard } from "../src/traders/leaderboard.js";
import { LeaderboardIngestService } from "../src/traders/leaderboard-ingest.service.js";
import { PAGE_DEADLINE_MS, TradersController } from "../src/traders/traders.controller.js";
import { TradersService } from "../src/traders/traders.service.js";
import type { TraderOrdersReader } from "../src/traders/trader-orders-reader.js";
import type { TraderTwapReader } from "../src/traders/trader-twap-reader.js";
import type { TraderAccountReader } from "../src/traders/trader-account-reader.js";
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const A = `0x${"a1".repeat(20)}`;
const B = `0x${"b2".repeat(20)}`;
const V = `0x${"f6".repeat(20)}`;

const emptyState = {
  assetPositions: [],
  marginSummary: { accountValue: "0", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "0" },
  crossMarginSummary: { accountValue: "0", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "0" },
  withdrawable: "0",
  time: 0,
};

/** A holder: no volume in 30 days, so the default activity filter hides it. */
const H = `0x${"09".repeat(20)}`;

const row = (address: string, month: number, vlm = 1) => ({
  ethAddress: address,
  accountValue: "1000",
  windowPerformances: [["month", { pnl: String(month), roi: "0", vlm: String(vlm) }]] as Array<
    [string, { pnl: string; roi: string; vlm: string }]
  >,
});

/** The real guard (stubbed Privy) in front of the public discovery routes. */
describe("public discovery routes over HTTP", () => {
  const db = getTestDb();
  const privy = stubPrivy({ "alice-token": { privyUserId: "did:privy:alice" } });
  let app: INestApplication;
  let auth: AuthService;
  let settings: SettingsService;
  const orderReader = { read: vi.fn<TraderOrdersReader['read']>(async (_user: string, dexes: readonly string[]) => ({ dexes: [...dexes], orders: dexes.map(() => []), observedAt: Date.now() })) };
  const twapReader = { read: vi.fn<TraderTwapReader['read']>(async () => ({ history: [], sourceTime: null, coverage: 'provider_snapshot', observedAt: Date.now() })) };
  const accountReader = { read: vi.fn<TraderAccountReader['read']>(async (_user, dexes) => ({ states: new Map(dexes.map(dex => [dex, emptyState])), missingDexes: [], observedAt: Date.now() })) };
  let info: {
    perpDexs: ReturnType<typeof vi.fn>;
    clearinghouseState: ReturnType<typeof vi.fn>;
    portfolio: ReturnType<typeof vi.fn>;
    userFills: ReturnType<typeof vi.fn>;
    userTwapSliceFills: ReturnType<typeof vi.fn>;
    spotClearinghouseState: ReturnType<typeof vi.fn>;
    spotMetaAndAssetCtxs: ReturnType<typeof vi.fn>;
    allMids: ReturnType<typeof vi.fn>;
    userAbstraction: ReturnType<typeof vi.fn>;
    delegatorSummary: ReturnType<typeof vi.fn>;
    frontendOpenOrders: ReturnType<typeof vi.fn>;
    twapHistory: ReturnType<typeof vi.fn>;
    userNonFundingLedgerUpdates: ReturnType<typeof vi.fn>;
  };

  beforeAll(async () => {
    process.env.AUTH_SERVICE_TOKEN = "service-token-for-traders-0123456789";
    info = {
      perpDexs: vi.fn(async () => [null]),
      clearinghouseState: vi.fn(async () => emptyState),
      portfolio: vi.fn(async () => []),
      userFills: vi.fn(async () => []),
      userTwapSliceFills: vi.fn(async () => []),
      spotClearinghouseState: vi.fn(async () => ({
        balances: [
          { coin: "USDC", token: 0, total: "250.5", hold: "0", entryNtl: "0" },
          { coin: "HYPE", token: 150, total: "2", hold: "0", entryNtl: "0" },
          { coin: "+12301", total: "100", hold: "0", entryNtl: "0" },
        ],
      })),
      spotMetaAndAssetCtxs: vi.fn(async () => [
        { tokens: [{ name: "USDC", index: 0 }, { name: "HYPE", index: 150 }], universe: [{ name: "@107", index: 107, tokens: [150, 0] }] },
        [{ coin: "@107", markPx: "50", midPx: "50" }],
      ]),
      allMids: vi.fn(async () => ({ "#12301": "0.25" })),
      userAbstraction: vi.fn(async () => "unifiedAccount"),
      delegatorSummary: vi.fn(async () => ({ delegated: "1", undelegated: "0", totalPendingWithdrawal: "0", nPendingWithdrawals: 0 })),
      frontendOpenOrders: vi.fn(async () => []),
      twapHistory: vi.fn(async () => []),
      userNonFundingLedgerUpdates: vi.fn(async () => []),
    };
    ({ app, auth, settings } = await createAuthedApp({
      db,
      privy,
      controllers: [TradersController, InsightsController],
      providers: [
        {
          provide: TradersService,
          useFactory: (s: SettingsService) =>
            new TradersService(testConfig(), new TradersRepository(db), info as unknown as HyperliquidInfoClient, new RoundTripService(new RoundTripRepository(db)), new LeaderboardIngestService(testConfig(), new LeaderboardIngestRepository(db), new UnitOfWork(db), s), s, undefined, undefined, undefined, undefined, orderReader as unknown as TraderOrdersReader, twapReader as unknown as TraderTwapReader, accountReader as unknown as TraderAccountReader),
          inject: [SettingsService],
        },
        { provide: InsightsService, useValue: new InsightsService(new InsightsRepository(db)) },
        // The cohort routes are covered by cohorts.spec.ts.
        { provide: CohortService, useValue: {} },
      ],
    }));
  });

  it("serves validated v1 discovery, profile, portfolio and insight DTOs", async () => {
    for (const path of ["/traders", `/traders/${A}`, `/traders/${A}/portfolio`, `/traders/${A}/fills`, "/insights/crowd"]) {
      const res = await request(app.getHttpServer()).get(path).set("x-api-contract", "1").expect(200);
      expect(res.body.success, path).toBe(true);
    }
  });

  it('loads all profile venues from one snapshot and retains the original observation time', async () => {
    const address = `0x${'42'.repeat(20)}`, service = app.get(TradersService);
    const dexes = ['', 'xyz', 'flx'], observedAt = Date.now() - 4000;
    service.ordersDexCache.set('dexes', dexes); accountReader.read.mockClear(); info.clearinghouseState.mockClear();
    accountReader.read.mockResolvedValueOnce({ states: new Map(dexes.map(dex => [dex, emptyState])), missingDexes: [], observedAt });
    try {
      const res = await request(app.getHttpServer()).get(`/traders/${address}`).expect(200);
      expect(accountReader.read).toHaveBeenCalledExactlyOnceWith(address, dexes);
      expect(info.clearinghouseState).not.toHaveBeenCalled();
      expect(res.body.data.perpEquity).toBe(0);
      expect(res.body.data.dataQuality.sources.perps.asOf).toBe(new Date(observedAt).toISOString());
      expect(res.body.data.dataQuality.sources['perp:xyz'].asOf).toBe(new Date(observedAt).toISOString());
    } finally { service.ordersDexCache.set('dexes', ['']); }
  });

  it('names a missing venue and shows the known parts instead of inventing zero equity or nulling the account', async () => {
    const address = `0x${'43'.repeat(20)}`, service = app.get(TradersService), observedAt = Date.now();
    service.ordersDexCache.set('dexes', ['', 'xyz']);
    accountReader.read.mockResolvedValueOnce({ states: new Map([['', emptyState]]), missingDexes: ['xyz'], observedAt });
    try {
      const res = await request(app.getHttpServer()).get(`/traders/${address}`).expect(200);
      expect(res.body.data.perpEquity).toBe(0); expect(res.body.data.unavailableParts).toEqual({ perpDexes: ['xyz'], staking: false });
      expect(res.body.data.accountValue).not.toBeNull();
      expect(res.body.data.dataQuality.partial).toBe(true);
      expect(res.body.data.dataQuality.sources['perp:xyz']).toMatchObject({ status: 'unavailable', asOf: null });
    } finally { service.ordersDexCache.set('dexes', ['']); }
  });

  it("serves the 訂單 / TWAP / 轉帳 tabs through the wire contract, cached", async () => {
    const D = `0x${"d4".repeat(20)}`;
    app.get(TradersService).ordersDexCache.set("dexes", ["", "xyz", "flx"]);
    orderReader.read.mockImplementation(async (_user: string, dexes: readonly string[]) => ({ dexes: [...dexes], observedAt: Date.now(), orders: dexes.map(dex =>
      dex === "xyz"
        ? [{ coin: "xyz:INTC", side: "A", limitPx: "94.5", sz: "0.0", oid: 2, timestamp: 1_789_984_198_470, triggerCondition: "Price below 105",
            isTrigger: true, triggerPx: "105.0", isPositionTpsl: true, reduceOnly: true, orderType: "Stop Market", origSz: "0.0" }]
        : [{ coin: "BTC", side: "B", limitPx: "60000", sz: "0.5", oid: 1, timestamp: 1_789_984_000_000, triggerCondition: "N/A",
            isTrigger: false, triggerPx: "0.0", isPositionTpsl: false, reduceOnly: false, orderType: "Limit", origSz: "1.0" }]) }));
    twapReader.read.mockResolvedValueOnce({ sourceTime: 1_790_000_000_000, coverage: 'provider_snapshot', observedAt: Date.now(), history: [
      { time: 1_790_000_000, twapId: 7, status: { status: "activated" },
        state: { coin: "ETH", side: "B", sz: "10", executedSz: "0.0", executedNtl: "0.0", minutes: 60, reduceOnly: false, randomize: true, timestamp: 1_790_000_000_000 } },
    ] });
    info.userTwapSliceFills.mockResolvedValueOnce([
      { twapId: 7, fill: { coin: "ETH", px: "2500", sz: "2.5", side: "B", time: 1_790_000_100_000, tid: 99, closedPnl: "0", fee: "0.1", dir: "Open Long", hash: "0x0", oid: 5, crossed: true } },
    ]);
    info.userNonFundingLedgerUpdates.mockResolvedValueOnce([
      { time: 1_790_000_000_000, hash: "0xabc", delta: { type: "send", user: D, destination: A, token: "USDC", amount: "200.0", usdcValue: "200.0", fee: "0" } },
      { time: 1_790_000_500_000, hash: "0xdef", delta: { type: "deposit", usdc: "1000.0" } },
    ]);
    // Unified (the default mock): every dex is asked, without clearinghouse reads.
    const orders = await request(app.getHttpServer()).get(`/traders/${D}/orders`).set("x-api-contract", "1").expect(200);
    expect(orders.body.success).toBe(true);
    expect(orders.body.data.dexes).toEqual(["", "xyz", "flx"]);
    expect(orders.body.data.orders.map((o: { oid: string; triggerPx: number | null }) => [o.oid, o.triggerPx])).toEqual([["1", null], ["2", 105]]);
    await request(app.getHttpServer()).get(`/traders/${D}/orders`).expect(200);
    expect(orderReader.read).toHaveBeenCalledTimes(1); // the second complete snapshot is cached
    expect(info.frontendOpenOrders).not.toHaveBeenCalled();

    const twap = await request(app.getHttpServer()).get(`/traders/${D}/twap`).set("x-api-contract", "1").expect(200);
    expect(twap.body.data.twaps).toEqual([expect.objectContaining({ twapId: 7, coin: "ETH", side: "buy", size: 10, filledSize: 2.5, filledFraction: 0.25, minutes: 60 })]);
    expect(info.twapHistory).not.toHaveBeenCalled();

    const transfers = await request(app.getHttpServer()).get(`/traders/${D}/transfers`).set("x-api-contract", "1").expect(200);
    expect(transfers.body.data.transfers.map((t: { kind: string; direction: string; amount: number }) => [t.kind, t.direction, t.amount]))
      .toEqual([["deposit", "in", 1000], ["sent", "out", 200]]);
    expect(transfers.body.data.truncated).toBe(false);
    expect((await request(app.getHttpServer()).get("/traders/0x12/orders")).status).toBe(400);
    app.get(TradersService).ordersDexCache.set("dexes", [""]);
  });

  it("reads every venue even when an account has no position or margin there", async () => {
    const address = `0x${"e5".repeat(20)}`, service = app.get(TradersService);
    const dexes = ["", "xyz", "flx"];
    service.ordersDexCache.set("dexes", dexes);
    orderReader.read.mockClear();
    orderReader.read.mockImplementation(async (_user, supplied) => ({ dexes: [...supplied], orders: supplied.map(() => []), observedAt: Date.now() }));
    info.frontendOpenOrders.mockClear(); info.clearinghouseState.mockClear(); info.userAbstraction.mockClear();
    try {
      const res = await request(app.getHttpServer()).get(`/traders/${address}/orders`).expect(200);
      expect(res.body.data.dexes).toEqual(dexes);
      expect(orderReader.read).toHaveBeenCalledWith(address, dexes);
      expect(info.frontendOpenOrders).not.toHaveBeenCalled();
      expect(info.clearinghouseState).not.toHaveBeenCalled(); expect(info.userAbstraction).not.toHaveBeenCalled();
    } finally { service.ordersDexCache.set("dexes", [""]); }
  });

  it('returns retryable capacity failure rather than an empty TWAP history and then recovers the full snapshot', async () => {
    const address = `0x${'f1'.repeat(20)}`;
    twapReader.read.mockClear();
    twapReader.read.mockRejectedValueOnce(new LiveBoundaryError('hyperliquid_quota_connections'));
    const denied = await request(app.getHttpServer()).get(`/traders/${address}/twap`).set('x-api-contract', '1').expect(503);
    expect(denied.headers['retry-after']).toBe('5'); expect(denied.body.error.code).toBe('busy');
    const observedAt = Date.now() - 500;
    twapReader.read.mockResolvedValueOnce({ history: [], coverage: 'provider_snapshot', sourceTime: null, observedAt });
    const recovered = await request(app.getHttpServer()).get(`/traders/${address}/twap`).expect(200);
    expect(recovered.body.data.twaps).toEqual([]); expect(new Date(recovered.body.data.fetchedAt).getTime()).toBe(observedAt);
    expect(twapReader.read).toHaveBeenCalledTimes(2); expect(info.twapHistory).not.toHaveBeenCalled();
  });

  it("retains no partial order result after a failed complete scan and retries the whole coverage", async () => {
    const address = `0x${"37".repeat(20)}`, service = app.get(TradersService);
    service.ordersDexCache.set("dexes", ["", "xyz", "flx"]);
    orderReader.read.mockClear();
    orderReader.read.mockRejectedValueOnce(new DOMException("Request deadline", "AbortError"));
    orderReader.read.mockImplementation(async (_user, dexes) => ({ dexes: [...dexes], orders: dexes.map(() => []), observedAt: Date.now() }));
    try {
      await request(app.getHttpServer()).get(`/traders/${address}/orders`).expect(503);
      const retry = await request(app.getHttpServer()).get(`/traders/${address}/orders`).expect(200);
      expect(retry.body.data.dexes).toEqual(["", "xyz", "flx"]);
      expect(orderReader.read).toHaveBeenCalledTimes(2);
    } finally { service.ordersDexCache.set("dexes", [""]); }
  });

  it("keeps the original oldest venue time and expires the aggregate cache with it", async () => {
    const address = `0x${"38".repeat(20)}`, service = app.get(TradersService);
    const observedAt = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(observedAt + 4000);
    service.ordersDexCache.set("dexes", ["", "xyz"]); orderReader.read.mockClear();
    orderReader.read.mockResolvedValueOnce({ dexes: ["", "xyz"], orders: [[], []], observedAt });
    orderReader.read.mockImplementation(async (_user, dexes) => ({ dexes: [...dexes], orders: dexes.map(() => []), observedAt: Date.now() }));
    try {
      expect((await service.orders(address)).fetchedAt.getTime()).toBe(observedAt);
      clock.mockReturnValue(observedAt + 29999); await service.orders(address);
      expect(orderReader.read).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(observedAt + 30001);
      expect((await service.orders(address)).fetchedAt.getTime()).toBe(observedAt + 30001);
      expect(orderReader.read).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); service.ordersDexCache.set("dexes", [""]); }
  });

  it("includes listed venues with no streaming markets in the order coverage", async () => {
    const address = `0x${"39".repeat(20)}`, service = app.get(TradersService);
    service.ordersDexCache.clear();
    info.perpDexs.mockResolvedValueOnce([null, { name: "xyz", assetToStreamingOiCap: [] }]);
    orderReader.read.mockImplementation(async (_user, dexes) => ({ dexes: [...dexes], orders: dexes.map(() => []), observedAt: Date.now() }));
    try {
      const res = await request(app.getHttpServer()).get(`/traders/${address}/orders`).expect(200);
      expect(res.body.data.dexes).toEqual(["", "xyz"]);
    } finally { service.ordersDexCache.set("dexes", [""]); }
  });

  it("sends the profile's total, its parts and the spot balances through the wire contract", async () => {
    const res = await request(app.getHttpServer()).get(`/traders/${A}`).set("x-api-contract", "1").expect(200);
    const parsed = wireTraderProfileSchema.safeParse(res.body.data);
    expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(true);
    // Unified: spot (250.5 USDC + 2 HYPE × 50 + 100 outcome × 0.25) + 1
    // staked HYPE; the (empty) perp state isn't added.
    expect(res.body.data).toMatchObject({
      accountMode: "unified",
      perpEquity: 0,
      spotValue: 375.5,
      stakedValue: 50,
      accountValue: 425.5,
      perpDexes: [""],
    });
    expect(res.body.data.spotBalances).toEqual([
      { coin: "USDC", token: 0, total: 250.5, hold: 0, px: 1, value: 250.5, priceKey: null },
      { coin: "HYPE", token: 150, total: 2, hold: 0, px: 50, value: 100, priceKey: "@107" },
      { coin: "+12301", token: null, total: 100, hold: 0, px: 0.25, value: 25, priceKey: "#12301" },
    ]);
    // A response without the new fields no longer satisfies the contract.
    const { perpEquity: _p, ...stale } = res.body.data;
    expect(wireTraderProfileSchema.safeParse(stale).success).toBe(false);
  });

  beforeEach(async () => {
    await truncateAll(db);
    auth.clearCache();
    await settings.patch({ discovery: {} }, null);
    const at = new Date();
    await db
      .insert(traderStats)
      .values(parseLeaderboard({ leaderboardRows: [row(A, 2), row(B, 1), row(V, 3), row(H, 9, 0)] }, at, new Set([V])));
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it("fills in `favorite` for a signed-in caller and leaves it false anonymously", async () => {
    // First signed-in request creates Alice's user row.
    const first = await request(app.getHttpServer()).get("/traders").set("Authorization", "Bearer alice-token");
    expect(first.status).toBe(200);
    const [alice] = await db.select().from(users).where(eq(users.privyUserId, "did:privy:alice"));
    await db.insert(userFavorites).values({ userId: alice.id, address: B });

    const mine = await request(app.getHttpServer()).get("/traders").set("Authorization", "Bearer alice-token");
    expect(mine.body.meta.pagination).toEqual({ type: "offset", limit: 50, offset: 0, total: mine.body.data.total, hasMore: false });
    expect(mine.body.data.items.map((i: { address: string; favorite: boolean }) => [i.address, i.favorite])).toEqual([
      [A, false],
      [B, true],
    ]);
    const profile = await request(app.getHttpServer()).get(`/traders/${B}`).set("Authorization", "Bearer alice-token");
    expect(profile.body.data).toMatchObject({ favorite: true, isVault: false });
    expect(profile.body.data).not.toHaveProperty("sample");
    const activity = await request(app.getHttpServer()).get(`/traders/${B}/activity`);
    expect(activity.status).toBe(200);
    expect(activity.body.data).toMatchObject({
      address: B,
      lastTradeAt: null,
      sample: { fills30d: 0, capped: false, lowSample: true },
    });

    const anon = await request(app.getHttpServer()).get("/traders");
    expect(anon.body.data.items.some((i: { favorite: boolean }) => i.favorite)).toBe(false);
    expect((await request(app.getHttpServer()).get(`/traders/${B}`)).body.data.favorite).toBe(false);

    // A bad token on a public route is treated as anonymous, not rejected.
    const bad = await request(app.getHttpServer()).get("/traders").set("Authorization", "Bearer nope");
    expect(bad.status).toBe(200);
  });

  it("serves hideVaults, 400s and the crowd view without sign-in", async () => {
    const shown = await request(app.getHttpServer()).get("/traders?hideVaults=false");
    expect(shown.body.data.items[0]).toMatchObject({ address: V, isVault: true });
    expect((await request(app.getHttpServer()).get("/traders")).body.data.total).toBe(2);
    expect((await request(app.getHttpServer()).get("/traders?hideVaults=1")).status).toBe(400);
    expect((await request(app.getHttpServer()).get("/traders/0x123")).status).toBe(400);

    // Activity filter (§12): the holder only shows with active=any.
    const active = await request(app.getHttpServer()).get("/traders?active=any");
    expect(active.body.data.items[0]).toMatchObject({ address: H, activity: "inactive" });
    expect(active.body.data.total).toBe(3);
    expect((await request(app.getHttpServer()).get("/traders?active=month")).body.data.total).toBe(2);
    expect((await request(app.getHttpServer()).get("/traders?active=day")).body.data.total).toBe(0);
    expect((await request(app.getHttpServer()).get("/traders?active=inactive")).status).toBe(400);

    const crowd = await request(app.getHttpServer()).get("/insights/crowd");
    expect(crowd.status).toBe(200);
    expect(crowd.body.data).toEqual({ trackedTraders: 0, coins: [], updatedAt: null, comparison: { currentTraders: 0, pastTraders: 0, matchedTraders: 0 } });
  });

  it("answers 503 busy with Retry-After past the page deadline, and the retry gets the finished work", async () => {
    const controller = app.get(TradersController);
    controller.pageDeadlineMs = 50;
    try {
      const C = `0x${"c3".repeat(20)}`;
      // Hyperliquid (or the budget queue in front of it) is slow.
      let releaseState!: (v: Awaited<ReturnType<TraderAccountReader['read']>>) => void;
      accountReader.read.mockReturnValueOnce(new Promise((r) => (releaseState = r)));
      let releaseTwap!: (v: unknown[]) => void;
      info.userTwapSliceFills.mockReturnValueOnce(new Promise((r) => (releaseTwap = r)));

      const profile = await request(app.getHttpServer()).get(`/traders/${C}`);
      expect(profile.status).toBe(503);
      expect(profile.headers["retry-after"]).toBe("5");
      expect(profile.body).toMatchObject({ statusCode: 503, error: { code: "busy", details: { retryAfterSeconds: 5 } } });
      const activity = await request(app.getHttpServer()).get(`/traders/${C}/activity`);
      expect(activity.status).toBe(503);
      expect(activity.headers["retry-after"]).toBe("5");

      const versioned = await request(app.getHttpServer()).get(`/traders/${C}`).set("x-api-contract", "1");
      expect(versioned.status).toBe(503);
      expect(versioned.headers["retry-after"]).toBe("5");
      expect(versioned.body).toMatchObject({ success: false, error: { code: "busy", details: { retryAfterSeconds: 5 } } });

      releaseState({ states: new Map([['', emptyState]]), missingDexes: [], observedAt: Date.now() });
      releaseTwap([]);
      await new Promise((r) => setTimeout(r, 20));
      const calls = accountReader.read.mock.calls.length;
      expect((await request(app.getHttpServer()).get(`/traders/${C}`)).status).toBe(200);
      expect((await request(app.getHttpServer()).get(`/traders/${C}/activity`)).status).toBe(200);
      expect(accountReader.read.mock.calls.length).toBe(calls); // served from the cache

      // Other upstream failures stay 502, without Retry-After.
      info.portfolio.mockRejectedValueOnce(new Error("Hyperliquid info request failed: 500"));
      const failed = await request(app.getHttpServer()).get(`/traders/${C}/portfolio`);
      expect(failed.status).toBe(502);
      expect(failed.headers["retry-after"]).toBeUndefined();
    } finally {
      controller.pageDeadlineMs = PAGE_DEADLINE_MS;
    }
  });
});
