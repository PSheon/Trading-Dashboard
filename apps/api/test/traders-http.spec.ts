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
import { InsightsService } from "../src/insights/insights.service.js";
import { SettingsService } from "../src/settings/settings.service.js";
import { parseLeaderboard } from "../src/traders/leaderboard.js";
import { LeaderboardIngestService } from "../src/traders/leaderboard-ingest.service.js";
import { PAGE_DEADLINE_MS, TradersController } from "../src/traders/traders.controller.js";
import { TradersService } from "../src/traders/traders.service.js";
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
    };
    ({ app, auth, settings } = await createAuthedApp({
      db,
      privy,
      controllers: [TradersController, InsightsController],
      providers: [
        {
          provide: TradersService,
          useFactory: (s: SettingsService) =>
            new TradersService(testConfig(), new TradersRepository(db), info as unknown as HyperliquidInfoClient, new RoundTripService(db), new LeaderboardIngestService(testConfig(), db, s), s),
          inject: [SettingsService],
        },
        { provide: InsightsService, useValue: new InsightsService(new InsightsRepository(db)) },
      ],
    }));
  });

  it("serves validated v1 discovery, profile, portfolio and insight DTOs", async () => {
    for (const path of ["/traders", `/traders/${A}`, `/traders/${A}/portfolio`, `/traders/${A}/fills`, "/insights/crowd"]) {
      const res = await request(app.getHttpServer()).get(path).set("x-api-contract", "1").expect(200);
      expect(res.body.success, path).toBe(true);
    }
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
      { coin: "USDC", token: 0, total: 250.5, px: 1, value: 250.5, priceKey: null },
      { coin: "HYPE", token: 150, total: 2, px: 50, value: 100, priceKey: "@107" },
      { coin: "+12301", token: null, total: 100, px: 0.25, value: 25, priceKey: "#12301" },
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
      let releaseState!: (v: typeof emptyState) => void;
      info.clearinghouseState.mockReturnValueOnce(new Promise((r) => (releaseState = r)));
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

      releaseState(emptyState);
      releaseTwap([]);
      await new Promise((r) => setTimeout(r, 20));
      const calls = info.clearinghouseState.mock.calls.length;
      expect((await request(app.getHttpServer()).get(`/traders/${C}`)).status).toBe(200);
      expect((await request(app.getHttpServer()).get(`/traders/${C}/activity`)).status).toBe(200);
      expect(info.clearinghouseState.mock.calls.length).toBe(calls); // served from the cache

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
