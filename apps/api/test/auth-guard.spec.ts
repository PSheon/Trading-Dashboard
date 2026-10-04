import { RulesSeedRepository } from "../src/rules/rules-seed.repository.js";
import { SkipTransform } from "../src/common/decorators/http.decorator.js";
import { testConfig } from "./config-test-utils.js";
import { RequirePermissions } from "../src/common/auth/permissions.js";
import { Controller, Get, type INestApplication } from "@nestjs/common";
import { adminAuditLogs, alertRules, users } from "@trading-dashboard/shared/database";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthService } from "../src/common/auth/auth.service.js";
import { EMBEDDED_WALLET_RETRY_MS } from "../src/common/auth/auth.service.js";
import type { SettingsService } from "../src/settings/settings.service.js";
import { CurrentUser, Roles, type RequestUser } from "../src/common/auth/current-user.js";
import { profileFromLinkedAccounts, SdkPrivyVerifier } from "../src/common/auth/privy-verifier.js";
import { Public } from "../src/common/auth/public.decorator.js";
import { RulesSeedService } from "../src/rules/rules-seed.service.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const SERVICE_TOKEN = "service-token-for-tests-0123456789";

@SkipTransform()
@Controller("t")
class ProbeController {
  @Public()
  @Get("public")
  open(@CurrentUser() user: RequestUser | null) {
    return { user };
  }

  @Get("protected")
  closed(@CurrentUser() user: RequestUser | null) {
    return { user };
  }

  @Public()
  @RequirePermissions("users.read", "settings.read")
  @Get("permission-probe")
  permissions() { return { ok: true }; }

  @Roles("admin")
  @Get("admin")
  admin(@CurrentUser() user: RequestUser | null) {
    return { user };
  }

  @Public()
  @Roles("admin")
  @Get("public-admin")
  publicAdmin() {
    return { ok: true };
  }
}

@Roles("admin")
@SkipTransform()
@Controller("admin-class")
class AdminClassController {
  @Get()
  get() {
    return { ok: true };
  }
}

