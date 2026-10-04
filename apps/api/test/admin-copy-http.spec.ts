import type { INestApplication } from "@nestjs/common";
import { adminAuditLogs, copyControlEvents, copyControls, copyOrders, copyRiskPolicies } from "@trading-dashboard/shared/database";
import {
  DEFAULT_COPY_RISK_LIMITS,
  wireAdminCopyControlSchema,
  wireAdminCopyExposureSchema,
  wireAdminCopyOrdersSchema,
  wireAdminCopyOverviewSchema,
  wireAdminCopyRiskSchema,
  wireAdminCopyStrategiesSchema,
  wireAdminCopyStrategyDetailSchema,
} from "@trading-dashboard/shared/contracts";
import { asc } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminCopyController } from "../src/admin/admin-copy.controller.js";
import type { AuthService } from "../src/common/auth/auth.service.js";
import { CopyAdminReadService } from "../src/copy/copy-admin-read.service.js";
import { CopyControlService } from "../src/copy/copy-control.service.js";
import { CopyExecutionService } from "../src/copy/copy-execution.service.js";
import { CopyMarketService } from "../src/copy/copy-market.service.js";
import { CopyOrderPlanner } from "../src/copy/copy-planner.service.js";
import { CopyRiskPolicyService } from "../src/copy/copy-risk-policy.service.js";
import { CopySignalService } from "../src/copy/copy-signal.service.js";
import { CopyStrategyService } from "../src/copy/copy-strategy.service.js";
import { CopyPerformanceService } from "../src/copy/copy-performance.service.js";
import { CopyStreamService } from "../src/copy/copy-stream.service.js";
import { CopyController } from "../src/copy/copy.controller.js";
import { CopyRepository } from "../src/copy/copy.repository.js";
import { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type { HlUserFill } from "../src/hyperliquid/types.js";
import { FillSyncRepository } from "../src/watcher/fill-sync.repository.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { SettingsService } from "../src/settings/settings.service.js";
import { closeTestDb, getTestDb, insertUser, openCopyTrading, truncateAll } from "./db-test-utils.js";

const READ_ONLY = "copy-read-only-service-token-0123456789";
const LEADER = "0x" + "1e".repeat(20);
const mids: Record<string, number> = { BTC: 100_000, ETH: 4_000 };
/** Hyperliquid stand-in: prices, the universe and a leader with no positions. */
const info = {
  allMids: vi.fn(async () => Object.fromEntries(Object.entries(mids).map(([k, v]) => [k, String(v)]))),
  metaAndAssetCtxs: vi.fn(async () => [
    { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "ETH", szDecimals: 4, maxLeverage: 25 }, { name: "kPEPE", szDecimals: 0, maxLeverage: 10 }] },
    ["BTC", "ETH", "kPEPE"].map((c) => ({ funding: "0.0001", markPx: String(mids[c] ?? 0.01), oraclePx: String(mids[c] ?? 0.01), openInterest: "1" })),
  ]),
  clearinghouseState: vi.fn(async () => ({
    assetPositions: [],
    marginSummary: { accountValue: "10000", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "0" },
    crossMarginSummary: { accountValue: "10000", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "0" },
    withdrawable: "0",
    time: Date.now() - 5,
  })),
  spotClearinghouseState: vi.fn(async () => ({ balances: [], portfolioMarginEnabled: false })),
  userAbstraction: vi.fn(async () => "default"),
  delegatorSummary: vi.fn(async () => ({ delegated: "0", undelegated: "0", totalPendingWithdrawal: "0", nPendingWithdrawals: 0 })),
  spotMetaAndAssetCtxs: vi.fn(async () => [{ tokens: [{ name: "USDC", index: 0 }], universe: [] }, []]),
  perpDexs: vi.fn(async () => [null]),
  portfolio: vi.fn(async () => [["allTime", { accountValueHistory: [[1, "1"], [2, "0"]], pnlHistory: [[1, "0"], [2, "0"]], vlm: "0" }]]),
  meta: vi.fn(async () => ({ universe: [] })),
};
let tid = 5_000;
function fill(o: { coin?: string; side: "B" | "A"; sz: number; px: number; start: number; time: number }): HlUserFill {
  tid += 1;
  return {
    coin: o.coin ?? "BTC", px: String(o.px), sz: String(o.sz), side: o.side, time: o.time, startPosition: String(o.start),
    dir: "Open Long", closedPnl: "0", hash: "0x" + tid.toString(16).padStart(64, "0"), oid: tid, crossed: true, fee: "0", tid,
  } as HlUserFill;
}

