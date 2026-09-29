import { TradersRepository } from "../src/traders/traders.repository.js";
import type { INestApplication } from "@nestjs/common";
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
  };

  beforeAll(async () => {
    process.env.AUTH_SERVICE_TOKEN = "service-token-for-traders-0123456789";
    info = {
      perpDexs: vi.fn(async () => [null]),
      clearinghouseState: vi.fn(async () => emptyState),
      portfolio: vi.fn(async () => []),
      userFills: vi.fn(async () => []),
      userTwapSliceFills: vi.fn(async () => []),
    };
    ({ app, auth, settings } = await createAuthedApp({
      db,
      privy,
      controllers: [TradersController, InsightsController],
      providers: [
        {
          provide: TradersService,
          useFactory: (s: SettingsService) =>
            new TradersService(new TradersRepository(db), info as unknown as HyperliquidInfoClient, new RoundTripService(db), new LeaderboardIngestService(db, s), s),
          inject: [SettingsService],
        },
        { provide: InsightsService, useValue: new InsightsService(db) },
      ],
    }));
  });

  it("serves validated v1 discovery, profile, portfolio and insight DTOs", async () => {
    for (const path of ["/traders", `/traders/${A}`, `/traders/${A}/portfolio`, `/traders/${A}/fills`, "/insights/crowd"]) {
      const res = await request(app.getHttpServer()).get(path).set("x-api-contract", "1").expect(200);
      expect(res.body.success, path).toBe(true);
    }
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
    expect(mine.body.items.map((i: { address: string; favorite: boolean }) => [i.address, i.favorite])).toEqual([
      [A, false],
      [B, true],
    ]);
    const profile = await request(app.getHttpServer()).get(`/traders/${B}`).set("Authorization", "Bearer alice-token");
    expect(profile.body).toMatchObject({ favorite: true, isVault: false });
    expect(profile.body).not.toHaveProperty("sample");
    const activity = await request(app.getHttpServer()).get(`/traders/${B}/activity`);
    expect(activity.status).toBe(200);
    expect(activity.body).toMatchObject({
      address: B,
      lastTradeAt: null,
      sample: { fills30d: 0, capped: false, lowSample: true },
    });

    const anon = await request(app.getHttpServer()).get("/traders");
    expect(anon.body.items.some((i: { favorite: boolean }) => i.favorite)).toBe(false);
    expect((await request(app.getHttpServer()).get(`/traders/${B}`)).body.favorite).toBe(false);

    // A bad token on a public route is treated as anonymous, not rejected.
    const bad = await request(app.getHttpServer()).get("/traders").set("Authorization", "Bearer nope");
    expect(bad.status).toBe(200);
  });

  it("serves hideVaults, 400s and the crowd view without sign-in", async () => {
    const shown = await request(app.getHttpServer()).get("/traders?hideVaults=false");
    expect(shown.body.items[0]).toMatchObject({ address: V, isVault: true });
    expect((await request(app.getHttpServer()).get("/traders")).body.total).toBe(2);
    expect((await request(app.getHttpServer()).get("/traders?hideVaults=1")).status).toBe(400);
    expect((await request(app.getHttpServer()).get("/traders/0x123")).status).toBe(400);

    // Activity filter (§12): the holder only shows with active=any.
    const active = await request(app.getHttpServer()).get("/traders?active=any");
    expect(active.body.items[0]).toMatchObject({ address: H, activity: "inactive" });
    expect(active.body.total).toBe(3);
    expect((await request(app.getHttpServer()).get("/traders?active=month")).body.total).toBe(2);
    expect((await request(app.getHttpServer()).get("/traders?active=day")).body.total).toBe(0);
    expect((await request(app.getHttpServer()).get("/traders?active=inactive")).status).toBe(400);

    const crowd = await request(app.getHttpServer()).get("/insights/crowd");
    expect(crowd.status).toBe(200);
    expect(crowd.body).toEqual({ trackedTraders: 0, coins: [], updatedAt: null });
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
      expect(profile.body).toEqual({ statusCode: 503, code: "busy", message: expect.any(String), retryAfterSeconds: 5 });
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
