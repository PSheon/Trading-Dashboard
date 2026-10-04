import type { INestApplication } from "@nestjs/common";
import { copyEquitySnapshots, copyOrders, copyPaperFills, copyStrategies, users } from "@trading-dashboard/shared/database";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthService } from "../src/common/auth/auth.service.js";
import { CopyAdminReadService } from "../src/copy/copy-admin-read.service.js";
import { CopyAdoptionRepairService } from "../src/copy/copy-adoption-repair.service.js";
import { CopyControlService } from "../src/copy/copy-control.service.js";
import { CopyExecutionService } from "../src/copy/copy-execution.service.js";
import { CopyMarketService } from "../src/copy/copy-market.service.js";
import { CopyPerformanceService, SPARKLINE_POINTS } from "../src/copy/copy-performance.service.js";
import { CopyStreamService } from "../src/copy/copy-stream.service.js";
import { CopyOrderPlanner } from "../src/copy/copy-planner.service.js";
import { CopyRiskPolicyService } from "../src/copy/copy-risk-policy.service.js";
import { CopySignalService } from "../src/copy/copy-signal.service.js";
import { CopyStrategyService } from "../src/copy/copy-strategy.service.js";
import { CopyController } from "../src/copy/copy.controller.js";
import { CopyRepository } from "../src/copy/copy.repository.js";
import { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import { NotifyService } from "../src/notify/notify.service.js";
import { FillSyncRepository } from "../src/watcher/fill-sync.repository.js";
import { AccountRepository } from "../src/users/account.repository.js";
import { AccountDeletionService } from "../src/users/account-deletion.service.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const LEADER_A = "0x" + "a1".repeat(20);
const LEADER_B = "0x" + "b2".repeat(20);
const LEADER_C = "0x" + "c3".repeat(20);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Hyperliquid is never needed for these reads. */
const info = {};

describe("the whole paper portfolio: merged PnL history, today's PnL, each copy's curve and closed trades", () => {
  const db = getTestDb();
  const privy = stubPrivy({
    "alice-token": { privyUserId: "did:privy:alice", profile: { email: "alice@example.com", walletAddress: null, embeddedWalletAddress: null } },
    "bob-token": { privyUserId: "did:privy:bob", profile: { email: "bob@example.com", walletAddress: null, embeddedWalletAddress: null } },
  });
  let app: INestApplication;
  let auth: AuthService;
  let service: CopyPerformanceService;
  // A minute boundary a little in the past, so that "now" in SQL is later.
  const NOW = new Date(Math.floor((Date.now() - 2 * MIN) / MIN) * MIN);

  beforeAll(async () => {
    ({ app, auth } = await createAuthedApp({
      db,
      privy,
      controllers: [CopyController],
      providers: [
        CopyRepository, CopyMarketService, CopyRiskPolicyService, CopyOrderPlanner, CopySignalService, CopyExecutionService,
        CopyControlService, CopyStrategyService, CopyPerformanceService, CopyStreamService, CopyAdminReadService, CopyAdoptionRepairService, FillSyncRepository, AccountRepository, AccountDeletionService,
        { provide: HyperliquidInfoClient, useValue: info },
        { provide: NotifyService, useValue: { sendSystemMessage: vi.fn() } },
      ],
    }));
    service = app.get(CopyPerformanceService);
  });

  beforeEach(async () => {
    await truncateAll(db);
    auth.clearCache();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const get = (path: string, token?: string) => {
    const r = request(app.getHttpServer()).get(path);
    return token ? r.set("Authorization", `Bearer ${token}`) : r;
  };
  async function userId(token: string, did: string): Promise<number> {
    await get("/me/copy/trades", token).expect(200);
    const [u] = await db.select().from(users).where(eq(users.privyUserId, did));
    return u!.id;
  }
  async function strategy(owner: number, leader: string, createdAt: Date, o: { stoppedAt?: Date; allocated?: string } = {}): Promise<number> {
    const [row] = await db.insert(copyStrategies).values({
      userId: owner, leaderAddress: leader, allocated: o.allocated ?? "1000", cash: o.stoppedAt ? "0" : (o.allocated ?? "1000"),
      status: o.stoppedAt ? "stopped" : "active", activatedAt: createdAt, createdAt, stoppedAt: o.stoppedAt ?? null,
    }).returning({ id: copyStrategies.id });
    return row!.id;
  }
  /** One valuation a minute from `from` to `to`, PnL = `pnlAt(time)`. */
  async function minutely(strategyId: number, from: Date, to: Date, pnlAt: (t: number) => number) {
    const rows = [];
    for (let t = from.getTime(); t <= to.getTime(); t += MIN) {
      const pnl = pnlAt(t);
      rows.push({ strategyId, time: new Date(t), equity: String(1000 + pnl), totalPnl: String(pnl), netDeposits: "1000", exposureUsd: "0" });
    }
    for (let i = 0; i < rows.length; i += 1000) await db.insert(copyEquitySnapshots).values(rows.slice(i, i + 1000));
  }

  describe("GET /me/copy/portfolio", () => {
    it("is the owner's alone: 401 signed out, 400 for an unknown window, empty with no copies", async () => {
      await get("/me/copy/portfolio").expect(401);
      await get("/me/copy/portfolio?window=2d", "alice-token").expect(400);
      const body = (await get("/me/copy/portfolio?window=7d", "alice-token").expect(200)).body.data;
      expect(body).toMatchObject({ mode: "paper", window: "7d", points: [], partial: false, todayPnl: 0, sparklines: [] });
    });

    it("sums every copy at each time: a copy adds 0 before it starts, a stopped copy keeps its final PnL, today's PnL leaves it out", async () => {
      const alice = await userId("alice-token", "did:privy:alice");
      const bob = await userId("bob-token", "did:privy:bob");
      const a = await strategy(alice, LEADER_A, new Date(NOW.getTime() - 3 * DAY));
      const b = await strategy(alice, LEADER_B, new Date(NOW.getTime() - 6 * HOUR));
      const c = await strategy(alice, LEADER_C, new Date(NOW.getTime() - 5 * DAY), { stoppedAt: new Date(NOW.getTime() - 2 * DAY) });
      const other = await strategy(bob, LEADER_A, new Date(NOW.getTime() - 3 * DAY));
      // A: +1 per hour; B: −2 per hour since its start; C stopped at +50; Bob's copy must never show.
      const aPnl = (t: number) => Math.round(((t - (NOW.getTime() - 3 * DAY)) / HOUR) * 1e6) / 1e6;
      const bPnl = (t: number) => -Math.round(((t - (NOW.getTime() - 6 * HOUR)) / HOUR) * 2e6) / 1e6;
      await minutely(a, new Date(NOW.getTime() - 26 * HOUR), NOW, aPnl);
      await minutely(b, new Date(NOW.getTime() - 6 * HOUR + MIN), NOW, bPnl);
      await db.insert(copyEquitySnapshots).values({ strategyId: c, time: new Date(NOW.getTime() - 2 * DAY), equity: "1050", totalPnl: "50", netDeposits: "1000", exposureUsd: "0" });
      await minutely(other, new Date(NOW.getTime() - 26 * HOUR), NOW, () => 9_999);

      const day = await service.portfolio(alice, { window: "1d" }, NOW);
      expect(day.from.toISOString()).toBe(new Date(NOW.getTime() - DAY).toISOString());
      expect(day.to.toISOString()).toBe(NOW.toISOString());
      expect(day.points.length).toBeGreaterThan(100);
      expect(day.points.length).toBeLessThanOrEqual(122);
      expect(day.partial).toBe(false);
      const first = day.points[0]!;
      expect(first.pnl).toBeCloseTo(aPnl(first.time.getTime()) + 50, 6);
      const last = day.points.at(-1)!;
      expect(last.time.toISOString()).toBe(NOW.toISOString());
      expect(last.pnl).toBeCloseTo(aPnl(NOW.getTime()) + bPnl(NOW.getTime()) + 50, 6);
      // Before B started, the sum is A and C only.
      const beforeB = day.points.filter((p) => p.time.getTime() < NOW.getTime() - 6 * HOUR).at(-1)!;
      expect(beforeB.pnl).toBeCloseTo(aPnl(Math.floor(beforeB.time.getTime() / MIN) * MIN) + 50, 6);

      // Today: A's change since 00:00 UTC plus all of B's (B started today or its base is 00:00) — not C.
      const midnight = new Date(NOW); midnight.setUTCHours(0, 0, 0, 0);
      const bBase = b && NOW.getTime() - 6 * HOUR >= midnight.getTime() ? 0 : bPnl(midnight.getTime());
      expect(day.todayPnl).toBeCloseTo(aPnl(NOW.getTime()) - aPnl(midnight.getTime()) + bPnl(NOW.getTime()) - bBase, 6);

      // "all" starts at the first copy, C's start.
      const all = await service.portfolio(alice, { window: "all" }, NOW);
      expect(all.from.toISOString()).toBe(new Date(NOW.getTime() - 5 * DAY).toISOString());
      // A has no valuation before NOW − 26 h: those times are unknown, not 0.
      expect(all.partial).toBe(true);
      expect(all.points.find((p) => p.time.getTime() < NOW.getTime() - 27 * HOUR && p.time.getTime() > NOW.getTime() - 3 * DAY + 5 * MIN)?.pnl).toBeNull();
      // Before A started only C counts: 0 before C's first valuation is unknown too (C has one valuation only, at its stop).
      expect(all.points.at(-1)!.pnl).toBeCloseTo(last.pnl!, 6);
    });

    it("a gap in a running copy's valuations makes those times unknown (null) and the answer partial", async () => {
      const alice = await userId("alice-token", "did:privy:alice");
      const a = await strategy(alice, LEADER_A, new Date(NOW.getTime() - 2 * DAY));
      await minutely(a, new Date(NOW.getTime() - 25 * HOUR), new Date(NOW.getTime() - 10 * HOUR), () => 10);
      await minutely(a, new Date(NOW.getTime() - 9 * HOUR), NOW, () => 12);
      const day = await service.portfolio(alice, { window: "1d" }, NOW);
      expect(day.partial).toBe(true);
      const gap = day.points.filter((p) => p.time.getTime() > NOW.getTime() - 10 * HOUR + 3 * MIN && p.time.getTime() < NOW.getTime() - 9 * HOUR);
      expect(gap.length).toBeGreaterThan(0);
      expect(gap.every((p) => p.pnl === null)).toBe(true);
      expect(day.points.at(-1)!.pnl).toBe(12);
      // Unpriced valuation (equity null) is unknown too.
      await db.update(copyEquitySnapshots).set({ equity: null, totalPnl: null }).where(sql`${copyEquitySnapshots.time} = ${NOW}`);
      const again = await service.portfolio(alice, { window: "1d" }, NOW);
      expect(again.points.at(-1)!.pnl).toBeNull();
      expect(again.todayPnl).toBeNull();
    });

    it("each copy's curve: 48 points from its start, 0 first, its final PnL last when stopped", async () => {
      const alice = await userId("alice-token", "did:privy:alice");
      const start = new Date(Date.now() - 4 * HOUR);
      const stop = new Date(Date.now() - HOUR);
      const c = await strategy(alice, LEADER_C, start, { stoppedAt: stop });
      await minutely(c, new Date(start.getTime() + MIN), stop, (t) => (t - start.getTime()) / MIN);
      const body = (await get("/me/copy/portfolio", "alice-token").expect(200)).body.data;
      const line = body.sparklines.find((s: { strategyId: number }) => s.strategyId === c);
      expect(line.points).toHaveLength(SPARKLINE_POINTS);
      expect(line.points[0]).toBe(0);
      expect(line.points.at(-1)).toBe(180);
      expect(line.points.every((v: number | null) => v !== null)).toBe(true);
    });
  });

  describe("GET /me/copy/trades", () => {
    async function fills(strategyId: number, owner: number, list: { coin: string; side: "B" | "A"; size: string; px: string; fee: string; realized: string; at: number }[]) {
      let n = 0;
      for (const f of list) {
        const [o] = await db.insert(copyOrders).values({
          cloid: `0x${String(strategyId).padStart(4, "0")}${String(++n).padStart(28, "0")}`, strategyId, userId: owner, strategyVersion: 1, riskPolicyVersion: 1,
          leaderAddress: LEADER_A, coin: f.coin, leg: "open", side: f.side, reduceOnly: false, size: f.size, signalPx: f.px, signalTime: new Date(f.at),
          signalTids: [], status: "filled", controlRevisions: { platform: 0, user: 0, strategy: 0 }, filledSize: f.size, avgPx: f.px, fee: f.fee,
        }).returning({ id: copyOrders.id });
        await db.insert(copyPaperFills).values({ orderId: o!.id, strategyId, coin: f.coin, side: f.side, size: f.size, px: f.px, basePx: f.px, priceSource: "mid",
          slippageBps: "0", fee: f.fee, builderFee: "0", realizedPnl: f.realized, ts: new Date(f.at) });
      }
    }

    it("rebuilds round trips from the copy's fills; PnL is after fees, ROI over the entry notional; open trades are left out", async () => {
      const alice = await userId("alice-token", "did:privy:alice");
      const bob = await userId("bob-token", "did:privy:bob");
      const a = await strategy(alice, LEADER_A, new Date(NOW.getTime() - DAY));
      const t0 = NOW.getTime() - 20 * HOUR;
      await fills(a, alice, [
        // Long BTC: 1 @ 100, 1 @ 110, closed 2 @ 120 (+30 gross, 0.4 fees).
        { coin: "BTC", side: "B", size: "1", px: "100", fee: "0.1", realized: "0", at: t0 },
        { coin: "BTC", side: "B", size: "1", px: "110", fee: "0.1", realized: "0", at: t0 + MIN },
        { coin: "BTC", side: "A", size: "2", px: "120", fee: "0.2", realized: "30", at: t0 + 2 * MIN },
        // Short ETH: 1 @ 100, closed @ 105 (−5 gross, 0.2 fees).
        { coin: "ETH", side: "A", size: "1", px: "100", fee: "0.1", realized: "0", at: t0 + 3 * MIN },
        { coin: "ETH", side: "B", size: "1", px: "105", fee: "0.1", realized: "-5", at: t0 + 4 * MIN },
        // Still open: not a closed trade.
        { coin: "BTC", side: "B", size: "0.5", px: "121", fee: "0.05", realized: "0", at: t0 + 5 * MIN },
      ]);
      const recent = (await get("/me/copy/trades?sort=recent", "alice-token").expect(200)).body.data.items;
      expect(recent).toHaveLength(2);
      expect(recent[0]).toMatchObject({ coin: "ETH", side: "short", size: 1, entryPx: 100, exitPx: 105, entryNotional: 100, pnl: -5.2, fees: 0.2, strategyId: a, leaderAddress: LEADER_A });
      expect(recent[0].roiPct).toBeCloseTo(-5.2, 9);
      expect(recent[1]).toMatchObject({ coin: "BTC", side: "long", size: 2, entryPx: 105, exitPx: 120, entryNotional: 210, pnl: 29.6, fees: 0.4 });
      expect(recent[1].roiPct).toBeCloseTo((29.6 / 210) * 100, 9);
      expect(new Date(recent[1].openedAt).getTime()).toBe(t0);
      expect(new Date(recent[1].closedAt).getTime()).toBe(t0 + 2 * MIN);
      const best = (await get("/me/copy/trades?sort=best&limit=5", "alice-token").expect(200)).body.data.items;
      expect(best.map((t: { coin: string }) => t.coin)).toEqual(["BTC"]);
      const worst = (await get("/me/copy/trades?sort=worst&limit=5", "alice-token").expect(200)).body.data.items;
      expect(worst.map((t: { coin: string }) => t.coin)).toEqual(["ETH"]);
      // The id is the opening fill: stable across reads.
      expect((await get("/me/copy/trades", "alice-token").expect(200)).body.data.items[1].id).toBe(recent[1].id);
      // One trade by its id (a share card's lookup); never another person's.
      const one = (await get(`/me/copy/trades?id=${recent[1].id}`, "alice-token").expect(200)).body.data.items;
      expect(one.map((t: { coin: string }) => t.coin)).toEqual(["BTC"]);
      expect((await get(`/me/copy/trades?id=${recent[1].id}`, "bob-token").expect(200)).body.data.items).toEqual([]);
      await get("/me/copy/trades?id=0", "alice-token").expect(400);
      // Another person sees nothing of it, even asking for the copy by id.
      expect((await get(`/me/copy/trades?strategyId=${a}`, "bob-token").expect(200)).body.data.items).toEqual([]);
      expect(bob).toBeGreaterThan(0);
      await get("/me/copy/trades?sort=top", "alice-token").expect(400);
      await get("/me/copy/trades?limit=101", "alice-token").expect(400);
      await get("/me/copy/trades").expect(401);
    });
  });
});
