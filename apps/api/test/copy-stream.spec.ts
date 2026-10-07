import type { INestApplication } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { copyStreamEventSchemas } from "@trading-dashboard/shared/contracts";
import { copyEvents, copyOrders, copyStrategies, users } from "@trading-dashboard/shared/database";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthService } from "../src/common/auth/auth.service.js";
import { CopyAdminReadService } from "../src/copy/copy-admin-read.service.js";
import { CopyAdoptionRepairService } from "../src/copy/copy-adoption-repair.service.js";
import { CopyControlService } from "../src/copy/copy-control.service.js";
import { CopyLiveSystemStops } from "../src/copy/copy-live-stop-system.js";
import { CopyLiveStopRepository } from "../src/copy/copy-live-stop.repository.js";
import { CopyLiveMandateRepository } from "../src/copy/copy-live-mandate.repository.js";
import { CopyExecutionService } from "../src/copy/copy-execution.service.js";
import { CopyMarketService } from "../src/copy/copy-market.service.js";
import { CopyPerformanceService } from "../src/copy/copy-performance.service.js";
import { CopyOrderPlanner } from "../src/copy/copy-planner.service.js";
import { CopyRiskPolicyService } from "../src/copy/copy-risk-policy.service.js";
import { insertOwnerEvent } from "../src/copy/copy-runtime.repository.js";
import { CopySignalService } from "../src/copy/copy-signal.service.js";
import { COPY_STREAM_OPTIONS, CopyStreamService } from "../src/copy/copy-stream.service.js";
import { CopyStrategyService } from "../src/copy/copy-strategy.service.js";
import { CopyController } from "../src/copy/copy.controller.js";
import { CopyRepository } from "../src/copy/copy.repository.js";
import { DATABASE_POOL } from "../src/db/drizzle.provider.js";
import { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import { NotifyService } from "../src/notify/notify.service.js";
import { CopyFeedListener } from "../src/runtime/copy-feed-relay.js";
import { AccountDeletionService } from "../src/users/account-deletion.service.js";
import { AccountRepository } from "../src/users/account.repository.js";
import { FillSyncRepository } from "../src/watcher/fill-sync.repository.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";
import { openSse, type SseConnection } from "./sse-test-client.js";

describe("GET /me/copy/stream — the owner's live copy feed over SSE (real Postgres NOTIFY)", () => {
  const db = getTestDb();
  const privy = stubPrivy({
    "alice-token": { privyUserId: "did:privy:alice" },
    "bob-token": { privyUserId: "did:privy:bob" },
  });
  let app: INestApplication;
  let streams: CopyStreamService;
  let repository: CopyRepository;
  let base: string;
  const open: SseConnection[] = [];
  const sse = async (headers: Record<string, string> = {}) => {
    const conn = await openSse(`${base}/me/copy/stream`, headers);
    open.push(conn);
    return conn;
  };
  const ready = (conn: SseConnection) => conn.waitFor((f) => f.some((x) => x.comments.includes("ok")));
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const waitUntil = async (check: () => boolean, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("condition not met");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  async function userId(token: string, did: string): Promise<number> {
    const conn = await sse(auth(token));
    await ready(conn);
    conn.close();
    const [u] = await db.select().from(users).where(eq(users.privyUserId, did));
    return u!.id;
  }
  const event = (owner: number, type: string, payload: Record<string, unknown> = { mode: "paper" }, strategyId: number | null = null) =>
    db.transaction((tx) => insertOwnerEvent(tx, owner, strategyId, type, payload));

  beforeAll(async () => {
    ({ app } = await createAuthedApp({
      db,
      privy,
      imports: [EventEmitterModule.forRoot()],
      controllers: [CopyController],
      providers: [
        CopyRepository, CopyMarketService, CopyRiskPolicyService, CopyOrderPlanner, CopySignalService, CopyExecutionService,
        CopyControlService, CopyLiveSystemStops, CopyLiveStopRepository, CopyLiveMandateRepository, CopyStrategyService, CopyPerformanceService, CopyAdminReadService, CopyAdoptionRepairService, FillSyncRepository, AccountRepository, AccountDeletionService,
        CopyStreamService, CopyFeedListener,
        { provide: DATABASE_POOL, useValue: (db as unknown as { $client: unknown }).$client },
        { provide: COPY_STREAM_OPTIONS, useValue: { heartbeatMs: 100, replayLimit: 5, setupTimeoutMs: 2000, authorizationTimeoutMs: 1000, maxPerIp: 10, maxTotal: 10 } },
        { provide: HyperliquidInfoClient, useValue: {} },
        { provide: NotifyService, useValue: { sendSystemMessage: vi.fn() } },
      ],
    }));
    streams = app.get(CopyStreamService);
    repository = app.get(CopyRepository);
    const address = app.getHttpServer().address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    for (const conn of open.splice(0)) conn.close();
    await waitUntil(() => streams.stats().total === 0);
    await truncateAll(db);
    app.get(AuthService).clearCache();
  });

  afterAll(async () => {
    for (const conn of open) conn.close();
    await app?.close();
    await closeTestDb();
  });

  it("refuses a signed-out caller before streaming", async () => {
    const conn = await sse();
    expect(conn.status).toBe(401);
  });

  it("pushes each committed event to its owner only, once, in order, as GET /me/copy/events lists it; a rolled-back write sends nothing", async () => {
    const alice = await userId("alice-token", "did:privy:alice");
    const bob = await userId("bob-token", "did:privy:bob");
    const a = await sse(auth("alice-token"));
    const b = await sse(auth("bob-token"));
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toMatch(/^text\/event-stream/);
    await Promise.all([ready(a), ready(b)]);

    await event(alice, "funds_added", { mode: "paper", amount: "100" });
    await event(alice, "order_filled", { mode: "paper", coin: "BTC", action: "open" });
    await expect(db.transaction(async (tx) => { await insertOwnerEvent(tx, alice, null, "funds_withdrawn", { mode: "paper" }); throw new Error("rolled back"); })).rejects.toThrow("rolled back");
    await event(alice, "position_liquidated", { mode: "paper", coin: "ETH" });
    await a.waitFor(() => a.events("copy").length === 3);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const got = a.events("copy");
    expect(got.map((e) => e.data.type)).toEqual(["funds_added", "order_filled", "position_liquidated"]);
    expect(got.map((e) => e.id)).toEqual(got.map((e) => e.data.id));
    for (const e of got) expect(copyStreamEventSchemas.copy.safeParse(e.data).success).toBe(true);
    const rows = await db.select().from(copyEvents).where(eq(copyEvents.userId, alice)).orderBy(asc(copyEvents.id));
    expect(rows.map((r) => String(r.id))).toEqual(got.map((e) => e.id));
    expect(b.events("copy")).toEqual([]);

    // Bob's own event reaches Bob only.
    await event(bob, "funds_added", { mode: "paper", amount: "5" });
    await b.waitFor(() => b.events("copy").length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(a.events("copy")).toHaveLength(3);
  });

  it("replays what a reconnecting page missed after its Last-Event-ID, without repeating, and resets past the replay bound", async () => {
    const alice = await userId("alice-token", "did:privy:alice");
    const first = await sse(auth("alice-token"));
    await ready(first);
    await event(alice, "funds_added");
    await first.waitFor(() => first.events("copy").length === 1);
    const last = first.events("copy")[0]!.id!;
    first.close();
    await waitUntil(() => streams.stats().total === 0);
    await event(alice, "order_filled", { mode: "paper", action: "increase" });
    await event(alice, "order_filled", { mode: "paper", action: "decrease" });

    const resumed = await sse({ ...auth("alice-token"), "Last-Event-ID": last });
    await resumed.waitFor(() => resumed.events("copy").length === 2);
    expect(resumed.events("copy").map((e) => (e.data.payload as { action: string }).action)).toEqual(["increase", "decrease"]);
    await event(alice, "order_filled", { mode: "paper", action: "close" });
    await resumed.waitFor(() => resumed.events("copy").length === 3);
    expect(new Set(resumed.events("copy").map((e) => e.id)).size).toBe(3);
    resumed.close();
    await waitUntil(() => streams.stats().total === 0);

    // More than the replay bound (5) missed: one reset, then live again.
    const before = resumed.events("copy").at(-1)!.id!;
    for (let i = 0; i < 7; i++) await event(alice, "funds_added");
    const late = await sse({ ...auth("alice-token"), "Last-Event-ID": before });
    await late.waitFor(() => late.events("reset").length === 1);
    expect(late.events("copy")).toEqual([]);
    expect(late.events("reset")[0]!.data).toEqual({ reason: "replay_truncated" });
    await event(alice, "strategy_command", { mode: "paper", command: "pause" });
    await late.waitFor(() => late.events("copy").length === 1);
    expect(late.events("copy")[0]!.data.type).toBe("strategy_command");
  });

  it("ends the stream when the session stops being valid (rechecked on heartbeats)", async () => {
    await userId("alice-token", "did:privy:alice");
    const conn = await sse(auth("alice-token"));
    await ready(conn);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.privyUserId, "did:privy:alice"));
    app.get(AuthService).clearCache();
    await conn.ended;
    await waitUntil(() => streams.stats().total === 0);
  });

  it("a paper fill's event says what it did to the position: open, increase, decrease, close", async () => {
    const alice = await userId("alice-token", "did:privy:alice");
    const [s] = await db.insert(copyStrategies).values({ userId: alice, leaderAddress: "0x" + "ab".repeat(20), allocated: "1000", cash: "1000", activatedAt: new Date() }).returning();
    const steps: Array<[string, string, "B" | "A"]> = [["0", "1", "B"], ["1", "3", "B"], ["3", "2", "A"], ["2", "0", "A"]];
    let n = 0;
    for (const [before, after, side] of steps) {
      const [o] = await db.insert(copyOrders).values({
        cloid: `0x${String(++n).padStart(32, "0")}`, strategyId: s!.id, userId: alice, strategyVersion: 1, riskPolicyVersion: 1, leaderAddress: s!.leaderAddress,
        coin: "BTC", leg: side === "B" ? "open" : "close", side, reduceOnly: side === "A", size: "1", signalPx: "100", signalTime: new Date(), signalTids: [], status: "filled",
        controlRevisions: { platform: 0, user: 0, strategy: 0 }, filledSize: "1", avgPx: "100",
      }).returning();
      await db.transaction((tx) => repository.insertPaperFill(tx, { orderId: o!.id, strategyId: s!.id, coin: "BTC", side, size: "1", px: "100", basePx: "100", priceSource: "mid", slippageBps: "0", fee: "0.04", builderFee: "0.01", realizedPnl: side === "A" ? "2.5" : "0" }, { before, after }));
    }
    const rows = await db.select().from(copyEvents).where(eq(copyEvents.strategyId, s!.id)).orderBy(asc(copyEvents.id));
    expect(rows.map((r) => r.type)).toEqual(["order_filled", "order_filled", "order_filled", "order_filled"]);
    expect(rows.map((r) => r.payload.action)).toEqual(["open", "increase", "decrease", "close"]);
    expect(rows.map((r) => r.payload.positionSize)).toEqual(["1", "3", "2", "0"]);
    expect(rows[3]!.payload).toMatchObject({ realizedPnl: "2.5", fee: "0.05", coin: "BTC", side: "A" });
  });
});
