import { Controller, Get, type INestApplication } from "@nestjs/common";
import { alertRules, users } from "@trading-dashboard/shared";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AuthService } from "../src/common/auth/auth.service.js";
import { CurrentUser, Roles, type RequestUser } from "../src/common/auth/current-user.js";
import { profileFromLinkedAccounts, SdkPrivyVerifier } from "../src/common/auth/privy-verifier.js";
import { Public } from "../src/common/auth/public.decorator.js";
import { RulesSeedService } from "../src/rules/rules-seed.service.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const SERVICE_TOKEN = "service-token-for-tests-0123456789";

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
      profile: { email: "alice@example.com", walletAddress: "0xa11ce00000000000000000000000000000000000" },
    },
    "boss-token": { privyUserId: "did:privy:boss", profile: { email: "boss@example.com", walletAddress: null } },
    "expired-token": { privyUserId: "did:privy:late", expiresAt: new Date(Date.now() - 1000) },
  });
  let app: INestApplication;
  let auth: AuthService;

  beforeAll(async () => {
    ({ app, auth } = await createAuthedApp({ db, privy, controllers: [ProbeController, AdminClassController] }));
  });

  beforeEach(async () => {
    await truncateAll(db);
    await new RulesSeedService(db).seedDefaultRules();
    auth.clearCache();
    privy.verifyAccessToken.mockClear();
    privy.fetchProfile.mockClear();
    process.env.API_AUTH_TOKEN = SERVICE_TOKEN;
    process.env.BOOTSTRAP_ADMIN_EMAILS = " Boss@Example.com , other@example.com";
  });

  afterEach(() => {
    delete process.env.API_AUTH_TOKEN;
    delete process.env.BOOTSTRAP_ADMIN_EMAILS;
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
    it("passes protected and admin routes as { kind: 'service' }", async () => {
      expect((await get("/t/protected", SERVICE_TOKEN).expect(200)).body).toEqual({ user: { kind: "service" } });
      await get("/t/admin", SERVICE_TOKEN).expect(200);
      await get("/admin-class", SERVICE_TOKEN).expect(200);
      expect(privy.verifyAccessToken).not.toHaveBeenCalled();
    });

    it("an unset API_AUTH_TOKEN never matches (fail closed), even an empty-looking token", async () => {
      delete process.env.API_AUTH_TOKEN;
      await get("/t/protected", SERVICE_TOKEN).expect(401);
      await get("/t/protected", "undefined").expect(401);
    });
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
      const sdk = new SdkPrivyVerifier();
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

    it("a bootstrap admin (email in BOOTSTRAP_ADMIN_EMAILS, case-insensitive) passes", async () => {
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
    it("creates the user with Privy email/wallet and copies the default rules to them", async () => {
      await get("/t/protected", "alice-token").expect(200);

      const [alice] = await db.select().from(users).where(eq(users.privyUserId, "did:privy:alice"));
      expect(alice).toMatchObject({
        email: "alice@example.com",
        walletAddress: "0xa11ce00000000000000000000000000000000000",
        role: "user",
        locale: "zh-TW",
      });

      const defaults = await db.select().from(alertRules);
      const own = defaults.filter((r) => r.userId === alice.id);
      const templates = defaults.filter((r) => r.userId === null);
      expect(own.map((r) => r.kind).sort()).toEqual(["R1", "R2", "R3"]);
      for (const rule of own) {
        const template = templates.find((t) => t.kind === rule.kind)!;
        expect(rule.id).not.toBe(template.id);
        expect({ ...rule, id: 0, userId: null }).toEqual({ ...template, id: 0 });
      }
    });

    it("a returning user: last_login_at bumps, rules are not copied twice, profile is not re-fetched", async () => {
      await get("/t/protected", "alice-token").expect(200);
      const [first] = await db.select().from(users);
      auth.clearCache();
      await new Promise((r) => setTimeout(r, 20));
      await get("/t/protected", "alice-token").expect(200);

      const rows = await db.select().from(users);
      expect(rows).toHaveLength(1);
      expect(rows[0].lastLoginAt.getTime()).toBeGreaterThan(first.lastLoginAt.getTime());
      expect((await db.select().from(alertRules).where(eq(alertRules.userId, first.id))).length).toBe(3);
      expect(privy.fetchProfile).toHaveBeenCalledTimes(1);
    });

    it("concurrent first requests create exactly one user", async () => {
      await Promise.all([1, 2, 3, 4].map(() => get("/t/protected", "alice-token").expect(200)));
      expect(await db.select().from(users)).toHaveLength(1);
      expect(await db.select().from(alertRules)).toHaveLength(6);
    });

    it("bootstrap admin email only applies on creation, and a non-listed email stays a user", async () => {
      process.env.BOOTSTRAP_ADMIN_EMAILS = "";
      await get("/t/protected", "boss-token").expect(200);
      process.env.BOOTSTRAP_ADMIN_EMAILS = "boss@example.com";
      auth.clearCache();
      await get("/t/admin", "boss-token").expect(403);
    });
  });

  describe("token cache", () => {
    it("a verified token is reused without re-verifying or hitting the users table", async () => {
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
  it("takes the email and prefers an external Ethereum wallet over the embedded one", () => {
    const profile = profileFromLinkedAccounts([
      { type: "wallet", chain_type: "ethereum", wallet_client: "privy", address: "0xEMBEDDED" },
      { type: "email", address: "Me@Example.com" },
      { type: "wallet", chain_type: "solana", wallet_client: "phantom", address: "So1ana" },
      { type: "wallet", chain_type: "ethereum", wallet_client: "unknown", address: "0xEXTERNAL" },
    ] as never);
    expect(profile).toEqual({ email: "me@example.com", walletAddress: "0xexternal" });
  });

  it("falls back to the embedded wallet, and nulls when nothing is linked", () => {
    expect(
      profileFromLinkedAccounts([
        { type: "wallet", chain_type: "ethereum", wallet_client: "privy", address: "0xEMB" },
      ] as never),
    ).toEqual({ email: null, walletAddress: "0xemb" });
    expect(profileFromLinkedAccounts([])).toEqual({ email: null, walletAddress: null });
  });
});
