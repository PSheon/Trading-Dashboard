import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { adminAuditLogs } from "@trading-dashboard/shared/database";
import { auditResponseSchema } from "@trading-dashboard/shared/contracts";
import { AdminAuditController } from "../src/admin/admin-audit.controller.js";
import { AdminAuditRepository } from "../src/admin/admin-audit.repository.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";
const db = getTestDb();
let app: INestApplication;
const token = "audit-settings-only-service-token-1234567890";
beforeAll(async () => {
  vi.stubEnv("AUTH_SERVICE_TOKEN", token); vi.stubEnv("AUTH_SERVICE_PERMISSIONS", "settings.read");
  await truncateAll(db);
  await insertUser(db, { privyUserId: "did:privy:audit-admin", role: "admin" });
  ({ app } = await createAuthedApp({ db, privy: stubPrivy({ admin: { privyUserId: "did:privy:audit-admin" } }), controllers: [AdminAuditController], providers: [AdminAuditRepository] }));
});
afterAll(async () => { await app?.close(); await truncateAll(db); await closeTestDb(); vi.unstubAllEnvs(); });
it("protects recorded changes and paginates exact event/actor/target matches with lossless IDs", async () => {
  await db.insert(adminAuditLogs).values([
    { id: 9007199254740993n, actorKind: "system", event: "settings.update", target: "app_settings", beforeJson: { discovery: { candidatePoolSize: 1000 } }, afterJson: { discovery: { candidatePoolSize: 500 } } },
    { id: 9007199254740994n, actorKind: "system", event: "settings.update", target: "app_settings" },
    { id: 9007199254740995n, actorKind: "service", event: "job.retry", target: "1" },
  ]);
  await request(app.getHttpServer()).get("/admin/audit").expect(401);
  await request(app.getHttpServer()).get("/admin/audit").auth(token, { type: "bearer" }).expect(403);
  const get = (query: string) => request(app.getHttpServer()).get('/admin/audit' + query).auth("admin", { type: "bearer" });
  for (const query of ['?limit=101', '?beforeId=9223372036854775808', '?event=invalid', '?actorUserId=0']) await get(query).expect(400);
  const result = await get('?limit=1&event=settings.update&actorKind=system&target=app_settings').expect(200);
  expect(result.headers['cache-control']).toBe('no-store');
  const first = auditResponseSchema.parse(result.body.data);
  expect(first.items[0].id).toBe('9007199254740994');
  expect(first.nextCursor).toBe('9007199254740994');
  const next = await get('?limit=1&event=settings.update&beforeId=' + first.nextCursor).expect(200);
  expect(next.body.data).toMatchObject({ items: [{ id: '9007199254740993', before: { discovery: { candidatePoolSize: 1000 } } }], nextCursor: null });
});
