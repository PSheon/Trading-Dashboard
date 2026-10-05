import { backfillJobs } from "@trading-dashboard/shared/database";
import { RulesSeedRepository } from "../src/rules/rules-seed.repository.js";
import { ProfileRepository } from "../src/users/profile.repository.js";
import { testConfig } from "./config-test-utils.js";
import type { INestApplication } from "@nestjs/common";
import {
  adminAuditLogs,
  alertRules,
  leaders,
  telegramLinkTokens,
  favoriteGroupMembers,
  favoriteGroups,
  users,
  notificationChannels,
  traderStats,
  userFavorites,
  walletWithdrawals,
  referralCodes, referralPolicies, referralClaims,
} from "@trading-dashboard/shared/database";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthService } from "../src/common/auth/auth.service.js";
import type { SettingsService } from "../src/settings/settings.service.js";
import { RulesSeedService } from "../src/rules/rules-seed.service.js";
import { AccountDeletionService } from "../src/users/account-deletion.service.js";
import { AccountRepository } from "../src/users/account.repository.js";
import { FavoritesService } from "../src/users/favorites.service.js";
import { MeController } from "../src/users/me.controller.js";
import { ProfileService } from "../src/users/profile.service.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const SERVICE_TOKEN = "service-token-for-me-tests-0123456789";
const ADDR = "0x" + "ab".repeat(20);
const ADDR_MIXED = "0x" + "AB".repeat(20);
const OTHER = "0x" + "cd".repeat(20);

