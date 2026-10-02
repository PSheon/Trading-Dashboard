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
  copyStrategyVersions,
  leaders,
  paperAccounts,
  adminAuditLogs,
  traderStats,
  users,
} from "@trading-dashboard/shared/database";
import { readFileSync } from "node:fs";

import { and, asc, eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthService } from "../src/common/auth/auth.service.js";
import type { RequestUser } from "../src/common/auth/current-user.js";
import { CopyAdminReadService } from "../src/copy/copy-admin-read.service.js";
import { CopyAdoptionRepairService, adoptionRepairKey } from "../src/copy/copy-adoption-repair.service.js";
import { CopyControlService } from "../src/copy/copy-control.service.js";
import { CopyExecutionService } from "../src/copy/copy-execution.service.js";
import { CopyMarketService, type AssetInfo } from "../src/copy/copy-market.service.js";
import { cloidOf } from "../src/copy/copy-math.js";
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
import { closeTestDb, getTestDb, openCopyTrading, truncateAll } from "./db-test-utils.js";

const SERVICE_TOKEN = "service-token-for-copy-tests-0123456789";
const LEADER = "0x" + "1e".repeat(20);
const LEADER_MIXED = "0x" + "1E".repeat(20);
const OTHER = "0x" + "2f".repeat(20);

