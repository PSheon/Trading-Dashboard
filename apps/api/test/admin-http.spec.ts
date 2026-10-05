import { AdminOverviewRepository } from "../src/admin/admin-overview.repository.js";
import { AdminUsersRepository } from "../src/admin/admin-users.repository.js";
import { RevenueRepository } from "../src/admin/revenue.repository.js";
import type { AuthService } from "../src/common/auth/auth.service.js";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminOverviewService } from "../src/admin/admin-overview.service.js";
import { AdminSettingsService } from "../src/admin/admin-settings.service.js";
import { AdminUsersService } from "../src/admin/admin-users.service.js";
import { AdminController, PublicSettingsController } from "../src/admin/admin.controller.js";
import { RevenueService } from "../src/admin/revenue.service.js";
import { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import { insertUser } from "./admin-test-utils.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const SERVICE_TOKEN = "service-token-for-admin-http-0123456789";

/** The real guard (stubbed Privy) in front of the admin routes. */
describe("admin routes over HTTP", () => {
  const db = getTestDb();
  const privy = stubPrivy({
    "admin-token": { privyUserId: "did:privy:admin" },
    "user-token": { privyUserId: "did:privy:user" },
  });
  let app: INestApplication;
  let auth: AuthService;

  beforeAll(async () => {
    process.env.AUTH_SERVICE_TOKEN = SERVICE_TOKEN;
    const info = { referral: vi.fn(async () => { throw new Error("offline"); }) };
    ({ app, auth } = await createAuthedApp({
      db,
      privy,
      controllers: [AdminController, PublicSettingsController],
      providers: [AdminOverviewRepository, AdminUsersRepository,
        AdminSettingsService,
        AdminUsersService,
        AdminOverviewService,
        RevenueRepository,
        RevenueService,
        { provide: HyperliquidInfoClient, useValue: info },
      ],
    }));
  });

  beforeEach(async () => {
    delete process.env.AUTH_SERVICE_PERMISSIONS;
    auth.clearCache();
    await truncateAll(db);
    await insertUser(db, { privyUserId: "did:privy:admin", role: "admin" });
    await insertUser(db, { privyUserId: "did:privy:user" });
  });

  afterAll(async () => {
    delete process.env.AUTH_SERVICE_TOKEN;
    delete process.env.AUTH_SERVICE_PERMISSIONS;
    await app.close();
    await truncateAll(db);
    await closeTestDb();
  });

  const get = (path: string, token?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };

  it("serves validated v1 DTOs for all admin reads", async () => {
    for (const path of ["/admin/settings", "/admin/users", "/admin/overview", "/admin/revenue", "/settings"]) {
      const res = await get(path, "admin-token").set("x-api-contract", "1").expect(200);
      expect(res.body.success, path).toBe(true);
    }
  });

  it("a service token without permissions cannot read administrative data", async () => {
    await request(app.getHttpServer()).get("/admin/users").set("Authorization", `Bearer ${SERVICE_TOKEN}`).expect(403);
  });

  it("a read-scoped service cannot mutate users or read unrelated settings", async () => {
    process.env.AUTH_SERVICE_PERMISSIONS = "admin.access,users.read";
    try {
      await request(app.getHttpServer()).get("/admin/users").set("Authorization", `Bearer ${SERVICE_TOKEN}`).expect(200);
      await request(app.getHttpServer()).patch("/admin/users/1").set("Authorization", `Bearer ${SERVICE_TOKEN}`).send({ role: "user" }).expect(403);
      await request(app.getHttpServer()).get("/admin/settings").set("Authorization", `Bearer ${SERVICE_TOKEN}`).expect(403);
    } finally {
      delete process.env.AUTH_SERVICE_PERMISSIONS;
    }
  });

  it("lets admins and explicitly scoped services in, and keeps everyone else out", async () => {
    // The class's admin.access is required too: a method's own permission
    // adds to it rather than replacing it (gap audit 2026-10-05).
    process.env.AUTH_SERVICE_PERMISSIONS = "settings.read,users.read,overview.read,revenue.read";
    for (const path of ["/admin/settings", "/admin/users", "/admin/overview", "/admin/revenue"]) expect((await get(path, SERVICE_TOKEN)).status, path).toBe(403);
    process.env.AUTH_SERVICE_PERMISSIONS = "admin.access,settings.read,users.read,overview.read,revenue.read";
    for (const path of ["/admin/settings", "/admin/users", "/admin/overview", "/admin/revenue"]) {
      expect((await get(path)).status, path).toBe(401);
      expect((await get(path, "forged")).status, path).toBe(401);
      expect((await get(path, "user-token")).status, path).toBe(403);
      expect((await get(path, "admin-token")).status, path).toBe(200);
      expect((await get(path, SERVICE_TOKEN)).status, path).toBe(200);
    }
  });

  it("rejects stale section edits and leaves unrelated settings intact", async () => {
    const initial = (await get("/admin/settings", "admin-token").expect(200)).body.data;
    expect(initial.revisions?.general).toEqual(expect.any(String));
    const patch = (body: object) => request(app.getHttpServer()).patch("/admin/settings")
      .set("Authorization", "Bearer admin-token").send(body);
    await patch({ general: { signupsOpen: false }, expectedRevisions: { general: initial.revisions.general } }).expect(200);
    await patch({ general: { ...initial.general, copyTradingEnabled: true }, expectedRevisions: { general: initial.revisions.general } }).expect(409);
    const latest = (await get("/admin/settings", "admin-token").expect(200)).body.data;
    expect(latest.general).toMatchObject({ signupsOpen: false, copyTradingEnabled: false });
    await patch({ discovery: { lowSampleThreshold: 42 }, expectedRevisions: { discovery: initial.revisions.discovery } }).expect(200);
  });

  it("requires preconditions and rejects unknown fields or empty writes", async () => {
    const patch = (body: object) => request(app.getHttpServer()).patch("/admin/settings")
      .set("Authorization", "Bearer admin-token").send(body);
    await patch({ general: { signupsOpen: false } }).expect(428);
    for (const body of [{}, { general: {} }, { general: { copyTradingEnable: true } }, { typo: {} },
      { general: { announcement: { enabled: true, text: { en: "", "zh-TW": "", typo: "x" } } } }]) {
      await patch(body).expect(400);
    }
  });

  it("serves the public settings to anyone", async () => {
    const res = await get("/settings");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ lowSampleThreshold: 20 });
    expect(res.body.data).not.toHaveProperty("builderAddress");
  });

  it("an operator reads every admin page here and can change nothing", async () => {
    const users = await get("/admin/users?q=", "admin-token");
    const target = users.body.data.items.find((u: { role: string }) => u.role === "user");
    const patch = (path: string, body: object, token: string) => request(app.getHttpServer()).patch(path).set("Authorization", `Bearer ${token}`).send(body);
    await patch(`/admin/users/${target.id}`, { role: "operator" }, "admin-token").expect(200);

    for (const path of ["/admin/users", "/admin/settings", "/admin/overview", "/admin/revenue"]) {
      expect((await get(path, "user-token")).status, path).toBe(200);
    }
    const me = (await get("/admin/users?role=operator", "user-token")).body.data.items;
    expect(me).toHaveLength(1);
    const admin = users.body.data.items.find((u: { role: string }) => u.role === "admin");
    const { revisions } = (await get("/admin/settings", "user-token")).body.data;
    // Not other users, not themself, not the settings.
    expect((await patch(`/admin/users/${admin.id}`, { disabled: true }, "user-token")).body.error.code).toBe("insufficient_permissions");
    await patch(`/admin/users/${target.id}`, { role: "admin" }, "user-token").expect(403);
    await patch("/admin/settings", { general: { signupsOpen: false }, expectedRevisions: { general: revisions.general } }, "user-token").expect(403);
    expect((await get("/admin/settings", "admin-token")).body.data.general.signupsOpen).toBe(true);
    expect((await get("/admin/users?role=admin", "admin-token")).body.data.items).toHaveLength(1);
    // Back to a plain user: the admin area closes on the very next request.
    await patch(`/admin/users/${target.id}`, { role: "user" }, "admin-token").expect(200);
    expect((await get("/admin/users", "user-token")).status).toBe(403);
  });

  it("applies a promotion or a disable to the user's very next request", async () => {
    expect((await get("/admin/users", "user-token")).status).toBe(403); // now cached as a plain user
    const users = await get("/admin/users?q=", "admin-token");
    const target = users.body.data.items.find((u: { role: string }) => u.role === "user");

    await request(app.getHttpServer())
      .patch(`/admin/users/${target.id}`)
      .set("Authorization", "Bearer admin-token")
      .send({ role: "admin" })
      .expect(200);
    expect((await get("/admin/users", "user-token")).status).toBe(200);

    await request(app.getHttpServer())
      .patch(`/admin/users/${target.id}`)
      .set("Authorization", "Bearer admin-token")
      .send({ disabled: true })
      .expect(200);
    expect((await get("/admin/users", "user-token")).status).toBe(401);
  });
});