describe("/admin/copy — the copy-trading admin API", () => {
  const db = getTestDb();
  const privy = stubPrivy({
    "admin-token": { privyUserId: "did:privy:copy-admin", profile: { email: "ops@example.com", walletAddress: null, embeddedWalletAddress: null } },
    "alice-token": { privyUserId: "did:privy:copy-alice", profile: { email: "alice@example.com", walletAddress: null, embeddedWalletAddress: null } },
  });
  let app: INestApplication;
  let auth: AuthService;
  let market: CopyMarketService;
  let adminId: number;
  let aliceId: number;

  const as = (token?: string) => {
    const set = (r: request.Test) => (token ? r.set("Authorization", `Bearer ${token}`) : r);
    return {
      get: (p: string) => set(request(app.getHttpServer()).get(p)),
      post: (p: string, body?: object) => set(request(app.getHttpServer()).post(p)).send(body),
      put: (p: string, body?: object) => set(request(app.getHttpServer()).put(p)).send(body),
    };
  };
  const admin = () => as("admin-token");

  beforeAll(async () => {
    vi.stubEnv("AUTH_SERVICE_TOKEN", READ_ONLY);
    vi.stubEnv("AUTH_SERVICE_PERMISSIONS", "admin.access,copy.read");
    ({ app, auth } = await createAuthedApp({
      db,
      privy,
      controllers: [AdminCopyController, CopyController],
      providers: [
        CopyRepository, CopyMarketService, CopyRiskPolicyService, CopyOrderPlanner, CopySignalService, CopyExecutionService,
        CopyControlService, CopyStrategyService, CopyPerformanceService, CopyStreamService, CopyAdminReadService, FillSyncRepository,
        { provide: HyperliquidInfoClient, useValue: info },
      ],
    }));
    market = app.get(CopyMarketService);
  });

  beforeEach(async () => {
    await truncateAll(db);
    auth.clearCache();
    market.resetCaches();
    // Copying is open here (the setting is off until an admin turns it on).
    await openCopyTrading(db);
    app.get(SettingsService).invalidate();
    adminId = (await insertUser(db, { privyUserId: "did:privy:copy-admin", email: "ops@example.com", role: "admin" })).id;
    aliceId = (await insertUser(db, { privyUserId: "did:privy:copy-alice", email: "alice@example.com" })).id;
  });

  afterAll(async () => {
    await app.close();
    await truncateAll(db);
    await closeTestDb();
    vi.unstubAllEnvs();
  });

  /** Alice copies the leader, who then opens 0.5 BTC: one filled order, one position. */
  async function aliceCopies(): Promise<number> {
    const res = await as("alice-token").post("/me/copy/strategies", { leader: LEADER, allocationUsd: 1_000, copyStartMode: "delta" }).expect(201);
    const activatedAt = new Date(res.body.data.activatedAt).getTime();
    await app.get(FillSyncRepository).insertFills(LEADER, [fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
    market.resetCaches();
    await app.get(CopySignalService).drain();
    await app.get(CopyExecutionService).drain();
    return res.body.data.id;
  }

  const READS = ["overview", "strategies", "orders", "exposure", "risk"];

  it("reads need copy.read: anonymous 401, a plain user 403, a copy.read service token 200", async () => {
    for (const path of READS) {
      await as().get(`/admin/copy/${path}`).expect(401);
      await as("alice-token").get(`/admin/copy/${path}`).expect(403);
      await as(READ_ONLY).get(`/admin/copy/${path}`).expect(200);
      await admin().get(`/admin/copy/${path}`).expect(200).expect("Cache-Control", "no-store");
    }
  });

  it("a copy.read caller can't stop, resume or change limits, and nothing is written", async () => {
    const control = { scope: "platform", command: "pause_new_risk", reason: "read-only attempt", expectedRevision: 0 };
    await as(READ_ONLY).post("/admin/copy/controls", control).expect(403);
    await as(READ_ONLY).post("/admin/copy/controls", { ...control, command: "resume" }).expect(403);
    await as(READ_ONLY).put("/admin/copy/risk", { limits: DEFAULT_COPY_RISK_LIMITS, reason: "read-only attempt", expectedVersion: 0 }).expect(403);
    await as("alice-token").post("/admin/copy/controls", control).expect(403);
    await as().post("/admin/copy/controls", control).expect(401);
    expect(await db.select().from(copyControls)).toEqual([]);
    expect(await db.select().from(copyRiskPolicies)).toEqual([]);
    expect(await db.select().from(adminAuditLogs)).toEqual([]);
  });

  it("the read models match their wire contracts and show a copy, its order, the exposure and the backlog", async () => {
    const id = await aliceCopies();
    const overview = wireAdminCopyOverviewSchema.parse((await admin().get("/admin/copy/overview").expect(200)).body.data);
    expect(overview).toMatchObject({ mode: "paper", platform: { pauseNewRisk: false, reduceOnly: false, revision: 0 }, strategies: { active: 1 }, orders24h: { filled: 1 },
      outbox: { pending: 0, failed: 0, oldestPendingAt: null }, riskPolicyVersion: 0, events: [] });

    const strategies = wireAdminCopyStrategiesSchema.parse((await admin().get("/admin/copy/strategies?status=active").expect(200)).body.data);
    expect(strategies.items).toHaveLength(1);
    expect(strategies.items[0]).toMatchObject({ id, userId: aliceId, userEmail: "alice@example.com", status: "active" });
    expect((await admin().get("/admin/copy/strategies?status=stopped").expect(200)).body.data.items).toEqual([]);
    expect((await admin().get(`/admin/copy/strategies?userId=${adminId}`).expect(200)).body.data.items).toEqual([]);

    const detail = wireAdminCopyStrategyDetailSchema.parse((await admin().get(`/admin/copy/strategies/${id}`).expect(200)).body.data);
    expect(detail.versions).toHaveLength(1);
    expect(detail.orders).toHaveLength(1);
    expect(detail.ledger.map((l) => l.kind)).toContain("allocate");
    await admin().get("/admin/copy/strategies/999999").expect(404);

    const orders = wireAdminCopyOrdersSchema.parse((await admin().get(`/admin/copy/orders?strategyId=${id}`).expect(200)).body.data);
    expect(orders.items[0]).toMatchObject({ coin: "BTC", status: "filled", userEmail: "alice@example.com" });
    expect((await admin().get("/admin/copy/orders?status=rejected,cancelled").expect(200)).body.data.items).toEqual([]);

    const exposure = wireAdminCopyExposureSchema.parse((await admin().get("/admin/copy/exposure").expect(200)).body.data);
    expect(exposure.items).toHaveLength(1);
    expect(exposure.items[0]).toMatchObject({ userId: aliceId, strategies: 1, control: { pauseNewRisk: false, reduceOnly: false, revision: 0 } });
    expect(exposure.items[0].coins[0]).toMatchObject({ coin: "BTC" });

    // A signal the consumer has not taken yet is the backlog, with its age.
    const [strategy] = strategies.items;
    await app.get(FillSyncRepository).insertFills(LEADER, [fill({ coin: "ETH", side: "B", sz: 1, px: 4_000, start: 0, time: new Date(strategy.activatedAt).getTime() + 2_000 })]);
    const behind = wireAdminCopyOverviewSchema.parse((await admin().get("/admin/copy/overview").expect(200)).body.data);
    expect(behind.outbox.pending).toBe(1);
    expect(behind.outbox.oldestPendingAt).not.toBeNull();
  });

  it("query bounds are validated", async () => {
    await admin().get("/admin/copy/strategies?limit=501").expect(400);
    await admin().get("/admin/copy/strategies?status=frozen").expect(400);
    await admin().get("/admin/copy/orders?status=rejected,nope").expect(400);
    await admin().get("/admin/copy/orders?userId=0").expect(400);
    await admin().get("/admin/copy/strategies/abc").expect(400);
  });

  it("a platform pause is applied, versioned and audited; a stale screen gets 409 with the current revision", async () => {
    const id = await aliceCopies();
    const res = await admin().post("/admin/copy/controls", { scope: "platform", command: "pause_new_risk", reason: "  incident drill  ", expectedRevision: 0 }).expect(201);
    const body = wireAdminCopyControlSchema.parse(res.body.data);
    expect(body).toMatchObject({ scope: "platform", scopeId: 0, state: { pauseNewRisk: true, reduceOnly: false, revision: 1 }, event: { command: "pause_new_risk", reason: "incident drill", actorUserId: adminId } });

    const stale = await admin().post("/admin/copy/controls", { scope: "platform", command: "reduce_only", reason: "second screen", expectedRevision: 0 }).expect(409);
    expect(stale.body.error).toMatchObject({ code: "stale_revision", details: { revision: 1 } });

    const overview = (await admin().get("/admin/copy/overview").expect(200)).body.data;
    expect(overview.platform).toMatchObject({ pauseNewRisk: true, revision: 1 });
    expect(overview.events[0]).toMatchObject({ scope: "platform", command: "pause_new_risk", reason: "incident drill", actorEmail: "ops@example.com" });

    const audit = await db.select().from(adminAuditLogs);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ event: "copy.control", target: "platform:0", actorKind: "user", actorUserId: adminId,
      beforeJson: { pauseNewRisk: false, reduceOnly: false, revision: 0 }, afterJson: { command: "pause_new_risk", reason: "incident drill", pauseNewRisk: true, revision: 1 } });

    // While paused the position stays; close-all sends one reduce-only close for it.
    const closed = await admin().post("/admin/copy/controls", { scope: "platform", command: "close_positions", reason: "close everything", expectedRevision: 1 }).expect(201);
    expect(closed.body.data).toMatchObject({ state: { pauseNewRisk: true, revision: 2 }, event: { result: { closeOrders: 1 } } });
    const [, close] = await db.select().from(copyOrders).orderBy(asc(copyOrders.id));
    expect(close).toMatchObject({ strategyId: id, leg: "stop_close", reduceOnly: true });

    const resumed = await admin().post("/admin/copy/controls", { scope: "platform", command: "resume", reason: "drill over", expectedRevision: 2 }).expect(201);
    expect(resumed.body.data.state).toEqual({ pauseNewRisk: false, reduceOnly: false, revision: 3 });
    expect((await db.select().from(copyControlEvents)).map((e) => e.command)).toEqual(["pause_new_risk", "close_positions", "resume"]);
    expect((await db.select().from(adminAuditLogs)).map((a) => a.event)).toEqual(["copy.control", "copy.control", "copy.control"]);
  });

  it("a user-level command stops that user only; the target must be exactly one scope", async () => {
    await aliceCopies();
    const res = await admin().post("/admin/copy/controls", { scope: "user", userId: aliceId, command: "reduce_only", reason: "limit review", expectedRevision: 0 }).expect(201);
    expect(res.body.data).toMatchObject({ scope: "user", scopeId: aliceId, state: { pauseNewRisk: false, reduceOnly: true, revision: 1 } });
    const exposure = (await admin().get("/admin/copy/exposure").expect(200)).body.data;
    expect(exposure.items[0].control).toEqual({ pauseNewRisk: false, reduceOnly: true, revision: 1 });
    expect((await admin().get("/admin/copy/overview").expect(200)).body.data.platform).toMatchObject({ pauseNewRisk: false, reduceOnly: false, revision: 0 });
    const [audit] = await db.select().from(adminAuditLogs);
    expect(audit).toMatchObject({ event: "copy.control", target: `user:${aliceId}` });

    await admin().post("/admin/copy/controls", { scope: "user", userId: 987_654, command: "pause_new_risk", reason: "nobody", expectedRevision: 0 }).expect(404);
    // No reason, a reason too short, a user command without a user, a platform command with one, an unknown command or key.
    const base = { scope: "platform", command: "pause_new_risk", reason: "because", expectedRevision: 0 };
    for (const bad of [
      { ...base, reason: undefined }, { ...base, reason: "  x " }, { ...base, scope: "user" }, { ...base, userId: aliceId },
      { ...base, command: "explode" }, { ...base, expectedRevision: -1 }, { ...base, expectedRevision: undefined }, { ...base, force: true },
    ]) await admin().post("/admin/copy/controls", bad).expect(400);
    expect(await db.select().from(adminAuditLogs)).toHaveLength(1);
  });

  it("the risk policy is saved as a new version with its reason, history and audit event", async () => {
    const before = wireAdminCopyRiskSchema.parse((await admin().get("/admin/copy/risk").expect(200)).body.data);
    expect(before).toMatchObject({ version: 0, limits: DEFAULT_COPY_RISK_LIMITS, history: [] });

    const limits = { ...DEFAULT_COPY_RISK_LIMITS, maxLeverage: 5, blockedCoins: ["kpepe"] };
    const saved = wireAdminCopyRiskSchema.parse((await admin().put("/admin/copy/risk", { limits, reason: "tighter before testnet", expectedVersion: 0 }).expect(200)).body.data);
    // Coins are stored in Hyperliquid's own spelling.
    expect(saved).toMatchObject({ version: 1, reason: "tighter before testnet", limits: { maxLeverage: 5, blockedCoins: ["kPEPE"] } });
    expect(saved.history).toMatchObject([{ version: 1, reason: "tighter before testnet", createdByUserId: adminId }]);

    const stale = await admin().put("/admin/copy/risk", { limits, reason: "from an old tab", expectedVersion: 0 }).expect(409);
    expect(stale.body.error).toMatchObject({ code: "stale_version", details: { version: 1 } });

    const again = (await admin().put("/admin/copy/risk", { limits: { ...limits, maxLeverage: 3 }, reason: "tighter still", expectedVersion: 1 }).expect(200)).body.data;
    expect(again.version).toBe(2);
    expect(again.history.map((h: { version: number }) => h.version)).toEqual([2, 1]);
    expect((await admin().get("/admin/copy/overview").expect(200)).body.data.riskPolicyVersion).toBe(2);

    const audit = await db.select().from(adminAuditLogs).orderBy(asc(adminAuditLogs.id));
    expect(audit.map((a) => [a.event, a.target])).toEqual([["copy.risk", "policy:1"], ["copy.risk", "policy:2"]]);
    expect(audit[1]).toMatchObject({ actorUserId: adminId, beforeJson: { version: 1 }, afterJson: { version: 2, reason: "tighter still" } });
  });

  it("an impossible or incomplete policy is refused and nothing is saved", async () => {
    const put = (limits: object, extra: object = {}) => admin().put("/admin/copy/risk", { limits, reason: "bad policy", expectedVersion: 0, ...extra });
    await put({ ...DEFAULT_COPY_RISK_LIMITS, minAllocationUsd: 500, maxAllocationUsd: 100 }).expect(400);
    await put({ ...DEFAULT_COPY_RISK_LIMITS, maxLeverage: 51 }).expect(400);
    await put({ ...DEFAULT_COPY_RISK_LIMITS, maxLeverage: undefined }).expect(400);
    await put({ ...DEFAULT_COPY_RISK_LIMITS, surprise: 1 }).expect(400);
    await put(DEFAULT_COPY_RISK_LIMITS, { reason: "" }).expect(400);
    const unknown = await put({ ...DEFAULT_COPY_RISK_LIMITS, blockedCoins: ["NOTACOIN"] }).expect(400);
    expect(unknown.body.error).toMatchObject({ code: "unknown_coin" });
    expect(await db.select().from(copyRiskPolicies)).toEqual([]);
    expect(await db.select().from(adminAuditLogs)).toEqual([]);
  });
});
