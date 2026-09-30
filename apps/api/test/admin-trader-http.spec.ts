import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  kolTraders,
  leaders,
  discoveryTraders,
  userFavorites,
  leaderLists,
  leaderListItems,
  backfillJobs,
  fills,
  traderAnalytics,
  analysisHistoryJobs,
} from "@trading-dashboard/shared/database";
import { AdminTraderController } from "../src/admin/admin-trader.controller.js";
import { AdminTraderRepository } from "../src/admin/admin-trader.repository.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import {
  getTestDb,
  closeTestDb,
  truncateAll,
  insertUser,
} from "./db-test-utils.js";
const db = getTestDb();
let app: INestApplication;
const address = "0x" + "ab".repeat(20);
const token = "admin-trader-read-service-token-123456789";
beforeAll(async () => {
  vi.stubEnv("AUTH_SERVICE_TOKEN", token);
  vi.stubEnv("AUTH_SERVICE_PERMISSIONS", "traders.read");
  await truncateAll(db);
  await insertUser(db, {
    privyUserId: "did:privy:trader-admin",
    role: "admin",
  });
  const user = await insertUser(db, { privyUserId: "did:privy:trader-user" });
  await db
    .insert(kolTraders)
    .values({ address, displayName: "Research", xHandle: "research" });
  await db
    .insert(discoveryTraders)
    .values({ address, inPool: true, lastError: "secret upstream body" });
  await db
    .insert(userFavorites)
    .values({ userId: user.id, address, alertEnabled: true });
  ({ app } = await createAuthedApp({
    db,
    privy: stubPrivy({
      admin: { privyUserId: "did:privy:trader-admin" },
      user: { privyUserId: "did:privy:trader-user" },
    }),
    controllers: [AdminTraderController],
    providers: [AdminTraderRepository],
  }));
});
afterAll(async () => {
  await app?.close();
  await truncateAll(db);
  await closeTestDb();
  vi.unstubAllEnvs();
});
const path = (a = address) => `/admin/traders/hyperliquid/${a}`;
it("requires a narrow permission, validates address and distinguishes registry from watched membership", async () => {
  const http = app.getHttpServer();
  await request(http).get(path()).expect(401);
  await request(http).get(path()).auth("user", { type: "bearer" }).expect(403);
  await request(http)
    .get(path("bad"))
    .auth(token, { type: "bearer" })
    .expect(400);
  await request(http)
    .get(`/admin/traders/other/${address}`)
    .auth(token, { type: "bearer" })
    .expect(400);
  const res = await request(http)
    .get(path("0x" + "AB".repeat(20)))
    .auth(token, { type: "bearer" })
    .expect(200);
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.body.data).toMatchObject({
    address,
    identity: { kolRegistered: true, displayName: "Research" },
    watch: null,
    discovery: { inPool: true, refreshFailed: true, portfolioAt: null },
    references: { favorites: 1, alerts: 1 },
    analytics: null,
    backfill: null,
  });
  expect(JSON.stringify(res.body.data)).not.toContain("secret upstream");
  expect(await db.select().from(leaders)).toHaveLength(0);
  expect(await db.select().from(backfillJobs)).toHaveLength(0);
});
it("shows absent records as missing and bounds historical import evidence without treating it as current membership", async () => {
  const missing = await request(app.getHttpServer())
    .get(path("0x" + "cd".repeat(20)))
    .auth("admin", { type: "bearer" })
    .expect(200);
  expect(missing.body.data).toMatchObject({
    identity: { kolRegistered: false },
    watch: null,
    discovery: null,
    references: { favorites: 0, alerts: 0 },
    fills: { firstAt: null, lastAt: null },
    history: null,
  });
  for (let i = 0; i < 21; i++) {
    const [list] = await db
      .insert(leaderLists)
      .values({ source: "test", fileName: "private.csv" })
      .returning();
    await db
      .insert(leaderListItems)
      .values({ listId: list.id, address, rank: i + 1 });
  }
  await db.insert(leaders).values({ address, active: false, source: "import" });
  await db
    .insert(backfillJobs)
    .values({
      address,
      source: "import",
      status: "failed",
      leaseToken: "private-lease",
    });
  const res = await request(app.getHttpServer())
    .get(path())
    .auth(token, { type: "bearer" })
    .expect(200);
  expect(res.body.data.watch).toMatchObject({
    active: false,
    source: "import",
  });
  expect(res.body.data.imports.items).toHaveLength(20);
  expect(res.body.data.imports.hasMore).toBe(true);
  expect(res.body.data.backfill.status).toBe("failed");
  expect(JSON.stringify(res.body.data)).not.toMatch(
    /private-lease|private.csv|leaseToken/,
  );
});

it("keeps fill event times, analytics coverage and history completion separate", async () => {
  const date = new Date("2026-09-01T00:00:00.000Z");
  await db
    .insert(fills)
    .values({
      address,
      tid: 1n,
      coin: "BTC",
      side: "B",
      dir: "Open Long",
      px: "100",
      sz: "1",
      fee: "0",
      ts: date,
      raw: {},
    });
  await db
    .insert(traderAnalytics)
    .values({
      address,
      source: "tracked",
      coverageFrom: date,
      computedAt: date,
      truncated: true,
      fillsRead: 1,
      summary: {},
      classification: {},
    });
  await db
    .insert(analysisHistoryJobs)
    .values({
      address,
      status: "caught_up",
      publishedThrough: date,
      checkpoint: {
        until: date.getTime(),
        sources: {
          regular: { cursor: 0, through: date.getTime(), status: "complete" },
          twap: { cursor: 0, through: date.getTime(), status: "complete" },
        },
        reason: null,
      },
    });
  const res = await request(app.getHttpServer())
    .get(path())
    .auth(token, { type: "bearer" })
    .expect(200);
  expect(res.body.data.fills).toEqual({
    firstAt: date.toISOString(),
    lastAt: date.toISOString(),
  });
  expect(res.body.data.analytics).toMatchObject({
    truncated: true,
    fillsRead: 1,
    historyThrough: null,
    fundingFrom: null,
    fundingThrough: null,
  });
  expect(res.body.data.history).toMatchObject({
    status: "caught_up",
    publishedThrough: date.toISOString(),
  });
});