describe("AuthGuard — service token, Privy tokens, @Public, @Roles (real Postgres, stubbed Privy)", () => {
  const db = getTestDb();
  const privy = stubPrivy({
    "alice-token": {
      privyUserId: "did:privy:alice",
      profile: { email: "alice@example.com", walletAddress: "0xa11ce00000000000000000000000000000000000", embeddedWalletAddress: "0xa11ce0000000000000000000000000000000e3b0" },
    },
    "boss-token": { privyUserId: "did:privy:boss", profile: { email: "boss@example.com", walletAddress: null, embeddedWalletAddress: "0xb055000000000000000000000000000000000e3b" } },
    "expired-token": { privyUserId: "did:privy:late", expiresAt: new Date(Date.now() - 1000) },
    "newbie-token": { privyUserId: "did:privy:newbie", profile: { email: "newbie@example.com", walletAddress: null, embeddedWalletAddress: "0x9e3b1e000000000000000000000000000000e3b0" } },
  });
  let app: INestApplication;
  let auth: AuthService;
  let settings: SettingsService;

  beforeAll(async () => {
    ({ app, auth, settings } = await createAuthedApp({
      db,
      privy,
      controllers: [ProbeController, AdminClassController],
    }));
  });

  beforeEach(async () => {
    await truncateAll(db);
    await new RulesSeedService(testConfig(), new RulesSeedRepository(db)).seedDefaultRules();
    // The settings cache outlives the truncate: reset it explicitly.
    await settings.patch({ general: { signupsOpen: true } }, null);
    auth.clearCache();
    privy.verifyAccessToken.mockClear();
    privy.fetchProfile.mockClear();
    delete process.env.AUTH_SERVICE_PERMISSIONS;
    process.env.AUTH_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.AUTH_ADMIN_EMAILS = " Boss@Example.com , other@example.com";
  });

  afterEach(() => {
    delete process.env.AUTH_SERVICE_TOKEN;
    delete process.env.AUTH_ADMIN_EMAILS;
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const get = (path: string, token?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };

  describe("anonymous", () => {
    it("public route: 200 with no user", async () => {
      const res = await get("/t/public").expect(200);
      expect(res.body).toEqual({ user: null });
    });

    it("protected route: 401", async () => {
      await get("/t/protected").expect(401);
    });

    it("admin route: 401 (not 403) — sign in first", async () => {
      await get("/t/admin").expect(401);
    });

    it("a non-Bearer Authorization header is ignored", async () => {
      await request(app.getHttpServer()).get("/t/protected").set("Authorization", SERVICE_TOKEN).expect(401);
    });
  });

  describe("service token", () => {
    it("authenticates a service without granting human admin roles", async () => {
      expect((await get("/t/protected", SERVICE_TOKEN).expect(200)).body).toEqual({ user: { kind: "service", permissions: [] } });
      await get("/t/admin", SERVICE_TOKEN).expect(403);
      await get("/admin-class", SERVICE_TOKEN).expect(403);
      expect(privy.verifyAccessToken).not.toHaveBeenCalled();
    });

    it("an unset AUTH_SERVICE_TOKEN never matches (fail closed), even an empty-looking token", async () => {
      delete process.env.AUTH_SERVICE_TOKEN;
      await get("/t/protected", SERVICE_TOKEN).expect(401);
      await get("/t/protected", "undefined").expect(401);
    });
  });

  it("permission metadata overrides Public and requires every permission", async () => {
    await get("/t/permission-probe").expect(401);
    await get("/t/permission-probe", "alice-token").expect(403);
    await get("/t/permission-probe", "boss-token").expect(200);
    process.env.AUTH_SERVICE_PERMISSIONS = "users.read";
    await get("/t/permission-probe", SERVICE_TOKEN).expect(403);
    process.env.AUTH_SERVICE_PERMISSIONS = "users.read,settings.read";
    await get("/t/permission-probe", SERVICE_TOKEN).expect(200);
    delete process.env.AUTH_SERVICE_PERMISSIONS;
    await get("/t/permission-probe", SERVICE_TOKEN).expect(403);
  });

  describe("Privy tokens", () => {
    it("a valid token passes a protected route and populates request.user (so @CurrentUser works)", async () => {
      const res = await get("/t/protected", "alice-token").expect(200);
      const [alice] = await db.select().from(users).where(eq(users.privyUserId, "did:privy:alice"));
      expect(res.body).toEqual({ user: { kind: "user", id: alice.id, privyUserId: "did:privy:alice", role: "user" } });
    });

    it("a valid token on a public route attaches the user", async () => {
      const res = await get("/t/public", "alice-token").expect(200);
      expect(res.body.user).toMatchObject({ kind: "user", privyUserId: "did:privy:alice" });
    });

    it("forged/invalid token: 401 on a protected route, anonymous on a public one", async () => {
      await get("/t/protected", "forged.jwt.value").expect(401);
      expect((await get("/t/public", "forged.jwt.value").expect(200)).body).toEqual({ user: null });
    });

    it("expired token: 401 on a protected route, anonymous on a public one; no user row is created", async () => {
      await get("/t/protected", "expired-token").expect(401);
      expect((await get("/t/public", "expired-token").expect(200)).body).toEqual({ user: null });
      expect(await db.select().from(users)).toHaveLength(0);
    });

    it("Privy not configured: SdkPrivyVerifier rejects every token (fail closed)", async () => {
      delete process.env.PRIVY_APP_ID;
      delete process.env.PRIVY_APP_SECRET;
      const sdk = new SdkPrivyVerifier(testConfig());
      await expect(sdk.verifyAccessToken("anything")).rejects.toThrow(/not configured/);
      expect(await sdk.fetchProfile("did:privy:x")).toBeNull();
    });
  });

  describe("@Roles", () => {
    it("a non-admin user gets 403 on a @Roles('admin') route (method and class level)", async () => {
      await get("/t/admin", "alice-token").expect(403);
      await get("/admin-class", "alice-token").expect(403);
    });

    it("@Roles wins over @Public: anonymous 401, non-admin 403, admin 200", async () => {
      await get("/t/public-admin").expect(401);
      await get("/t/public-admin", "alice-token").expect(403);
      await get("/t/public-admin", "boss-token").expect(200);
    });

    it("a bootstrap admin (email in AUTH_ADMIN_EMAILS, case-insensitive) passes", async () => {
      const res = await get("/t/admin", "boss-token").expect(200);
      expect(res.body.user).toMatchObject({ kind: "user", role: "admin" });
    });

    it("an admin role set in the database passes", async () => {
      await get("/t/protected", "alice-token").expect(200);
      await db.update(users).set({ role: "admin" }).where(eq(users.privyUserId, "did:privy:alice"));
      auth.clearCache();
      await get("/t/admin", "alice-token").expect(200);
    });
  });

  describe("first sign-in", () => {
    it("creates the user with Privy email/wallet, and no alert rules (sign-up no longer copies them)", async () => {
      await get("/t/protected", "alice-token").expect(200);

      const [alice] = await db.select().from(users).where(eq(users.privyUserId, "did:privy:alice"));
      expect(alice).toMatchObject({
        email: "alice@example.com",
        walletAddress: "0xa11ce00000000000000000000000000000000000",
        embeddedWalletAddress: "0xa11ce0000000000000000000000000000000e3b0",
        role: "user",
        locale: "zh-TW",
      });

      const rules = await db.select().from(alertRules);
      expect(rules.map((r) => r.kind).sort()).toEqual(["R1", "R2", "R3"]);
      expect(rules.every((r) => r.userId === null)).toBe(true);
    });

    it("a new account starts in the language the request names; one that already exists keeps its own (review 29)", async () => {
      await get("/t/protected", "alice-token").set("Accept-Language", "en").expect(200);
      await get("/t/protected", "newbie-token").set("Accept-Language", "ja-JP,ja;q=0.9,en;q=0.8").expect(200);
      await get("/t/protected", "boss-token").set("Accept-Language", "xx,*;q=0.5").expect(200);
      const locales = async () => Object.fromEntries((await db.select().from(users)).map((u) => [u.email, u.locale]));
      expect(await locales()).toEqual({ "alice@example.com": "en", "newbie@example.com": "ja", "boss@example.com": "zh-TW" });

      // Later requests in another language, cached or not, change nothing.
      auth.clearCache();
      await get("/t/protected", "alice-token").set("Accept-Language", "ko").expect(200);
      expect((await locales())["alice@example.com"]).toBe("en");
    });

    it("a returning user: last_login_at bumps, profile is not re-fetched", async () => {
      await get("/t/protected", "alice-token").expect(200);
      const [first] = await db.select().from(users);
      auth.clearCache();
      await new Promise((r) => setTimeout(r, 20));
      await get("/t/protected", "alice-token").expect(200);

      const rows = await db.select().from(users);
      expect(rows).toHaveLength(1);
      expect(rows[0].lastLoginAt.getTime()).toBeGreaterThan(first.lastLoginAt.getTime());
      expect(await db.select().from(alertRules).where(eq(alertRules.userId, first.id))).toEqual([]);
      expect(privy.fetchProfile).toHaveBeenCalledTimes(1);
    });

    it("concurrent first requests create exactly one user", async () => {
      // Exercise PostgreSQL's speculative inserts against both DID and wallet
      // unique indexes. A single attempt rarely triggers the non-arbiter index
      // race; every concurrent caller must still resolve the committed identity.
      for (let attempt = 0; attempt < 20; attempt++) {
        await db.delete(users);
        auth.clearCache();
        const responses = await Promise.all([1, 2, 3, 4].map(() => get("/t/protected", "alice-token").expect(200)));
        const rows = await db.select().from(users);
        expect(rows).toHaveLength(1);
        expect(responses.map((response) => response.body.user.id)).toEqual([rows[0].id, rows[0].id, rows[0].id, rows[0].id]);
        expect(await db.select().from(alertRules)).toHaveLength(3); // the defaults only
      }
    });

    it("does not restore a demoted bootstrap admin while the email remains allowlisted", async () => {
      await get("/t/admin", "boss-token").expect(200);
      await db.update(users).set({ role: "user" }).where(eq(users.privyUserId, "did:privy:boss"));
      auth.clearCache();
      await get("/t/admin", "boss-token").expect(403);
      expect((await db.select().from(users))[0].role).toBe("user");
    });

    it("a demoted admin who deletes the account and signs in again is a plain user: the list only makes the first admin (review 33)", async () => {
      await get("/t/admin", "boss-token").expect(200);
      // Another admin exists and demotes boss, who then deletes the account.
      await get("/t/protected", "alice-token").expect(200);
      await db.update(users).set({ role: "admin" }).where(eq(users.privyUserId, "did:privy:alice"));
      await db.delete(users).where(eq(users.privyUserId, "did:privy:boss"));
      auth.clearCache();

      await get("/t/protected", "boss-token").expect(200); // still allowed to sign up
      await get("/t/admin", "boss-token").expect(403);
      const [boss] = await db.select().from(users).where(eq(users.privyUserId, "did:privy:boss"));
      expect(boss!.role).toBe("user");
      // One bootstrap happened, the first, and it is in the audit log.
      const audit = (await db.select().from(adminAuditLogs)).filter((a) => a.event === "user.bootstrap");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ event: "user.bootstrap", actorKind: "system", actorUserId: null, afterJson: { role: "admin", source: "AUTH_ADMIN_EMAILS" } });
      expect(JSON.stringify([audit[0]!.target, audit[0]!.afterJson, audit[0]!.beforeJson])).not.toContain("boss@example.com");
    });

    it("with no enabled admin left, a listed address is the admin again; two signing in together make one admin", async () => {
      await get("/t/admin", "boss-token").expect(200);
      await db.update(users).set({ disabledAt: new Date() });
      process.env.AUTH_ADMIN_EMAILS = "alice@example.com,newbie@example.com";
      auth.clearCache();
      await Promise.all([get("/t/protected", "alice-token").expect(200), get("/t/protected", "newbie-token").expect(200)]);
      const roles = (await db.select().from(users)).filter((u) => u.disabledAt === null).map((u) => u.role).sort();
      expect(roles).toEqual(["admin", "user"]);
      expect((await db.select().from(adminAuditLogs)).filter((a) => a.event === "user.bootstrap")).toHaveLength(2);
    });

    it("adding an email to the bootstrap list does not promote an existing user", async () => {
      process.env.AUTH_ADMIN_EMAILS = "";
      await get("/t/protected", "boss-token").expect(200);
      await get("/t/protected", "alice-token").expect(200);
      process.env.AUTH_ADMIN_EMAILS = "boss@example.com";
      auth.clearCache();
      await get("/t/admin", "boss-token").expect(403);
      await get("/t/admin", "alice-token").expect(403);
    });

    it("profile recovery fills email without granting an existing user admin", async () => {
      privy.fetchProfile.mockResolvedValueOnce(null); // Privy unavailable at first sign-in
      await get("/t/admin", "boss-token").expect(403);
      const [before] = await db.select().from(users).where(eq(users.privyUserId, "did:privy:boss"));
      expect(before).toMatchObject({ email: null, role: "user" });

      auth.clearCache();
      await get("/t/admin", "boss-token").expect(403);
      const [after] = await db.select().from(users).where(eq(users.privyUserId, "did:privy:boss"));
      expect(after).toMatchObject({ email: "boss@example.com", role: "user" });
    });

    it("looks a user with no email up at Privy at most every 10 minutes", async () => {
      privy.fetchProfile.mockResolvedValue(null);
      try {
        await get("/t/protected", "alice-token").expect(200); // created without an email
        auth.clearCache();
        await get("/t/protected", "alice-token").expect(200); // one retry
        auth.clearCache();
        await get("/t/protected", "alice-token").expect(200); // too soon: no lookup
        expect(privy.fetchProfile).toHaveBeenCalledTimes(2);
      } finally {
        privy.fetchProfile.mockReset();
        privy.fetchProfile.mockImplementation(
          async (did: string) =>
            ({
              "did:privy:alice": { email: "alice@example.com", walletAddress: "0xa11ce00000000000000000000000000000000000", embeddedWalletAddress: "0xa11ce0000000000000000000000000000000e3b0" },
              "did:privy:boss": { email: "boss@example.com", walletAddress: null, embeddedWalletAddress: "0xb055000000000000000000000000000000000e3b" },
              "did:privy:newbie": { email: "newbie@example.com", walletAddress: null, embeddedWalletAddress: "0x9e3b1e000000000000000000000000000000e3b0" },
            })[did] ?? null,
        );
      }
    });

    it("backfills a missing embedded wallet from Privy at the next login", async () => {
      await get("/t/protected", "alice-token").expect(200);
      await db.update(users).set({ embeddedWalletAddress: null }).where(eq(users.privyUserId, "did:privy:alice"));
      auth.clearCache();
      // Earlier cases leave this id inside its Privy retry window.
      (auth as unknown as { profileRetryAt: Map<number, number> }).profileRetryAt.clear();
      privy.fetchProfile.mockClear();
      await get("/t/protected", "alice-token").expect(200);
      const [alice] = await db.select().from(users).where(eq(users.privyUserId, "did:privy:alice"));
      expect(alice.embeddedWalletAddress).toBe("0xa11ce0000000000000000000000000000000e3b0");
      expect(privy.fetchProfile).toHaveBeenCalledTimes(1);
    });

    it("looks a missing embedded wallet up again after 15 s, not 10 min: the browser creates it right after the first sign-in", async () => {
      await get("/t/protected", "alice-token").expect(200);
      await db.update(users).set({ embeddedWalletAddress: null }).where(eq(users.privyUserId, "did:privy:alice"));
      auth.clearCache();
      const retryAt = (auth as unknown as { profileRetryAt: Map<number, number> }).profileRetryAt;
      retryAt.clear();
      privy.fetchProfile.mockClear();
      // Privy's record carries no wallet yet: nothing to store, a short window.
      privy.fetchProfile.mockResolvedValueOnce({ email: "alice@example.com", walletAddress: "0xa11ce00000000000000000000000000000000000", embeddedWalletAddress: null });
      const before = Date.now();
      await get("/t/protected", "alice-token").expect(200);
      let [alice] = await db.select().from(users).where(eq(users.privyUserId, "did:privy:alice"));
      expect(alice.embeddedWalletAddress).toBeNull();
      expect(retryAt.get(alice.id)).toBeGreaterThan(before);
      expect(retryAt.get(alice.id)).toBeLessThanOrEqual(Date.now() + EMBEDDED_WALLET_RETRY_MS);
      // Inside the window: no lookup.
      auth.clearCache();
      await get("/t/protected", "alice-token").expect(200);
      expect(privy.fetchProfile).toHaveBeenCalledTimes(1);
      // The window has passed (the wallet exists at Privy by now): stored.
      retryAt.set(alice.id, Date.now() - 1);
      auth.clearCache();
      await get("/t/protected", "alice-token").expect(200);
      [alice] = await db.select().from(users).where(eq(users.privyUserId, "did:privy:alice"));
      expect(alice.embeddedWalletAddress).toBe("0xa11ce0000000000000000000000000000000e3b0");
      expect(privy.fetchProfile).toHaveBeenCalledTimes(2);
      // Once complete, the usual ten-minute window applies.
      expect(retryAt.get(alice.id)).toBeUndefined();
    });
  });

  describe("disabled users", () => {
    async function disable(privyUserId: string, at: Date | null = new Date()) {
      await db.update(users).set({ disabledAt: at }).where(eq(users.privyUserId, privyUserId));
    }

    it("are treated as signed out: anonymous on @Public, 401 elsewhere, 401 on admin routes", async () => {
      await get("/t/protected", "boss-token").expect(200);
      await disable("did:privy:boss");
      auth.clearCache();

      expect((await get("/t/public", "boss-token").expect(200)).body).toEqual({ user: null });
      await get("/t/protected", "boss-token").expect(401);
      await get("/t/admin", "boss-token").expect(401);
    });

    it("don't get last_login_at bumped", async () => {
      await get("/t/protected", "alice-token").expect(200);
      await disable("did:privy:alice");
      const [before] = await db.select().from(users);
      auth.clearCache();
      await new Promise((r) => setTimeout(r, 20));
      await get("/t/protected", "alice-token").expect(401);
      const [after] = await db.select().from(users);
      expect(after.lastLoginAt).toEqual(before.lastLoginAt);
    });

    it("database revocation applies without a process-local invalidation", async () => {
      await get("/t/protected", "alice-token").expect(200);
      const [alice] = await db.select().from(users);
      await disable("did:privy:alice");

      // Simulates a change committed by another application process.
      await get("/t/protected", "alice-token").expect(401);
      auth.invalidateUser(alice.id);
      await get("/t/protected", "alice-token").expect(401);

      // Re-enabling is also visible without invalidation.
      await disable("did:privy:alice", null);
      await get("/t/protected", "alice-token").expect(200);
      auth.invalidateUser(alice.id);
      await get("/t/protected", "alice-token").expect(200);
    });

    it("does not publish stale authorization when disabled during a slow profile refresh", async () => {
      await db.insert(users).values({ id: 90000, privyUserId: "did:privy:boss", role: "admin", email: null });
      let started!: () => void;
      const entered = new Promise<void>((resolve) => { started = resolve; });
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      privy.fetchProfile.mockImplementationOnce(async () => { started(); await waiting; return null; });
      const pending = auth.authenticate("boss-token");
      await entered;
      try { await disable("did:privy:boss"); }
      finally { release(); }
      expect(await pending).toEqual({ status: "disabled", userId: 90000 });
      await get("/t/admin", "boss-token").expect(401);
    });

    it("cached tokens observe committed demotion and deletion on the next request", async () => {
      await get("/t/admin", "boss-token").expect(200);
      await db.update(users).set({ role: "user" }).where(eq(users.privyUserId, "did:privy:boss"));
      await get("/t/admin", "boss-token").expect(403);
      const caller = await get("/t/protected", "boss-token").expect(200);
      expect(caller.body.user.role).toBe("user");
      await db.delete(users).where(eq(users.privyUserId, "did:privy:boss"));
      await get("/t/protected", "boss-token").expect(401);
    });

    it("the cache expires after 30 s even without invalidateUser", async () => {
      await get("/t/protected", "alice-token").expect(200);
      await disable("did:privy:alice");
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + 31_000;
        await get("/t/protected", "alice-token").expect(401);
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe("sign-ups closed (settings.general.signupsOpen = false)", () => {
    beforeEach(async () => {
      await settings.patch({ general: { signupsOpen: false } }, null);
    });

    it("a new Privy user: no row created; anonymous on @Public, 403 {code:'signups_closed'} elsewhere", async () => {
      expect((await get("/t/public", "newbie-token").expect(200)).body).toEqual({ user: null });
      const res = await get("/t/protected", "newbie-token").expect(403);
      expect(res.body.error).toMatchObject({ code: "signups_closed" });
      await get("/t/admin", "newbie-token").expect(403);
      expect(await db.select().from(users)).toHaveLength(0);
    });

    it("existing users are unaffected", async () => {
      await settings.patch({ general: { signupsOpen: true } }, null);
      await get("/t/protected", "alice-token").expect(200);
      await settings.patch({ general: { signupsOpen: false } }, null);
      auth.clearCache();
      await get("/t/protected", "alice-token").expect(200);
    });

    it("a AUTH_ADMIN_EMAILS address still signs up (as admin)", async () => {
      const res = await get("/t/admin", "boss-token").expect(200);
      expect(res.body.user).toMatchObject({ kind: "user", role: "admin" });
    });

    it("a refused token is verified once within the cache window, and opening sign-ups lets it in at once", async () => {
      privy.verifyAccessToken.mockClear();
      for (let i = 0; i < 5; i++) await get("/t/protected", "newbie-token").expect(403);
      // The refusal is a cost cap too: repeated requests do not re-verify.
      expect(privy.verifyAccessToken).toHaveBeenCalledTimes(1);
      await settings.patch({ general: { signupsOpen: true } }, null);
      await get("/t/protected", "newbie-token").expect(200);
    });
  });

  describe("token cache", () => {
    it.each([
      { expiry: 60000, boundary: 30000, status: "user" },
      { expiry: 1000, boundary: 1000, status: "invalid" },
    ])("distinguishes cache TTL from token expiry across the DB await ($status)", async ({ expiry, boundary, status }) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        privy.verifyAccessToken.mockResolvedValueOnce({ privyUserId: "did:privy:alice", expiresAt: new Date(now + expiry) });
        expect((await auth.authenticate("alice-token")).status).toBe("user");
        clock.mockReturnValue(now + boundary + 1).mockReturnValueOnce(now + boundary - 1);
        expect((await auth.authenticate("alice-token")).status).toBe(status);
        expect(privy.verifyAccessToken).toHaveBeenCalledTimes(1);
      } finally { clock.mockRestore(); }
    });
    it("a verified token is reused without re-verifying while authorization is refreshed", async () => {
      await get("/t/protected", "alice-token").expect(200);
      await get("/t/protected", "alice-token").expect(200);
      await get("/t/public", "alice-token").expect(200);
      expect(privy.verifyAccessToken).toHaveBeenCalledTimes(1);
    });

    it("an expired token is never cached", async () => {
      await get("/t/protected", "expired-token").expect(401);
      await get("/t/protected", "expired-token").expect(401);
      expect(privy.verifyAccessToken).toHaveBeenCalledTimes(2);
    });
  });
});

describe("profileFromLinkedAccounts", () => {
  it("keeps the main account at HD index zero regardless of linked-wallet order", () => {
    const main = { type: "wallet", chain_type: "ethereum", wallet_client: "privy", wallet_index: 0, imported: false, address: "0xMAIN" };
    const secondary = { ...main, wallet_index: 1, address: "0xCOPY" };
    for (const linked of [[secondary, main], [main, secondary]]) {
      expect(profileFromLinkedAccounts(linked as never)).toEqual({ email: null, walletAddress: "0xmain", embeddedWalletAddress: "0xmain" });
    }
  });

  it("does not persist a secondary or an ambiguous wallet as the main account", () => {
    const wallet = { type: "wallet", chain_type: "ethereum", wallet_client: "privy", imported: false, address: "0xMAIN" };
    for (const linked of [
      [{ ...wallet, wallet_index: 1 }],
      [wallet, { ...wallet, address: "0xOTHER" }],
      [{ ...wallet, wallet_index: 0 }, { ...wallet, wallet_index: 0, address: "0xOTHER" }],
      [{ ...wallet, wallet_index: 0, imported: true }],
    ]) {
      expect(profileFromLinkedAccounts(linked as never)).toEqual({ email: null, walletAddress: null, embeddedWalletAddress: null });
    }
  });

  it("recognizes Privy v2 as embedded rather than as an external wallet", () => {
    expect(profileFromLinkedAccounts([
      { type: "wallet", chain_type: "ethereum", wallet_client: "privy-v2", wallet_index: 0, address: "0xV2" },
    ] as never)).toEqual({ email: null, walletAddress: "0xv2", embeddedWalletAddress: "0xv2" });
  });

  it("takes the email and prefers an external Ethereum wallet over the embedded one", () => {
    const profile = profileFromLinkedAccounts([
      { type: "wallet", chain_type: "ethereum", wallet_client: "privy", address: "0xEMBEDDED" },
      { type: "email", address: "Me@Example.com" },
      { type: "wallet", chain_type: "solana", wallet_client: "phantom", address: "So1ana" },
      { type: "wallet", chain_type: "ethereum", wallet_client: "unknown", address: "0xEXTERNAL" },
    ] as never);
    expect(profile).toEqual({ email: "me@example.com", walletAddress: "0xexternal", embeddedWalletAddress: "0xembedded" });
  });

  it("uses a Google or Apple login's email when there is no email login", () => {
    expect(
      profileFromLinkedAccounts([{ type: "google_oauth", email: "G@Example.com", subject: "1" }] as never).email,
    ).toBe("g@example.com");
    expect(
      profileFromLinkedAccounts([
        { type: "apple_oauth", email: "a@example.com", subject: "2" },
        { type: "email", address: "e@example.com" },
      ] as never).email,
    ).toBe("e@example.com");
  });

  it("falls back to the embedded wallet, and nulls when nothing is linked", () => {
    expect(
      profileFromLinkedAccounts([
        { type: "wallet", chain_type: "ethereum", wallet_client: "privy", address: "0xEMB" },
      ] as never),
    ).toEqual({ email: null, walletAddress: "0xemb", embeddedWalletAddress: "0xemb" });
    expect(profileFromLinkedAccounts([])).toEqual({ email: null, walletAddress: null, embeddedWalletAddress: null });
  });
});
