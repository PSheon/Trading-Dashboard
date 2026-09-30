import { AdminSettingsRuntimeController } from "../src/admin/admin-settings-runtime.controller.js";
import request from "supertest";
import { Pool } from "pg";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, expect, it } from "vitest";
import { discoveryTraders } from "@trading-dashboard/shared/database";
import { adminSystemSchema } from "@trading-dashboard/shared/contracts";
import { AdminSystemController } from "../src/admin/admin-system.controller.js";
import { AdminSystemRepository } from "../src/admin/admin-system.repository.js";
import { AdminSystemService } from "../src/admin/admin-system.service.js";
import { RequestBudgeterService } from "../src/hyperliquid/request-budgeter.service.js";
import { DATABASE_POOL } from "../src/db/drizzle.provider.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

// getTestDb first enforces the local *_test database guard.
const db = getTestDb();
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3, connectionTimeoutMillis: 2000 });
const repository = new AdminSystemRepository(pool);
let app: INestApplication;
beforeAll(async () => {
  await truncateAll(db);
  await insertUser(db, { privyUserId: "did:privy:monitor-admin", role: "admin" });
  await insertUser(db, { privyUserId: "did:privy:monitor-user", role: "user" });
  ({app} = await createAuthedApp({ db,
    privy: stubPrivy({ "admin": {privyUserId: "did:privy:monitor-admin"}, "user": {privyUserId: "did:privy:monitor-user"} }),
    controllers: [AdminSystemController, AdminSettingsRuntimeController],
    providers: [AdminSystemRepository, AdminSystemService, RequestBudgeterService, {provide: DATABASE_POOL, useValue: pool}],
  }));
});
afterAll(async () => { await app?.close(); await truncateAll(db); await pool.end(); await closeTestDb(); });
it("requires administrator access and emits the registered wire contract", async () => {
  await request(app.getHttpServer()).get("/admin/system/overview").expect(401);
  await request(app.getHttpServer()).get("/admin/system/overview").auth("user", {type: "bearer"}).expect(403);
  const result = await request(app.getHttpServer()).get("/admin/system/overview").auth("admin", {type: "bearer"}).expect(200);
  expect(result.headers["cache-control"]).toBe("no-store");
  const data = adminSystemSchema.parse(result.body.data);
  expect(data.database.state).toBe("available");
  expect(data.outbox).toHaveLength(2);
  expect(data.outbox?.[0].oldestDueAt).toBeNull();
});
it("counts missing coverage separately and releases every pooled connection", async () => {
  await db.insert(discoveryTraders).values([
    { address: "0x" + "1".repeat(40), portfolioAt: new Date("2026-01-01T00:00:00Z"), lastError: "upstream" },
    { address: "0x" + "2".repeat(40), tradesAt: new Date("2026-01-02T00:00:00Z") },
    { address: "0x" + "3".repeat(40), inPool: false, portfolioAt: new Date() },
  ]);
  const data = await repository.data();
  expect(data).toMatchObject({candidates: 2, portfolios: 1, trades: 1, errors: 1, oldestPortfolioAt: "2026-01-01T00:00:00.000Z"});
  expect(data.freshness).toMatchObject({ portfolioStale: 1, portfolioMissing: 1, tradesStale: 1, tradesMissing: 1, portfolioThresholdMinutes: 1440 });
  for (let i = 0; i < 6; i++) await repository.probe();
  expect(pool.idleCount).toBe(pool.totalCount);
});

it("protects settings runtime telemetry and leaves unacknowledged consumers unknown", async () => {
  await request(app.getHttpServer()).get("/admin/settings/runtime").expect(401);
  await request(app.getHttpServer()).get("/admin/settings/runtime").auth("user", { type: "bearer" }).expect(403);
  const result = await request(app.getHttpServer()).get("/admin/settings/runtime").auth("admin", { type: "bearer" }).expect(200);
  expect(result.headers["cache-control"]).toBe("no-store");
  expect(result.body.data.savedRevision).toMatch(/^[a-f0-9]{64}$/);
  expect(result.body.data.consumers).toEqual([]);
});
