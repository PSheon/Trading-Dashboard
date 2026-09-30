import { AdminUsersRepository } from "../src/admin/admin-users.repository.js";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { adminAuditLogs, users } from "@trading-dashboard/shared/database";
import { AdminUsersService } from "../src/admin/admin-users.service.js";
import type { AuthService } from "../src/common/auth/auth.service.js";
import { SettingsService } from "../src/settings/settings.service.js";
import { SettingsRepository } from "../src/settings/settings.repository.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { getTestDb, truncateAll, closeTestDb } from "./db-test-utils.js";
const db = getTestDb();
const auth = { invalidateUser: vi.fn() } as unknown as AuthService;
const service = new AdminUsersService(new AdminUsersRepository(db), new UnitOfWork(db), auth);
beforeEach(async () => { vi.clearAllMocks(); await truncateAll(db); });
afterAll(closeTestDb);

it("records role/disable before and after with the real actor, retaining history after deletion", async () => {
  const [actor] = await db.insert(users).values({ privyUserId: "did:privy:actor", role: "admin" }).returning();
  const [target] = await db.insert(users).values({ privyUserId: "did:privy:target" }).returning();
  await service.patch(target.id, { role: "admin" }, { kind: "user", id: actor.id, privyUserId: actor.privyUserId, role: "admin" });
  await service.patch(target.id, { disabled: true }, { kind: "service", permissions: ["users.manage"] });
  const rows = await db.select().from(adminAuditLogs).orderBy(adminAuditLogs.id);
  expect(rows).toMatchObject([
    { actorKind: "user", actorUserId: actor.id, event: "user.update", target: String(target.id), beforeJson: { role: "user", disabled: false }, afterJson: { role: "admin", disabled: false } },
    { actorKind: "service", actorUserId: null, beforeJson: { role: "admin", disabled: false }, afterJson: { role: "admin", disabled: true } },
  ]);
  await db.delete(users).where(eq(users.id, actor.id));
  expect(await db.select().from(adminAuditLogs)).toHaveLength(2);
});

it("rolls back the role edit if audit insertion fails", async () => {
  const [target] = await db.insert(users).values({ privyUserId: "did:privy:target" }).returning();
  await db.execute(sql`alter table admin_audit_logs add constraint audit_test_reject check (event <> 'user.update')`);
  try {
    await expect(service.patch(target.id, { role: "admin" }, { kind: "service", permissions: ["users.manage"] })).rejects.toThrow();
    expect((await db.select().from(users).where(eq(users.id, target.id)))[0].role).toBe("user");
    expect(await db.select().from(adminAuditLogs)).toHaveLength(0);
    expect(auth.invalidateUser).not.toHaveBeenCalled();
  } finally { await db.execute(sql`alter table admin_audit_logs drop constraint audit_test_reject`); }
});

it("settings audit captures only changed sections and shares the settings transaction", async () => {
  const settings = new SettingsService(new SettingsRepository(db), new UnitOfWork(db));
  await settings.patch({ general: { signupsOpen: false } }, null, { kind: "service", permissions: ["settings.write"] });
  const [record] = await db.select().from(adminAuditLogs);
  expect(record).toMatchObject({ actorKind: "service", event: "settings.update", beforeJson: { general: { signupsOpen: true } }, afterJson: { general: { signupsOpen: false } } });
  expect(Object.keys(record.afterJson as object)).toEqual(["general"]);
  await db.execute(sql`alter table admin_audit_logs add constraint audit_test_reject check (event <> 'settings.update') not valid`);
  try {
    await expect(settings.patch({ general: { signupsOpen: true } }, null)).rejects.toThrow();
    expect((await settings.get("general")).signupsOpen).toBe(false);
    expect(await db.select().from(adminAuditLogs)).toHaveLength(1);
  } finally { await db.execute(sql`alter table admin_audit_logs drop constraint audit_test_reject`); }
});
