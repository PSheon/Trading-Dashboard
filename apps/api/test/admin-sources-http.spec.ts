import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import {
  kolTraders,
  leaders,
  discoveryTraders,
} from "@trading-dashboard/shared/database";
import { AdminSourcesController } from "../src/admin/admin-sources.controller.js";
import { AdminSourcesRepository } from "../src/admin/admin-sources.repository.js";
import { ImportController } from "../src/import/import.controller.js";
import { ImportService } from "../src/import/import.service.js";
import { ImportRepository } from "../src/import/import.repository.js";
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
const token = "sources-read-only-token-123456789012345";
beforeAll(async () => {
  vi.stubEnv("AUTH_SERVICE_TOKEN", token);
  vi.stubEnv("AUTH_SERVICE_PERMISSIONS", "sources.read");
  await truncateAll(db);
  await insertUser(db, {
    privyUserId: "did:privy:sources-admin",
    role: "admin",
  });
  await insertUser(db, { privyUserId: "did:privy:sources-user" });
  await db.insert(kolTraders).values({ address });
  await db.insert(discoveryTraders).values({ address, inPool: true });
  await db.insert(leaders).values({ address, active: false });
  ({ app } = await createAuthedApp({
    db,
    privy: stubPrivy({
      admin: { privyUserId: "did:privy:sources-admin" },
      user: { privyUserId: "did:privy:sources-user" },
    }),
    controllers: [AdminSourcesController, ImportController],
    providers: [AdminSourcesRepository, ImportService, ImportRepository],
  }));
});
afterAll(async () => {
  await app?.close();
  await truncateAll(db);
  await closeTestDb();
  vi.unstubAllEnvs();
});
it("reports overlapping sets and absent telemetry without claiming all registered addresses are watched", async () => {
  const http = app.getHttpServer();
  await request(http).get("/admin/data-sources").expect(401);
  await request(http)
    .get("/admin/data-sources")
    .auth("user", { type: "bearer" })
    .expect(403);
  const r = await request(http)
    .get("/admin/data-sources")
    .auth(token, { type: "bearer" })
    .expect(200);
  expect(r.headers["cache-control"]).toBe("no-store");
  expect(r.body.data.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "kol", count: 1 }),
      expect.objectContaining({ id: "discovery", count: 1, latestAt: null }),
      expect.objectContaining({ id: "watched", count: 0, latestAt: null }),
      expect.objectContaining({ id: "leaderboard", count: 0, latestAt: null }),
    ]),
  );
});
it("gates import preview separately and returns structured errors without creating imports", async () => {
  const body = {
    source: "manual",
    fileName: "test.csv",
    rows: [
      { address, rank: 1 },
      { address: "bad", rank: 2 },
    ],
  };
  const http = app.getHttpServer();
  await request(http)
    .post("/import/lists/preview")
    .auth(token, { type: "bearer" })
    .send(body)
    .expect(403);
  const r = await request(http)
    .post("/import/lists/preview")
    .auth("admin", { type: "bearer" })
    .send(body)
    .expect(200);
  expect(r.body.data.canImport).toBe(false);
  expect(r.body.data.errors).toHaveLength(1);
  const s = await request(http)
    .get("/admin/data-sources")
    .auth(token, { type: "bearer" })
    .expect(200);
  expect(
    s.body.data.items.find((r: { id: string }) => r.id === "imports").count,
  ).toBe(0);
});
