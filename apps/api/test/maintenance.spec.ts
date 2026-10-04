import { Controller, Get, Global, Module, Post, type INestApplication } from "@nestjs/common";
import { adminAuditLogs } from "@trading-dashboard/shared/database";
import { publicSettingsSchema } from "@trading-dashboard/shared/contracts";
import * as schema from "@trading-dashboard/shared/database";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminOverviewService } from "../src/admin/admin-overview.service.js";
import { AdminSettingsService } from "../src/admin/admin-settings.service.js";
import { AdminUsersService } from "../src/admin/admin-users.service.js";
import { AdminController, PublicSettingsController } from "../src/admin/admin.controller.js";
import { RevenueService } from "../src/admin/revenue.service.js";
import type { AuthService } from "../src/common/auth/auth.service.js";
import { Public } from "../src/common/auth/public.decorator.js";
import { SkipTransform } from "../src/common/decorators/http.decorator.js";
import { DATABASE_POOL } from "../src/db/drizzle.provider.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { SettingsRepository } from "../src/settings/settings.repository.js";
import { SettingsService } from "../src/settings/settings.service.js";
import { AccountDeletionService } from "../src/users/account-deletion.service.js";
import { AccountRepository } from "../src/users/account.repository.js";
import { FavoritesService } from "../src/users/favorites.service.js";
import { MeController } from "../src/users/me.controller.js";
import { ProfileRepository } from "../src/users/profile.repository.js";
import { ProfileService } from "../src/users/profile.service.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

const SERVICE_TOKEN = "maintenance-service-token-0123456789abcdef";

/** Stand-ins for a public write and for a write under /health. */
@SkipTransform()
@Controller()
class ProbeController {
  @Public() @Post("probe/write") write() { return { written: true }; }
  @Public() @Get("probe/read") read() { return { read: true }; }
  @Public() @Post("health/probe") health() { return { ok: true }; }
}

