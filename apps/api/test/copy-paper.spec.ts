import type { INestApplication } from "@nestjs/common";
import {
  appSettings,
  copyConsumerCheckpoints,
  copyControlEvents,
  copyLedger,
  copyOrders,
  copyPositions,
  copySignalLegs,
  copySignalOutbox,
  copyStrategies,
  leaders,
  paperAccounts,
  adminAuditLogs,
  users,
} from "@trading-dashboard/shared/database";
import { and, asc, eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthService } from "../src/common/auth/auth.service.js";
import type { RequestUser } from "../src/common/auth/current-user.js";
import { CopyAdminReadService } from "../src/copy/copy-admin-read.service.js";
import { CopyControlService } from "../src/copy/copy-control.service.js";
import { CopyExecutionService } from "../src/copy/copy-execution.service.js";
import { CopyMarketService } from "../src/copy/copy-market.service.js";
import { CopyOrderPlanner } from "../src/copy/copy-planner.service.js";
import { CopyRiskPolicyService } from "../src/copy/copy-risk-policy.service.js";
import { CopySignalService } from "../src/copy/copy-signal.service.js";
import { CopyStrategyService } from "../src/copy/copy-strategy.service.js";
import { CopyController } from "../src/copy/copy.controller.js";
import { CopyRepository } from "../src/copy/copy.repository.js";
import { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type { HlUserFill } from "../src/hyperliquid/types.js";
import { SettingsService } from "../src/settings/settings.service.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { FillSyncRepository } from "../src/watcher/fill-sync.repository.js";
import { FavoritesRepository } from "../src/users/favorites.repository.js";
import { AccountRepository } from "../src/users/account.repository.js";
import { AccountDeletionService } from "../src/users/account-deletion.service.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const SERVICE_TOKEN = "service-token-for-copy-tests-0123456789";
const LEADER = "0x" + "1e".repeat(20);
const LEADER_MIXED = "0x" + "1E".repeat(20);
const OTHER = "0x" + "2f".repeat(20);

/** Hyperliquid stand-in: prices, universe with funding, leader account. */
const market = {
  mids: { BTC: 100_000, ETH: 4_000, kPEPE: 0.01 } as Record<string, number>,
  funding: 0.0001,
  leaderEquity: 10_000,
  leaderPositions: [] as { coin: string; szi: string; positionValue: string; entryPx: string }[],
};
const info = {
  allMids: vi.fn(async () => Object.fromEntries(Object.entries(market.mids).map(([k, v]) => [k, String(v)]))),
  metaAndAssetCtxs: vi.fn(async () => [
    { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "ETH", szDecimals: 4, maxLeverage: 25 }, { name: "kPEPE", szDecimals: 0, maxLeverage: 10 }] },
    ["BTC", "ETH", "kPEPE"].map((c) => ({ funding: String(market.funding), markPx: String(market.mids[c]), oraclePx: String(market.mids[c]), openInterest: "1" })),
  ]),
  clearinghouseState: vi.fn(async () => ({
    assetPositions: market.leaderPositions.map((p) => ({ position: { ...p, leverage: { type: "cross", value: 5 }, marginUsed: "0", unrealizedPnl: "0" } })),
    marginSummary: { accountValue: String(market.leaderEquity), totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "0" },
    crossMarginSummary: { accountValue: String(market.leaderEquity), totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "0" },
    withdrawable: "0",
    time: Date.now() - 5,
  })),
  meta: vi.fn(async (dex?: string) => ({ universe: dex === "xyz" ? [{ name: "xyz:TSLA", szDecimals: 3, maxLeverage: 10 }] : [] })),
};

let tidSeq = 1_000n;
/** A verified leader fill as Hyperliquid returns it. */
function fill(o: { coin?: string; side: "B" | "A"; sz: number; px: number; start: number; time: number; tid?: bigint }): HlUserFill {
  const tid = o.tid ?? ++tidSeq;
  return {
    coin: o.coin ?? "BTC", px: String(o.px), sz: String(o.sz), side: o.side, time: o.time, startPosition: String(o.start),
    dir: "Open Long", closedPnl: "0", hash: "0x" + tid.toString(16).padStart(64, "0"), oid: Number(tid), crossed: true, fee: "0", tid: Number(tid),
  } as HlUserFill;
}

