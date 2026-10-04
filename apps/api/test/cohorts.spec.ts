import type { INestApplication } from "@nestjs/common";
import { cohortMembers, cohortSnapshots, discoveryTraders, kolTraders, traderAnalytics, traderStats } from "@trading-dashboard/shared/database";
import { COHORT_HEADLINE_MIN_COVERAGE, cohortHeadlineReady, discoverySettingsSchema, wireCohortDetailSchema, wireCohortHistorySchema } from "@trading-dashboard/shared/contracts";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type { HlClearinghouseStateResponse } from "../src/hyperliquid/types.js";
import { CohortRepository } from "../src/insights/cohort.repository.js";
import { CohortService, SWEEP_MS } from "../src/insights/cohort.service.js";
import { aggregate, candleInterval, cohortEligible, cohortHistoryReady, COHORT_MAX_PERP_EQUITY, downsample, positionsFrom, walletOf } from "../src/insights/cohorts.js";
import type { DiscoveryService } from "../src/discovery/discovery.service.js";
import { InsightsController } from "../src/insights/insights.controller.js";
import { InsightsRepository } from "../src/insights/insights.repository.js";
import { InsightsService } from "../src/insights/insights.service.js";
import type { SettingsService } from "../src/settings/settings.service.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { testConfig } from "./config-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const state = (equity: number, positions: Array<[string, number, number, number]>): HlClearinghouseStateResponse => ({
  assetPositions: positions.map(([coin, szi, value, upnl]) => ({
    type: "oneWay",
    position: { coin, szi: String(szi), entryPx: "1", positionValue: String(value), unrealizedPnl: String(upnl), marginUsed: "0", leverage: { type: "cross", value: 5 } },
  })) as unknown as HlClearinghouseStateResponse["assetPositions"],
  marginSummary: { accountValue: String(equity), totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "0" },
  crossMarginSummary: { accountValue: String(equity), totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "0" },
  withdrawable: "0",
  time: 0,
});

