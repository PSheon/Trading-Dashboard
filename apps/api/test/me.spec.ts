import type { INestApplication } from "@nestjs/common";
import { alertRules, leaders, notificationChannels, traderStats, userFavorites } from "@trading-dashboard/shared";
import { and, eq, isNull } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthService } from "../src/common/auth/auth.service.js";
import { RulesSeedService } from "../src/rules/rules-seed.service.js";
import { FavoritesService } from "../src/users/favorites.service.js";
import { MeController } from "../src/users/me.controller.js";
import { NotificationChannelsService } from "../src/users/notification-channels.service.js";
import { ProfileService } from "../src/users/profile.service.js";
import { UserAlertRulesService } from "../src/users/user-alert-rules.service.js";
import { BackfillService } from "../src/watcher/backfill.service.js";
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
  const backfill = { trigger: vi.fn() };
  let app: INestApplication;
  let auth: AuthService;

  beforeAll(async () => {
    process.env.AUTH_SERVICE_TOKEN = SERVICE_TOKEN;
    ({ app, auth } = await createAuthedApp({
      db,
      privy,
      controllers: [MeController],
      providers: [
        ProfileService,
        FavoritesService,
        NotificationChannelsService,
        UserAlertRulesService,
        { provide: BackfillService, useValue: backfill },
      ],
    }));
  });

  beforeEach(async () => {
    await truncateAll(db);
    await new RulesSeedService(db).seedDefaultRules();
    auth.clearCache();
    backfill.trigger.mockClear();
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

  describe("GET/PATCH /me", () => {
    it("returns the caller's profile and updates locale/displayName", async () => {
      const me = (await alice.get("/me").expect(200)).body;
      expect(me).toMatchObject({
        privyUserId: "did:privy:alice",
        email: "alice@example.com",
        role: "user",
        locale: "zh-TW",
        displayName: null,
      });

      const patched = (await alice.patch("/me", { locale: "en", displayName: "  Alice  " }).expect(200)).body;
      expect(patched).toMatchObject({ locale: "en", displayName: "Alice" });
      expect((await alice.get("/me").expect(200)).body).toMatchObject({ locale: "en", displayName: "Alice" });
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
      expect(res.body).toMatchObject({ address: ADDR, stats: null });
    });

    it("a new address becomes an active favorite-sourced leader and is backfilled once", async () => {
      await alice.put(`/me/favorites/${ADDR}`).expect(200);
      await alice.put(`/me/favorites/${ADDR}`).expect(200); // idempotent
      await bob.put(`/me/favorites/${ADDR}`).expect(200);

      expect(await leaderRow(ADDR)).toMatchObject({ source: "favorite", active: true, tier: "B" });
      expect(backfill.trigger).toHaveBeenCalledTimes(1);
      expect(backfill.trigger).toHaveBeenCalledWith(ADDR);
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

      const list = (await alice.get("/me/favorites").expect(200)).body as { address: string; stats: unknown }[];
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
      expect((await bob.get("/me/favorites").expect(200)).body).toHaveLength(1);
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
      backfill.trigger.mockClear();

      await bob.put(`/me/favorites/${ADDR}`).expect(200);
      expect(await leaderRow(ADDR)).toMatchObject({ active: true, source: "favorite" });
      expect(backfill.trigger).not.toHaveBeenCalled();
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
      expect(backfill.trigger).not.toHaveBeenCalled();
    });
  });

  describe("notification channels", () => {
    it("PUT telegram upserts one row per user; GET lists it", async () => {
      expect((await alice.get("/me/notification-channels").expect(200)).body).toEqual([]);

      expect((await alice.put("/me/notification-channels/telegram", { target: "12345" }).expect(200)).body).toEqual({
        kind: "telegram",
        target: "12345",
        enabled: true,
      });
      await alice.put("/me/notification-channels/telegram", { target: "-100987", enabled: false }).expect(200);

      expect((await alice.get("/me/notification-channels").expect(200)).body).toEqual([
        { kind: "telegram", target: "-100987", enabled: false },
      ]);
      const rows = await db.select().from(notificationChannels);
      expect(rows).toHaveLength(1);
      expect((await bob.get("/me/notification-channels").expect(200)).body).toEqual([]);
    });

    it("rejects a non-numeric chat id with 400", async () => {
      await alice.put("/me/notification-channels/telegram", { target: "@mychannel" }).expect(400);
      await alice.put("/me/notification-channels/telegram", {}).expect(400);
    });
  });

  describe("alert rules", () => {
    it("GET lists only the caller's own copies", async () => {
      const aliceRules = (await alice.get("/me/alert-rules").expect(200)).body as { userId: number; kind: string }[];
      const bobRules = (await bob.get("/me/alert-rules").expect(200)).body as { userId: number }[];
      expect(aliceRules.map((r) => r.kind)).toEqual(["R1", "R2", "R3"]);
      expect(new Set(aliceRules.map((r) => r.userId)).size).toBe(1);
      expect(aliceRules[0].userId).not.toBe(bobRules[0].userId);
    });

    it("PATCH updates only the given fields of the caller's own rule", async () => {
      const [r1] = (await alice.get("/me/alert-rules").expect(200)).body as { id: number; kind: string }[];
      const res = await alice
        .patch(`/me/alert-rules/${r1.id}`, { cooldownS: 60, paramsJson: { flatThresholdUsd: 1000, pctThreshold: 0.05 } })
        .expect(200);
      expect(res.body).toMatchObject({ id: r1.id, cooldownS: 60, enabled: true, tiers: ["A", "B", "C"] });

      await alice.patch(`/me/alert-rules/${r1.id}`, { enabled: false }).expect(200);
      const [row] = await db.select().from(alertRules).where(eq(alertRules.id, r1.id));
      expect(row).toMatchObject({ enabled: false, cooldownS: 60, paramsJson: { flatThresholdUsd: 1000, pctThreshold: 0.05 } });

      // The default template is untouched.
      const [template] = await db
        .select()
        .from(alertRules)
        .where(and(eq(alertRules.kind, "R1"), isNull(alertRules.userId)));
      expect(template).toMatchObject({ cooldownS: 900, enabled: true });
    });

    it("another user's rule is a 404, and so is the default template", async () => {
      const [bobR1] = (await bob.get("/me/alert-rules").expect(200)).body as { id: number }[];
      await alice.patch(`/me/alert-rules/${bobR1.id}`, { enabled: false }).expect(404);
      const defaults = (await db.select().from(alertRules)).filter((r) => r.userId === null);
      await alice.patch(`/me/alert-rules/${defaults[0].id}`, { enabled: false }).expect(404);
      const [row] = await db.select().from(alertRules).where(eq(alertRules.id, bobR1.id));
      expect(row.enabled).toBe(true);
    });

    it("validates like the admin editor: bad fields, bad R1/R3 params, kind changes → 400", async () => {
      const rules = (await alice.get("/me/alert-rules").expect(200)).body as { id: number; kind: string }[];
      const r1 = rules.find((r) => r.kind === "R1")!;
      await alice.patch(`/me/alert-rules/${r1.id}`, { cooldownS: -1 }).expect(400);
      await alice.patch(`/me/alert-rules/${r1.id}`, { tiers: ["Z"] }).expect(400);
      await alice.patch(`/me/alert-rules/${r1.id}`, { paramsJson: { flatThresholdUsd: "lots" } }).expect(400);
      await alice.patch(`/me/alert-rules/${r1.id}`, { kind: "R2" }).expect(400);
      await alice.patch(`/me/alert-rules/abc`, { enabled: false }).expect(400);
    });
  });
});