describe("/me — real controllers and services, real Postgres, stubbed Privy + backfill", () => {
  const db = getTestDb();
  const privy = stubPrivy({
    "alice-token": { privyUserId: "did:privy:alice", profile: { email: "alice@example.com", walletAddress: null } },
    "bob-token": { privyUserId: "did:privy:bob" },
  });
  let app: INestApplication;
  let auth: AuthService;
  let settings: SettingsService;

  beforeAll(async () => {
    process.env.AUTH_SERVICE_TOKEN = SERVICE_TOKEN;
    ({ app, auth, settings } = await createAuthedApp({
      db,
      privy,
      controllers: [MeController],
      providers: [
        ProfileRepository,
        ProfileService,
        FavoritesService,
        AccountRepository,
        AccountDeletionService,
      ],
    }));
  });

  beforeEach(async () => {
    await truncateAll(db);
    await new RulesSeedService(testConfig(), new RulesSeedRepository(db)).seedDefaultRules();
    await settings.patch({ notifications: { alertsEnabled: true, maxAlertTraders: 3 } }, null);
    auth.clearCache();
  });

  afterAll(async () => {
    delete process.env.AUTH_SERVICE_TOKEN;
    await app.close();
    await closeTestDb();
  });

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (path: string) => http().get(path).set("Authorization", `Bearer ${token}`),
    put: (path: string, body?: object) =>
      http().put(path).set("Authorization", `Bearer ${token}`).send(body ?? {}),
    patch: (path: string, body?: object) =>
      http().patch(path).set("Authorization", `Bearer ${token}`).send(body ?? {}),
    // DELETE /me carries the confirmation the settings page sends.
    delete: (path: string) => {
      const req = http().delete(path).set("Authorization", `Bearer ${token}`);
      return path === "/me" ? req.set("X-Confirm-Delete", "delete-account") : req;
    },
  });
  const alice = as("alice-token");
  const bob = as("bob-token");

  it("the favorites limit is the admin's setting, and MAX_FAVORITES_PER_USER only while that is unset (review finding 18)", async () => {
    const THIRD = "0x" + "ef".repeat(20);
    vi.stubEnv("MAX_FAVORITES_PER_USER", "1");
    try {
      await alice.put(`/me/favorites/${ADDR}`).expect(200);
      // Unset: the deployment default applies.
      expect((await alice.put(`/me/favorites/${OTHER}`).expect(409)).body.error).toMatchObject({ code: "favorite_limit", details: { limit: 1 } });
      // Set: the setting wins over the environment, at once.
      await settings.patch({ general: { maxFavoritesPerUser: 2 } }, null);
      await alice.put(`/me/favorites/${OTHER}`).expect(200);
      expect((await alice.put(`/me/favorites/${THIRD}`).expect(409)).body.error).toMatchObject({ code: "favorite_limit", details: { limit: 2 } });
      // Lowering it removes nothing and still lets an existing favorite be re-put.
      await settings.patch({ general: { maxFavoritesPerUser: 1 } }, null);
      await alice.put(`/me/favorites/${ADDR}`).expect(200);
      expect(await db.select().from(userFavorites)).toHaveLength(2);
      // Cleared again: back to the environment.
      vi.stubEnv("MAX_FAVORITES_PER_USER", "3");
      await settings.patch({ general: { maxFavoritesPerUser: null } }, null);
      await alice.put(`/me/favorites/${THIRD}`).expect(200);
    } finally { vi.unstubAllEnvs(); }
  });

  it("the site watches at most general.maxWatchedAddresses for its users; an address already watched still passes (review finding 34)", async () => {
    const THIRD = "0x" + "ef".repeat(20);
    await settings.patch({ general: { maxWatchedAddresses: 2 } }, null);
    await alice.put(`/me/favorites/${ADDR}`).expect(200);
    await bob.put(`/me/favorites/${OTHER}`).expect(200);
    // A third address would be one more to watch: refused, nothing saved.
    expect((await bob.put(`/me/favorites/${THIRD}`).expect(409)).body.error).toMatchObject({ code: "watch_capacity", details: { limit: 2 } });
    expect(await db.select().from(userFavorites)).toHaveLength(2);
    expect(await db.select().from(leaders)).toHaveLength(2);
    expect(await db.select().from(backfillJobs)).toHaveLength(2);
    // An address someone already watches costs nothing more.
    await bob.put(`/me/favorites/${ADDR}`).expect(200);
    // An imported leader is the admin's and is not counted or refused.
    await db.insert(leaders).values({ chain: "hyperliquid", address: THIRD, active: true, source: "import" });
    await alice.put(`/me/favorites/${THIRD}`).expect(200);
    // Room again once an address is no longer watched.
    await bob.delete(`/me/favorites/${OTHER}`).expect(204);
    await bob.put(`/me/favorites/${"0x" + "12".repeat(20)}`).expect(200);
    // Two additions racing for the last place: one wins.
    await bob.delete(`/me/favorites/${"0x" + "12".repeat(20)}`).expect(204);
    const racing = await Promise.all([alice.put(`/me/favorites/${"0x" + "34".repeat(20)}`), bob.put(`/me/favorites/${"0x" + "56".repeat(20)}`)]);
    expect(racing.map((r) => r.status).sort()).toEqual([200, 409]);
    // Raising the setting takes effect at once.
    await settings.patch({ general: { maxWatchedAddresses: 10 } }, null);
    await bob.put(`/me/favorites/${"0x" + "56".repeat(20)}`).expect(200);
  });

  it("serializes favorite quota checks, preserves idempotency and rejects before backfill", async () => {
    vi.stubEnv("MAX_FAVORITES_PER_USER", "1");
    try {
      await alice.get("/me").expect(200);
      const responses = await Promise.all([alice.put(`/me/favorites/${ADDR}`), alice.put(`/me/favorites/${OTHER}`)]);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(responses.find((r) => r.status === 409)?.body.error.code).toBe("favorite_limit");
      const winner = responses.find((r) => r.status === 200)!.body.data.address;
      await alice.put(`/me/favorites/${winner}`).expect(200);
      expect(await db.select().from(userFavorites)).toHaveLength(1);
      expect(await db.select().from(leaders)).toHaveLength(1);
      expect(await db.select().from(backfillJobs)).toHaveLength(1);
      await alice.delete(`/me/favorites/${winner}`).expect(204);
      await alice.put(`/me/favorites/${winner === ADDR ? OTHER : ADDR}`).expect(200);
    } finally { vi.unstubAllEnvs(); }
  });

  it("serves validated v1 profile and favorite DTOs with string timestamps", async () => {
    const me = await alice.get("/me").set("x-api-contract", "1").expect(200);
    expect(typeof me.body.data.createdAt).toBe("string");
    expect(me.body.data.permissions).toEqual([]);
    const favorite = await alice.put(`/me/favorites/${ADDR}`).set("x-api-contract", "1").expect(200);
    expect(favorite.body.data.address).toBe(ADDR);
    const list = await alice.get("/me/favorites").set("x-api-contract", "1").expect(200);
    expect(list.body.data).toHaveLength(1);
  });

  async function leaderRow(address: string) {
    const [row] = await db.select().from(leaders).where(eq(leaders.address, address));
    return row;
  }

  describe("access", () => {
    it("anonymous: 401; service token: 403 (no profile); forged token: 401", async () => {
      await http().get("/me").expect(401);
      await http().get("/me/favorites").expect(401);
      await as(SERVICE_TOKEN).get("/me").expect(403);
      await as("forged").get("/me").expect(401);
    });
  });

  it("sign-up doesn't copy the default rules", async () => {
    const me = (await alice.get("/me").expect(200)).body.data as { id: number };
    expect(await db.select().from(alertRules).where(eq(alertRules.userId, me.id))).toEqual([]);
  });

  describe("GET/PATCH /me", () => {
    it("returns the caller's profile and updates locale/displayName", async () => {
      const me = (await alice.get("/me").expect(200)).body.data;
      expect(me).toMatchObject({
        privyUserId: "did:privy:alice",
        email: "alice@example.com",
        role: "user",
        locale: "zh-TW",
        displayName: null,
      });

      const patched = (await alice.patch("/me", { locale: "en", displayName: "  Alice  " }).expect(200)).body.data;
      expect(patched).toMatchObject({ locale: "en", displayName: "Alice" });
      expect((await alice.get("/me").expect(200)).body.data).toMatchObject({ locale: "en", displayName: "Alice" });
    });

    it("accepts CopyDog's eleven languages", async () => {
      for (const locale of ["en", "zh-CN", "ko", "ja", "ru", "tr", "vi", "es", "pt", "id", "zh-TW"]) {
        expect((await alice.patch("/me", { locale }).expect(200)).body.data.locale).toBe(locale);
      }
    });

    it("rejects an unknown locale or an over-long name with 400", async () => {
      await alice.patch("/me", { locale: "fr" }).expect(400);
      await alice.patch("/me", { displayName: "x".repeat(65) }).expect(400);
    });
  });

  describe("favorites", () => {
    it("PUT validates the address (400) and lowercases it", async () => {
      await alice.put("/me/favorites/not-an-address").expect(400);
      await alice.put("/me/favorites/0x1234").expect(400);
      const res = await alice.put(`/me/favorites/${ADDR_MIXED}`).expect(200);
      expect(res.body.data).toMatchObject({ address: ADDR, stats: null });
    });

    it("a new address becomes an active favorite-sourced leader and is backfilled once", async () => {
      await alice.put(`/me/favorites/${ADDR}`).expect(200);
      await alice.put(`/me/favorites/${ADDR}`).expect(200); // idempotent
      await bob.put(`/me/favorites/${ADDR}`).expect(200);

      expect(await leaderRow(ADDR)).toMatchObject({ source: "favorite", active: true, tier: "B" });
      expect(await db.select().from(backfillJobs)).toHaveLength(1);
      expect(await db.select().from(backfillJobs)).toMatchObject([{address: ADDR, status: "pending"}]);
      expect(await db.select().from(userFavorites)).toHaveLength(2);
    });

    it("GET lists the caller's favorites with trader_stats joined in as numbers", async () => {
      await db.insert(traderStats).values({
        address: ADDR,
        displayName: "Whale",
        accountValue: "1000000",
        pnlDay: "1",
        pnlWeek: "2",
        pnlMonth: "3",
        pnlAllTime: "4",
        roiDay: "0.1",
        roiWeek: "0.2",
        roiMonth: "0.3",
        roiAllTime: "0.4",
        volumeDay: "10",
        volumeWeek: "20",
        volumeMonth: "30",
        volumeAllTime: "40",
        updatedAt: new Date(),
      });
      await alice.put(`/me/favorites/${ADDR}`).expect(200);
      await alice.put(`/me/favorites/${OTHER}`).expect(200);
      await bob.put(`/me/favorites/${OTHER}`).expect(200);

      const list = (await alice.get("/me/favorites").expect(200)).body.data as { address: string; stats: unknown }[];
      expect(list.map((f) => f.address).sort()).toEqual([ADDR, OTHER].sort());
      const whale = list.find((f) => f.address === ADDR)!;
      expect(whale.stats).toMatchObject({
        displayName: "Whale",
        accountValue: 1_000_000,
        accountPnl: { day: 1, week: 2, month: 3, allTime: 4 },
        accountRoi: { month: 0.3 },
        volume: { allTime: 40 },
      });
      expect(list.find((f) => f.address === OTHER)!.stats).toBeNull();
      expect((await bob.get("/me/favorites").expect(200)).body.data).toHaveLength(1);
    });

    it("DELETE deactivates a favorite-sourced leader only when nobody else favorites it", async () => {
      await alice.put(`/me/favorites/${ADDR}`).expect(200);
      await bob.put(`/me/favorites/${ADDR}`).expect(200);

      await alice.delete(`/me/favorites/${ADDR}`).expect(204);
      expect((await leaderRow(ADDR)).active).toBe(true); // bob still favorites it

      await bob.delete(`/me/favorites/${ADDR}`).expect(204);
      expect(await leaderRow(ADDR)).toMatchObject({ active: false, source: "favorite" });

      await bob.delete(`/me/favorites/${ADDR}`).expect(204); // idempotent
    });

    it("favoriting again reactivates an inactive favorite-sourced leader without a new backfill", async () => {
      await alice.put(`/me/favorites/${ADDR}`).expect(200);
      await alice.delete(`/me/favorites/${ADDR}`).expect(204);
      expect((await leaderRow(ADDR)).active).toBe(false);

      await bob.put(`/me/favorites/${ADDR}`).expect(200);
      expect(await leaderRow(ADDR)).toMatchObject({ active: true, source: "favorite" });
      expect(await db.select().from(backfillJobs)).toHaveLength(1);
    });

    it("imported leaders are never changed: not re-sourced, not deactivated, not reactivated", async () => {
      await db.insert(leaders).values([
        { address: ADDR, source: "import", active: true, tier: "A", label: "Imported" },
        { address: OTHER, source: "import", active: false, tier: "C" },
      ]);

      await alice.put(`/me/favorites/${ADDR}`).expect(200);
      await alice.put(`/me/favorites/${OTHER}`).expect(200);
      expect(await leaderRow(ADDR)).toMatchObject({ source: "import", active: true, tier: "A", label: "Imported" });
      expect(await leaderRow(OTHER)).toMatchObject({ source: "import", active: false, tier: "C" });

      await alice.delete(`/me/favorites/${ADDR}`).expect(204);
      expect(await leaderRow(ADDR)).toMatchObject({ source: "import", active: true });
      expect(await db.select().from(backfillJobs)).toHaveLength(0);
    });
  });

  describe("favorite alerts: PATCH /me/favorites/:address/alert", () => {
    async function aliceId() {
      const me = (await alice.get("/me").expect(200)).body.data as { id: number };
      return me.id;
    }
    async function linkTelegram(userId: number, enabled = true) {
      await db.insert(notificationChannels).values({ userId, kind: "telegram", target: "555", enabled });
    }
    const addr = (i: number) => "0x" + i.toString(16).padStart(2, "0").repeat(20);

    it("404 when the address isn't a favorite; 400 on a bad address or body", async () => {
      await linkTelegram(await aliceId());
      await alice.patch(`/me/favorites/${ADDR}/alert`, { enabled: true }).expect(404);
      await alice.patch(`/me/favorites/not-an-address/alert`, { enabled: true }).expect(400);
      await alice.put(`/me/favorites/${ADDR}`).expect(200);
      await alice.patch(`/me/favorites/${ADDR}/alert`, { minUsd: -1 }).expect(400);
      await alice.patch(`/me/favorites/${ADDR}/alert`, { sides: "up" }).expect(400);
    });

    it("turning on without a linked, enabled Telegram → 409 telegram_not_linked", async () => {
      await alice.put(`/me/favorites/${ADDR}`).expect(200);
      const res = await alice.patch(`/me/favorites/${ADDR}/alert`, { enabled: true }).expect(409);
      expect(res.body.error).toMatchObject({ code: "telegram_not_linked" });

      await linkTelegram(await aliceId(), false); // paused with /stop
      expect((await alice.patch(`/me/favorites/${ADDR}/alert`, { enabled: true }).expect(409)).body.error.code).toBe(
        "telegram_not_linked",
      );
      // Side and minimum can still be set while off.
      const off = (await alice.patch(`/me/favorites/${ADDR}/alert`, { sides: "sell", minUsd: 5000 }).expect(200)).body.data;
      expect(off.alert).toEqual({ enabled: false, sides: "sell", minUsd: 5000 });
    });

    it("with Telegram linked: switches on, sets side and minimum, and GET /me/favorites shows it", async () => {
      await linkTelegram(await aliceId());
      await alice.put(`/me/favorites/${ADDR}`).expect(200);
      const res = await alice.patch(`/me/favorites/${ADDR}/alert`, { enabled: true, sides: "buy", minUsd: 25000 }).expect(200);
      expect(res.body.data).toMatchObject({ address: ADDR, alert: { enabled: true, sides: "buy", minUsd: 25000 } });

      await alice.patch(`/me/favorites/${ADDR}/alert`, { minUsd: null }).expect(200);
      const [fav] = (await alice.get("/me/favorites").expect(200)).body.data as { alert: unknown }[];
      expect(fav.alert).toEqual({ enabled: true, sides: "buy", minUsd: null });
    });

    it("the limit (notifications.maxAlertTraders, default 3) → 409 alert_limit with the limit", async () => {
      await linkTelegram(await aliceId());
      for (let i = 1; i <= 4; i++) await alice.put(`/me/favorites/${addr(i)}`).expect(200);
      for (let i = 1; i <= 3; i++) await alice.patch(`/me/favorites/${addr(i)}/alert`, { enabled: true }).expect(200);

      const res = await alice.patch(`/me/favorites/${addr(4)}/alert`, { enabled: true }).expect(409);
      expect(res.body.error).toMatchObject({ code: "alert_limit", details: { limit: 3 } });

      // Editing one that is already on isn't counted again; switching one off frees a slot.
      await alice.patch(`/me/favorites/${addr(1)}/alert`, { enabled: true, sides: "sell" }).expect(200);
      await alice.patch(`/me/favorites/${addr(2)}/alert`, { enabled: false }).expect(200);
      await alice.patch(`/me/favorites/${addr(4)}/alert`, { enabled: true }).expect(200);
    });

    it("concurrent requests can't both take the last slot", async () => {
      await linkTelegram(await aliceId());
      for (let i = 1; i <= 6; i++) await alice.put(`/me/favorites/${addr(i)}`).expect(200);
      await alice.patch(`/me/favorites/${addr(1)}/alert`, { enabled: true }).expect(200);
      await alice.patch(`/me/favorites/${addr(2)}/alert`, { enabled: true }).expect(200);

      const results = await Promise.all(
        [3, 4, 5, 6].map((i) => alice.patch(`/me/favorites/${addr(i)}/alert`, { enabled: true })),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
      const on = await db.select().from(userFavorites).where(eq(userFavorites.alertEnabled, true));
      expect(on).toHaveLength(3);
    });

    it("lowering the limit keeps existing alerts on; only new ones are refused", async () => {
      await linkTelegram(await aliceId());
      for (let i = 1; i <= 3; i++) {
        await alice.put(`/me/favorites/${addr(i)}`).expect(200);
      }
      await alice.patch(`/me/favorites/${addr(1)}/alert`, { enabled: true }).expect(200);
      await alice.patch(`/me/favorites/${addr(2)}/alert`, { enabled: true }).expect(200);

      await settings.patch({ notifications: { maxAlertTraders: 1 } }, null);
      const list = (await alice.get("/me/favorites").expect(200)).body.data as { alert: { enabled: boolean } }[];
      expect(list.filter((f) => f.alert.enabled)).toHaveLength(2);
      await alice.patch(`/me/favorites/${addr(2)}/alert`, { minUsd: 10 }).expect(200);
      expect((await alice.patch(`/me/favorites/${addr(3)}/alert`, { enabled: true }).expect(409)).body.error).toMatchObject({
        code: "alert_limit",
        details: { limit: 1 },
      });
    });

    it("the limit is per user", async () => {
      await linkTelegram(await aliceId());
      await settings.patch({ notifications: { maxAlertTraders: 1 } }, null);
      await alice.put(`/me/favorites/${ADDR}`).expect(200);
      await alice.patch(`/me/favorites/${ADDR}/alert`, { enabled: true }).expect(200);

      const bobMe = (await bob.get("/me").expect(200)).body.data as { id: number };
      await linkTelegram(bobMe.id);
      await bob.put(`/me/favorites/${ADDR}`).expect(200);
      await bob.patch(`/me/favorites/${ADDR}/alert`, { enabled: true }).expect(200);
    });

    it("unfavoriting deletes the alert with the row", async () => {
      await linkTelegram(await aliceId());
      await alice.put(`/me/favorites/${ADDR}`).expect(200);
      await alice.patch(`/me/favorites/${ADDR}/alert`, { enabled: true, sides: "sell" }).expect(200);
      await alice.delete(`/me/favorites/${ADDR}`).expect(204);
      expect(await db.select().from(userFavorites)).toHaveLength(0);

      const again = (await alice.put(`/me/favorites/${ADDR}`).expect(200)).body.data;
      expect(again.alert).toEqual({ enabled: false, sides: "both", minUsd: null });
    });
  });

  describe("DELETE /me (account deletion)", () => {
    it("needs the explicit confirmation header, not only a valid token (audit C)", async () => {
      const id = (await alice.get("/me").expect(200)).body.data.id as number;
      const bare = await http().delete("/me").set("Authorization", "Bearer alice-token").expect(428);
      expect(bare.body.error.code).toBe("confirmation_required");
      await http().delete("/me").set("Authorization", "Bearer alice-token").set("X-Confirm-Delete", "yes").expect(428);
      expect((await alice.get("/me").expect(200)).body.data.id).toBe(id);
      await alice.delete("/me").expect(204);
    });

    it('removes unbound referral aliases when the owner deletes an otherwise empty account', async () => {
      const id = (await alice.get('/me').expect(200)).body.data.id as number;
      await db.insert(referralCodes).values({ id: 'unused-referral', userId: id, code: 'UNUSEDCODE', kind: 'custom' });
      await alice.delete('/me').expect(204);
      expect(await db.select().from(referralCodes)).toHaveLength(0);
    });
    it('preserves referral financial history and returns a controlled conflict before deletion', async () => {
      const id = (await alice.get('/me').expect(200)).body.data.id as number;
      await db.insert(referralPolicies).values({ version: 'retention-test', effectiveFrom: new Date(0) });
      await db.insert(referralClaims).values({ id: 'historical-claim', userId: id, key: 'historical-owner-key', requestHash: 'a'.repeat(64), policyVersion: 'retention-test',
        network: 'mainnet', token: 'USDC', destination: OTHER, amountUnits: '1', status: 'unknown', attemptId: 'retained-attempt', createdAt: new Date(), updatedAt: new Date() });
      // A claim whose payout is still unknown is in flight: it blocks.
      expect((await alice.delete('/me').expect(409)).body.error.code).toBe('referral_claim_pending');
      expect(await db.select().from(referralClaims)).toHaveLength(1);
      expect(await db.select().from(users).where(eq(users.id, id))).toHaveLength(1);
    });
    it("deletes the account and everything it owns here, releases the watch list and audits counts only", async () => {
      const id = (await alice.get("/me").expect(200)).body.data.id as number;
      await db.insert(notificationChannels).values({ userId: id, kind: "telegram", target: "555", enabled: true });
      await alice.put(`/me/favorites/${ADDR}`).expect(200);
      await alice.put(`/me/favorites/${OTHER}`).expect(200);
      await bob.put(`/me/favorites/${OTHER}`).expect(200);
      await alice.patch(`/me/favorites/${ADDR}/alert`, { enabled: true }).expect(200);
      const [group] = await db.insert(favoriteGroups).values({ userId: id, name: "Core", color: "#ff7a45" }).returning();
      await db.insert(favoriteGroupMembers).values({ groupId: group.id, userId: id, address: ADDR });
      await db.insert(telegramLinkTokens).values({ userId: id, tokenHash: "hash-for-deletion-test", expiresAt: new Date(Date.now() + 60_000) });

      await alice.delete("/me").expect(204);

      expect(await db.select().from(users).where(eq(users.id, id))).toHaveLength(0);
      expect(await db.select().from(userFavorites).where(eq(userFavorites.userId, id))).toHaveLength(0);
      expect(await db.select().from(favoriteGroups)).toHaveLength(0);
      expect(await db.select().from(favoriteGroupMembers)).toHaveLength(0);
      expect(await db.select().from(notificationChannels)).toHaveLength(0);
      expect(await db.select().from(telegramLinkTokens)).toHaveLength(0);
      // ADDR was only Alice's: no longer watched. OTHER is still Bob's.
      expect(await leaderRow(ADDR)).toMatchObject({ active: false, source: "favorite" });
      expect((await leaderRow(OTHER)).active).toBe(true);
      const [audit] = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.event, "user.delete"));
      // Nothing had to be kept, so there is no tombstone (docs/account-deletion.md).
      expect(audit).toMatchObject({ actorKind: "user", actorUserId: id, target: `user:${id}`, afterJson: expect.objectContaining({ tombstoneUserId: null, kept: {} }),
        beforeJson: { role: "user", favorites: 2, alerts: 1, groups: 1, telegramLinked: true } });
      expect(await db.select().from(users)).toHaveLength(1); // Bob
      expect(JSON.stringify(audit.beforeJson)).not.toContain("alice@example.com");

      // The same token is refused while its cache entry lives (requests in
      // flight during sign-out can't recreate the account) …
      await alice.get("/me").expect(401);
      await alice.delete("/me").expect(401);
      await alice.put(`/me/favorites/${ADDR}`).expect(401);
      expect(await db.select().from(users).where(eq(users.privyUserId, "did:privy:alice"))).toHaveLength(0);
      // … and a later sign-in is a brand-new, empty account.
      auth.clearCache();
      const again = (await alice.get("/me").expect(200)).body.data as { id: number };
      expect(again.id).not.toBe(id);
      expect((await alice.get("/me/favorites").expect(200)).body.data).toEqual([]);
    });

    it("refuses the only enabled admin (409 last_admin), allows an admin when another remains", async () => {
      const id = (await alice.get("/me").expect(200)).body.data.id as number;
      await db.update(users).set({ role: "admin" }).where(eq(users.id, id));
      auth.clearCache();
      expect((await alice.delete("/me").expect(409)).body.error.code).toBe("last_admin");
      const bobId = (await bob.get("/me").expect(200)).body.data.id as number;
      await db.update(users).set({ role: "admin" }).where(eq(users.id, bobId));
      auth.clearCache();
      await alice.delete("/me").expect(204);
      expect(await db.select().from(users).where(eq(users.id, id))).toHaveLength(0);
    });

    it("a withdrawal whose outcome is unknown blocks deletion (409 withdrawal_pending) and is kept", async () => {
      const id = (await alice.get("/me").expect(200)).body.data.id as number;
      await db.insert(walletWithdrawals).values({ id: "withdrawal-record", userId: id, network: "testnet", address: ADDR, destination: OTHER, amount: "12.5", nonce: Date.now(), origin: "legacy", status: "unknown" });
      expect((await alice.delete("/me").expect(409)).body.error.code).toBe("withdrawal_pending");
      expect(await db.select().from(walletWithdrawals)).toHaveLength(1);
      expect(await db.select().from(users).where(eq(users.id, id))).toHaveLength(1);
    });

    it("anonymous: 401; service token: 403", async () => {
      await http().delete("/me").expect(401);
      await as(SERVICE_TOKEN).delete("/me").expect(403);
    });
  });

  it("the old endpoints are gone", async () => {
    await alice.get("/me/notification-channels").expect(404);
    await alice.put("/me/notification-channels/telegram", { target: "1" }).expect(404);
    await alice.get("/me/alert-rules").expect(404);
    await alice.patch("/me/alert-rules/1", { enabled: false }).expect(404);
  });
});
