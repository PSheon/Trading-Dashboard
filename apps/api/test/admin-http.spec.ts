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

  beforeAll(async () => {
    process.env.AUTH_SERVICE_TOKEN = SERVICE_TOKEN;
    const info = { referral: vi.fn(async () => { throw new Error("offline"); }) };
    ({ app } = await createAuthedApp({
      db,
      privy,
      controllers: [AdminController, PublicSettingsController],
      providers: [
        AdminSettingsService,
        AdminUsersService,
        AdminOverviewService,
        RevenueService,
        { provide: HyperliquidInfoClient, useValue: info },
      ],
    }));
  });

  beforeEach(async () => {
    await truncateAll(db);
    await insertUser(db, { privyUserId: "did:privy:admin", role: "admin" });
    await insertUser(db, { privyUserId: "did:privy:user" });
  });

  afterAll(async () => {
    await app.close();
    await truncateAll(db);
    await closeTestDb();
  });

  const get = (path: string, token?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };

  it("lets admins and the service token in, and keeps everyone else out", async () => {
    for (const path of ["/admin/settings", "/admin/users", "/admin/overview", "/admin/revenue"]) {
      expect((await get(path)).status, path).toBe(401);
      expect((await get(path, "forged")).status, path).toBe(401);
      expect((await get(path, "user-token")).status, path).toBe(403);
      expect((await get(path, "admin-token")).status, path).toBe(200);
      expect((await get(path, SERVICE_TOKEN)).status, path).toBe(200);
    }
  });

  it("serves the public settings to anyone", async () => {
    const res = await get("/settings");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ lowSampleThreshold: 20 });
    expect(res.body).not.toHaveProperty("builderAddress");
  });

  it("applies a promotion or a disable to the user's very next request", async () => {
    expect((await get("/admin/users", "user-token")).status).toBe(403); // now cached as a plain user
    const users = await get("/admin/users?q=", "admin-token");
    const target = users.body.items.find((u: { role: string }) => u.role === "user");

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
