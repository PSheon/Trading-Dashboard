import type { INestApplication } from "@nestjs/common";
import { actions, alertRules, alerts, leaders, userFavorites, users } from "@trading-dashboard/shared/database";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ActionsController } from "../src/api/actions/actions.controller.js";
import { ActionsService } from "../src/api/actions/actions.service.js";
import { ActionStreamService } from "../src/api/actions/action-stream.service.js";
import { AlertRulesController } from "../src/api/alert-rules/alert-rules.controller.js";
import { AlertRulesService } from "../src/api/alert-rules/alert-rules.service.js";
import { AlertsController } from "../src/api/alerts/alerts.controller.js";
import { AlertsService } from "../src/api/alerts/alerts.service.js";
import { HealthController } from "../src/api/health/health.controller.js";
import { HealthService } from "../src/api/health/health.service.js";
import { LeadersController } from "../src/api/leaders/leaders.controller.js";
import { LeadersService } from "../src/api/leaders/leaders.service.js";
import { ListsController } from "../src/api/lists/lists.controller.js";
import { ListsService } from "../src/api/lists/lists.service.js";
import type { AuthService } from "../src/common/auth/auth.service.js";
import { ImportController } from "../src/import/import.controller.js";
import { ImportService } from "../src/import/import.service.js";
import { RulesSeedService } from "../src/rules/rules-seed.service.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const SERVICE_TOKEN = "service-token-for-routes-0123456789";
const WHALE = "0x" + "11".repeat(20);
const OTHER = "0x" + "22".repeat(20);

/** The real controllers with their decorators; market-data services that
 * need Hyperliquid are stubbed, the per-user ones run on the real DB. */
