import { backfillJobs } from "@trading-dashboard/shared/database";
import { RulesSeedRepository } from "../src/rules/rules-seed.repository.js";
import { ProfileRepository } from "../src/users/profile.repository.js";
import { testConfig } from "./config-test-utils.js";
import type { INestApplication } from "@nestjs/common";
import {
  alertRules,
  leaders,
  notificationChannels,
  traderStats,
  userFavorites,
} from "@trading-dashboard/shared/database";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthService } from "../src/common/auth/auth.service.js";
import type { SettingsService } from "../src/settings/settings.service.js";
import { RulesSeedService } from "../src/rules/rules-seed.service.js";
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
    delete: (path: string) => http().delete(path).set("Authorization", `Bearer ${token}`),
  });
  const alice = as("alice-token");
  const bob = as("bob-token");

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
        pnl: { day: 1, week: 2, month: 3, allTime: 4 },
        roi: { month: 0.3 },
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

  it("the old endpoints are gone", async () => {
    await alice.get("/me/notification-channels").expect(404);
    await alice.put("/me/notification-channels/telegram", { target: "1" }).expect(404);
    await alice.get("/me/alert-rules").expect(404);
    await alice.patch("/me/alert-rules/1", { enabled: false }).expect(404);
  });
});
