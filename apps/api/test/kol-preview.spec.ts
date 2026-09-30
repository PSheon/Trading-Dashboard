import { beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import {
  kolTraders,
  leaders,
  userFavorites,
  adminAuditLogs,
} from "@trading-dashboard/shared/database";
import { KolRepository } from "../src/discovery/kol.repository.js";
import { KolService } from "../src/discovery/kol.service.js";
import { AdminKolController } from "../src/discovery/discovery.controller.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import {
  getTestDb,
  closeTestDb,
  truncateAll,
  insertUser,
} from "./db-test-utils.js";
const db = getTestDb();
const service = new KolService(new KolRepository(db), new UnitOfWork(db));
let app: INestApplication;
const a = "0x" + "aa".repeat(20),
  b = "0x" + "bb".repeat(20),
  c = "0x" + "cc".repeat(20);
beforeAll(async () => {
  ({ app } = await createAuthedApp({
    db,
    privy: stubPrivy({
      admin: { privyUserId: "did:privy:kol-review-admin" },
      user: { privyUserId: "did:privy:kol-review-user" },
    }),
    controllers: [AdminKolController],
    providers: [KolRepository, KolService],
  }));
});
beforeEach(async () => {
  await truncateAll(db);
  await insertUser(db, {
    role: "admin",
    privyUserId: "did:privy:kol-review-admin",
  });
  const u = await insertUser(db, { privyUserId: "did:privy:kol-review-user" });
  await db.insert(kolTraders).values([
    {
      address: a,
      displayName: "Manual name",
      xHandle: "manual",
      verified: true,
      sortOrder: 9,
    },
    { address: b, displayName: "Retain watch" },
  ]);
  await db.insert(leaders).values({ address: b, active: true });
  await db
    .insert(userFavorites)
    .values({ userId: u.id, address: b, alertEnabled: true });
});
afterAll(async () => {
  await app?.close();
  await truncateAll(db);
  await closeTestDb();
});
it("previews blank overwrites and removals without changing registry, watches, favorites or audit", async () => {
  const csv = `address,display_name,x_handle,verified,sort_order\n${a},,,,1\n${c},New,,,2`;
  const p = await service.previewImport(csv, true);
  expect(p).toMatchObject({
    inserted: 1,
    changed: 1,
    unchanged: 0,
    removed: 1,
    errorCount: 0,
    deletionsSuppressed: false,
    canImport: true,
  });
  expect(p.items).toContainEqual(
    expect.objectContaining({
      address: a,
      kind: "update",
      before: expect.objectContaining({
        displayName: "Manual name",
        verified: true,
      }),
      after: expect.objectContaining({
        displayName: null,
        xHandle: null,
        verified: false,
      }),
    }),
  );
  expect(await db.select().from(kolTraders)).toHaveLength(2);
  expect(await db.select().from(adminAuditLogs)).toHaveLength(0);
  const result = await service.importCsv(csv, true, null);
  expect(result).toMatchObject({ inserted: 1, updated: 1, removed: 1 });
  expect(await db.select().from(leaders)).toMatchObject([
    { address: b, active: true },
  ]);
  expect(await db.select().from(userFavorites)).toMatchObject([
    { address: b, alertEnabled: true },
  ]);
});
it("preserves actual partial-upsert semantics when replace includes invalid rows", async () => {
  const csv = `address,display_name\n${a},Changed\nbad,Invalid`;
  const p = await service.previewImport(csv, true);
  expect(p).toMatchObject({
    changed: 1,
    removed: 0,
    errorCount: 1,
    deletionsSuppressed: true,
    canImport: true,
  });
  expect(await service.importCsv(csv, true, null)).toMatchObject({
    updated: 1,
    removed: 0,
  });
  expect(await db.select().from(kolTraders)).toHaveLength(2);
});
it("handles header-only replacement, unchanged rows and duplicate last-valid-wins consistently", async () => {
  expect(await service.previewImport("address", true)).toMatchObject({
    removed: 2,
    canImport: true,
  });
  expect(await service.previewImport("address", false)).toMatchObject({
    removed: 0,
    canImport: false,
  });
  const csv = `address,display_name,x_handle,verified,sort_order\n${a},First,manual,true,9\n${a},Manual name,manual,true,9`;
  expect(await service.previewImport(csv, false)).toMatchObject({
    changed: 0,
    unchanged: 1,
    duplicateRows: 1,
  });
});
it("requires KOL permission and exposes a no-store bounded preview", async () => {
  const http = app.getHttpServer();
  const body = { csv: "address", replace: true };
  await request(http).post("/admin/kols/import/preview").send(body).expect(401);
  await request(http)
    .post("/admin/kols/import/preview")
    .auth("user", { type: "bearer" })
    .send(body)
    .expect(403);
  const r = await request(http)
    .post("/admin/kols/import/preview")
    .auth("admin", { type: "bearer" })
    .send(body)
    .expect(200);
  expect(r.headers["cache-control"]).toBe("no-store");
  expect(r.body.data.removed).toBe(2);
  await request(http)
    .post("/admin/kols/import/preview")
    .auth("admin", { type: "bearer" })
    .send({ csv: "bad header" })
    .expect(400);
});

it("bounds per-row preview details while preserving full impact counts", async () => {
  const csv =
    "address\n" +
    Array.from(
      { length: 101 },
      (_, i) => "0x" + (i + 1).toString(16).padStart(40, "0"),
    ).join("\n");
  const p = await service.previewImport(csv, false);
  expect(p.inserted).toBe(101);
  expect(p.items).toHaveLength(100);
  expect(p.hasMore).toBe(true);
});
