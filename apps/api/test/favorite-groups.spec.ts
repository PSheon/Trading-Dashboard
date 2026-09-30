import type { INestApplication } from "@nestjs/common";
import { discoveryTraders, kolTraders, traderStats, userFavoriteGroupMembers, userFavorites } from "@trading-dashboard/shared/database";
import { wireFavoriteGroupSchema, wireTraderCardsSchema } from "@trading-dashboard/shared/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthService } from "../src/common/auth/auth.service.js";
import { DiscoveryController } from "../src/discovery/discovery.controller.js";
import { DiscoveryRepository } from "../src/discovery/discovery.repository.js";
import { DiscoveryService } from "../src/discovery/discovery.service.js";
import { TradersService } from "../src/traders/traders.service.js";
import { FavoriteGroupsController } from "../src/users/favorite-groups.controller.js";
import { FavoriteGroupsRepository } from "../src/users/favorite-groups.repository.js";
import { FavoriteGroupsService } from "../src/users/favorite-groups.service.js";
import { insertUser } from "./admin-test-utils.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

describe("favorite groups and watchlist cards (real Postgres)", () => {
  const db = getTestDb();
  let app: INestApplication;
  let auth: AuthService;
  let alice: number;
  let bob: number;
  const privy = stubPrivy({ "alice-token": { privyUserId: "did:privy:alice" }, "bob-token": { privyUserId: "did:privy:bob" } });

  beforeAll(async () => {
    ({ app, auth } = await createAuthedApp({
      db,
      privy,
      controllers: [FavoriteGroupsController, DiscoveryController],
      providers: [FavoriteGroupsRepository, FavoriteGroupsService, DiscoveryRepository, DiscoveryService, { provide: TradersService, useValue: { rawPortfolio: vi.fn() } }],
    }));
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    await truncateAll(db);
    auth.clearCache();
    alice = (await insertUser(db, { privyUserId: "did:privy:alice" })).id;
    bob = (await insertUser(db, { privyUserId: "did:privy:bob" })).id;
    await db.insert(userFavorites).values([{ userId: alice, address: addr(1) }, { userId: alice, address: addr(2) }, { userId: bob, address: addr(3) }]);
  });

  const as = (token: string) => (r: request.Test) => r.set("Authorization", `Bearer ${token}`);

  it("creates, lists, renames, fills and deletes a user's groups", async () => {
    const server = app.getHttpServer();
    const a = as("alice-token");
    await request(server).get("/me/favorite-groups").expect(401);
    const created = wireFavoriteGroupSchema.parse((await a(request(server).post("/me/favorite-groups").send({ name: "  Whales " })).expect(201)).body.data);
    expect(created).toMatchObject({ name: "Whales", color: "#ff7a45", sortOrder: 0, members: [] });
    const second = (await a(request(server).post("/me/favorite-groups").send({ name: "Scalpers", color: "#123456" })).expect(201)).body.data;
    expect(second).toMatchObject({ sortOrder: 1, color: "#123456" });
    expect((await a(request(server).post("/me/favorite-groups").send({ name: "Whales" })).expect(409)).body.error.code).toBe("group_exists");
    await a(request(server).post("/me/favorite-groups").send({ name: "x".repeat(21) })).expect(400);
    await a(request(server).post("/me/favorite-groups").send({ name: "ok", color: "red" })).expect(400);

    const withMember = (await a(request(server).put(`/me/favorite-groups/${created.id}/members/${addr(1).toUpperCase().replace("0X", "0x")}`)).expect(200)).body.data;
    expect(withMember.members).toEqual([addr(1)]);
    await a(request(server).put(`/me/favorite-groups/${created.id}/members/${addr(1)}`)).expect(200); // idempotent
    await a(request(server).put(`/me/favorite-groups/${created.id}/members/${addr(3)}`)).expect(404); // bob's favorite, not alice's
    await a(request(server).put(`/me/favorite-groups/${created.id}/members/${addr(2)}`)).expect(200);

    const renamed = (await a(request(server).patch(`/me/favorite-groups/${created.id}`).send({ name: "Big", sortOrder: 5 })).expect(200)).body.data;
    expect(renamed).toMatchObject({ name: "Big", sortOrder: 5, members: [addr(1), addr(2)] });
    await a(request(server).patch(`/me/favorite-groups/${created.id}`).send({ name: "Scalpers" })).expect(409);

    const list = (await a(request(server).get("/me/favorite-groups")).expect(200)).body.data;
    expect(list.map((g: { name: string }) => g.name)).toEqual(["Scalpers", "Big"]);

    await a(request(server).delete(`/me/favorite-groups/${created.id}/members/${addr(2)}`)).expect(204);
    await a(request(server).delete(`/me/favorite-groups/${created.id}`)).expect(204);
    await a(request(server).delete(`/me/favorite-groups/${created.id}`)).expect(204); // idempotent
    // The favorites themselves stay.
    expect((await db.select().from(userFavorites)).length).toBe(3);
  });

  it("keeps groups private and drops a member when it is unfavorited", async () => {
    const server = app.getHttpServer();
    const group = (await as("alice-token")(request(server).post("/me/favorite-groups").send({ name: "Mine" })).expect(201)).body.data;
    await as("bob-token")(request(server).get("/me/favorite-groups")).expect(200).expect((r) => expect(r.body.data).toEqual([]));
    await as("bob-token")(request(server).patch(`/me/favorite-groups/${group.id}`).send({ name: "Stolen" })).expect(404);
    await as("bob-token")(request(server).put(`/me/favorite-groups/${group.id}/members/${addr(3)}`)).expect(404);
    await as("alice-token")(request(server).put(`/me/favorite-groups/${group.id}/members/${addr(1)}`)).expect(200);
    await db.delete(userFavorites).where((await import("drizzle-orm")).eq(userFavorites.address, addr(1)));
    expect(await db.select().from(userFavoriteGroupMembers)).toEqual([]);
  });

  it("stops at 20 groups", async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 20; i++) await as("alice-token")(request(server).post("/me/favorite-groups").send({ name: `g${i}` })).expect(201);
    const res = await as("alice-token")(request(server).post("/me/favorite-groups").send({ name: "one more" })).expect(409);
    expect(res.body.error).toMatchObject({ code: "group_limit" });
  });

  it("serves watchlist cards from the pool, else the leaderboard, else identity only", async () => {
    const now = new Date();
    await db.insert(traderStats).values([1, 2].map((n) => ({
      address: addr(n), displayName: n === 2 ? "Board Two" : null, accountValue: "500", pnlDay: "0", pnlWeek: "0", pnlMonth: "12", pnlAllTime: String(n * 100),
      roiDay: "0", roiWeek: "0", roiMonth: "0.1", roiAllTime: "0.5", volumeDay: "0", volumeWeek: "0", volumeMonth: "1", volumeAllTime: "1", updatedAt: now,
    })));
    await db.insert(discoveryTraders).values({
      address: addr(1), poolRank: 1, portfolioAt: now, accountValue: "1000", pnlAll: "900", roiAll: "2", pnl30d: "40", sharpe: "1.5", maxDrawdown: "0.2", copyScore: 77,
      sparkline: [0, 5, 9], topCoins: ["BTC"], coinStats: { BTC: { pnl: 900, volume: 1, trades: 4, wins: 3 } },
    });
    await db.insert(kolTraders).values({ address: addr(3), displayName: "Kol Three", xHandle: "three", verified: true });
    const res = await request(app.getHttpServer()).get(`/discover/cards?addresses=${addr(2)},${addr(1)},${addr(3)},${addr(1)}`).expect(200);
    const { items } = wireTraderCardsSchema.parse(res.body.data);
    expect(items.map((c) => c.address)).toEqual([addr(2), addr(1), addr(3)]);
    expect(items[0]).toMatchObject({ source: "leaderboard", displayName: "Board Two", pnl: 200, roi: 0.5, pnl30d: 12, copyScore: null, sparkline: [], winRate: null });
    expect(items[1]).toMatchObject({ source: "pool", pnl: 900, roi: 2, pnl30d: 40, copyScore: 77, winRate: 0.75, sharpe: 1.5, maxDrawdown: 0.2, sparkline: [0, 5, 9] });
    expect(items[2]).toMatchObject({ source: "none", displayName: "Kol Three", kol: true, verified: true, xHandle: "three", avatarUrl: null, pnl: null });
    await request(app.getHttpServer()).get("/discover/cards?addresses=nope").expect(400);
    await request(app.getHttpServer()).get("/discover/cards").expect(400);
  });
});