describe("cohort aggregation (CopyDog's cohorts)", () => {
  it("reads positions and equity across dexes, signed by side", () => {
    const { positions, equity } = positionsFrom([state(1000, [["BTC", 0.5, 30000, 200], ["ETH", -2, 5000, -50], ["SOL", 0, 0, 0]]), state(200, [["xyz:TSLA", 3, 900, 10]])]);
    expect(equity).toBe(1200);
    expect(positions).toEqual([{ coin: "BTC", notional: 30000, upnl: 200 }, { coin: "ETH", notional: -5000, upnl: -50 }, { coin: "xyz:TSLA", notional: 900, upnl: 10 }]);
  });

  it("builds the hero, markets and wallets from fresh snapshots only", () => {
    const now = new Date("2026-09-30T00:00:00Z");
    const base = { pnlAll: 2e6, roiAll: 1.5, displayName: null, avatarUrl: null, verified: false, copyScore: 80 };
    const members = [
      { ...base, address: addr(1), perpEquity: 10_000, fetchedAt: now, positions: [{ coin: "BTC", notional: 30_000, upnl: 300 }, { coin: "ETH", notional: -10_000, upnl: -100 }] },
      { ...base, address: addr(2), perpEquity: 50_000, fetchedAt: now, positions: [{ coin: "BTC", notional: -20_000, upnl: -500 }] },
      { ...base, address: addr(3), perpEquity: 5_000, fetchedAt: new Date(now.getTime() - 5 * 3_600_000), positions: [{ coin: "BTC", notional: 1e9, upnl: 1e9 }] },
      { ...base, address: addr(4), perpEquity: 1_000, fetchedAt: now, positions: [] },
    ];
    const d = aggregate("extremely_profitable", members, new Date(now.getTime() - 3_600_000));
    expect(d).toMatchObject({ memberCount: 4, walletCount: 3 });
    expect(d.hero).toEqual({ upnlProfit: 300, upnlLoss: 600, upnlProfitPct: 33.3, walletsInProfit: 1, walletsInLoss: 1, notionalLong: 30_000, notionalShort: 30_000, longPct: 50 });
    expect(d.markets.map((m) => [m.coin, m.notionalLong, m.notionalShort, m.biasPct, m.tradersLong, m.tradersShort, m.tradersProfit, m.tradersLoss])).toEqual([
      ["BTC", 30_000, 20_000, 60, 1, 1, 1, 1],
      ["ETH", 0, 10_000, 0, 0, 1, 0, 1],
    ]);
    expect(d.wallets.map((w) => w.address)).toEqual([addr(2), addr(1), addr(4)]);
    expect(d.wallets[1]).toMatchObject({ positionValue: 40_000, leverage: 4, sumUpnl: 200, biasPct: 75, topAssets: ["BTC", "ETH"] });
    expect(walletOf(members[3])).toMatchObject({ positionValue: 0, biasPct: null, leverage: 0 });
  });

  it("applies CopyDog's member eligibility: no vaults, no whale above the perp-equity ceiling", () => {
    expect(cohortEligible({ isVault: null, perpEquity: 30_400_000 })).toBe(true); // CopyDog's largest member
    expect(cohortEligible({ isVault: null, perpEquity: null })).toBe(true);
    expect(cohortEligible({ isVault: true, perpEquity: 1 })).toBe(false);
    expect(cohortEligible({ isVault: false, perpEquity: COHORT_MAX_PERP_EQUITY })).toBe(true);
    expect(cohortEligible({ isVault: false, perpEquity: 56_500_000 })).toBe(false); // CopyDog's smallest absent whale
  });

  it("writes a history point only when 95 % of the members and of their perp equity are fresh", () => {
    const now = new Date("2026-10-01T15:45:00Z");
    const since = new Date(now.getTime() - 3_600_000);
    const stale = new Date(now.getTime() - 5 * 3_600_000);
    const members = Array.from({ length: 40 }, () => ({ fetchedAt: now, perpEquity: 1_000_000 }));
    expect(cohortHistoryReady(members, since)).toBe(true);
    // One whale holding most of the equity is stale: 39 of 40 by count, not by equity.
    expect(cohortHistoryReady([...members.slice(1), { fetchedAt: stale, perpEquity: 170_000_000 }], since)).toBe(false);
    // Three of forty stale is under 95 % by count.
    expect(cohortHistoryReady(members.map((m, i) => (i < 3 ? { ...m, fetchedAt: stale } : m)), since)).toBe(false);
    expect(cohortHistoryReady([], since)).toBe(false);
  });

  it("downsamples history and picks candle sizes per window", () => {
    const pts = Array.from({ length: 1000 }, (_, i) => ({ t: new Date(i * 60_000), pctLong: i % 100 }));
    const out = downsample(pts, 100);
    expect(out).toHaveLength(100);
    expect(out.at(-1)).toEqual({ t: pts.at(-1)!.t, pctLong: 99 });
    expect(candleInterval("7d", 7 * 86_400_000).interval).toBe("1h");
    expect(candleInterval("30d", 30 * 86_400_000).interval).toBe("4h");
    expect(candleInterval("all", 20 * 86_400_000).interval).toBe("4h");
    expect(candleInterval("all", 400 * 86_400_000).interval).toBe("1d");
  });
});

