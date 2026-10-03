import type { INestApplication } from "@nestjs/common";
import { discoveryTraders, kolTraders, traderStats } from "@trading-dashboard/shared/database";
import { wireTraderCardsSchema } from "@trading-dashboard/shared/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DiscoveryController } from "../src/discovery/discovery.controller.js";
import { DiscoveryRepository } from "../src/discovery/discovery.repository.js";
import { DiscoveryService } from "../src/discovery/discovery.service.js";
import { MarketCatalogService } from "../src/hyperliquid/market-catalog.service.js";
import { TradersService } from "../src/traders/traders.service.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

describe("watchlist cards (real Postgres)", () => {
  const db = getTestDb();
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createAuthedApp({
      db,
      privy: stubPrivy({}),
      controllers: [DiscoveryController],
      providers: [DiscoveryRepository, DiscoveryService, { provide: TradersService, useValue: { rawPortfolio: vi.fn() } }, { provide: MarketCatalogService, useValue: { isListed: vi.fn(async () => null) } }],
    }));
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("serves watchlist cards from the pool, else the leaderboard, else identity only", async () => {
    const now = new Date();
    await db.insert(traderStats).values([1, 2].map((n) => ({
      address: addr(n), displayName: n === 2 ? "Board Two" : null, accountValue: "500", pnlDay: "0", pnlWeek: "0", pnlMonth: "12", pnlAllTime: String(n * 100),
      roiDay: "0", roiWeek: "0", roiMonth: "0.1", roiAllTime: "0.5", volumeDay: "0", volumeWeek: "0", volumeMonth: "1", volumeAllTime: "1", updatedAt: now,
    })));
    await db.insert(discoveryTraders).values({
      address: addr(1), poolRank: 1, portfolioAt: now, accountValue: "1000", pnlAll: "900", roiAll: "2", pnl30d: "40", sharpe: "1.5", maxDrawdown: "0.2", returnSamples: 10, spanDays: "100", copyScore: 77,
      sparkline: [0, 5, 9], topCoins: ["BTC"], coinStats: { BTC: { pnl: 900, volume: 1, trades: 4, wins: 3 } },
    });
    await db.insert(kolTraders).values({ address: addr(3), displayName: "Kol Three", xHandle: "three", verified: true });
    const res = await request(app.getHttpServer()).get(`/discover/cards?addresses=${addr(2)},${addr(1)},${addr(3)},${addr(1)}`).expect(200);
    const { items } = wireTraderCardsSchema.parse(res.body.data);
    expect(items.map((c) => c.address)).toEqual([addr(2), addr(1), addr(3)]);
    expect(items[0]).toMatchObject({ source: "leaderboard", displayName: "Board Two", pnl: 200, roi: 0.5, pnl30d: 12, copyScore: null, sparkline: [], winRate: null });
    expect(items[1]).toMatchObject({ source: "pool", pnl: 900, roi: 2, pnl30d: 40, copyScore: 49, winRate: 0.75, sharpe: 1.5, maxDrawdown: 0.2, sparkline: [0, 5, 9] });
    expect(items[2]).toMatchObject({ source: "none", displayName: "Kol Three", kol: true, verified: true, xHandle: "three", avatarUrl: null, pnl: null });
    await request(app.getHttpServer()).get("/discover/cards?addresses=nope").expect(400);
    await request(app.getHttpServer()).get("/discover/cards").expect(400);
  });
});
