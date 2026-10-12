import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminAuditController } from "../src/admin/admin-audit.controller.js";
import { AdminAuditRepository } from "../src/admin/admin-audit.repository.js";
import { AdminJobsController } from "../src/admin/admin-jobs.controller.js";
import { AdminSettingsRuntimeController } from "../src/admin/admin-settings-runtime.controller.js";
import { AdminSourcesController } from "../src/admin/admin-sources.controller.js";
import { AdminSourcesRepository } from "../src/admin/admin-sources.repository.js";
import { AdminSystemService } from "../src/admin/admin-system.service.js";
import { AdminTraderController } from "../src/admin/admin-trader.controller.js";
import { AdminTraderRepository } from "../src/admin/admin-trader.repository.js";
import { BackfillJobsRepository } from "../src/jobs/backfill-jobs.repository.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const SERVICE_TOKEN = "admin-access-guard-service-token-0123456789";
/** Every route-level permission of the five controllers, minus admin.access. */
const SCOPED = "audit.read,traders.read,sources.read,settings.read,jobs.read,jobs.retry";

const ROUTES: { name: string; send: (app: INestApplication) => request.Test }[] = [
  { name: "GET /admin/audit", send: (app) => request(app.getHttpServer()).get("/admin/audit") },
  { name: "GET /admin/traders/:chain/:address", send: (app) => request(app.getHttpServer()).get(`/admin/traders/hyperliquid/0x${"ab".repeat(20)}`) },
  { name: "GET /admin/data-sources", send: (app) => request(app.getHttpServer()).get("/admin/data-sources") },
  { name: "GET /admin/settings/runtime", send: (app) => request(app.getHttpServer()).get("/admin/settings/runtime") },
  { name: "GET /admin/jobs", send: (app) => request(app.getHttpServer()).get("/admin/jobs") },
  { name: "POST /admin/jobs/:id/retry", send: (app) => request(app.getHttpServer()).post("/admin/jobs/1/retry").send({ expectedVersion: 1 }) },
];

/** A route's own permission is not enough: every admin controller also
 * requires the class-level admin.access (review 2026-10-12). */
describe("admin controllers require admin.access", () => {
  const db = getTestDb();
  let app: INestApplication;

  beforeAll(async () => {
    vi.stubEnv("AUTH_SERVICE_TOKEN", SERVICE_TOKEN);
    await truncateAll(db);
    const system = { overview: vi.fn(async () => ({ sampledAt: new Date().toISOString(), worker: { state: "unknown", sample: null } })) };
    ({ app } = await createAuthedApp({
      db,
      privy: stubPrivy({}),
      controllers: [AdminAuditController, AdminTraderController, AdminSourcesController, AdminSettingsRuntimeController, AdminJobsController],
      providers: [AdminAuditRepository, AdminTraderRepository, AdminSourcesRepository, BackfillJobsRepository, { provide: AdminSystemService, useValue: system }],
    }));
  });

  beforeEach(() => { vi.stubEnv("AUTH_SERVICE_PERMISSIONS", SCOPED); });

  afterAll(async () => {
    await app?.close();
    await truncateAll(db);
    await closeTestDb();
    vi.unstubAllEnvs();
  });

  it.each(ROUTES)("refuses $name to a caller holding its permission but not admin.access", async (route) => {
    expect((await route.send(app).auth(SERVICE_TOKEN, { type: "bearer" })).status).toBe(403);
  });

  it("lets the same caller through once admin.access is granted", async () => {
    vi.stubEnv("AUTH_SERVICE_PERMISSIONS", `admin.access,${SCOPED}`);
    for (const route of ROUTES) {
      expect([401, 403], route.name).not.toContain((await route.send(app).auth(SERVICE_TOKEN, { type: "bearer" })).status);
    }
  });
});