describe("paper copy trading — real services, real Postgres, stubbed Hyperliquid", () => {
  const db = getTestDb();
  const privy = stubPrivy({
    "alice-token": { privyUserId: "did:privy:alice", profile: { email: "alice@example.com", walletAddress: null, embeddedWalletAddress: null } },
    "bob-token": { privyUserId: "did:privy:bob", profile: { email: "bob@example.com", walletAddress: null, embeddedWalletAddress: null } },
  });
  let app: INestApplication;
  let auth: AuthService;
  let settings: SettingsService;
  let signals: CopySignalService;
  let execution: CopyExecutionService;
  let controls: CopyControlService;
  let policies: CopyRiskPolicyService;
  let reads: CopyAdminReadService;
  let marketService: CopyMarketService;
  let fillsRepo: FillSyncRepository;

  beforeAll(async () => {
    process.env.AUTH_SERVICE_TOKEN = SERVICE_TOKEN;
    ({ app, auth, settings } = await createAuthedApp({
      db,
      privy,
      controllers: [CopyController],
      providers: [
        CopyRepository, CopyMarketService, CopyRiskPolicyService, CopyOrderPlanner, CopySignalService, CopyExecutionService,
        CopyControlService, CopyStrategyService, CopyAdminReadService, FillSyncRepository, AccountRepository, AccountDeletionService,
        { provide: HyperliquidInfoClient, useValue: info },
      ],
    }));
    signals = app.get(CopySignalService);
    execution = app.get(CopyExecutionService);
    controls = app.get(CopyControlService);
    policies = app.get(CopyRiskPolicyService);
    reads = app.get(CopyAdminReadService);
    marketService = app.get(CopyMarketService);
    fillsRepo = app.get(FillSyncRepository);
  });

  beforeEach(async () => {
    await truncateAll(db);
    auth.clearCache();
    (settings as unknown as { cache: unknown }).cache = undefined;
    marketService.resetCaches();
    market.mids = { BTC: 100_000, ETH: 4_000, kPEPE: 0.01 };
    market.funding = 0.0001;
    market.leaderEquity = 10_000;
    market.leaderPositions = [];
    vi.clearAllMocks();
  });

  afterAll(async () => {
    delete process.env.AUTH_SERVICE_TOKEN;
    await app.close();
    await closeTestDb();
  });

  const api = (token?: string) => {
    const auth = (r: request.Test) => (token ? r.set("Authorization", `Bearer ${token}`) : r);
    return {
      get: (p: string) => auth(request(app.getHttpServer()).get(p)),
      post: (p: string, body?: object) => auth(request(app.getHttpServer()).post(p)).send(body),
      patch: (p: string, body?: object) => auth(request(app.getHttpServer()).patch(p)).send(body),
    };
  };
  const alice = api("alice-token");

  async function startCopy(body: Record<string, unknown> = {}): Promise<{ id: number; activatedAt: number }> {
    const res = await alice.post("/me/copy/strategies", { leader: LEADER, allocationUsd: 1_000, copyStartMode: "delta", ...body }).expect(201);
    return { id: res.body.data.id, activatedAt: new Date(res.body.data.activatedAt).getTime() };
  }
  const store = (fills: HlUserFill[], address = LEADER) => fillsRepo.insertFills(address, fills);
  async function run() {
    marketService.resetCaches();
    const s = await signals.drain();
    const e = await execution.drain();
    return { ...s, ...e };
  }
  const orders = (strategyId: number) => db.select().from(copyOrders).where(eq(copyOrders.strategyId, strategyId)).orderBy(asc(copyOrders.id));
  async function position(strategyId: number, coin = "BTC") {
    const [p] = await db.select().from(copyPositions).where(and(eq(copyPositions.strategyId, strategyId), eq(copyPositions.coin, coin)));
    return p ? Number(p.size) : 0;
  }
  async function aliceUser(): Promise<Extract<RequestUser, { kind: "user" }>> {
    const [u] = await db.select().from(users).where(eq(users.privyUserId, "did:privy:alice"));
    return { kind: "user", id: u!.id, privyUserId: u!.privyUserId, role: u!.role };
  }
  const admin: RequestUser = { kind: "service", permissions: ["copy.read", "execution.pause", "execution.resume", "risk.manage"] };

  describe("starting a copy", () => {
    it("needs a signed-in person", async () => {
      await api().get("/me/copy").expect(401);
      await api(SERVICE_TOKEN).get("/me/copy").expect(403);
    });

    it("funds the copy from a 10,000 USDC paper balance, watches the leader, and refuses a second copy of the same leader in any case", async () => {
      const first = await alice.get("/me/copy").expect(200);
      expect(first.body.data).toMatchObject({ mode: "paper", paper: { balance: 10_000, startingBalance: 10_000, totalValue: 10_000 }, strategies: [] });

      const { id } = await startCopy();
      const overview = (await alice.get("/me/copy").expect(200)).body.data;
      expect(overview.paper).toMatchObject({ balance: 9_000, allocated: 1_000, totalValue: 10_000, totalPnl: 0 });
      expect(overview.strategies[0]).toMatchObject({
        id, mode: "paper", leaderAddress: LEADER, status: "active", version: 1, allocated: 1_000, equity: 1_000,
        settings: { direction: "same", sizingMode: "ratio", perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: null, copyStartMode: "delta" },
      });
      const [leader] = await db.select().from(leaders).where(eq(leaders.address, LEADER));
      expect(leader).toMatchObject({ active: true, source: "copy" });

      const again = await alice.post("/me/copy/strategies", { leader: LEADER_MIXED, allocationUsd: 500, copyStartMode: "delta" }).expect(409);
      expect(again.body.error.code).toBe("already_copying");
    });

    it("enforces CopyDog's $100 minimum, the paper balance and 6-decimal amounts", async () => {
      expect((await alice.post("/me/copy/strategies", { leader: LEADER, allocationUsd: 50, copyStartMode: "delta" }).expect(409)).body.error.code).toBe("below_min_allocation");
      await alice.get("/me/copy").expect(200);
      expect((await alice.post("/me/copy/strategies", { leader: LEADER, allocationUsd: 20_000, copyStartMode: "delta" }).expect(409)).body.error.code).toBe("insufficient_balance");
      await alice.post("/me/copy/strategies", { leader: LEADER, allocationUsd: 100.0000001, copyStartMode: "delta" }).expect(400);
      await alice.post("/me/copy/strategies", { leader: LEADER, allocationUsd: 150, sizingMode: "fixed", copyStartMode: "delta" }).expect(400);
    });

    it("adopts the leader's current positions (跟單目前持倉) and copies only fills after that snapshot", async () => {
      market.leaderPositions = [{ coin: "ETH", szi: "-5", positionValue: "20000", entryPx: "4100" }];
      const res = await alice.post("/me/copy/strategies", { leader: LEADER, allocationUsd: 1_000, direction: "reverse" }).expect(201);
      const id = res.body.data.id as number;
      // ratio: 20,000 × 1,000 / 10,000 = 2,000 notional; reverse of a short is a long.
      const [adopt] = await orders(id);
      expect(adopt).toMatchObject({ leg: "adopt", side: "B", status: "risk_approved", size: "0.5" });
      await run();
      expect(await position(id, "ETH")).toBeCloseTo(0.5);
      // A fill from before the snapshot is never copied.
      await store([fill({ coin: "ETH", side: "A", sz: 1, px: 4_000, start: -4, time: res.body.data.activatedAt ? new Date(res.body.data.activatedAt).getTime() - 1 : 0 })]);
      expect(await db.select().from(copySignalOutbox)).toHaveLength(0);
    });
  });

  describe("the execution outbox", () => {
    it("is written only for copied leaders' fills after the activation cursor, in the fills transaction", async () => {
      await store([fill({ side: "B", sz: 1, px: 100_000, start: 0, time: Date.now() })], OTHER);
      expect(await db.select().from(copySignalOutbox)).toHaveLength(0);
      const { activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 1, px: 100_000, start: 0, time: activatedAt - 10 })]);
      await store([fill({ side: "B", sz: 1, px: 100_000, start: 1, time: activatedAt + 10 })]);
      const rows = await db.select().from(copySignalOutbox);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ address: LEADER, status: "pending" });
    });

    it("unfavoriting a copied leader keeps it watched", async () => {
      await startCopy();
      const [u] = await db.select().from(users);
      const favorites = app.get(FavoritesRepository);
      await db.transaction(async (tx) => {
        await favorites.addAndWatch(tx as never, u!.id, LEADER);
        await favorites.removeAndUnwatch(tx as never, u!.id, LEADER);
      });
      const [leader] = await db.select().from(leaders).where(eq(leaders.address, LEADER));
      expect(leader!.active).toBe(true);
    });
  });

  describe("canonical signals", () => {
    it("copies a verified open with ratio sizing, fills at mid + slippage and reserves margin in the same transaction", async () => {
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      const outbox = await db.select().from(copySignalOutbox);
      expect(outbox).toHaveLength(1);

      const r1 = await signals.drain();
      expect(r1).toEqual({ processed: 1, orders: 1 });
      const [order] = await orders(id);
      // 50,000 × 1,000 / 10,000 = 5,000 → 0.05 BTC; strategy cap min(1,000 × 5, 1,000 × 10).
      expect(order).toMatchObject({ leg: "open", side: "B", size: "0.05", status: "risk_approved", reduceOnly: false, riskPolicyVersion: 0, strategyVersion: 1 });
      expect(order!.controlRevisions).toEqual({ platform: 0, user: 0, strategy: 0 });
      const held = await db.execute(sql`select status, notional::float8 as notional, margin::float8 as margin from copy_reservations`);
      expect(held.rows).toEqual([{ status: "held", notional: 5_000, margin: 500 }]);

      await execution.drain();
      const [filled] = await orders(id);
      expect(filled).toMatchObject({ status: "filled", filledSize: "0.05", avgPx: "100050" });
      expect(await position(id)).toBeCloseTo(0.05);
      const after = await db.execute(sql`select status from copy_reservations`);
      expect(after.rows).toEqual([{ status: "consumed" }]);
      const [cp] = await db.select().from(copyConsumerCheckpoints);
      expect(Number(cp!.lastOutboxId)).toBe(Number(outbox[0]!.id));
    });

    it("duplicated, replayed and re-enqueued fills never trade twice", async () => {
      const { id, activatedAt } = await startCopy();
      const f = fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 });
      await store([f]);
      await store([f]); // a second sync of the same window: the fill PK absorbs it
      expect(await db.select().from(copySignalOutbox)).toHaveLength(1);
      await run();
      // Replay: the outbox row is processed again (as after a crash between commit and ack).
      await db.update(copySignalOutbox).set({ status: "pending" });
      await run();
      // Re-enqueue from stored fills (activation catch-up path).
      await db.delete(copySignalOutbox);
      await db.transaction((tx) => app.get(CopyRepository).catchUp(tx as never, LEADER, new Date(activatedAt)));
      await run();
      expect(await orders(id)).toHaveLength(1);
      expect(await position(id)).toBeCloseTo(0.05);
      const legs = await db.select().from(copySignalLegs);
      expect(legs).toEqual([expect.objectContaining({ leg: "open", outcome: "ordered", dedupeKey: `${id}:${f.tid}:open:v1` })]);
    });

    it("a new strategy version does not re-trade a fill already acted on", async () => {
      const { id, activatedAt } = await startCopy();
      const f = fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 });
      await store([f]);
      await run();
      await alice.patch(`/me/copy/strategies/${id}`, { maxLeverage: 3 }).expect(200);
      await db.update(copySignalOutbox).set({ status: "pending" });
      await run();
      expect(await orders(id)).toHaveLength(1);
    });

    it("out of order: a close that arrives before its open reduces nothing, and the late open is superseded", async () => {
      const { id, activatedAt } = await startCopy();
      const open = fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 });
      const close = fill({ side: "A", sz: 0.5, px: 100_100, start: 0.5, time: activatedAt + 2_000 });
      await store([close]);
      await run();
      await store([open]);
      await run();
      expect(await orders(id)).toHaveLength(0);
      expect(await position(id)).toBe(0);
      const outcomes = (await db.select().from(copySignalLegs)).map((l) => l.outcome).sort();
      expect(outcomes).toEqual(["nothing_to_reduce", "superseded"]);
    });

    it("processes a batch in fill-time order whatever the arrival order, one order per leader order", async () => {
      const { id, activatedAt } = await startCopy();
      // Two partial fills of one leader order, then a partial close; stored newest first.
      const a = fill({ side: "B", sz: 0.3, px: 100_000, start: 0, time: activatedAt + 1_000 });
      const b = fill({ side: "B", sz: 0.2, px: 100_000, start: 0.3, time: activatedAt + 1_001 });
      const c = fill({ side: "A", sz: 0.25, px: 100_000, start: 0.5, time: activatedAt + 3_000 });
      await store([c, b, a]);
      await run();
      const list = await orders(id);
      expect(list.map((o) => [o.leg, o.side, o.size, o.status])).toEqual([
        ["open", "B", "0.05", "filled"],
        ["close", "A", "0.025", "filled"],
      ]);
      expect(await position(id)).toBeCloseTo(0.025);
    });

    it("a late open older than maxSignalAgeSeconds is rejected as stale; a late reduction still applies", async () => {
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      await run();
      // Backdate the activation, then deliver fills 10 minutes old.
      await db.update(copyStrategies).set({ activatedAt: new Date(activatedAt - 3_600_000) });
      const old = Date.now() - 600_000;
      await store([fill({ coin: "ETH", side: "B", sz: 1, px: 4_000, start: 0, time: old })]);
      await store([fill({ side: "A", sz: 0.25, px: 100_000, start: 0.5, time: old + 1 })]);
      await run();
      const list = await orders(id);
      expect(list.find((o) => o.coin === "ETH")).toMatchObject({ status: "rejected", reason: "stale_signal" });
      expect(list.find((o) => o.leg === "close")).toMatchObject({ status: "filled", size: "0.025" });
    });

    it("splits a leader flip into a full close and a new open", async () => {
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      await run();
      // Long 0.5 → short 0.5 in one fill.
      await store([fill({ side: "A", sz: 1, px: 100_000, start: 0.5, time: activatedAt + 2_000 })]);
      await run();
      const list = await orders(id);
      expect(list.map((o) => [o.leg, o.side, o.reduceOnly, o.status])).toEqual([
        ["open", "B", false, "filled"],
        ["close", "A", true, "filled"],
        ["open", "A", false, "filled"],
      ]);
      expect(await position(id)).toBeCloseTo(-0.05);
    });

    it("reverse copies take the other side and reduce their own opposite position", async () => {
      const { id, activatedAt } = await startCopy({ direction: "reverse" });
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      await run();
      expect(await position(id)).toBeCloseTo(-0.05);
      await store([fill({ side: "A", sz: 0.1, px: 100_000, start: 0.5, time: activatedAt + 2_000 })]);
      await run();
      expect(await position(id)).toBeCloseTo(-0.04);
    });

    it("fixed sizing uses the per-trade notional", async () => {
      const { id, activatedAt } = await startCopy({ sizingMode: "fixed", perTradeUsd: 200 });
      await store([fill({ coin: "ETH", side: "B", sz: 10, px: 4_000, start: 0, time: activatedAt + 1_000 })]);
      await run();
      expect(await position(id, "ETH")).toBeCloseTo(0.05);
    });

    it("the leader's own numbers never leak in: two strategies on one leader keep isolated ledgers", async () => {
      const a = await startCopy();
      const bob = api("bob-token");
      const b = (await bob.post("/me/copy/strategies", { leader: LEADER, allocationUsd: 2_000, copyStartMode: "delta" }).expect(201)).body.data.id as number;
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: Date.now() + 1_000 })]);
      await run();
      expect(await position(a.id)).toBeCloseTo(0.05);
      expect(await position(b)).toBeCloseTo(0.1);
    });
  });

  describe("reduce-only", () => {
    it("never flips: a reduce order larger than the position fills only the position (partial)", async () => {
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      await run();
      const [s] = await db.select().from(copyStrategies);
      await db.insert(copyOrders).values({
        cloid: "0x" + "ab".repeat(16), strategyId: id, userId: s!.userId, strategyVersion: 1, riskPolicyVersion: 0, leaderAddress: LEADER,
        coin: "BTC", leg: "close", side: "A", reduceOnly: true, size: "0.2", signalPx: "100000", signalTime: new Date(), signalTids: [], status: "risk_approved",
        controlRevisions: { platform: 0, user: 0, strategy: 0 },
      });
      await execution.drain();
      const last = (await orders(id)).at(-1)!;
      expect(last).toMatchObject({ status: "partial", filledSize: "0.05", reason: "reduce_only_clamped" });
      expect(await position(id)).toBe(0);
    });

    it("a reduce order with no position is cancelled", async () => {
      const { id } = await startCopy();
      const [s] = await db.select().from(copyStrategies);
      await db.insert(copyOrders).values({
        cloid: "0x" + "cd".repeat(16), strategyId: id, userId: s!.userId, strategyVersion: 1, riskPolicyVersion: 0, leaderAddress: LEADER,
        coin: "BTC", leg: "close", side: "A", reduceOnly: true, size: "0.2", signalPx: "100000", signalTime: new Date(), signalTids: [], status: "risk_approved",
        controlRevisions: { platform: 0, user: 0, strategy: 0 },
      });
      await execution.drain();
      expect((await orders(id))[0]).toMatchObject({ status: "cancelled", reason: "reduce_only_no_position" });
    });
  });

  describe("risk", () => {
    it("rejects a blocked coin (saved in Hyperliquid's spelling from any case), and records the reason", async () => {
      await policies.put({ limits: { blockedCoins: ["kpepe", "ETH"] }, reason: "test blocklist", expectedVersion: 0 }, admin);
      expect((await policies.get()).limits.blockedCoins).toEqual(["kPEPE", "ETH"]);
      const { id, activatedAt } = await startCopy();
      await store([fill({ coin: "kPEPE", side: "B", sz: 1_000_000, px: 0.01, start: 0, time: activatedAt + 1_000 })]);
      await run();
      expect((await orders(id))[0]).toMatchObject({ status: "rejected", reason: "symbol_blocked", riskPolicyVersion: 1 });
    });

    it("policy edits: unknown coins 400, impossible limits 400, stale version 409, and risk.manage required", async () => {
      await expect(policies.put({ limits: { blockedCoins: ["NOPE"] }, reason: "bad", expectedVersion: 0 }, admin)).rejects.toMatchObject({ status: 400 });
      await expect(policies.put({ limits: { minAllocationUsd: 900, maxAllocationUsd: 100 }, reason: "bad", expectedVersion: 0 }, admin)).rejects.toMatchObject({ status: 400 });
      await expect(policies.put({ limits: {}, reason: "who", expectedVersion: 0 }, { kind: "service", permissions: ["copy.read"] })).rejects.toMatchObject({ status: 403 });
      await policies.put({ limits: { blockedCoins: ["xyz:tsla"] }, reason: "tsla off", expectedVersion: 0 }, admin);
      expect((await policies.get()).limits.blockedCoins).toEqual(["xyz:TSLA"]);
      await expect(policies.put({ limits: {}, reason: "stale", expectedVersion: 0 }, admin)).rejects.toMatchObject({ status: 409 });
      const audit = await db.select().from(adminAuditLogs);
      expect(audit.map((a) => a.event)).toEqual(["copy.risk"]);
    });

    it("rejects over the per-minute order frequency", async () => {
      await policies.put({ limits: { maxOrdersPerMinute: 1 }, reason: "slow", expectedVersion: 0 }, admin);
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.1, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      await store([fill({ coin: "ETH", side: "B", sz: 5, px: 4_000, start: 0, time: activatedAt + 2_000 })]);
      await run();
      expect((await orders(id)).map((o) => o.status)).toEqual(["filled", "rejected"]);
      expect((await orders(id))[1]!.reason).toBe("frequency");
    });

    it("unknown leader equity is never sized as zero", async () => {
      const { id, activatedAt } = await startCopy();
      info.clearinghouseState.mockRejectedValue(new Error("down"));
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      await run();
      info.clearinghouseState.mockReset();
      expect((await orders(id))[0]).toMatchObject({ status: "rejected", reason: "leader_equity_unknown" });
    });
  });

  describe("stop commands and the kill switch", () => {
    it("a platform pause takes effect before the next order, and cancels an approved order at the execution boundary", async () => {
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      await signals.drain(); // approved, not yet submitted
      await controls.apply({ scope: "platform", command: "pause_new_risk", reason: "incident drill", expectedRevision: 0 }, admin);
      // The approved order was cancelled with the command (pending risk-increasing orders).
      expect((await orders(id))[0]).toMatchObject({ status: "cancelled", reason: "platform_pause_new_risk" });
      await store([fill({ coin: "ETH", side: "B", sz: 5, px: 4_000, start: 0, time: activatedAt + 2_000 })]);
      await run();
      expect((await orders(id))[1]).toMatchObject({ status: "rejected", reason: "platform_paused" });
      expect(await position(id)).toBe(0);
      const [event] = await db.select().from(copyControlEvents);
      expect(event).toMatchObject({ scope: "platform", command: "pause_new_risk", revision: 1, reason: "incident drill" });
      expect((await db.select().from(adminAuditLogs)).map((a) => a.event)).toEqual(["copy.control"]);
    });

    it("the execution boundary re-reads the control rows (no cache): an order approved before a pause set outside the command path is cancelled", async () => {
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      await signals.drain();
      await db.execute(sql`insert into copy_controls (scope, scope_id, pause_new_risk, revision) values ('platform', 0, true, 1)`);
      await execution.drain();
      expect((await orders(id))[0]).toMatchObject({ status: "cancelled", reason: "platform_paused_before_submit" });
    });

    it("pause and reduce-only still copy the leader's reductions", async () => {
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      await run();
      const user = await aliceUser();
      await controls.apply({ scope: "user", userId: user.id, command: "reduce_only", reason: "limit", expectedRevision: 0 }, admin);
      await store([fill({ side: "A", sz: 0.25, px: 100_000, start: 0.5, time: activatedAt + 2_000 })]);
      await store([fill({ coin: "ETH", side: "B", sz: 5, px: 4_000, start: 0, time: activatedAt + 3_000 })]);
      await run();
      expect(await position(id)).toBeCloseTo(0.025);
      expect((await orders(id)).find((o) => o.coin === "ETH")).toMatchObject({ status: "rejected", reason: "user_reduce_only" });
    });

    it("close_positions closes every position in scope; a strategy resume can't lift a platform stop", async () => {
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      await run();
      const res = await controls.apply({ scope: "platform", command: "close_positions", reason: "kill", expectedRevision: 0 }, admin);
      expect(res).toMatchObject({ state: { pauseNewRisk: true, revision: 1 }, event: { result: { cancelledOrders: 0, closeOrders: 1 } } });
      await execution.drain();
      expect(await position(id)).toBe(0);
      await alice.post(`/me/copy/strategies/${id}/commands`, { command: "resume" }).expect(200);
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 5_000 })]);
      await run();
      expect((await orders(id)).at(-1)).toMatchObject({ status: "rejected", reason: "platform_paused" });
    });

    it("admin commands: stale revision 409, the right permission, and one parsed target", async () => {
      await alice.get("/me/copy").expect(200);
      const user = await aliceUser();
      await expect(controls.apply({ scope: "platform", command: "pause_new_risk", reason: "x1x", expectedRevision: 3 }, admin)).rejects.toMatchObject({ status: 409 });
      await expect(controls.apply({ scope: "platform", command: "resume", reason: "back", expectedRevision: 0 }, { kind: "service", permissions: ["execution.pause"] })).rejects.toMatchObject({ status: 403 });
      await expect(controls.apply({ scope: "platform", command: "pause_new_risk", reason: "go now", expectedRevision: 0 }, { kind: "service", permissions: ["execution.resume"] })).rejects.toMatchObject({ status: 403 });
      await expect(controls.apply({ scope: "user", command: "pause_new_risk", reason: "who", expectedRevision: 0 }, admin)).rejects.toMatchObject({ status: 400 });
      await expect(controls.apply({ scope: "platform", userId: user.id, command: "pause_new_risk", reason: "both", expectedRevision: 0 }, admin)).rejects.toMatchObject({ status: 400 });
      await expect(controls.apply({ scope: "user", userId: 999_999, command: "pause_new_risk", reason: "ghost", expectedRevision: 0 }, admin)).rejects.toMatchObject({ status: 404 });
      await controls.apply({ scope: "user", userId: user.id, command: "pause_new_risk", reason: "ok!", expectedRevision: 0 }, admin);
      const view = (await alice.get("/me/copy").expect(200)).body.data;
      expect(view.user).toMatchObject({ pauseNewRisk: true, revision: 1 });
      expect(view.platform).toMatchObject({ pauseNewRisk: false, revision: 0 });
      expect((await alice.post("/me/copy/strategies", { leader: OTHER, allocationUsd: 500, copyStartMode: "delta" }).expect(409)).body.error.code).toBe("copy_paused");
    });

    it("strategy commands act only on the caller's own strategy", async () => {
      const { id } = await startCopy();
      await api("bob-token").get("/me/copy").expect(200);
      await api("bob-token").post(`/me/copy/strategies/${id}/commands`, { command: "stop" }).expect(404);
      await api("bob-token").get(`/me/copy/strategies/${id}/orders`).expect(404);
      await alice.post(`/me/copy/strategies/${id}/commands`, { command: "explode" }).expect(400);
      const paused = (await alice.post(`/me/copy/strategies/${id}/commands`, { command: "pause" }).expect(200)).body.data;
      expect(paused).toMatchObject({ status: "paused", pauseNewRisk: true });
      const resumed = (await alice.post(`/me/copy/strategies/${id}/commands`, { command: "resume" }).expect(200)).body.data;
      expect(resumed).toMatchObject({ status: "active", pauseNewRisk: false });
    });

    it("stop closes the copy's positions, then returns its cash to the paper balance and unwatches the leader", async () => {
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      await run();
      const stopping = (await alice.post(`/me/copy/strategies/${id}/commands`, { command: "stop" }).expect(200)).body.data;
      expect(stopping.status).toBe("stopping");
      await run();
      expect(await execution.settleStopping()).toBe(1);
      const [s] = await db.select().from(copyStrategies);
      expect(s!.status).toBe("stopped");
      const [acct] = await db.select().from(paperAccounts);
      expect(Number(acct!.balance)).toBeCloseTo(9_000 + Number(s!.cash), 6);
      const [leader] = await db.select().from(leaders).where(eq(leaders.address, LEADER));
      expect(leader!.active).toBe(false);
      await alice.post(`/me/copy/strategies/${id}/commands`, { command: "resume" }).expect(409);
    });

    it("account deletion waits until every copy is stopped (CopyDog)", async () => {
      const { id } = await startCopy();
      const [u] = await db.select().from(users);
      await expect(app.get(AccountDeletionService).delete(u!.id)).rejects.toMatchObject({ status: 409 });
      await alice.post(`/me/copy/strategies/${id}/commands`, { command: "stop" }).expect(200);
      await execution.settleStopping();
      await app.get(AccountDeletionService).delete(u!.id);
      expect(await db.select().from(copyStrategies)).toHaveLength(0);
    });
  });

  describe("restart recovery", () => {
    it("a failed consumer pass leaves rows pending; the next consumer resumes from the checkpoint", async () => {
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      const repo = app.get(CopyRepository);
      const spy = vi.spyOn(repo, "claimLeg").mockRejectedValueOnce(new Error("db blip"));
      expect(await signals.drain()).toEqual({ processed: 0, orders: 0 });
      spy.mockRestore();
      const [row] = await db.select().from(copySignalOutbox);
      expect(row).toMatchObject({ status: "pending", attempts: 1, lastError: "db blip" });
      expect(await orders(id)).toHaveLength(0);
      await db.update(copySignalOutbox).set({ availableAt: new Date(0) });
      // A fresh consumer instance (a restart) over the same database.
      const restarted = new CopySignalService(repo, app.get(UnitOfWork), marketService, app.get(CopyOrderPlanner), policies);
      expect(await restarted.drain()).toEqual({ processed: 1, orders: 1 });
      const [cp] = await db.select().from(copyConsumerCheckpoints);
      expect(Number(cp!.lastOutboxId)).toBe(Number(row!.id));
    });

    it("an order left `submitting` by a crash is filled exactly once on restart", async () => {
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      await signals.drain();
      const [o] = await orders(id);
      await execution.submit(o!.id); // crashed after the boundary step
      await db.update(copyOrders).set({ updatedAt: new Date(Date.now() - 60_000) });
      await execution.drain();
      await execution.drain();
      expect((await orders(id))[0]).toMatchObject({ status: "filled" });
      expect(await position(id)).toBeCloseTo(0.05);
    });
  });

  describe("ledger", () => {
    it("matches the hand-computed fixture: fees, builder fee, realized PnL and funding", async () => {
      await db.insert(appSettings).values({ key: "revenue", value: { builderAddress: null, builderFeeTenthsBps: 10 } });
      (settings as unknown as { cache: unknown }).cache = undefined;
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      await run();
      market.mids.BTC = 110_000;
      await store([fill({ side: "A", sz: 0.5, px: 110_000, start: 0.5, time: activatedAt + 2_000 })]);
      await run();
      const [s] = await db.select().from(copyStrategies);
      // Buy 0.05 @ 100,050: fee 2.251125, builder 0.50025. Sell 0.05 @ 109,945: realized 494.75, fee 2.4737625, builder 0.549725.
      expect(Number(s!.realizedPnl)).toBeCloseTo(494.75, 6);
      expect(Number(s!.fees)).toBeCloseTo(2.251125 + 0.50025 + 2.4737625 + 0.549725, 6);
      expect(Number(s!.cash)).toBeCloseTo(1488.9751375, 6);
      const ledger = await db.select().from(copyLedger).where(eq(copyLedger.strategyId, id));
      expect(ledger.reduce((a, l) => a + Number(l.amount), 0)).toBeCloseTo(1488.9751375, 6);

      // Funding: a long 0.05 BTC held two whole hours at mark 110,000 and +0.01 %/h pays 1.1.
      await store([fill({ side: "B", sz: 0.5, px: 110_000, start: 0, time: activatedAt + 3_000 })]);
      await run();
      const qty = await position(id);
      const twoHoursAgo = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 2 * 3_600_000);
      await db.update(copyPositions).set({ fundingThrough: twoHoursAgo });
      marketService.resetCaches();
      market.mids.BTC = 110_000;
      expect(await execution.accrueFunding()).toBe(1);
      expect(await execution.accrueFunding()).toBe(0); // once per hour
      const [p] = await db.select().from(copyPositions).where(eq(copyPositions.strategyId, id));
      expect(Number(p!.funding)).toBeCloseTo(qty * 110_000 * 0.0001 * 2, 6);
    });
  });

  describe("admin read models (for the admin API)", () => {
    it("strategies, failed orders and per-user exposure", async () => {
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      await store([fill({ coin: "kPEPE", side: "B", sz: 1, px: 0.01, start: 0, time: activatedAt + 2_000 })]);
      await run();
      const list = await reads.strategies();
      expect(list.items[0]).toMatchObject({ id, userEmail: "alice@example.com", tradesCopied: 1 });
      const failed = await reads.orders({ status: ["rejected"] });
      // The BTC copy already uses the whole allocation × 5 exposure cap.
      expect(failed.items[0]).toMatchObject({ coin: "kPEPE", reason: "below_min_after_max_strategy_exposure", userEmail: "alice@example.com" });
      const exposure = await reads.exposure();
      expect(exposure.items[0]).toMatchObject({ userEmail: "alice@example.com", strategies: 1, coins: [{ coin: "BTC", longUsd: 5_000, shortUsd: 0, netUsd: 5_000 }] });
      const overview = await reads.overview();
      expect(overview).toMatchObject({ mode: "paper", outbox: { pending: 0, failed: 0 }, riskPolicyVersion: 0, strategies: { active: 1 } });
      const detail = await reads.strategy(id);
      expect(detail.versions).toHaveLength(1);
      expect(detail.ledger.map((l) => l.kind)).toContain("allocate");
    });
  });
});