describe("maintenance mode (review finding 17)", () => {
  const db = getTestDb();
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const privy = stubPrivy({
    "admin-token": { privyUserId: "did:privy:m-admin", profile: { email: "ops@example.com", walletAddress: null } },
    "user-token": { privyUserId: "did:privy:m-user", profile: { email: "user@example.com", walletAddress: null } },
    "operator-token": { privyUserId: "did:privy:m-operator", profile: { email: "op@example.com", walletAddress: null } },
  });
  let app: INestApplication;
  let auth: AuthService;
  let settings: SettingsService;
  let adminId: number;

  // The app listens for saves made elsewhere, as a deployed process does.
  @Global() @Module({ providers: [{ provide: DATABASE_POOL, useValue: pool }], exports: [DATABASE_POOL] })
  class PoolModule {}

  const as = (token?: string) => {
    const set = (r: request.Test) => (token ? r.set("Authorization", `Bearer ${token}`) : r);
    return {
      get: (p: string) => set(request(app.getHttpServer()).get(p)),
      post: (p: string, body?: object) => set(request(app.getHttpServer()).post(p)).send(body),
      patch: (p: string, body?: object) => set(request(app.getHttpServer()).patch(p)).send(body),
    };
  };
  const maintenance = (o: Partial<{ enabled: boolean; message: { "zh-TW": string; en: string }; endsAt: string | null }> = {}) =>
    ({ enabled: true, message: { "zh-TW": "升級資料庫", en: "Database upgrade" }, endsAt: null, ...o });
  /** PATCH /admin/settings as `token`, against the revision an admin reads now; resolves to the response. */
  async function save(token: string, value: ReturnType<typeof maintenance>): Promise<request.Response> {
    const { revisions } = (await as("admin-token").get("/admin/settings").expect(200)).body.data;
    return await as(token).patch("/admin/settings", { general: { maintenance: value }, expectedRevisions: { general: revisions.general } });
  }

  beforeAll(async () => {
    vi.stubEnv("AUTH_SERVICE_TOKEN", SERVICE_TOKEN);
    vi.stubEnv("AUTH_SERVICE_PERMISSIONS", "admin.access,settings.read,settings.write");
    ({ app, auth, settings } = await createAuthedApp({
      db, privy, imports: [PoolModule],
      controllers: [AdminController, PublicSettingsController, MeController, ProbeController],
      providers: [
        AdminSettingsService, ProfileRepository, ProfileService, FavoritesService, AccountRepository, AccountDeletionService,
        { provide: RevenueService, useValue: { triggerSnapshot() {} } },
        { provide: AdminUsersService, useValue: {} },
        { provide: AdminOverviewService, useValue: {} },
      ],
    }));
  });

  beforeEach(async () => {
    await truncateAll(db);
    auth.clearCache();
    settings.invalidate();
    adminId = (await insertUser(db, { privyUserId: "did:privy:m-admin", email: "ops@example.com", role: "admin" })).id;
    await insertUser(db, { privyUserId: "did:privy:m-user", email: "user@example.com" });
    await insertUser(db, { privyUserId: "did:privy:m-operator", email: "op@example.com", role: "operator" });
  });

  afterAll(async () => {
    await app.close();
    await truncateAll(db);
    await pool.end();
    await closeTestDb();
    vi.unstubAllEnvs();
  });

  it("off by default: writes work and the public settings say so", async () => {
    await as("user-token").patch("/me", { displayName: "Before" }).expect(200);
    await as().post("/probe/write").expect(201);
    const pub = publicSettingsSchema.parse((await as().get("/settings").expect(200)).body.data);
    expect(pub.maintenance).toEqual({ enabled: false, message: { "zh-TW": "", en: "" }, endsAt: null });
  });

  it("on: writes are refused with 503 maintenance, reads keep working, admins and /health are exempt, and the change is audited", async () => {
    const endsAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const saved = await save("admin-token", maintenance({ endsAt }));
    expect(saved.status).toBe(200);
    expect(saved.body.data.general.maintenance).toEqual(maintenance({ endsAt }));

    const refused = await as("user-token").patch("/me", { displayName: "During" }).expect(503);
    expect(refused.body).toMatchObject({ success: false, statusCode: 503, error: { code: "maintenance" } });
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(29 * 60);
    expect(Number(refused.headers["retry-after"])).toBeLessThanOrEqual(30 * 60);
    expect((await as().post("/probe/write").expect(503)).body.error.code).toBe("maintenance");
    // Nothing was written.
    expect((await as("user-token").get("/me").expect(200)).body.data.displayName).toBeNull();

    // Reads, for everyone; the notice travels with the public settings.
    await as().get("/probe/read").expect(200);
    const pub = (await as().get("/settings").expect(200)).body.data;
    expect(pub.maintenance).toEqual(maintenance({ endsAt }));
    // The health routes, whatever the method.
    await as().post("/health/probe").expect(201);
    // Admins (a person or a service token with admin.access) keep working.
    await as("admin-token").patch("/me", { displayName: "Ops" }).expect(200);
    await as(SERVICE_TOKEN).post("/probe/write").expect(201);

    const audit = await db.select().from(adminAuditLogs);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ event: "settings.update", actorUserId: adminId,
      beforeJson: { general: { maintenance: { enabled: false } } }, afterJson: { general: { maintenance: { enabled: true, endsAt } } } });

    // Switching it off is itself a write: the admin can do it, and writes resume.
    expect((await save("admin-token", maintenance({ enabled: false }))).status).toBe(200);
    await as("user-token").patch("/me", { displayName: "After" }).expect(200);
    expect((await db.select().from(adminAuditLogs)).map((a) => a.event)).toEqual(["settings.update", "settings.update"]);
  });

  it("a user can't switch it on or off; an end time in the past sends no Retry-After and ends nothing by itself", async () => {
    expect((await save("user-token", maintenance())).status).toBe(403);
    expect((await save("admin-token", maintenance({ endsAt: new Date(Date.now() - 60_000).toISOString() }))).status).toBe(200);
    const refused = await as("user-token").patch("/me", { displayName: "Late" }).expect(503);
    expect(refused.headers["retry-after"]).toBeUndefined();
    // Not by a user either: the 503 comes before the permission check.
    await as("user-token").patch("/admin/settings", { general: { maintenance: maintenance({ enabled: false }) } }).expect(503);
  });

  it("a read-only operator is not exempt: their own writes wait like everyone's", async () => {
    expect((await save("admin-token", maintenance())).status).toBe(200);
    // admin.access lets an operator into the admin pages; it is not the exemption.
    expect((await as("operator-token").patch("/me", { displayName: "Op" }).expect(503)).body.error.code).toBe("maintenance");
    await as("operator-token").get("/admin/settings").expect(200);
    await as("admin-token").patch("/me", { displayName: "Ops" }).expect(200);
  });

  it("the whole value is required and validated", async () => {
    const { revisions } = (await as("admin-token").get("/admin/settings").expect(200)).body.data;
    const patch = (value: unknown) => as("admin-token").patch("/admin/settings", { general: { maintenance: value }, expectedRevisions: { general: revisions.general } });
    await patch({ enabled: true }).expect(400);
    await patch(maintenance({ endsAt: "tomorrow" })).expect(400);
    await patch({ ...maintenance(), until: "x" }).expect(400);
    await patch(maintenance({ message: { "zh-TW": "x".repeat(281), en: "" } })).expect(400);
    expect(await db.select().from(adminAuditLogs)).toEqual([]);
  });

  it("switched on from another process, this one refuses writes within a second (and accepts them again when it is switched off)", async () => {
    await as("user-token").patch("/me", { displayName: "Cached off" }).expect(200);
    const otherPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const otherDb = drizzle(otherPool, { schema });
    const other = new SettingsService(new SettingsRepository(otherDb), new UnitOfWork(otherDb));
    const status = async () => (await as("user-token").patch("/me", { displayName: "Probe" })).status;
    const within = async (expected: number) => {
      const started = performance.now();
      while ((await status()) !== expected) {
        if (performance.now() - started > 2000) throw new Error(`still not ${expected} after 2 s`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return performance.now() - started;
    };
    try {
      await other.patch({ general: { maintenance: maintenance() } }, adminId);
      expect(await within(503)).toBeLessThan(1000);
      await other.patch({ general: { maintenance: maintenance({ enabled: false }) } }, adminId);
      expect(await within(200)).toBeLessThan(1000);
    } finally { await otherPool.end(); }
  });
});