describe("cohort job and endpoints (real Postgres)", () => {
  const db = getTestDb();
  const repository = new CohortRepository(db);
  const settingsValue = { ...discoverySettingsSchema.parse({}), cohortMembersPerTier: 2 };
  const settings = { get: vi.fn(async () => settingsValue) } as unknown as SettingsService;
  const info = {
    perpDexs: vi.fn(async () => [null, { name: "xyz" }, { name: "flx" }]),
    clearinghouseState: vi.fn(async (address: string, dex?: string) =>
      dex === "xyz" ? state(100, [["xyz:TSLA", 1, 500, 5]]) : dex ? state(0, []) : state(address === addr(1) ? 10_000 : 2_000, [["BTC", address === addr(1) ? 1 : -1, 20_000, address === addr(1) ? 100 : -40]])),
    candleSnapshot: vi.fn(async () => [{ t: 1, T: 2, s: "BTC", i: "1h", o: "1", c: "84000", h: "1", l: "1", v: "1", n: 1 }]),
  };
  const config = { value: { ...testConfig().value, app: { ...testConfig().value.app, nodeEnv: "development" } } } as ReturnType<typeof testConfig>;
  let service: CohortService;
  // The pool snapshot's percentile, as the trader page shows it (not the
  // stored legacy column, which is 91 for addr(1) in the seed).
  const discovery = { copyScoreMap: vi.fn(async () => new Map([[addr(1), 77]])) };
  const stat = (address: string, pnl: number, accountValue: number, extra: Partial<typeof traderStats.$inferInsert> = {}) => ({
    address, displayName: null, accountValue: String(accountValue), pnlDay: "0", pnlWeek: "0", pnlMonth: "0", pnlAllTime: String(pnl),
    roiDay: "0", roiWeek: "0", roiMonth: "0", roiAllTime: "0.1", volumeDay: "0", volumeWeek: "0", volumeMonth: "1000", volumeAllTime: "1",
    isVault: false, updatedAt: new Date(), ...extra,
  });

  beforeEach(async () => {
    await truncateAll(db);
    vi.clearAllMocks();
    service = new CohortService(config, repository, info as unknown as HyperliquidInfoClient, settings, undefined, discovery as unknown as DiscoveryService);
  });
  afterAll(async () => {
    await closeTestDb();
  });

  async function seed() {
    await db.insert(traderStats).values([
      stat(addr(1), 5e6, 900_000, { displayName: "Whale" }), stat(addr(2), 2e6, 800_000), stat(addr(3), 3e6, 700_000),
      stat(addr(4), -50_000, 600_000), stat(addr(5), -60_000, 500_000, { isVault: true }), stat(addr(6), -2e6, 400_000),
    ]);
    await db.insert(discoveryTraders).values([
      { address: addr(1), poolRank: 1, pnlAll: "4000000", roiAll: "2", copyScore: 91, portfolioAt: new Date(), coinStats: { "xyz:TSLA": { pnl: 1, volume: 1, trades: 1, wins: 1 } } },
      { address: addr(2), poolRank: 2, pnlAll: "1500000", roiAll: "1", portfolioAt: new Date() },
      { address: addr(3), poolRank: 3, pnlAll: "1200000", roiAll: "1", portfolioAt: new Date() },
    ]);
    await db.insert(discoveryTraders).values([
      { address: addr(4), inPool: false, pnlAll: "-50000", roiAll: "-0.1", portfolioAt: new Date() },
      { address: addr(5), inPool: false, pnlAll: "-60000", roiAll: "-0.2", portfolioAt: new Date() },
      { address: addr(6), inPool: false, pnlAll: "-2000000", roiAll: "-0.9", portfolioAt: new Date() },
    ]);
    await db.insert(kolTraders).values({ address: addr(1), displayName: "KOL One", verified: true });
  }

  it("tiers topups by perp PnL even when whole-account PnL disagrees, excluding unknowns", async () => {
    await seed();
    await db.update(traderStats).set({ pnlAllTime: "9000000" }).where(eq(traderStats.address, addr(4)));
    await db.insert(traderStats).values(stat(addr(7), 9e6, 1e6));
    const topups = await repository.leaderboardTopUp("unprofitable", 20, []);
    expect(topups).toEqual([{ address: addr(4), pnlAll: "-50000", roiAll: "-0.1" }]);
    expect((await repository.leaderboardTopUp("extremely_profitable", 20, [])).map(row => row.address)).not.toContain(addr(7));
  });

  it("chooses members per tier from the pool, topped up from the leaderboard", async () => {
    await seed();
    expect(await service.build(2)).toMatchObject({ total: 4, added: 4 });
    const rows = await db.select().from(cohortMembers);
    const by = new Map(rows.map((r) => [r.address, r]));
    expect(by.get(addr(1))).toMatchObject({ tier: "extremely_profitable", source: "pool", rank: 1, dexes: ["xyz"] });
    expect(by.get(addr(2))).toMatchObject({ tier: "extremely_profitable", rank: 2 });
    expect(by.has(addr(3))).toBe(false); // third by account value, cap 2
    expect(by.get(addr(4))).toMatchObject({ tier: "unprofitable", source: "leaderboard", dexes: ["xyz"] });
    expect(by.has(addr(5))).toBe(false); // vault
    expect(by.get(addr(6))).toMatchObject({ tier: "rekt" });
    // Rebuilding keeps snapshots and drops members that left.
    await db.update(cohortMembers).set({ fetchedAt: new Date() }).where(eq(cohortMembers.address, addr(1)));
    await db.delete(traderStats).where(eq(traderStats.address, addr(6)));
    expect(await service.build(2)).toMatchObject({ added: 0, removed: 1 });
    expect((await db.select().from(cohortMembers).where(eq(cohortMembers.address, addr(1))))[0].fetchedAt).not.toBeNull();
  });

  it("leaves out whales above the perp-equity ceiling and vaults, largest perp equity first", async () => {
    const now = new Date();
    const analytics = (address: string, perp: number) => ({ address, source: "hyperliquid" as const, summary: {}, classification: { perpAccountValue: perp },
      coverageFrom: new Date(now.getTime() - 86_400_000), fillCursor: now, fillsRead: 100, truncated: true, computedAt: now });
    await db.insert(traderStats).values([
      stat(addr(20), 96e6, 250e6), stat(addr(21), 44e6, 60e6), stat(addr(22), 73e6, 100e6), stat(addr(23), 50e6, 12e6), stat(addr(24), 3e6, 9e6, { isVault: true }), stat(addr(25), 2e6, 15e6),
    ]);
    await db.insert(discoveryTraders).values([20, 21, 22, 23, 24, 25].map((n, i) => ({ address: addr(n), poolRank: i + 1, pnlAll: "2000000", roiAll: "1", portfolioAt: now })));
    await db.insert(traderAnalytics).values([
      analytics(addr(20), 170e6), // whale: absent from CopyDog's members
      analytics(addr(21), 30e6), // CopyDog's largest member
      analytics(addr(22), 0), // spot-heavy: large account, no perp equity
      analytics(addr(23), 10e6),
    ]);
    // addr(25)'s perp equity is not known yet: after every known one, never
    // ranked by its whole account's value (audit A4).
    await service.build(3);
    expect((await repository.membersOf("extremely_profitable")).map((m) => m.address)).toEqual([addr(21), addr(23), addr(22)]);
    await service.build(10);
    expect((await repository.membersOf("extremely_profitable")).map((m) => m.address)).toEqual([addr(21), addr(23), addr(22), addr(25)]);
    // A cohort snapshot's perp equity is newer than the ledger's: addr(21) grew past the ceiling.
    await db.update(cohortMembers).set({ perpEquity: "60000000" }).where(eq(cohortMembers.address, addr(21)));
    await service.build(10);
    expect((await repository.membersOf("extremely_profitable")).map((m) => m.address)).toEqual([addr(23), addr(22), addr(25)]);
  });

  it("refreshes positions on known dexes, sweeps every dex daily, writes history and serves the tier", async () => {
    await seed();
    await service.build(2);
    const [first] = await repository.nextDue(1, new Date());
    expect(first.address).toBe(addr(1)); // never attempted, extremely profitable, rank 1
    // The first read sweeps every dex.
    expect(await service.refreshOne(first)).toEqual({ weight: 6, ok: true });
    expect(info.clearinghouseState.mock.calls.map((c) => c[1])).toEqual([undefined, "xyz", "flx"]);
    await service.refreshOne((await repository.nextDue(1, new Date()))[0]);
    const [row1] = await db.select().from(cohortMembers).where(eq(cohortMembers.address, addr(1)));
    expect(row1.positions).toEqual([{ coin: "BTC", notional: 20_000, upnl: 100 }, { coin: "xyz:TSLA", notional: 500, upnl: 5 }]);
    expect(Number(row1.perpEquity)).toBe(10_100);
    // In between: the main dex and the dexes it holds or traded …
    info.clearinghouseState.mockClear();
    expect((await service.refreshOne(row1, Date.now() + 60_000)).weight).toBe(4);
    expect(info.clearinghouseState.mock.calls.map((c) => c[1])).toEqual([undefined, "xyz"]);
    // … and a day later every dex again.
    expect((await service.refreshOne(row1, Date.now() + SWEEP_MS + 1)).weight).toBe(6);

    expect(await service.writeSnapshots(15 * 60_000)).toBe(1); // only the tier with fresh wallets
    expect(await service.writeSnapshots(15 * 60_000)).toBe(0); // not due again yet
    const detail = await service.detail("extremely_profitable");
    expect(detail).toMatchObject({ memberCount: 2, walletCount: 2 });
    expect(detail.wallets[0]).toMatchObject({ address: addr(1), displayName: "KOL One", verified: true, copyScore: 77, totalPnl: 4_000_000 });
    expect(detail.wallets[1]).toMatchObject({ address: addr(2), copyScore: null });
    expect(detail.hero).toMatchObject({ notionalLong: 21_000, notionalShort: 20_000 }); // both swept: TSLA on xyz each
    const history = await service.history("extremely_profitable", "7d");
    expect(history.series).toHaveLength(1);
    expect(history.btc).toEqual([[1, 84000]]);
    // Hyperliquid busy: the last candles read are still drawn.
    service.candleCache.clear();
    info.candleSnapshot.mockRejectedValueOnce(new Error("hyperliquid_quota_exhausted"));
    expect((await service.history("extremely_profitable", "7d")).btc).toEqual([]); // t=1 is before the 7-day window
    service.candleCache.clear();
    const recent = Date.now() - 3_600_000;
    info.candleSnapshot.mockResolvedValueOnce([{ t: recent, T: recent + 1, s: "BTC", i: "1h", o: "1", c: "85000", h: "1", l: "1", v: "1", n: 1 }]);
    expect((await service.history("extremely_profitable", "7d")).btc).toEqual([[recent, 85000]]);
    service.candleCache.clear();
    info.candleSnapshot.mockRejectedValueOnce(new Error("hyperliquid_quota_exhausted"));
    expect((await service.history("extremely_profitable", "7d")).btc).toEqual([[recent, 85000]]);
    const [snap] = await db.select().from(cohortSnapshots);
    expect(snap).toMatchObject({ tier: "extremely_profitable", walletCount: 2, walletsInProfit: 1, walletsInLoss: 1 });
  });

  it("persists the selected membership with each snapshot across rank and member changes", async () => {
    await seed();
    await service.build(2);
    for (const member of await repository.membersOf("extremely_profitable")) await service.refreshOne(member);
    const now = new Date();
    await service.writeSnapshots(60_000, now);
    const [first] = await db.select().from(cohortSnapshots);
    expect(first).toMatchObject({ memberAddresses: [addr(1), addr(2)], membershipVersion: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await db.update(cohortMembers).set({ rank: 10 }).where(eq(cohortMembers.address, addr(1)));
    await service.writeSnapshots(60_000, new Date(now.getTime() + 60_000));
    await db.delete(cohortMembers).where(eq(cohortMembers.address, addr(2)));
    await service.writeSnapshots(60_000, new Date(now.getTime() + 120_000));
    const snapshots = await db.select().from(cohortSnapshots).orderBy(cohortSnapshots.ts);
    expect(snapshots[0]).toMatchObject({ memberAddresses: [addr(1), addr(2)] });
    expect(snapshots[1]).toMatchObject({ membershipVersion: snapshots[0].membershipVersion });
    expect(snapshots[2]).toMatchObject({ memberAddresses: [addr(1)] });
    const history = await service.history("extremely_profitable", "all");
    expect(history.series).toEqual([
      expect.objectContaining({ membershipVersion: expect.any(String), membershipChanged: false }),
      expect.objectContaining({ membershipVersion: expect.any(String), membershipChanged: false }),
      expect.objectContaining({ membershipVersion: expect.any(String), membershipChanged: true }),
    ]);
  });

  it("withholds the headline until most of the tier is fresh: no history point from a fraction of the members (review 52)", async () => {
    const now = new Date("2026-09-30T00:00:00Z");
    const fresh = new Date(now.getTime() - 60_000);
    const stale = new Date(now.getTime() - 5 * 3_600_000);
    const member = (i: number, fetchedAt: Date | null, notional: number) => ({
      address: addr(100 + i), pnlAll: 2e6, roiAll: 1.5, displayName: null, avatarUrl: null, verified: false, copyScore: 80,
      perpEquity: 10_000, fetchedAt, positions: [{ coin: "BTC", notional, upnl: 0 }],
    });
    // Ten members; the two read so far are short, the tier as a whole is long.
    const partial = [...Array.from({ length: 2 }, (_, i) => member(i, fresh, -50_000)), ...Array.from({ length: 8 }, (_, i) => member(2 + i, i < 4 ? stale : null, 40_000))];
    const early = aggregate("extremely_profitable", partial, new Date(now.getTime() - 3_600_000));
    expect(early).toMatchObject({ memberCount: 10, walletCount: 2, headlineReady: false });
    // What the page would have shown: 0 % long.
    expect(early.hero.longPct).toBe(0);
    expect(cohortHeadlineReady(7, 10)).toBe(false);
    expect(cohortHeadlineReady(8, 10)).toBe(true);
    expect(cohortHeadlineReady(0, 0)).toBe(false);
    expect(COHORT_HEADLINE_MIN_COVERAGE).toBe(0.8);
    const full = aggregate("extremely_profitable", partial.map((m) => ({ ...m, fetchedAt: fresh })), new Date(now.getTime() - 3_600_000));
    expect(full).toMatchObject({ walletCount: 10, headlineReady: true });
    expect(full.hero.longPct).toBeCloseTo(76.2, 1);

    // The worker: no history row while the tier is 1 of 2 fresh; one once both are.
    await seed();
    await service.build(2);
    await service.refreshOne((await repository.nextDue(1, new Date()))[0]);
    // (1 of 2 fresh.)
    expect(await service.writeSnapshots(15 * 60_000)).toBe(0);
    expect(await db.select().from(cohortSnapshots)).toHaveLength(0);
    await service.refreshOne((await repository.nextDue(1, new Date()))[0]);
    expect(await service.detail("extremely_profitable")).toMatchObject({ walletCount: 2, headlineReady: true });
    expect(await service.writeSnapshots(15 * 60_000)).toBe(1);

    // A row written before this rule, from 33 of 150 members, is not drawn on the chart.
    await db.insert(cohortSnapshots).values({ tier: "extremely_profitable", ts: new Date(Date.now() - 3_600_000), memberCount: 150, walletCount: 33,
      notionalLong: "6.9", notionalShort: "93.1", longPct: "6.9", upnlProfit: "0", upnlLoss: "0", walletsInProfit: 0, walletsInLoss: 0 });
    // Nor one from 140 of 150 (93 %): under the history's 95 %.
    await db.insert(cohortSnapshots).values({ tier: "extremely_profitable", ts: new Date(Date.now() - 1_800_000), memberCount: 150, walletCount: 140,
      notionalLong: "71.6", notionalShort: "28.4", longPct: "71.6", upnlProfit: "0", upnlLoss: "0", walletsInProfit: 0, walletsInLoss: 0 });
    const history = await service.history("extremely_profitable", "7d");
    expect(history.series).toHaveLength(1);
    expect(history.series[0]!.pctLong).not.toBe(6.9);
    expect(history.series[0]!.pctLong).not.toBe(71.6);
  });

  it("preserves legacy unknown identity and hidden membership changes when capping history", async () => {
    const base = { tier: "extremely_profitable", memberCount: 1, walletCount: 1,
      notionalLong: "100", notionalShort: "100", upnlProfit: "0", upnlLoss: "0", walletsInProfit: 0, walletsInLoss: 0 };
    const start = Date.now() - 1_000_000;
    await db.insert(cohortSnapshots).values(Array.from({ length: 801 }, (_, i) => ({
      ...base, ts: new Date(start + i * 1000), longPct: i === 3 ? "100" : "25",
      // A brief A→B→A between sampled points must not be averaged or bridged.
      membershipVersion: i < 2 ? null : (i === 3 ? "b" : "a").repeat(64),
      memberAddresses: i < 2 ? null : [addr(i === 3 ? 2 : 1)],
    })));
    const history = await service.history("extremely_profitable", "all");
    expect(history.series).toHaveLength(400);
    expect(history.series[0]).toMatchObject({ membershipVersion: null, membershipChanged: false });
    expect(history.series[1]).toMatchObject({ membershipVersion: "a".repeat(64), membershipChanged: true });
    expect(history.series[2]).toMatchObject({ membershipVersion: "a".repeat(64), membershipChanged: true });
    expect(history.series.every(point => point.pctLong === 25)).toBe(true);
    expect(history.series.at(-1)?.t.getTime()).toBe(start + 800_000);
    expect(wireCohortHistorySchema.parse(JSON.parse(JSON.stringify(history))).series[1]).toMatchObject({ membershipChanged: true, membershipVersion: "a".repeat(64) });
    expect((await db.select().from(cohortSnapshots).orderBy(cohortSnapshots.ts))[0]).toMatchObject({ membershipVersion: null, memberAddresses: null });
  });

  it("keeps the last snapshot when a refresh fails", async () => {
    await seed();
    await service.build(2);
    const [m] = await repository.nextDue(1, new Date());
    info.clearinghouseState.mockRejectedValueOnce(new Error("Hyperliquid info request failed: 429"));
    expect((await service.refreshOne(m)).ok).toBe(false);
    const [row] = await db.select().from(cohortMembers).where(eq(cohortMembers.address, m.address));
    expect(row.lastError).toMatch(/429/);
    expect(row.attemptedAt).not.toBeNull();
    expect((await repository.nextDue(5, new Date(Date.now() - 60_000))).map((r) => r.address)).not.toContain(m.address);
  });

  describe("HTTP", () => {
    let app: INestApplication;
    beforeAll(async () => {
      ({ app } = await createAuthedApp({
        db,
        privy: stubPrivy({}),
        controllers: [InsightsController],
        providers: [InsightsService, InsightsRepository, { provide: CohortService, useFactory: () => service }],
      }));
    });
    afterAll(async () => {
      await app.close();
    });

    it("validates the tier and window and serves the contract", async () => {
      await seed();
      await service.build(2);
      const server = app.getHttpServer();
      await request(server).get("/insights/cohorts/whales").expect(400);
      await request(server).get("/insights/cohorts/rekt/history?window=1y").expect(400);
      const detail = wireCohortDetailSchema.parse((await request(server).get("/insights/cohorts/rekt").expect(200)).body.data);
      expect(detail).toMatchObject({ tier: "rekt", walletCount: 0, wallets: [], updatedAt: null });
      const history = wireCohortHistorySchema.parse((await request(server).get("/insights/cohorts/rekt/history").expect(200)).body.data);
      expect(history).toEqual({ tier: "rekt", window: "all", series: [], btc: [] });
    });
  });
});
