import { UnitOfWork } from "../src/db/unit-of-work.js";
import { AdminUsersRepository, escapeLike } from "../src/admin/admin-users.repository.js";
import { BadRequestException, ConflictException, NotFoundException, type HttpException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { adminAuditLogs, notificationChannels, userFavorites, users } from "@trading-dashboard/shared/database";
import { adminUsersResponseSchema } from "@trading-dashboard/shared/contracts";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminUsersService } from "../src/admin/admin-users.service.js";
import type { AuthService } from "../src/common/auth/auth.service.js";
import type { RequestUser } from "../src/common/auth/current-user.js";
import { insertUser, truncateAdminTables } from "./admin-test-utils.js";
import { closeTestDb, getTestDb } from "./db-test-utils.js";

const SERVICE: RequestUser = { kind: "service", permissions: [] };
const asUser = (row: { id: number; privyUserId: string; role: "user" | "operator" | "admin" }): RequestUser => ({
  kind: "user",
  id: row.id,
  privyUserId: row.privyUserId,
  role: row.role,
});

async function httpError(promise: Promise<unknown>): Promise<HttpException> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e as HttpException,
  );
}

describe("admin users — real Postgres", () => {
  const db = getTestDb();
  const invalidateUser = vi.fn();
  const service = new AdminUsersService(new AdminUsersRepository(db), new UnitOfWork(db), { invalidateUser } as unknown as AuthService);

  beforeEach(async () => {
    await truncateAdminTables(db);
    invalidateUser.mockClear();
  });

  afterAll(async () => {
    await truncateAdminTables(db);
    await closeTestDb();
  });

  it("escapes LIKE wildcards", () => {
    expect(escapeLike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });

  describe("GET /admin/users", () => {
    it("lists newest first with total, favorites, telegram and disabled", async () => {
      const t0 = Date.parse("2026-09-01T00:00:00Z");
      const alice = await insertUser(db, { email: "alice@example.com", createdAt: new Date(t0) });
      const bob = await insertUser(db, {
        walletAddress: "0xB0b0000000000000000000000000000000000000",
        displayName: "Bobby",
        createdAt: new Date(t0 + 1000),
        disabledAt: new Date(),
      });
      const carol = await insertUser(db, { email: "carol@example.com", role: "admin", createdAt: new Date(t0 + 2000) });
      await db.insert(userFavorites).values([
        { userId: alice.id, address: "0x1" },
        { userId: alice.id, address: "0x2" },
        { userId: bob.id, address: "0x1" },
      ]);
      await db.insert(notificationChannels).values([
        { userId: alice.id, kind: "telegram", target: "1", enabled: true },
        { userId: bob.id, kind: "telegram", target: "2", enabled: false },
      ]);

      const res = await service.list({});
      expect(adminUsersResponseSchema.parse(res)).toEqual(res);
      expect(res.total).toBe(3);
      expect(res.items.map((u) => u.id)).toEqual([carol.id, bob.id, alice.id]);
      const byId = new Map(res.items.map((u) => [u.id, u]));
      expect(byId.get(alice.id)).toMatchObject({ favorites: 2, telegramEnabled: true, disabled: false, role: "user" });
      expect(byId.get(bob.id)).toMatchObject({ favorites: 1, telegramEnabled: false, disabled: true, displayName: "Bobby" });
      expect(byId.get(carol.id)).toMatchObject({ favorites: 0, telegramEnabled: false, disabled: false, role: "admin" });
    });

    it("searches email, wallet and display name case-insensitively", async () => {
      await insertUser(db, { email: "Alice@Example.com" });
      await insertUser(db, { walletAddress: "0xABCDEF0000000000000000000000000000000000" });
      await insertUser(db, { displayName: "Big Whale" });
      await insertUser(db, { email: "nobody@else.io" });

      expect((await service.list({ q: "alice@EXAMPLE" })).items.map((u) => u.email)).toEqual(["Alice@Example.com"]);
      expect((await service.list({ q: "0xabcdef" })).total).toBe(1);
      expect((await service.list({ q: "whale" })).items.map((u) => u.displayName)).toEqual(["Big Whale"]);
      expect((await service.list({ q: "example" })).total).toBe(1);
      expect((await service.list({ q: "   " })).total).toBe(4);
    });

    it("treats % and _ in the search literally", async () => {
      await insertUser(db, { displayName: "100% degen" });
      await insertUser(db, { displayName: "1000 degen" });
      await insertUser(db, { email: "a_b@x.io" });
      await insertUser(db, { email: "axb@x.io" });
      await insertUser(db, { displayName: "back\\slash" });

      expect((await service.list({ q: "100%" })).items.map((u) => u.displayName)).toEqual(["100% degen"]);
      expect((await service.list({ q: "%" })).total).toBe(1);
      expect((await service.list({ q: "a_b" })).items.map((u) => u.email)).toEqual(["a_b@x.io"]);
      expect((await service.list({ q: "_" })).total).toBe(1);
      expect((await service.list({ q: "k\\s" })).total).toBe(1);
    });

    it("filters by role and paginates with the full total", async () => {
      const t0 = Date.parse("2026-09-01T00:00:00Z");
      for (let i = 0; i < 5; i++) {
        await insertUser(db, { email: `u${i}@x.io`, createdAt: new Date(t0 + i * 1000) });
      }
      await insertUser(db, { email: "admin@x.io", role: "admin", createdAt: new Date(t0 - 1000) });

      const admins = await service.list({ role: "admin" });
      expect(admins.total).toBe(1);
      expect(admins.items[0].email).toBe("admin@x.io");

      const page = await service.list({ role: "user", limit: "2", offset: "1" });
      expect(page.total).toBe(5);
      expect(page.items.map((u) => u.email)).toEqual(["u3@x.io", "u2@x.io"]);

      const last = await service.list({ limit: 2, offset: 4 });
      expect(last.total).toBe(6);
      expect(last.items.map((u) => u.email)).toEqual(["u0@x.io", "admin@x.io"]);
    });

    it.each([{ role: "owner" }, { limit: "0" }, { limit: "101" }, { offset: "-1" }, { q: "x".repeat(65) }])(
      "400s on %o",
      async (query) => {
        const error = await httpError(service.list(query));
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.getResponse()).toMatchObject({ issues: expect.any(Array) });
      },
    );
  });

  describe("PATCH /admin/users/:id", () => {
    it("promotes, demotes, disables and enables, returning the row", async () => {
      const admin = await insertUser(db, { role: "admin" });
      const user = await insertUser(db, { email: "u@x.io" });

      const promoted = await service.patch(user.id, { role: "admin" }, asUser(admin));
      expect(promoted).toMatchObject({ id: user.id, role: "admin", disabled: false, email: "u@x.io" });

      const demoted = await service.patch(user.id, { role: "user" }, asUser(admin));
      expect(demoted.role).toBe("user");

      const before = Date.now();
      const disabled = await service.patch(user.id, { disabled: true }, asUser(admin));
      expect(disabled.disabled).toBe(true);
      const [row] = await db.select().from(users).where(eq(users.id, user.id));
      expect(row.disabledAt!.getTime()).toBeGreaterThan(before - 5000);

      const enabled = await service.patch(user.id, { disabled: false }, SERVICE);
      expect(enabled.disabled).toBe(false);
      const [after] = await db.select().from(users).where(eq(users.id, user.id));
      expect(after.disabledAt).toBeNull();
      expect(invalidateUser.mock.calls).toEqual([[user.id], [user.id], [user.id], [user.id]]);
    });

    it("makes a user a read-only operator and back; the audit log keeps both roles", async () => {
      const admin = await insertUser(db, { role: "admin" });
      const user = await insertUser(db, { email: "ops@x.io" });
      expect((await service.patch(user.id, { role: "operator" }, asUser(admin))).role).toBe("operator");
      expect((await service.list({ role: "operator" })).items.map((u) => u.id)).toEqual([user.id]);
      expect((await service.patch(user.id, { role: "admin" }, asUser(admin))).role).toBe("admin");
      expect((await service.patch(user.id, { role: "operator" }, asUser(admin))).role).toBe("operator");
      const audit = await db.select().from(adminAuditLogs).orderBy(asc(adminAuditLogs.id));
      expect(audit.map((a) => [a.event, (a.beforeJson as { role: string }).role, (a.afterJson as { role: string }).role])).toEqual([
        ["user.update", "user", "operator"], ["user.update", "operator", "admin"], ["user.update", "admin", "operator"],
      ]);
    });

    it("an admin can't make themself an operator, and the last enabled admin can't become one", async () => {
      const admin = await insertUser(db, { role: "admin" });
      const self = await httpError(service.patch(admin.id, { role: "operator" }, asUser(admin)));
      expect(self).toBeInstanceOf(BadRequestException);
      expect(self.getResponse()).toMatchObject({ code: "self" });
      const last = await httpError(service.patch(admin.id, { role: "operator" }, SERVICE));
      expect(last).toBeInstanceOf(ConflictException);
      expect(last.getResponse()).toMatchObject({ code: "last_admin" });
      // An operator is not an admin: with one admin and one operator, the admin is still the last one.
      await insertUser(db, { role: "operator" });
      expect(await httpError(service.patch(admin.id, { role: "user" }, SERVICE))).toBeInstanceOf(ConflictException);
    });

    it("drops the user's cached sign-ins only after a change that went through", async () => {
      const user = await insertUser(db);
      await service.patch(user.id, {}, SERVICE);
      await httpError(service.patch(user.id, { role: "root" }, SERVICE));
      await httpError(service.patch(999, { role: "admin" }, SERVICE));
      expect(invalidateUser).not.toHaveBeenCalled();
    });

    it("404s on an unknown id", async () => {
      const error = await httpError(service.patch(999, { role: "admin" }, SERVICE));
      expect(error).toBeInstanceOf(NotFoundException);
    });

    it("400s on an invalid body", async () => {
      const user = await insertUser(db);
      const error = await httpError(service.patch(user.id, { role: "root" }, SERVICE));
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({ issues: expect.any(Array) });
    });

    it("400s {code:'self'} when an admin demotes or disables themself", async () => {
      const me = await insertUser(db, { role: "admin" });
      await insertUser(db, { role: "admin" });

      for (const body of [{ role: "user" }, { disabled: true }, { role: "admin", disabled: true }]) {
        const error = await httpError(service.patch(me.id, body, asUser(me)));
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.getResponse()).toMatchObject({ code: "self" });
      }
      const [row] = await db.select().from(users).where(eq(users.id, me.id));
      expect(row).toMatchObject({ role: "admin", disabledAt: null });

      // A no-op on yourself is fine.
      expect((await service.patch(me.id, { role: "admin", disabled: false }, asUser(me))).role).toBe("admin");
    });

    it("409s {code:'last_admin'} when no enabled admin would be left", async () => {
      const only = await insertUser(db, { role: "admin" });
      await insertUser(db, { role: "admin", disabledAt: new Date() });

      for (const body of [{ role: "user" }, { disabled: true }]) {
        const error = await httpError(service.patch(only.id, body, SERVICE));
        expect(error).toBeInstanceOf(ConflictException);
        expect(error.getResponse()).toMatchObject({ code: "last_admin" });
      }

      // With a second enabled admin it goes through.
      const other = await insertUser(db, { role: "admin" });
      expect((await service.patch(only.id, { role: "user" }, asUser(other))).role).toBe("user");
      // …and now `other` is the last one.
      const error = await httpError(service.patch(other.id, { disabled: true }, SERVICE));
      expect(error.getResponse()).toMatchObject({ code: "last_admin" });
    });

    it("lets only one of two concurrent cross-demotions through", async () => {
      const a = await insertUser(db, { role: "admin" });
      const b = await insertUser(db, { role: "admin" });
      const results = await Promise.allSettled([
        service.patch(b.id, { role: "user" }, asUser(a)),
        service.patch(a.id, { role: "user" }, asUser(b)),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect((rejected.reason as HttpException).getResponse()).toMatchObject({ code: "last_admin" });
      const admins = await db.select().from(users).where(eq(users.role, "admin"));
      expect(admins).toHaveLength(1);
    });

    it("demoting a disabled admin doesn't count against the last enabled admin", async () => {
      await insertUser(db, { role: "admin" });
      const disabledAdmin = await insertUser(db, { role: "admin", disabledAt: new Date() });
      expect((await service.patch(disabledAdmin.id, { role: "user" }, SERVICE)).role).toBe("user");
    });
  });
});