describe("route access on the existing controllers", () => {
  const db = getTestDb();
  const privy = stubPrivy({
    "alice-token": { privyUserId: "did:privy:alice" },
    "bob-token": { privyUserId: "did:privy:bob" },
    "boss-token": { privyUserId: "did:privy:boss", profile: { email: "boss@example.com", walletAddress: null } },
  });
  let app: INestApplication;
  let auth: AuthService;

  beforeAll(async () => {
    process.env.AUTH_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.AUTH_SERVICE_PERMISSIONS = "lists.read,leaders.import,leaders.manage,rules.read,alerts.readAll";
    process.env.AUTH_ADMIN_EMAILS = "boss@example.com";
    ({ app, auth } = await createAuthedApp({
      db,
      privy,
      controllers: [
        HealthController,
        LeadersController,
        ActionsController,
        AlertsController,
        AlertRulesController,
        ListsController,
        ImportController,
      ],
      providers: [
        ActionsService,
        ActionStreamService,
        AlertsService,
        AlertRulesService,
        { provide: HealthService, useValue: { heartbeat: async () => ({ ok: true }) } },
        {
          provide: LeadersService,
          useValue: {
            findAll: async () => [],
            findDetail: async (_c: string, _a: string, _i: string, scope: unknown) => ({ scope }),
            update: async () => ({ updated: true }),
          },
        },
        { provide: ListsService, useValue: { findAll: async () => [], diff: async () => ({ entries: [] }) } },
        { provide: ImportService, useValue: { importLeaderList: async () => ({ listId: 1, itemCount: 0, newAddresses: [] }) } },
      ],
    }));
  });

  beforeEach(async () => {
    await truncateAll(db);
    await new RulesSeedService(db).seedDefaultRules();
    auth.clearCache();
  });

  afterAll(async () => {
    delete process.env.AUTH_SERVICE_TOKEN;
    delete process.env.AUTH_SERVICE_PERMISSIONS;
    delete process.env.AUTH_ADMIN_EMAILS;
    await app.close();
    await closeTestDb();
  });

  const call = (method: "get" | "post" | "patch", path: string, token?: string, body?: object) => {
    const req = request(app.getHttpServer())[method](path);
    if (token) req.set("Authorization", `Bearer ${token}`);
    return body ? req.send(body) : req;
  };

  it("public market data: /health, GET /leaders*, GET /actions* work anonymously and with a forged token", async () => {
    for (const token of [undefined, "forged-token"]) {
      await call("get", "/health", token).expect(200);
      await call("get", "/leaders", token).expect(200);
      await call("get", `/leaders/hyperliquid/${WHALE}`, token).expect(200);
      await call("get", "/actions", token).expect(200);
      await call("get", "/actions/1/fills", token).expect(404);
    }
  });

  it("admin routes: anonymous 401, user 403, admin 200, service 200", async () => {
    const adminRoutes: [("get" | "post" | "patch"), string, object?][] = [
      ["get", "/lists"],
      ["get", "/lists/diff?fromListId=1&toListId=2"],
      ["post", "/import/lists", { fileName: "x.csv", rows: [{ address: WHALE, rank: 1 }] }],
      ["patch", `/leaders/hyperliquid/${WHALE}`, { tier: "A" }],
      ["get", "/alert-rules"],
    ];
    for (const [method, path, body] of adminRoutes) {
      const anonymous = await call(method, path, undefined, body);
      expect(anonymous.status, `${method.toUpperCase()} ${path}: ${JSON.stringify(anonymous.body)}`).toBe(401);
      await call(method, path, "alice-token", body).expect(403);
      const ok = method === "post" ? 201 : 200;
      await call(method, path, "boss-token", body).expect(ok);
      await call(method, path, SERVICE_TOKEN, body).expect(ok);
    }
  });

  it("/alert-rules lists and edits only the defaults, with validation", async () => {
    await call("get", "/alerts", "alice-token").expect(200); // signs alice in
    const [alice] = await db.select().from(users).where(eq(users.privyUserId, "did:privy:alice"));
    // Sign-up no longer copies rules; a leftover owned row is still never
    // listed or edited here.
    expect(await db.select().from(alertRules).where(eq(alertRules.userId, alice.id))).toEqual([]);
    const [owned] = await db
      .insert(alertRules)
      .values({ userId: alice.id, scope: "address", kind: "R1", paramsJson: { flatThresholdUsd: 1, pctThreshold: 0.1 }, cooldownS: 900, tiers: ["A"] })
      .returning();

    const listed = (await call("get", "/alert-rules", "boss-token").expect(200)).body as { userId: number | null; id: number }[];
    expect(listed).toHaveLength(3);
    expect(listed.every((r) => r.userId === null)).toBe(true);

    const body = { id: owned.id, scope: "address", kind: owned.kind, paramsJson: owned.paramsJson, cooldownS: 1, tiers: ["A"] };
    await call("post", "/alert-rules", "boss-token", body).expect(404); // not a default

    await call("post", "/alert-rules", "boss-token", { ...body, id: listed[0].id, cooldownS: -5 }).expect(400);
    await call("post", "/alert-rules", "boss-token", { ...body, id: undefined, kind: "R1" }).expect(409);
  });

  it("GET /alerts: 401 anonymous; a user sees only their own; admin and service see all", async () => {
    await call("get", "/alerts").expect(401);
    await call("get", "/alerts", "alice-token").expect(200);
    await call("get", "/alerts", "bob-token").expect(200);
    const all = await db.select().from(users);
    const alice = all.find((u) => u.privyUserId === "did:privy:alice")!;
    const bob = all.find((u) => u.privyUserId === "did:privy:bob")!;
    const [defaultRule] = await db.select().from(alertRules);
    await db.insert(alerts).values([
      // A favorite alert has no rule; an admin-style one references a default.
      { ruleId: null, userId: alice.id, address: WHALE, coin: "BTC", payloadJson: { chatId: "a" }, sendStatus: "sent", sentAt: new Date() },
      { ruleId: defaultRule.id, userId: bob.id, address: WHALE, coin: "BTC", payloadJson: { chatId: "b" }, sendStatus: "sent", sentAt: new Date() },
    ]);

    const mine = (await call("get", "/alerts", "alice-token").expect(200)).body as { userId: number }[];
    expect(mine.map((a) => a.userId)).toEqual([alice.id]);
    expect((await call("get", "/alerts", "boss-token").expect(200)).body).toHaveLength(2);
    expect((await call("get", "/alerts", SERVICE_TOKEN).expect(200)).body).toHaveLength(2);
  });

  it("leader detail: alert history is the caller's own (none when anonymous, all for admins)", async () => {
    expect((await call("get", `/leaders/hyperliquid/${WHALE}`).expect(200)).body.scope).toBe("none");
    const aliceScope = (await call("get", `/leaders/hyperliquid/${WHALE}`, "alice-token").expect(200)).body.scope;
    expect(aliceScope).toEqual({ userId: expect.any(Number) });
    expect((await call("get", `/leaders/hyperliquid/${WHALE}`, "boss-token").expect(200)).body.scope).toBe("all");
  });

  it("an unscoped service cannot read another user's alert payload", async () => {
    await call("get", "/alerts", "alice-token").expect(200);
    const [alice] = await db.select().from(users).where(eq(users.privyUserId, "did:privy:alice"));
    await db.insert(alerts).values({ userId: alice.id, address: WHALE, coin: "BTC", payloadJson: { chatId: "private-chat" }, sendStatus: "sent", sentAt: new Date() });
    const previous = process.env.AUTH_SERVICE_PERMISSIONS;
    try {
      process.env.AUTH_SERVICE_PERMISSIONS = "users.read";
      expect((await call("get", "/alerts", SERVICE_TOKEN).expect(200)).body).toEqual([]);
      process.env.AUTH_SERVICE_PERMISSIONS = "alerts.readAll";
      expect((await call("get", "/alerts", SERVICE_TOKEN).expect(200)).body).toHaveLength(1);
    } finally { process.env.AUTH_SERVICE_PERMISSIONS = previous; }
  });

  it("GET /actions?scope=favorites: anonymous 401, service 403, a user sees only their favorites' actions", async () => {
    await db.insert(leaders).values([{ address: WHALE }, { address: OTHER }]);
    const base = { coin: "BTC", kind: "open" as const, side: "long", notionalUsd: "1", avgPx: "1", fillIds: [], ts: new Date() };
    await db.insert(actions).values([
      { ...base, address: WHALE },
      { ...base, address: OTHER },
    ]);

    await call("get", "/actions?scope=favorites").expect(401);
    await call("get", "/actions?scope=favorites", SERVICE_TOKEN).expect(403);

    await call("get", "/actions", "alice-token").expect(200);
    const [alice] = await db.select().from(users).where(eq(users.privyUserId, "did:privy:alice"));
    await db.insert(userFavorites).values({ userId: alice.id, address: WHALE });

    const favs = (await call("get", "/actions?scope=favorites", "alice-token").expect(200)).body as { address: string }[];
    expect(favs.map((a) => a.address)).toEqual([WHALE]);
    expect((await call("get", "/actions", "alice-token").expect(200)).body).toHaveLength(2);
    expect((await call("get", "/actions?scope=favorites", "bob-token").expect(200)).body).toEqual([]);
  });
  it("filters a trader's actions by normalized address", async () => {
    const address = "0x" + "ab".repeat(20);
    const base = { coin: "BTC", kind: "open" as const, side: "long", notionalUsd: "1", avgPx: "1", fillIds: [], ts: new Date() };
    await db.insert(actions).values([{ ...base, address }, { ...base, address: OTHER }]);
    const result = await call("get", `/actions?address=0x${"AB".repeat(20)}`).expect(200);
    expect(result.body.map((a: { address: string }) => a.address)).toEqual([address]);
  });

  it.each(["limit=0", "limit=-1", "limit=501", "limit=abc", "before=invalid", "beforeId=1", "before=2026-01-01&beforeId=9223372036854775808", "kind=bogus", "scope=bogus", "address=invalid"])(
    "rejects malformed action query %s", async (query) => {
      await call("get", `/actions?${query}`).expect(400);
    },
  );

  it("validates alert queries and administrative input", async () => {
    await call("get", "/alerts?limit=1000000", "alice-token").expect(400);
    await call("get", "/lists/diff?fromListId=oops&toListId=2", "boss-token").expect(400);
    await call("get", "/leaders?active=maybe").expect(400);
    await call("patch", `/leaders/hyperliquid/${WHALE}`, "boss-token", { active: "false" }).expect(400);
    await call("patch", `/leaders/hyperliquid/${WHALE}`, "boss-token", { address: OTHER }).expect(400);
    await call("post", "/import/lists", "boss-token", { fileName: "x.csv", rows: [null] }).expect(400);
  });

});