/** Hyperliquid stand-in: prices, universe with funding, leader account. */
const market = {
  mids: { BTC: 100_000, ETH: 4_000, kPEPE: 0.01 } as Record<string, number>,
  funding: 0.0001,
  /** The main dex's `marginSummary.accountValue`. */
  leaderEquity: 10_000,
  leaderPositions: [] as { coin: string; szi: string; positionValue: string; entryPx: string }[],
  /** `userAbstraction`; "default" is a standard account. */
  abstraction: "default",
  spotBalances: [] as { coin: string; token: number; total: string; hold: string; entryNtl: string }[],
  stakedHype: 0,
  /** Perp equity on HIP-3 dexes, by dex name. */
  hip3Equity: {} as Record<string, number>,
  tvl: 0,
};
const HYPE_PX = 40;
const info = {
  allMids: vi.fn(async () => Object.fromEntries(Object.entries(market.mids).map(([k, v]) => [k, String(v)]))),
  metaAndAssetCtxs: vi.fn(async () => [
    { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "ETH", szDecimals: 4, maxLeverage: 25 }, { name: "kPEPE", szDecimals: 0, maxLeverage: 10 }] },
    ["BTC", "ETH", "kPEPE"].map((c) => ({ funding: String(market.funding), markPx: String(market.mids[c]), oraclePx: String(market.mids[c]), openInterest: "1" })),
  ]),
  clearinghouseState: vi.fn(async (_address?: string, dex?: string) => {
    const equity = String(dex ? (market.hip3Equity[dex] ?? 0) : market.leaderEquity);
    return {
      assetPositions: dex ? [] : market.leaderPositions.map((p) => ({ position: { ...p, leverage: { type: "cross", value: 5 }, marginUsed: "0", unrealizedPnl: "0" } })),
      marginSummary: { accountValue: equity, totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "0" },
      crossMarginSummary: { accountValue: equity, totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "0" },
      withdrawable: "0",
      time: Date.now() - 5,
    };
  }),
  spotClearinghouseState: vi.fn(async () => ({ balances: market.spotBalances, portfolioMarginEnabled: market.abstraction === "portfolioMargin" })),
  userAbstraction: vi.fn(async () => market.abstraction),
  delegatorSummary: vi.fn(async () => ({ delegated: String(market.stakedHype), undelegated: "0", totalPendingWithdrawal: "0", nPendingWithdrawals: 0 })),
  spotMetaAndAssetCtxs: vi.fn(async () => [
    { tokens: [{ name: "USDC", index: 0 }, { name: "HYPE", index: 150 }], universe: [{ name: "@107", index: 107, tokens: [150, 0], isCanonical: true }] },
    [{ coin: "@107", markPx: String(HYPE_PX), midPx: String(HYPE_PX) }],
  ]),
  perpDexs: vi.fn(async () => [null, ...Object.keys(market.hip3Equity).map((name) => ({ name, assetToStreamingOiCap: [[`${name}:TSLA`, "1"]] }))]),
  portfolio: vi.fn(async () => [["allTime", { accountValueHistory: [[1, "1"], [2, String(market.tvl)]], pnlHistory: [[1, "0"], [2, "0"]], vlm: "0" }]]),
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
        CopyControlService, CopyStrategyService, CopyAdminReadService, CopyAdoptionRepairService, FillSyncRepository, AccountRepository, AccountDeletionService,
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
    // Copying is open in these tests (the setting is off until an admin turns it on).
    await openCopyTrading(db);
    settings.invalidate();
    marketService.resetCaches();
    market.mids = { BTC: 100_000, ETH: 4_000, kPEPE: 0.01 };
    market.funding = 0.0001;
    market.leaderEquity = 10_000;
    market.leaderPositions = [];
    market.abstraction = "default";
    market.spotBalances = [];
    market.stakedHype = 0;
    market.hip3Equity = {};
    market.tvl = 0;
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

    it("a copy of a leader nobody watches yet is refused at the site's watch cap, and nothing is taken (review finding 34)", async () => {
      await settings.patch({ general: { maxWatchedAddresses: 1 } }, null);
      await alice.post("/me/copy/strategies", { leader: LEADER, allocationUsd: 1_000, copyStartMode: "delta" }).expect(201);
      const refused = await alice.post("/me/copy/strategies", { leader: OTHER, allocationUsd: 1_000, copyStartMode: "delta" }).expect(409);
      expect(refused.body.error).toMatchObject({ code: "watch_capacity", details: { limit: 1 } });
      // Rolled back whole: no strategy, no leader row, the balance untouched.
      expect(await db.select().from(leaders).where(eq(leaders.address, OTHER))).toHaveLength(0);
      const { data: overview } = (await alice.get("/me/copy").expect(200)).body;
      expect(overview.strategies).toHaveLength(1);
      await settings.patch({ general: { maxWatchedAddresses: 100 } }, null);
      await alice.post("/me/copy/strategies", { leader: OTHER, allocationUsd: 1_000, copyStartMode: "delta" }).expect(201);
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

  describe("general.copyTradingEnabled: whether a new copy may start", () => {
    const open = async (enabled: boolean) => { await openCopyTrading(db, enabled); settings.invalidate(); };

    it("off: starting a copy is refused with 403 copy_not_open and nothing is created", async () => {
      await open(false);
      await alice.get("/me/copy").expect(200);
      const refused = await alice.post("/me/copy/strategies", { leader: LEADER, allocationUsd: 1_000, copyStartMode: "delta" }).expect(403);
      expect(refused.body.error).toMatchObject({ code: "copy_not_open" });
      expect(await db.select().from(copyStrategies)).toHaveLength(0);
      expect(await db.select().from(leaders).where(eq(leaders.address, LEADER))).toHaveLength(0);
      expect((await alice.get("/me/copy").expect(200)).body.data.paper).toMatchObject({ balance: 10_000, allocated: 0 });
      // The public settings tell the web before anyone tries.
      expect((await settings.getPublic()).copyTradingEnabled).toBe(false);

      // On again: the same request starts the copy.
      await open(true);
      await startCopy();
      expect(await db.select().from(copyStrategies)).toHaveLength(1);
    });

    it("off: a copy already running keeps following its leader, and can still be paused, resumed, edited and stopped", async () => {
      const { id, activatedAt } = await startCopy();
      await open(false);

      // The leader opens 1 BTC at 100,000 on a 10,000 account: the copy follows in ratio.
      await store([fill({ side: "B", sz: 1, px: 100_000, start: 0, time: activatedAt + 10 })]);
      expect(await run()).toMatchObject({ filled: 1 });
      expect(await position(id)).toBeGreaterThan(0);
      expect((await orders(id))[0]).toMatchObject({ status: "filled" });

      await alice.post(`/me/copy/strategies/${id}/commands`, { command: "pause" }).expect(200);
      expect((await db.select().from(copyStrategies))[0]).toMatchObject({ status: "paused" });
      await alice.post(`/me/copy/strategies/${id}/commands`, { command: "resume" }).expect(200);
      expect((await db.select().from(copyStrategies))[0]).toMatchObject({ status: "active" });
      await alice.patch(`/me/copy/strategies/${id}`, { maxLeverage: 3 }).expect(200);
      // But a second, new copy is refused while it is off.
      expect((await alice.post("/me/copy/strategies", { leader: OTHER, allocationUsd: 500, copyStartMode: "delta" }).expect(403)).body.error.code).toBe("copy_not_open");
      await alice.post(`/me/copy/strategies/${id}/commands`, { command: "stop" }).expect(200);
      expect(["stopping", "stopped"]).toContain((await db.select().from(copyStrategies))[0].status);
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

  describe("the watch list follows favorites and copies together (review 25)", () => {
    const favorites = () => app.get(FavoritesRepository);
    const leaderRow = async (address = LEADER) => (await db.select().from(leaders).where(eq(leaders.address, address)))[0];
    async function bobId(): Promise<number> {
      await api("bob-token").get("/me/copy").expect(200);
      const [u] = await db.select().from(users).where(eq(users.privyUserId, "did:privy:bob"));
      return u!.id;
    }
    async function stopCopy(id: number) {
      await alice.post(`/me/copy/strategies/${id}/commands`, { command: "stop" }).expect(200);
      await run();
      expect(await execution.settleStopping()).toBe(1);
    }

    it("favoriting a leader whose last copy stopped watches it again", async () => {
      const { id } = await startCopy();
      await stopCopy(id);
      expect(await leaderRow()).toMatchObject({ source: "copy", active: false });
      const bob = await bobId();
      const created = await db.transaction((tx) => favorites().addAndWatch(tx as never, bob, LEADER));
      expect(created).toBe(false);
      expect(await leaderRow()).toMatchObject({ source: "copy", active: true });
    });

    it("a copy-sourced leader someone also favorites is unwatched when the favorite goes after the copy", async () => {
      const { id } = await startCopy();
      const bob = await bobId();
      await db.transaction((tx) => favorites().addAndWatch(tx as never, bob, LEADER));
      await stopCopy(id);
      expect(await leaderRow()).toMatchObject({ source: "copy", active: true }); // still favorited
      await db.transaction((tx) => favorites().removeAndUnwatch(tx as never, bob, LEADER));
      expect(await leaderRow()).toMatchObject({ source: "copy", active: false });
    });

    it("a favorite-sourced leader someone also copies is unwatched when the copy stops after the favorite went", async () => {
      const bob = await bobId();
      await db.transaction((tx) => favorites().addAndWatch(tx as never, bob, LEADER));
      const { id } = await startCopy();
      await db.transaction((tx) => favorites().removeAndUnwatch(tx as never, bob, LEADER));
      expect(await leaderRow()).toMatchObject({ source: "favorite", active: true }); // still copied
      await stopCopy(id);
      expect(await leaderRow()).toMatchObject({ source: "favorite", active: false });
      // And a new copy of it is watched again.
      await startCopy();
      expect(await leaderRow()).toMatchObject({ source: "favorite", active: true });
    });

    it("an imported leader is the admin's: neither path switches it", async () => {
      await db.insert(leaders).values([{ address: LEADER, source: "import", active: false }, { address: OTHER, source: "import", active: true }]);
      const bob = await bobId();
      await db.transaction((tx) => favorites().addAndWatch(tx as never, bob, LEADER));
      await startCopy();
      expect(await leaderRow()).toMatchObject({ source: "import", active: false });
      await db.transaction(async (tx) => {
        await favorites().addAndWatch(tx as never, bob, OTHER);
        await favorites().removeAndUnwatch(tx as never, bob, OTHER);
      });
      expect(await leaderRow(OTHER)).toMatchObject({ source: "import", active: true });
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

    it("a leader whose account was read and holds nothing is never sized as zero", async () => {
      const { id, activatedAt } = await startCopy();
      market.leaderEquity = 0;
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      await run();
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

  describe("pause, resume and edit over the HTTP routes (the three controls on the user pages)", () => {
    const btc = (o: { side: "B" | "A"; sz: number; start: number; at: number }) => fill({ side: o.side, sz: o.sz, px: 100_000, start: o.start, time: o.at });
    const eth = (o: { side: "B" | "A"; sz: number; start: number; at: number }) => fill({ coin: "ETH", side: o.side, sz: o.sz, px: 4_000, start: o.start, time: o.at });
    const versions = (id: number) => db.select().from(copyStrategyVersions).where(eq(copyStrategyVersions.strategyId, id)).orderBy(asc(copyStrategyVersions.version));

    it("start → pause → resume → edit → stop: each step is what the next GET /me/copy shows", async () => {
      const { id, activatedAt } = await startCopy();
      const shown = async () => (await alice.get("/me/copy").expect(200)).body.data.strategies.find((s: { id: number }) => s.id === id);
      await store([btc({ side: "B", sz: 0.1, start: 0, at: activatedAt + 1_000 })]);
      await run();
      expect(await shown()).toMatchObject({ status: "active", version: 1, pauseNewRisk: false, tradesCopied: 1, positions: [expect.objectContaining({ coin: "BTC", size: 0.01 })] });

      expect((await alice.post(`/me/copy/strategies/${id}/commands`, { command: "pause" }).expect(200)).body.data).toMatchObject({ id, status: "paused", pauseNewRisk: true, reduceOnly: false });
      expect(await shown()).toMatchObject({ status: "paused", pauseNewRisk: true, version: 1 });
      // Pausing twice is the same state, not an error.
      expect((await alice.post(`/me/copy/strategies/${id}/commands`, { command: "pause" }).expect(200)).body.data.status).toBe("paused");

      expect((await alice.post(`/me/copy/strategies/${id}/commands`, { command: "resume" }).expect(200)).body.data).toMatchObject({ status: "active", pauseNewRisk: false, reduceOnly: false });
      expect(await shown()).toMatchObject({ status: "active", pauseNewRisk: false });

      const edited = (await alice.patch(`/me/copy/strategies/${id}`, { sizingMode: "fixed", perTradeUsd: 200, maxLeverage: 3 }).expect(200)).body.data;
      expect(edited).toMatchObject({ id, status: "active", version: 2, settings: { direction: "same", sizingMode: "fixed", perTradeUsd: 200, maxTotalExposureUsd: null, maxLeverage: 3, copyStartMode: "delta" } });
      expect(await shown()).toMatchObject({ version: 2, settings: { sizingMode: "fixed", perTradeUsd: 200, maxLeverage: 3 } });

      expect((await alice.post(`/me/copy/strategies/${id}/commands`, { command: "stop" }).expect(200)).body.data.status).toBe("stopping");
      await run();
      expect(await execution.settleStopping()).toBe(1);
      expect(await shown()).toMatchObject({ status: "stopped", positions: [] });
      // Every command left its own row: who, what, and the revision it produced.
      const events = await db.select().from(copyControlEvents).orderBy(asc(copyControlEvents.id));
      expect(events.map((e) => [e.scope, e.command, e.revision])).toEqual([
        ["strategy", "pause_new_risk", 1], ["strategy", "pause_new_risk", 2], ["strategy", "resume", 3], ["strategy", "close_positions", 4],
      ]);
      expect(new Set(events.map((e) => e.actorUserId))).toEqual(new Set([(await aliceUser()).id]));
    });

    it("a paused copy takes no new risk — no new coin, no add, and an approved open is cancelled — while the leader's reductions still execute", async () => {
      const { id, activatedAt } = await startCopy();
      await store([btc({ side: "B", sz: 0.1, start: 0, at: activatedAt + 1_000 })]);
      await run();
      expect(await position(id)).toBeCloseTo(0.01);

      // Approved but not yet submitted when the pause arrives.
      await store([eth({ side: "B", sz: 1, start: 0, at: activatedAt + 2_000 })]);
      await signals.drain();
      expect((await orders(id)).at(-1)).toMatchObject({ coin: "ETH", status: "risk_approved" });
      await alice.post(`/me/copy/strategies/${id}/commands`, { command: "pause" }).expect(200);
      expect((await orders(id)).at(-1)).toMatchObject({ coin: "ETH", status: "cancelled", reason: "strategy_pause" });

      // The leader adds to BTC and opens kPEPE: both refused, nothing moves.
      await store([btc({ side: "B", sz: 0.1, start: 0.1, at: activatedAt + 3_000 })]);
      await store([fill({ coin: "kPEPE", side: "B", sz: 100_000, px: 0.01, start: 0, time: activatedAt + 4_000 })]);
      await run();
      const refused = (await orders(id)).slice(2);
      expect(refused.map((o) => [o.coin, o.status, o.reason])).toEqual([["BTC", "rejected", "strategy_paused"], ["kPEPE", "rejected", "strategy_paused"]]);
      expect(await position(id)).toBeCloseTo(0.01);
      expect(await position(id, "ETH")).toBe(0);
      expect(await position(id, "kPEPE")).toBe(0);

      // The leader sells half of its 0.2 BTC: the copy halves too.
      await store([btc({ side: "A", sz: 0.1, start: 0.2, at: activatedAt + 5_000 })]);
      await run();
      expect((await orders(id)).at(-1)).toMatchObject({ coin: "BTC", side: "A", reduceOnly: true, status: "filled" });
      expect(await position(id)).toBeCloseTo(0.005);
      // …and closes the rest: the copy is flat, still paused.
      await store([btc({ side: "A", sz: 0.1, start: 0.1, at: activatedAt + 6_000 })]);
      await run();
      expect(await position(id)).toBe(0);
      const [s] = await db.select().from(copyStrategies);
      expect(s).toMatchObject({ status: "paused", pauseNewRisk: true });

      // Resumed: the next open is copied again.
      await alice.post(`/me/copy/strategies/${id}/commands`, { command: "resume" }).expect(200);
      await store([eth({ side: "B", sz: 1, start: 1, at: activatedAt + 7_000 })]);
      await run();
      expect((await orders(id)).at(-1)).toMatchObject({ coin: "ETH", side: "B", reduceOnly: false, status: "filled" });
      expect(await position(id, "ETH")).toBeGreaterThan(0);
    });

    it("an edit writes a new version and leaves the old one as it was; orders carry the version they were sized under", async () => {
      const { id, activatedAt } = await startCopy();
      await store([btc({ side: "B", sz: 0.1, start: 0, at: activatedAt + 1_000 })]);
      await run();
      const [v1] = await versions(id);
      expect(v1).toMatchObject({ version: 1, settings: { sizingMode: "ratio", perTradeUsd: null, maxLeverage: null } });

      await alice.patch(`/me/copy/strategies/${id}`, { sizingMode: "fixed", perTradeUsd: 200 }).expect(200);
      // Fixed sizing: $200 of ETH at 4,000 whatever the leader's size.
      await store([eth({ side: "B", sz: 3, start: 0, at: activatedAt + 2_000 })]);
      await run();
      const placed = await orders(id);
      expect(placed.map((o) => [o.coin, o.strategyVersion, o.size, o.status])).toEqual([["BTC", 1, "0.01", "filled"], ["ETH", 2, "0.05", "filled"]]);

      // A second edit changes one field and keeps the rest of version 2.
      const third = (await alice.patch(`/me/copy/strategies/${id}`, { maxTotalExposureUsd: 2_500 }).expect(200)).body.data;
      expect(third).toMatchObject({ version: 3, settings: { sizingMode: "fixed", perTradeUsd: 200, maxTotalExposureUsd: 2_500 } });
      // null clears a cap back to the platform default.
      expect((await alice.patch(`/me/copy/strategies/${id}`, { maxTotalExposureUsd: null }).expect(200)).body.data).toMatchObject({ version: 4, settings: { maxTotalExposureUsd: null } });

      const all = await versions(id);
      expect(all.map((v) => v.version)).toEqual([1, 2, 3, 4]);
      expect(all[0]).toEqual(v1);
      expect(all[1]!.settings).toMatchObject({ sizingMode: "fixed", perTradeUsd: 200, maxTotalExposureUsd: null });
      expect(all.every((v) => v.createdByUserId === v1!.createdByUserId)).toBe(true);
      // An edit is not a control command: paused stays paused, positions stay.
      await alice.post(`/me/copy/strategies/${id}/commands`, { command: "pause" }).expect(200);
      expect((await alice.patch(`/me/copy/strategies/${id}`, { maxLeverage: 2 }).expect(200)).body.data).toMatchObject({ version: 5, status: "paused", pauseNewRisk: true });
      expect(await position(id)).toBeCloseTo(0.01);
    });

    it("refuses a bad edit or command with 400 and changes nothing", async () => {
      const { id } = await startCopy();
      const path = `/me/copy/strategies/${id}`;
      for (const body of [
        {}, { maxLeverage: 0 }, { maxLeverage: 51 }, { maxLeverage: "3x" }, { perTradeUsd: 0 }, { perTradeUsd: -5 }, { perTradeUsd: 1.0000001 },
        { maxTotalExposureUsd: 0 }, { sizingMode: "martingale" }, { direction: "reverse" }, { leader: OTHER }, { allocationUsd: 5_000 }, { copyStartMode: "adopt" },
      ]) {
        const res = await alice.patch(path, body);
        expect([res.status, JSON.stringify(body)]).toEqual([400, JSON.stringify(body)]);
      }
      // Fixed sizing without an amount (none saved, none sent).
      expect((await alice.patch(path, { sizingMode: "fixed" }).expect(400)).body.error.code).toBe("per_trade_required");
      for (const body of [{}, { command: "explode" }, { command: "pause", extra: 1 }, { command: ["pause"] }]) await alice.post(`${path}/commands`, body).expect(400);
      for (const bad of ["abc", "0", "-1", "1.5", "99999999999"]) {
        await alice.patch(`/me/copy/strategies/${bad}`, { maxLeverage: 3 }).expect(400);
        await alice.post(`/me/copy/strategies/${bad}/commands`, { command: "pause" }).expect(400);
      }
      await alice.patch("/me/copy/strategies/999999", { maxLeverage: 3 }).expect(404);
      await alice.post("/me/copy/strategies/999999/commands", { command: "pause" }).expect(404);

      expect(await versions(id)).toHaveLength(1);
      expect(await db.select().from(copyControlEvents)).toHaveLength(0);
      const [s] = await db.select().from(copyStrategies);
      expect(s).toMatchObject({ status: "active", version: 1, pauseNewRisk: false, controlRevision: 0 });
    });

    it("is closed to anyone but the owner: 401 signed out, 403 for the service token, 404 for another user — and nothing changes", async () => {
      const { id } = await startCopy();
      const path = `/me/copy/strategies/${id}`;
      const calls = (as: ReturnType<typeof api>) => [
        as.patch(path, { maxLeverage: 3 }), as.post(`${path}/commands`, { command: "pause" }), as.post(`${path}/commands`, { command: "resume" }),
        as.post(`${path}/commands`, { command: "stop" }), as.post(`${path}/funds`, { amountUsd: 100 }), as.get(`${path}/orders`),
      ];
      for (const res of await Promise.all(calls(api()))) expect(res.status).toBe(401);
      for (const res of await Promise.all(calls(api("not-a-token")))) expect(res.status).toBe(401);
      for (const res of await Promise.all(calls(api(SERVICE_TOKEN)))) expect(res.status).toBe(403);
      const bob = api("bob-token");
      await bob.get("/me/copy").expect(200);
      for (const res of await Promise.all(calls(bob))) {
        expect(res.status).toBe(404);
        // The same answer as for an id that does not exist.
        expect(res.body.message).toBe((await bob.get("/me/copy/strategies/999999/orders")).body.message);
      }
      expect((await bob.get("/me/copy").expect(200)).body.data).toMatchObject({ strategies: [], paper: { balance: 10_000 } });

      expect(await versions(id)).toHaveLength(1);
      expect(await db.select().from(copyControlEvents)).toHaveLength(0);
      const mine = (await alice.get("/me/copy").expect(200)).body.data;
      expect(mine.strategies[0]).toMatchObject({ id, status: "active", version: 1, pauseNewRisk: false, allocated: 1_000 });
      expect(mine.paper.balance).toBe(9_000);
    });

    it("a stopping or stopped copy can't be edited or resumed", async () => {
      const { id, activatedAt } = await startCopy();
      await store([btc({ side: "B", sz: 0.1, start: 0, at: activatedAt + 1_000 })]);
      await run();
      await alice.post(`/me/copy/strategies/${id}/commands`, { command: "stop" }).expect(200);
      expect((await alice.patch(`/me/copy/strategies/${id}`, { maxLeverage: 3 }).expect(409)).body.error.code).toBe("strategy_stopped");
      expect((await alice.post(`/me/copy/strategies/${id}/commands`, { command: "resume" }).expect(409)).body.error.code).toBe("strategy_stopping");
      await run();
      await execution.settleStopping();
      for (const command of ["pause", "resume", "stop"]) {
        expect((await alice.post(`/me/copy/strategies/${id}/commands`, { command }).expect(409)).body.error.code).toBe("strategy_stopped");
      }
      expect((await alice.patch(`/me/copy/strategies/${id}`, { maxLeverage: 3 }).expect(409)).body.error.code).toBe("strategy_stopped");
      expect(await versions(id)).toHaveLength(1);
    });
  });

  describe("market data that fails to load is retried, never a rejection", () => {
    const down = () => new Error("Request deadline exceeded");

    it("starting with 跟單目前持倉 while the universe can't be read creates nothing (503), and the retry adopts once", async () => {
      market.leaderPositions = [{ coin: "ETH", szi: "5", positionValue: "20000", entryPx: "4100" }];
      await alice.get("/me/copy").expect(200);
      info.metaAndAssetCtxs.mockRejectedValueOnce(down());
      const refused = await alice.post("/me/copy/strategies", { leader: LEADER, allocationUsd: 1_000 }).expect(503);
      expect(refused.body.error.code).toBe("leader_unavailable");
      expect(await db.select().from(copyStrategies)).toHaveLength(0);
      expect(await db.select().from(copyOrders)).toHaveLength(0);
      expect(await db.select().from(copyLedger)).toHaveLength(0);
      expect(Number((await db.select().from(paperAccounts))[0]!.balance)).toBe(10_000);

      const res = await alice.post("/me/copy/strategies", { leader: LEADER, allocationUsd: 1_000 }).expect(201);
      const id = res.body.data.id as number;
      expect(res.body.data).toMatchObject({ status: "active", pendingOrders: 1 });
      expect(await orders(id)).toEqual([expect.objectContaining({ leg: "adopt", side: "B", status: "risk_approved", size: "0.5" })]);
      await run();
      expect(await position(id, "ETH")).toBeCloseTo(0.5);
      expect(await orders(id)).toHaveLength(1);
    });

    it("starting while the mids can't be read creates nothing either; a leader with no position needs no market data", async () => {
      market.leaderPositions = [{ coin: "ETH", szi: "5", positionValue: "20000", entryPx: "4100" }];
      info.allMids.mockRejectedValueOnce(down());
      expect((await alice.post("/me/copy/strategies", { leader: LEADER, allocationUsd: 1_000 }).expect(503)).body.error.code).toBe("leader_unavailable");
      expect(await db.select().from(copyStrategies)).toHaveLength(0);

      market.leaderPositions = [];
      marketService.resetCaches();
      info.allMids.mockRejectedValue(down());
      info.metaAndAssetCtxs.mockRejectedValue(down());
      await alice.post("/me/copy/strategies", { leader: LEADER, allocationUsd: 1_000 }).expect(201);
      info.allMids.mockReset();
      info.metaAndAssetCtxs.mockReset();
    });

    it("the planner itself never writes a rejection for missing data", async () => {
      const { id } = await startCopy();
      const repo = app.get(CopyRepository);
      const [strategy] = await db.select().from(copyStrategies);
      const place = (assets: null | Map<string, AssetInfo>, mids: null | { at: Date; px: Map<string, number> }) => app.get(UnitOfWork).run(async (tx) => app.get(CopyOrderPlanner).place(tx, {
        strategy: strategy!, settings: await repo.settingsOf(tx, id, 1) as never, policy: await policies.current(tx), controls: { platform: undefined, user: undefined }, mids, assets,
        coin: "ETH", leg: "adopt", side: "B", notional: 500, signalPx: 4_000, signalTime: new Date(), signalTids: [], dedupeKey: `${id}:adopt:ETH:v1`,
      }));
      await expect(place(null, { at: new Date(), px: new Map([["ETH", 4_000]]) })).rejects.toMatchObject({ name: "CopyMarketDataUnavailableError", gap: "asset_info" });
      await expect(place(new Map(), null)).rejects.toMatchObject({ name: "CopyMarketDataUnavailableError", gap: "mids" });
      expect(await orders(id)).toHaveLength(0);
    });

    it("what the loaded data says stays a rejection: a coin outside the universe, a coin without a mid", async () => {
      market.mids.DOGE = 0.2; // has a mid, not in the stubbed universe
      delete market.mids.kPEPE; // in the universe, no mid
      market.leaderPositions = [
        { coin: "DOGE", szi: "1000", positionValue: "200", entryPx: "0.2" },
        { coin: "kPEPE", szi: "100000", positionValue: "1000", entryPx: "0.01" },
        { coin: "ETH", szi: "5", positionValue: "20000", entryPx: "4100" },
      ];
      const res = await alice.post("/me/copy/strategies", { leader: LEADER, allocationUsd: 1_000 }).expect(201);
      const id = res.body.data.id as number;
      expect((await orders(id)).map((o) => [o.coin, o.status, o.reason])).toEqual([
        ["DOGE", "rejected", "no_asset_info"],
        ["kPEPE", "rejected", "no_price"],
        ["ETH", "risk_approved", null],
      ]);
      // The partial adoption is visible where the web already reads it: the copy's orders.
      const listed = (await alice.get(`/me/copy/strategies/${id}/orders`).expect(200)).body.data.items;
      expect(listed.filter((o: { status: string }) => o.status === "rejected").map((o: { coin: string; leg: string; reason: string }) => [o.coin, o.leg, o.reason]).sort())
        .toEqual([["DOGE", "adopt", "no_asset_info"], ["kPEPE", "adopt", "no_price"]]);

      await store([fill({ coin: "DOGE", side: "B", sz: 1_000, px: 0.2, start: 1_000, time: Date.now() + 1_000 })]);
      await run();
      expect((await orders(id)).at(-1)).toMatchObject({ coin: "DOGE", leg: "open", status: "rejected", reason: "no_asset_info" });
    });

    it("an open whose mids can't be read waits in the outbox and is copied once they can", async () => {
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      marketService.resetCaches();
      info.allMids.mockRejectedValueOnce(down());
      expect(await signals.drain()).toEqual({ processed: 0, orders: 0, deferred: 1 });
      expect(await orders(id)).toHaveLength(0);
      expect(await db.select().from(copySignalLegs)).toHaveLength(0);
      const [waiting] = await db.select().from(copySignalOutbox);
      expect(waiting).toMatchObject({ status: "pending", attempts: 1, lastError: "market_data_unavailable:mids" });
      expect(waiting!.availableAt.getTime()).toBeGreaterThan(Date.now());
      // Backoff: not picked up again before it is due.
      expect(await signals.drain()).toEqual({ processed: 0, orders: 0 });

      await db.update(copySignalOutbox).set({ availableAt: new Date(0) });
      expect(await run()).toMatchObject({ processed: 1, orders: 1, filled: 1 });
      expect(await orders(id)).toEqual([expect.objectContaining({ leg: "open", status: "filled", size: "0.05" })]);
      // Replayed after it was done: still one order.
      await db.update(copySignalOutbox).set({ status: "pending" });
      await run();
      expect(await orders(id)).toHaveLength(1);
      expect(await position(id)).toBeCloseTo(0.05);
    });

    it("the same when the universe can't be read (metaAndAssetCtxs timed out): no `no_asset_info`", async () => {
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      marketService.resetCaches();
      info.metaAndAssetCtxs.mockRejectedValueOnce(down());
      expect(await signals.drain()).toEqual({ processed: 0, orders: 0, deferred: 1 });
      expect(await orders(id)).toHaveLength(0);
      expect((await db.select().from(copySignalOutbox))[0]).toMatchObject({ status: "pending", lastError: "market_data_unavailable:asset_info" });
      await db.update(copySignalOutbox).set({ availableAt: new Date(0) });
      await run();
      expect(await orders(id)).toEqual([expect.objectContaining({ leg: "open", status: "filled" })]);
    });

    it("reductions are placed without prices; only the open in the same batch waits", async () => {
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      await run();
      await store([
        fill({ side: "A", sz: 0.25, px: 100_000, start: 0.5, time: activatedAt + 2_000 }),
        fill({ coin: "ETH", side: "B", sz: 5, px: 4_000, start: 0, time: activatedAt + 3_000 }),
      ]);
      marketService.resetCaches();
      info.allMids.mockRejectedValue(down());
      expect(await signals.drain()).toEqual({ processed: 1, orders: 1, deferred: 1 });
      await execution.drain();
      info.allMids.mockReset();
      info.allMids.mockImplementation(async () => Object.fromEntries(Object.entries(market.mids).map(([k, v]) => [k, String(v)])));
      expect(await position(id)).toBeCloseTo(0.025);
      expect((await orders(id)).map((o) => [o.coin, o.leg, o.status])).toEqual([["BTC", "open", "filled"], ["BTC", "close", "filled"]]);

      await db.update(copySignalOutbox).set({ availableAt: new Date(0) });
      await run();
      expect((await orders(id)).at(-1)).toMatchObject({ coin: "ETH", leg: "open", status: "filled" });
      expect(await orders(id)).toHaveLength(3);
    });

    it("the wait is bounded by the signal-age rule: an open still unpriced past maxSignalAgeSeconds is rejected as stale", async () => {
      const { id, activatedAt } = await startCopy();
      await db.update(copyStrategies).set({ activatedAt: new Date(activatedAt - 3_600_000) });
      await store([fill({ coin: "ETH", side: "B", sz: 1, px: 4_000, start: 0, time: Date.now() - 90_000 })]);
      marketService.resetCaches();
      info.allMids.mockRejectedValue(down());
      expect(await signals.drain()).toEqual({ processed: 0, orders: 0, deferred: 1 }); // 90 s old, limit 120 s
      await policies.put({ limits: { maxSignalAgeSeconds: 60 }, reason: "tighter", expectedVersion: 0 }, admin);
      await db.update(copySignalOutbox).set({ availableAt: new Date(0) });
      expect(await signals.drain()).toEqual({ processed: 1, orders: 1 });
      info.allMids.mockReset();
      info.allMids.mockImplementation(async () => Object.fromEntries(Object.entries(market.mids).map(([k, v]) => [k, String(v)])));
      expect(await orders(id)).toEqual([expect.objectContaining({ coin: "ETH", status: "rejected", reason: "stale_signal" })]);
      expect((await db.select().from(copySignalOutbox))[0]).toMatchObject({ status: "done" });
    });
  });

  describe("a leader-equity read that fails is retried, never a rejection (review 23)", () => {
    const down = () => new Error("Request deadline exceeded");

    it("a ratio-sized open waits in the outbox and is copied once the leader's account can be read", async () => {
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      marketService.resetCaches();
      info.clearinghouseState.mockRejectedValueOnce(down());
      expect(await signals.drain()).toEqual({ processed: 0, orders: 0, deferred: 1 });
      expect(await orders(id)).toHaveLength(0);
      expect(await db.select().from(copySignalLegs)).toHaveLength(0);
      expect((await db.select().from(copySignalOutbox))[0]).toMatchObject({ status: "pending", attempts: 1, lastError: "market_data_unavailable:leader_equity" });

      await db.update(copySignalOutbox).set({ availableAt: new Date(0) });
      expect(await run()).toMatchObject({ processed: 1, orders: 1, filled: 1 });
      expect(await orders(id)).toEqual([expect.objectContaining({ leg: "open", status: "filled", size: "0.05" })]);
    });

    it("a failed read is not cached: the next pass asks Hyperliquid again", async () => {
      await startCopy();
      marketService.resetCaches();
      info.clearinghouseState.mockRejectedValueOnce(down());
      expect(await marketService.leaderEquity(LEADER)).toEqual({ state: "failed" });
      expect(await marketService.leaderEquity(LEADER)).toEqual({ state: "known", value: 10_000 });
    });

    it("fixed sizing needs no leader equity and does not wait; a reduction in the same batch is placed", async () => {
      const { id, activatedAt } = await startCopy({ sizingMode: "fixed", perTradeUsd: 200 });
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      marketService.resetCaches();
      info.clearinghouseState.mockRejectedValue(down());
      expect(await signals.drain()).toEqual({ processed: 1, orders: 1 });
      await execution.drain();
      await store([fill({ side: "A", sz: 0.5, px: 100_000, start: 0.5, time: activatedAt + 2_000 })]);
      expect(await signals.drain()).toEqual({ processed: 1, orders: 1 });
      await execution.drain();
      info.clearinghouseState.mockReset();
      expect((await orders(id)).map((o) => [o.leg, o.status])).toEqual([["open", "filled"], ["close", "filled"]]);
    });

    it("the wait is bounded by the signal-age rule: past maxSignalAgeSeconds the open is rejected as stale", async () => {
      const { id, activatedAt } = await startCopy();
      await db.update(copyStrategies).set({ activatedAt: new Date(activatedAt - 3_600_000) });
      await store([fill({ coin: "ETH", side: "B", sz: 1, px: 4_000, start: 0, time: Date.now() - 90_000 })]);
      marketService.resetCaches();
      info.clearinghouseState.mockRejectedValue(down());
      expect(await signals.drain()).toEqual({ processed: 0, orders: 0, deferred: 1 }); // 90 s old, limit 120 s
      await policies.put({ limits: { maxSignalAgeSeconds: 60 }, reason: "tighter", expectedVersion: 0 }, admin);
      await db.update(copySignalOutbox).set({ availableAt: new Date(0) });
      expect(await signals.drain()).toEqual({ processed: 1, orders: 1 });
      info.clearinghouseState.mockReset();
      expect(await orders(id)).toEqual([expect.objectContaining({ coin: "ETH", status: "rejected", reason: "stale_signal" })]);
    });
  });

  describe("ratio sizing divides by the leader's whole account, as the trader profile shows it (review 26)", () => {
    const usdc = (total: number) => ({ coin: "USDC", token: 0, total: String(total), hold: "0", entryNtl: "0" });
    /** A leader open of 0.1 BTC = $10,000: 10% of a $100,000 account. */
    async function copyOneOpen() {
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.1, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      await run();
      return (await orders(id))[0]!;
    }

    it("standard account: perp equity on every dex + spot + staked HYPE", async () => {
      market.leaderEquity = 60_000;
      market.hip3Equity = { xyz: 10_000 };
      market.spotBalances = [usdc(20_000)];
      market.stakedHype = 250; // × $40
      expect(await marketService.leaderEquity(LEADER)).toEqual({ state: "known", value: 100_000 });
      // 10% of the leader's account → 10% of the copy's $1,000 → 0.001 BTC (0.00166 against the main dex alone).
      expect(await copyOneOpen()).toMatchObject({ status: "filled", size: "0.001", reason: null });
    });

    it("unified account: the spot balance already holds the perp collateral, so the perp summary is neither the capital nor added to it", async () => {
      market.abstraction = "unifiedAccount";
      market.leaderEquity = 40_000; // margin its positions hold: part of the 100,000 below
      market.spotBalances = [usdc(100_000)];
      expect(await marketService.leaderEquity(LEADER)).toEqual({ state: "known", value: 100_000 });
      expect(await copyOneOpen()).toMatchObject({ status: "filled", size: "0.001", reason: null });
    });

    it("portfolio margin with no position open: a perp account value of 0 is not `leader_equity_unknown`", async () => {
      market.abstraction = "portfolioMargin";
      market.leaderEquity = 0;
      market.spotBalances = [usdc(100_000)];
      expect(await copyOneOpen()).toMatchObject({ status: "filled", size: "0.001" });
    });

    it("a vault's capital is its TVL (Hyperliquid's portfolio), not its own balances", async () => {
      const zero = Object.fromEntries(["accountValue", "pnlDay", "pnlWeek", "pnlMonth", "pnlAllTime", "roiDay", "roiWeek", "roiMonth", "roiAllTime", "volumeDay", "volumeWeek", "volumeMonth", "volumeAllTime"].map((k) => [k, "0"]));
      await db.insert(traderStats).values({ ...zero, address: LEADER, isVault: true, updatedAt: new Date() } as typeof traderStats.$inferInsert);
      market.leaderEquity = 25_000;
      market.tvl = 100_000;
      expect(await marketService.leaderEquity(LEADER)).toEqual({ state: "known", value: 100_000 });
    });

    it("Hyperliquid's own figures (read live 2026-09-29): a unified and a portfolio-margin account come out at its portfolio total, not the perp summary", async () => {
      const snap = JSON.parse(readFileSync(new URL("./fixtures/spot-valuation-live.json", import.meta.url), "utf8")) as {
        spotMetaAndAssetCtxs: unknown; allMids: Record<string, string>;
        accounts: { user: string; abstraction: string; portfolioMarginEnabled: boolean; balances: typeof market.spotBalances; delegatorSummary: unknown; perpEquity: number; hlTotal: number }[];
      };
      info.spotMetaAndAssetCtxs.mockResolvedValue(snap.spotMetaAndAssetCtxs as never);
      info.allMids.mockResolvedValue(snap.allMids);
      for (const mode of ["unifiedAccount", "portfolioMargin"]) {
        const account = snap.accounts.find((a) => a.abstraction === mode)!;
        marketService.resetCaches();
        market.abstraction = account.abstraction;
        market.spotBalances = account.balances;
        market.leaderEquity = account.perpEquity;
        info.delegatorSummary.mockResolvedValueOnce(account.delegatorSummary as never);
        const equity = await marketService.leaderEquity(account.user);
        expect(equity.state).toBe("known");
        const value = (equity as { value: number }).value;
        expect(Math.abs(value - account.hlTotal) / account.hlTotal, `${mode}: ours ${value}, Hyperliquid ${account.hlTotal}`).toBeLessThan(0.002);
        expect(account.perpEquity / account.hlTotal, `${mode}: the perp summary is a fraction of the account`).toBeLessThan(0.6);
      }
      info.spotMetaAndAssetCtxs.mockReset();
      info.allMids.mockReset();
    });

    it("跟單目前持倉 adopts against the same capital; when it can't be read nothing is created (503)", async () => {
      market.abstraction = "unifiedAccount";
      market.leaderEquity = 4_000;
      market.spotBalances = [usdc(10_000)];
      market.leaderPositions = [{ coin: "ETH", szi: "5", positionValue: "20000", entryPx: "4100" }];
      info.spotClearinghouseState.mockRejectedValueOnce(new Error("Request deadline exceeded"));
      const refused = await alice.post("/me/copy/strategies", { leader: LEADER, allocationUsd: 1_000 }).expect(503);
      expect(refused.body.error.code).toBe("leader_unavailable");
      expect(await db.select().from(copyStrategies)).toHaveLength(0);
      // Fixed sizing never needed it.
      info.spotClearinghouseState.mockRejectedValue(new Error("Request deadline exceeded"));
      await api("bob-token").post("/me/copy/strategies", { leader: LEADER, allocationUsd: 1_000, sizingMode: "fixed", perTradeUsd: 200 }).expect(201);
      info.spotClearinghouseState.mockReset();

      const res = await alice.post("/me/copy/strategies", { leader: LEADER, allocationUsd: 1_000 }).expect(201);
      // 20,000 × 1,000 / 10,000 = 2,000 → 0.5 ETH (1.25 ETH against the 4,000 perp summary).
      expect(await orders(res.body.data.id)).toEqual([expect.objectContaining({ leg: "adopt", side: "B", status: "risk_approved", size: "0.5" })]);
    });
  });

  describe("adoption repair", () => {
    /** The state the old code left: an active copy whose adopt leg was rejected when the universe read timed out. */
    async function broken(coin = "ETH", reason = "no_asset_info") {
      const { id } = await startCopy();
      const [s] = await db.select().from(copyStrategies).where(eq(copyStrategies.id, id));
      await db.insert(copyOrders).values({
        cloid: cloidOf(`${id}:adopt:${coin}:v1`), strategyId: id, userId: s!.userId, strategyVersion: 1, riskPolicyVersion: 0, leaderAddress: LEADER,
        coin, leg: "adopt", side: "B", reduceOnly: false, size: "0", signalPx: "4000", signalTime: s!.activatedAt, signalTids: [], status: "rejected", reason,
        controlRevisions: { platform: 0, user: 0, strategy: 0 },
      });
      return id;
    }
    const repair = (options?: { dryRun?: boolean; strategyId?: number }) => { marketService.resetCaches(); return app.get(CopyAdoptionRepairService).repair(options); };

    it("adopts the leader's position now, at the mid now, as a new adopt leg with its own key, exactly once", async () => {
      const id = await broken();
      market.leaderPositions = [{ coin: "ETH", szi: "5", positionValue: "20000", entryPx: "4100" }];

      expect(await repair({ dryRun: true })).toEqual([expect.objectContaining({ strategyId: id, coin: "ETH", outcome: "would_order", side: "B", notional: 2_000 })]);
      expect(await orders(id)).toHaveLength(1);

      const [done] = await repair();
      expect(done).toMatchObject({ outcome: "ordered", orderStatus: "risk_approved", size: 0.5 });
      const [, adopt] = await orders(id);
      expect(adopt).toMatchObject({ leg: "adopt", side: "B", status: "risk_approved", size: "0.5", signalPx: "4000", cloid: cloidOf(adoptionRepairKey(id, "ETH")) });

      // Again, before and after the fill, and twice at once: nothing more.
      expect(await repair()).toEqual([expect.objectContaining({ outcome: "already_repaired" })]);
      await execution.drain();
      await Promise.all([repair(), repair()]);
      expect(await orders(id)).toHaveLength(2);
      expect(await position(id, "ETH")).toBeCloseTo(0.5);
      const overview = (await alice.get("/me/copy").expect(200)).body.data;
      expect(overview.strategies[0]).toMatchObject({ tradesCopied: 1, pendingOrders: 0, positions: [expect.objectContaining({ coin: "ETH", size: 0.5 })] });
    });

    it("two runs at once write one order", async () => {
      const id = await broken();
      market.leaderPositions = [{ coin: "ETH", szi: "5", positionValue: "20000", entryPx: "4100" }];
      const service = app.get(CopyAdoptionRepairService);
      marketService.resetCaches();
      const [a, b] = await Promise.all([service.repair(), service.repair()]);
      expect([a[0]!.outcome, b[0]!.outcome].sort()).toEqual(["already_repaired", "ordered"]);
      expect(await orders(id)).toHaveLength(2);
    });

    it("writes nothing while data is missing, and repairs on the next run", async () => {
      const id = await broken();
      market.leaderPositions = [{ coin: "ETH", szi: "-5", positionValue: "20000", entryPx: "4100" }];
      marketService.resetCaches();
      info.metaAndAssetCtxs.mockRejectedValueOnce(new Error("Request deadline exceeded"));
      expect(await app.get(CopyAdoptionRepairService).repair()).toEqual([expect.objectContaining({ outcome: "market_data_unavailable" })]);
      info.clearinghouseState.mockRejectedValueOnce(new Error("down"));
      expect(await repair()).toEqual([expect.objectContaining({ outcome: "leader_unavailable" })]);
      expect(await orders(id)).toHaveLength(1);
      expect(await repair()).toEqual([expect.objectContaining({ outcome: "ordered", side: "A", orderStatus: "risk_approved" })]);
    });

    it("leaves alone: a leader who closed the position, a copy that already holds the coin, a stopped or paused copy, other rejections", async () => {
      const id = await broken();
      expect(await repair()).toEqual([expect.objectContaining({ outcome: "leader_flat" })]);

      market.leaderPositions = [{ coin: "ETH", szi: "5", positionValue: "20000", entryPx: "4100" }];
      await store([fill({ coin: "ETH", side: "B", sz: 1, px: 4_000, start: 5, time: Date.now() + 1_000 })]);
      expect(await repair()).toEqual([expect.objectContaining({ outcome: "leader_trading" })]);
      await run();
      expect(await repair()).toEqual([expect.objectContaining({ outcome: "already_positioned" })]);
      expect((await orders(id)).filter((o) => o.leg === "adopt")).toHaveLength(1);

      await alice.post(`/me/copy/strategies/${id}/commands`, { command: "pause" }).expect(200);
      expect(await repair()).toEqual([]);
      await db.update(copyOrders).set({ reason: "symbol_blocked" }).where(eq(copyOrders.leg, "adopt"));
      await alice.post(`/me/copy/strategies/${id}/commands`, { command: "resume" }).expect(200);
      expect(await repair()).toEqual([]);
    });

    it("a repair the risk policy refuses is recorded with that reason and not tried again", async () => {
      await policies.put({ limits: { blockedCoins: ["ETH"] }, reason: "test blocklist", expectedVersion: 0 }, admin);
      const id = await broken();
      market.leaderPositions = [{ coin: "ETH", szi: "5", positionValue: "20000", entryPx: "4100" }];
      expect(await repair()).toEqual([expect.objectContaining({ outcome: "ordered", orderStatus: "rejected", orderReason: "symbol_blocked" })]);
      expect(await repair()).toEqual([expect.objectContaining({ outcome: "already_repaired" })]);
      expect(await orders(id)).toHaveLength(2);
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

  describe("execution order within a strategy (review 24)", () => {
    it("a flip whose close fails: the open waits for it, other strategies still execute, and the retry ends on the leader's side", async () => {
      const { id } = await startCopy();
      const bob = api("bob-token");
      const bobId = (await bob.post("/me/copy/strategies", { leader: LEADER, allocationUsd: 1_000, copyStartMode: "delta" }).expect(201)).body.data.id as number;
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: Date.now() + 1_000 })]);
      await run();
      expect([await position(id), await position(bobId)]).toEqual([0.05, 0.05]);
      // The leader flips long 0.5 → short 0.5: a close and an open per copy.
      await store([fill({ side: "A", sz: 1, px: 100_000, start: 0.5, time: Date.now() + 2_000 })]);
      await signals.drain();
      expect((await orders(id)).map((o) => [o.leg, o.status])).toEqual([["open", "filled"], ["close", "risk_approved"], ["open", "risk_approved"]]);

      const repo = app.get(CopyRepository);
      const save = repo.savePosition.bind(repo);
      let failing = true;
      const spy = vi.spyOn(repo, "savePosition").mockImplementation(async (tx, strategyId, coin, v) => {
        if (failing && strategyId === id) throw new Error("db blip");
        return save(tx, strategyId, coin, v);
      });
      // One failed fill neither throws nor stops the other strategy.
      expect(await execution.drain()).toEqual({ filled: 2, cancelled: 0 });
      expect(await position(bobId)).toBeCloseTo(-0.05);
      // Alice's close is past the boundary and unfilled; her open must not run ahead of it.
      await execution.drain();
      expect((await orders(id)).map((o) => [o.leg, o.status])).toEqual([["open", "filled"], ["close", "submitting"], ["open", "risk_approved"]]);
      expect(await position(id)).toBeCloseTo(0.05);

      failing = false;
      spy.mockRestore();
      await db.update(copyOrders).set({ updatedAt: new Date(Date.now() - 60_000) }).where(eq(copyOrders.status, "submitting"));
      expect(await execution.drain()).toEqual({ filled: 2, cancelled: 0 });
      expect((await orders(id)).map((o) => [o.leg, o.side, o.status])).toEqual([["open", "B", "filled"], ["close", "A", "filled"], ["open", "A", "filled"]]);
      expect(await position(id)).toBeCloseTo(-0.05);
      const held = await db.execute(sql`select count(*)::int as n from copy_reservations where status = 'held'`);
      expect(held.rows).toEqual([{ n: 0 }]);
    });

    it("an open never fills against the strategy's own opposite position", async () => {
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      await run();
      const [s] = await db.select().from(copyStrategies);
      await db.insert(copyOrders).values({
        cloid: "0x" + "ef".repeat(16), strategyId: id, userId: s!.userId, strategyVersion: 1, riskPolicyVersion: 0, leaderAddress: LEADER,
        coin: "BTC", leg: "open", side: "A", reduceOnly: false, size: "0.05", signalPx: "100000", signalTime: new Date(), signalTids: [], status: "risk_approved",
        controlRevisions: { platform: 0, user: 0, strategy: 0 },
      });
      expect(await execution.drain()).toEqual({ filled: 0, cancelled: 0 });
      expect((await orders(id)).at(-1)).toMatchObject({ status: "cancelled", reason: "opposite_position" });
      expect(await position(id)).toBeCloseTo(0.05);
    });

    it("an approved open that waited past maxSignalAgeSeconds is cancelled at the boundary and its margin released", async () => {
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      await signals.drain();
      // The worker was down for ten minutes.
      await db.update(copyOrders).set({ signalTime: new Date(Date.now() - 600_000) });
      expect(await execution.drain()).toEqual({ filled: 0, cancelled: 1 });
      expect((await orders(id))[0]).toMatchObject({ status: "cancelled", reason: "stale_signal_before_submit" });
      expect(await position(id)).toBe(0);
      expect((await db.execute(sql`select status from copy_reservations`)).rows).toEqual([{ status: "released" }]);
    });

    it("the same for an open left `submitting`: resumed too late, it is cancelled, not filled at today's mid", async () => {
      const { id, activatedAt } = await startCopy();
      await store([fill({ side: "B", sz: 0.5, px: 100_000, start: 0, time: activatedAt + 1_000 })]);
      await signals.drain();
      const [o] = await orders(id);
      await execution.submit(o!.id);
      await db.update(copyOrders).set({ signalTime: new Date(Date.now() - 600_000), updatedAt: new Date(Date.now() - 600_000) });
      await execution.drain();
      expect((await orders(id))[0]).toMatchObject({ status: "cancelled", reason: "stale_signal_before_fill" });
      expect(await position(id)).toBe(0);
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
