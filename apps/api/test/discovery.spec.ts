import { SettingsRepository } from "../src/settings/settings.repository.js";
import { readFileSync } from "node:fs";
import type { INestApplication } from "@nestjs/common";
import { adminAuditLogs, discoveryTraders, kolAvatars, kolTraders, traderAnalytics, traderStats, traderTrades } from "@trading-dashboard/shared/database";
import { wireBoardSchema, wireCoinBoardSchema, wireCoinIndexSchema, wireCopyScoreSchema, wireHomeBoardsSchema, wireDiscoverSearchSchema } from "@trading-dashboard/shared/contracts";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { copyScore } from "../src/analytics/copy-score.js";
import { AuthService } from "../src/common/auth/auth.service.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { buildBoard, toCandidate, boardKind, effectiveSort, effectiveWindow } from "../src/discovery/boards.js";
import { isStockCoin, portfolioNumbers } from "../src/discovery/discovery-figures.js";
import { AdminKolController, CopyScoreController, DiscoveryController } from "../src/discovery/discovery.controller.js";
import { DiscoveryPoolService } from "../src/discovery/discovery-pool.service.js";
import { DiscoveryRepository } from "../src/discovery/discovery.repository.js";
import { DiscoveryService } from "../src/discovery/discovery.service.js";
import { parseKolCsv } from "../src/discovery/kol-csv.js";
import { KolRepository } from "../src/discovery/kol.repository.js";
import { KolService } from "../src/discovery/kol.service.js";
import { DEFAULT_KOL_FILE } from "../src/discovery/seed-kols.js";
import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type { HlPortfolioResponse } from "../src/hyperliquid/types.js";
import { SettingsService } from "../src/settings/settings.service.js";
import type { LeaderboardIngestService } from "../src/traders/leaderboard-ingest.service.js";
import type { TradeAnalyticsService } from "../src/traders/trade-analytics.service.js";
import { TradersService } from "../src/traders/traders.service.js";
import { insertUser } from "./admin-test-utils.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { testConfig } from "./config-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const PORTFOLIO = fixture("portfolio.json") as HlPortfolioResponse;
const D70C = fixture("portfolio-copydog-d70c.json") as { portfolio: HlPortfolioResponse; copydog: { roi: number; sharpe: number; maxDrawdown: number; return_sample_count: number } };
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

describe("copy score (CopyDog v5, fitted)", () => {
  it("matches CopyDog's scores on its own reference set", () => {
    const ref = fixture("copydog-copy-score-2026-09-30.json") as { rows: number[][] };
    const errors = ref.rows.map(([score, roi, pnl, sharpe, maxDrawdown, returnSamples, spanDays, accountValue]) =>
      Math.abs(copyScore({ roi, pnl, sharpe, maxDrawdown, returnSamples, spanDays, accountValue })! - score)).sort((a, b) => a - b);
    const within = (k: number) => errors.filter((e) => e <= k).length / errors.length;
    expect(errors.length).toBeGreaterThanOrEqual(500);
    expect(errors[Math.floor(errors.length / 2)]).toBeLessThanOrEqual(8);
    expect(within(10)).toBeGreaterThanOrEqual(0.72);
    expect(within(20)).toBeGreaterThanOrEqual(0.93);
  });

  it("ranks a long, steady winner high and a young or losing record low; never above 98", () => {
    const strong = copyScore({ roi: 8.94, pnl: 5_937_391, sharpe: 1.5874, maxDrawdown: 0.264, returnSamples: 91, spanDays: 622.3, accountValue: 2_515_015 });
    const young = copyScore({ roi: 1.28, pnl: 5_591_970, sharpe: 2.43, maxDrawdown: 0.237, returnSamples: 40, spanDays: 54.95, accountValue: 12_984_695 });
    const loser = copyScore({ roi: -0.75, pnl: -1_004_185, sharpe: -2.01, maxDrawdown: 1, returnSamples: 47, spanDays: 118, accountValue: 1_115 });
    expect(strong).toBeGreaterThanOrEqual(92);
    expect(strong).toBeLessThanOrEqual(98);
    expect(young).toBeLessThan(75);
    expect(loser).toBeLessThan(20);
    expect(copyScore({ roi: 1, pnl: 1, sharpe: null, maxDrawdown: null, returnSamples: 0, spanDays: 0, accountValue: 1 })).toBeNull();
    // A holder with no perp PnL is not scored, however large.
    expect(copyScore({ roi: 0, pnl: 0, sharpe: 0.4, maxDrawdown: 0.1, returnSamples: 60, spanDays: 600, accountValue: 4e7 })).toBeNull();
    expect(copyScore({ roi: 1e6, pnl: 1e12, sharpe: 99, maxDrawdown: 0, returnSamples: 1e4, spanDays: 1e4, accountValue: 1e12 })).toBe(98);
  });

  it("computes the inputs from Hyperliquid's portfolio as CopyDog does (0xd70c…)", () => {
    const n = portfolioNumbers(D70C.portfolio);
    expect(n.roiAll!).toBeCloseTo(D70C.copydog.roi, 1);
    expect(n.sharpe!).toBeCloseTo(D70C.copydog.sharpe, 1);
    expect(n.maxDrawdown!).toBeCloseTo(D70C.copydog.maxDrawdown, 2);
    expect(n.returnSamples).toBe(D70C.copydog.return_sample_count);
  });
});

describe("KOL CSV and board rules", () => {
  it("parses handles, quotes and bad rows; later rows win", () => {
    const csv = [
      "address,display_name,x_handle,verified,sort_order",
      `${addr(1).toUpperCase().replace("0X", "0x")},"Doe, Jane",https://x.com/jane_doe/,true,2`,
      `${addr(2)},,@bob,no,`,
      "0x123,Bad,,true,1",
      `${addr(2)},Bob,bob,yes,5`,
    ].join("\n");
    const { rows, errors } = parseKolCsv(csv);
    expect(errors).toEqual([expect.objectContaining({ line: 4 })]);
    expect(rows.map((r) => r.value)).toEqual([
      expect.objectContaining({ address: addr(1), displayName: "Doe, Jane", xHandle: "jane_doe", verified: true, sortOrder: 2 }),
      expect.objectContaining({ address: addr(2), displayName: "Bob", xHandle: "bob", verified: true, sortOrder: 5 }),
    ]);
    expect(() => parseKolCsv("name\nx")).toThrow(/address/);
  });

  it("follows CopyDog's board rules for windows, sorts and markets", () => {
    expect(isStockCoin("xyz:TSLA")).toBe(true);
    expect(isStockCoin("km:US500")).toBe(true);
    expect(isStockCoin("hyna:BTC")).toBe(false);
    expect(isStockCoin("BTC")).toBe(false);
    expect(boardKind("xyz:GOLD")).toBe("coin");
    expect(effectiveWindow({ market: "crypto", board: "BTC", window: "30d" })).toBe("all");
    expect(effectiveWindow({ market: "crypto", board: "top100", window: "30d" })).toBe("30d");
    expect(effectiveWindow({ market: "stocks", board: "top100", window: "30d" })).toBe("all");
    expect(effectiveSort({ market: "crypto", board: "BTC", sort: "accountValue" }, "all")).toBe("pnl");
    expect(effectiveSort({ market: "crypto", board: "top100", sort: "copyScore" }, "30d")).toBe("pnl");
    expect(effectiveSort({ market: "crypto", board: "kol", sort: "accountValue" }, "all")).toBe("accountValue");
  });
});

describe("discovery pool, boards and KOL registry (real Postgres)", () => {
  const db = getTestDb();
  const repository = new DiscoveryRepository(db);
  const kols = new KolService(new KolRepository(db), new UnitOfWork(db));
  const discoverySettings = { candidatePoolSize: 3, poolWeightPerMinute: 100, homeMarkets: ["BTC", "xyz:TSLA"], cryptoBoards: ["BTC"], stockBoards: ["xyz:TSLA"] };
  const settings = { get: vi.fn(async () => discoverySettings), getAll: vi.fn(async () => ({ discovery: discoverySettings })), acknowledgeDiscovery: vi.fn() } as unknown as SettingsService;
  const ingest = { lastImportAt: vi.fn(async () => new Date("2026-09-30T00:00:00Z")) } as unknown as LeaderboardIngestService;
  const info = { portfolio: vi.fn(async () => PORTFOLIO) };
  /** Stands in for trade analytics: writes a small ledger and a cost log. */
  const lastLog = new Map<string, Array<{ kind: string; weight: number; calls: number }>>();
  let tradeSeq = 1n;
  const analytics = {
    lastLog,
    compute: vi.fn(async (address: string) => {
      const trade = (coin: string, net: number, ntl: number, exit: string | null, last: string) => ({
        address, openTid: tradeSeq++, coin, side: "long" as const, entryTime: new Date("2026-09-01T00:00:00Z"),
        exitTime: exit ? new Date(exit) : null, sortTime: new Date(exit ?? "2026-09-01T00:00:00Z"), position: exit ? "0" : "1",
        entrySz: "1", entryNtl: String(ntl), exitSz: "1", exitNtl: String(ntl), realizedPnl: String(net + 1), fees: "1",
        netPnl: String(net), fills: 2, lastFillTime: new Date(last),
      });
      await db.insert(traderTrades).values([
        trade("BTC", 1000, 50_000, "2026-09-10T00:00:00Z", "2026-09-10T00:00:00Z"),
        trade("BTC", -200, 30_000, "2026-09-12T00:00:00Z", "2026-09-12T00:00:00Z"),
        trade("xyz:TSLA", 300, 10_000, "2026-09-20T00:00:00Z", "2026-09-20T00:00:00Z"),
        trade("ETH", 0, 5_000, null, "2026-09-25T00:00:00Z"),
      ]);
      await db.insert(traderAnalytics).values({ address, source: "hyperliquid", summary: {}, classification: { style: "swing" },
        coverageFrom: new Date("2026-08-01T00:00:00Z"), computedAt: new Date() }).onConflictDoNothing();
      lastLog.set(address, [...(lastLog.get(address) ?? []), { kind: "cold", weight: 180, calls: 5 }]);
    }),
  };
  const pool = new DiscoveryPoolService(
    testConfig(), repository, info as unknown as HyperliquidInfoClient, analytics as unknown as TradeAnalyticsService, ingest, settings,
  );

  const stat = (address: string, pnlAllTime: number, extra: Partial<typeof traderStats.$inferInsert> = {}) => ({
    address, displayName: null, accountValue: "250000", pnlDay: "0", pnlWeek: "0", pnlMonth: "0", pnlAllTime: String(pnlAllTime),
    roiDay: "0", roiWeek: "0", roiMonth: "0", roiAllTime: "0", volumeDay: "0", volumeWeek: "0", volumeMonth: "1000", volumeAllTime: "1",
    isVault: false, updatedAt: new Date(), ...extra,
  });

  beforeEach(async () => {
    await truncateAll(db);
    info.portfolio.mockClear();
    analytics.compute.mockClear();
    lastLog.clear();
  });
  afterAll(async () => {
    await truncateAll(db);
    await closeTestDb();
  });

  it("seeds the KOL registry from the shipped file through the import path, idempotently", async () => {
    const csv = readFileSync(DEFAULT_KOL_FILE, "utf8");
    const first = await kols.importCsv(csv, false, null);
    expect(first).toMatchObject({ inserted: 168, updated: 0, removed: 0, errors: [] });
    const second = await kols.importCsv(csv, false, null);
    expect(second).toMatchObject({ inserted: 0, updated: 168 });
    const list = await kols.list();
    expect(list[0]).toMatchObject({ address: "0x77375a8c9d13bf79afb2a87f1b0ac1dfd5f5bf66", displayName: "mk4", xHandle: "mk4_lul", verified: true, sortOrder: 1, avatarUrl: null });
    const audits = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.event, "kol.import"));
    expect(audits).toHaveLength(2);
    expect(audits[0].actorKind).toBe("system");
    // replace removes what the file doesn't list, but never on a file with errors
    const one = `address,display_name\n${list[0].address},mk4`;
    expect(await kols.importCsv(`${one}\n0xbad,x`, true, null)).toMatchObject({ removed: 0 });
    expect(await kols.importCsv(one, true, null)).toMatchObject({ removed: 167 });
  });

  it("acknowledges a paused policy only after membership is built, without upstream refresh", async () => {
    const actualSettings = new SettingsService(new SettingsRepository(db), new UnitOfWork(db));
    const saved = await actualSettings.patch({ discovery: { candidatePoolSize: 50, poolWeightPerMinute: 0 } }, null);
    const fresh = new DiscoveryPoolService(testConfig(), repository, info as never, analytics as never, ingest, actualSettings);
    await fresh.tick();
    expect(actualSettings.appliedDiscovery()).toEqual([]);
    await db.insert(traderStats).values([stat(addr(1), 900)]);
    await fresh.tick();
    expect(actualSettings.appliedDiscovery()).toMatchObject([{ consumer: "pool", revision: saved.revisions.discovery, poolWeightPerMinute: 0 }]);
    expect(await db.select().from(discoveryTraders)).toHaveLength(1);
    expect(info.portfolio).not.toHaveBeenCalled();
  });

  it("applies a changed pool size on the next tick without waiting for the periodic rebuild", async () => {
    const fresh = new DiscoveryPoolService(testConfig(), repository, info as never, analytics as never, ingest, settings);
    await db.insert(traderStats).values([stat(addr(1), 900), stat(addr(2), 800)]);
    const now = Date.now();
    await fresh.buildIfDue(1, now);
    expect(await fresh.buildIfDue(2, now + 1000)).toBe(true);
    expect(await db.select().from(discoveryTraders)).toHaveLength(2);
  });

  it("builds the pool from the leaderboard's active top N plus KOLs, then prunes", async () => {
    await db.insert(traderStats).values([
      stat(addr(1), 900), stat(addr(2), 800), stat(addr(3), 700), stat(addr(4), 600),
      stat(addr(5), 5000, { isVault: true }), stat(addr(6), 4000, { volumeMonth: "0" }),
    ]);
    await kols.upsert({ address: addr(9), displayName: "Nine", xHandle: "nine", verified: true }, null);
    await kols.upsert({ address: addr(2), displayName: "Two" }, null);
    expect(await pool.build(3)).toMatchObject({ added: 4, removed: 0, total: 4 });
    const rows = await db.select().from(discoveryTraders).orderBy(sql`pool_rank nulls last`);
    expect(rows.map((r) => [r.address, r.poolRank])).toEqual([[addr(1), 1], [addr(2), 2], [addr(3), 3], [addr(9), null]]);
    await db.update(traderStats).set({ volumeMonth: "0" }).where(eq(traderStats.address, addr(3)));
    await kols.remove(addr(9), null);
    expect(await pool.build(3)).toMatchObject({ added: 1, removed: 2 });
    expect((await db.select({ a: discoveryTraders.address }).from(discoveryTraders)).map((r) => r.a).sort()).toEqual([addr(1), addr(2), addr(4)]);
  });

  it("gives new rows their portfolio first, then refreshes the trade ledger, within the minute's allowance", async () => {
    await db.insert(traderStats).values([stat(addr(1), 900), stat(addr(2), 800), stat(addr(3), 700)]);
    await pool.build(3);
    await pool.tick(Date.now());
    // A fresh tick has a sliver of allowance: one portfolio-only refresh (20).
    expect(info.portfolio).toHaveBeenCalledTimes(1);
    expect(analytics.compute).not.toHaveBeenCalled();
    let [row] = await db.select().from(discoveryTraders).where(eq(discoveryTraders.address, addr(1)));
    expect(row.portfolioAt).not.toBeNull();
    expect(row.tradesAt).toBeNull();
    expect(row.copyScore).toEqual(expect.any(Number));
    expect(await repository.nextUnseen(3)).toEqual([addr(2), addr(3)]);

    await pool.refreshOne(addr(1));
    expect(analytics.compute).toHaveBeenCalledWith(addr(1), false, expect.objectContaining({ funding: false }));
    expect(pool.log.at(-1)).toMatchObject({ address: addr(1), kind: "cold", weight: 200, ok: true });
    [row] = await db.select().from(discoveryTraders).where(eq(discoveryTraders.address, addr(1)));
    expect(Number(row.pnlAll)).toBeCloseTo(407153.71, 1);
    expect(row.sparkline.length).toBeGreaterThan(10);
    expect(row.sparkline.at(-1)).toBeCloseTo(407153.71, 1);
    expect(row.topCoins).toEqual(["BTC", "xyz:TSLA", "ETH"]);
    expect(row.style).toBe("swing");
    expect(row.lastTradeAt?.toISOString()).toBe("2026-09-25T00:00:00.000Z");
    expect(row.coinStats.BTC).toEqual({ pnl: 800, volume: 80_000, trades: 2, wins: 1 });
    expect(row.coinStats.ETH).toEqual({ pnl: 0, volume: 5_000, trades: 0, wins: 0 });
    // Full refreshes: no ledger first; a row attempted within the backoff waits.
    expect((await repository.nextBatch(3, 15 * 60_000)).map((q) => q.address)).toEqual([addr(2), addr(3)]);
    expect((await repository.nextBatch(3, 0, new Date(Date.now() + 1000))).map((q) => q.address)).toEqual([addr(2), addr(3), addr(1)]);
  });

  it("keeps the previous figures and records the error when a refresh fails", async () => {
    await db.insert(traderStats).values([stat(addr(1), 900)]);
    await pool.build(1);
    await pool.refreshOne(addr(1));
    info.portfolio.mockRejectedValueOnce(new Error("Hyperliquid info request failed: 429"));
    const result = await pool.refreshOne(addr(1));
    expect(result.ok).toBe(false);
    const [row] = await db.select().from(discoveryTraders);
    expect(row.lastError).toMatch(/429/);
    expect(row.copyScore).toEqual(expect.any(Number));
  });

  describe("HTTP", () => {
    let app: INestApplication;
    let auth: AuthService;
    const privy = stubPrivy({ "admin-token": { privyUserId: "did:privy:admin" }, "user-token": { privyUserId: "did:privy:user" } });
    const traders = { rawPortfolio: vi.fn(async () => D70C.portfolio) };

    beforeAll(async () => {
      ({ app, auth } = await createAuthedApp({
        db,
        privy,
        controllers: [DiscoveryController, CopyScoreController, AdminKolController],
        providers: [DiscoveryRepository, DiscoveryService, KolRepository, KolService, { provide: TradersService, useValue: traders }],
      }));
    });
    afterAll(async () => {
      await app.close();
    });
    beforeEach(async () => {
      auth.clearCache();
      await insertUser(db, { privyUserId: "did:privy:admin", role: "admin" });
      await insertUser(db, { privyUserId: "did:privy:user" });
    });

    async function seedPool() {
      const row = (n: number, figures: Partial<typeof discoveryTraders.$inferInsert>) => ({
        address: addr(n), poolRank: n, portfolioAt: new Date(), accountValue: "1000", sparkline: [0, 1, 2, 3], sparkline30d: [0, 1], ...figures,
      });
      await db.insert(traderStats).values([stat(addr(1), 1), stat(addr(2), 1), stat(addr(3), 1), stat(addr(4), 1, { accountValue: "0" })]);
      await db.insert(discoveryTraders).values([
        row(1, { copyScore: 90, pnlAll: "100", roiAll: "1", pnl30d: "50", roi30d: "0.5", style: "swing", topCoins: ["BTC"],
          coinStats: { BTC: { pnl: 70, volume: 700, trades: 3, wins: 2 } } }),
        row(2, { copyScore: 60, pnlAll: "900", roiAll: "0.2", pnl30d: "-5", roi30d: "-0.1", style: "intraday", topCoins: ["xyz:TSLA", "BTC"],
          coinStats: { BTC: { pnl: 300, volume: 1000, trades: 1, wins: 1 }, "xyz:TSLA": { pnl: 40, volume: 400, trades: 2, wins: 1 }, "xyz:GOLD": { pnl: -10, volume: 100, trades: 1, wins: 0 } } }),
        row(3, { copyScore: null, pnlAll: "5", roiAll: "0.01", portfolioAt: null }),
        row(4, { copyScore: 99, pnlAll: "1", roiAll: "9" }),
      ]);
      await kols.upsert({ address: addr(2), displayName: "KOL Two", xHandle: "two", verified: true }, null);
    }

    it("serves CopyDog's boards from the pool: top 100, coin, stocks, KOL, style and window", async () => {
      await seedPool();
      const get = async (query: string) => {
        const res = await request(app.getHttpServer()).get(`/discover/boards?${query}`).expect(200);
        return wireBoardSchema.parse(res.body.data);
      };
      const top = await get("");
      expect(top.items.map((t) => t.address)).toEqual([addr(1), addr(2)]); // no figures / no account value left out
      expect(top).toMatchObject({ sort: "copyScore", window: "all", pool: { total: 4, ready: 3, tradesReady: 0 } });
      // No cached avatar yet → null (the web draws its generated one) …
      expect(top.items[1]).toMatchObject({ displayName: "KOL Two", kol: true, verified: true, avatarUrl: null, pnl: 900 });
      // … and the api's own versioned URL once the drip job has cached it.
      await db.insert(kolAvatars).values({ address: addr(2), source: "x:two", bytes: Buffer.from([0xff, 0xd8, 0xff]), contentType: "image/jpeg", etag: '"abcdefghijklmnop"', fetchedAt: new Date() });
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000); // past the 30 s pool snapshot
      expect((await get("")).items[1].avatarUrl).toBe(`/kols/${addr(2)}/avatar?v=abcdefghijkl`);
      clock.mockRestore();
      const month = await get("sort=roi&window=30d");
      expect(month.items.map((t) => t.roi)).toEqual([0.5, -0.1]);
      expect(month.items[0].sparkline).toEqual([0, 1]);
      const btc = await get("board=BTC&sort=accountValue");
      expect(btc).toMatchObject({ coin: "BTC", sort: "pnl", window: "all" });
      expect(btc.items.map((t) => [t.address, t.pnl, t.roi])).toEqual([[addr(2), 300, 0.3], [addr(1), 70, 0.1]]);
      const stocks = await get("market=stocks&sort=pnl");
      expect(stocks.items.map((t) => [t.address, t.pnl, t.roi])).toEqual([[addr(2), 30, 0.06]]);
      const kol = await get("board=kol");
      expect(kol.items.map((t) => t.address)).toEqual([addr(2)]);
      const swing = await get("style=swing");
      expect(swing.items.map((t) => t.address)).toEqual([addr(1)]);
      await request(app.getHttpServer()).get("/discover/boards?board=../x").expect(400);
      await request(app.getHttpServer()).get("/discover/boards?sort=volume").expect(400);
    });

    it("serves every home row in one read", async () => {
      await seedPool();
      const res = await request(app.getHttpServer()).get("/discover/home").expect(200);
      const home = wireHomeBoardsSchema.parse(res.body.data);
      expect(home.featured.map((t) => t.address)).toEqual([addr(2)]);
      expect(home.crypto.map((t) => t.address)).toEqual([addr(1), addr(2)]);
      expect(home.stocks.map((t) => t.address)).toEqual([addr(2)]);
      // One row per default home market, in order, each by that coin's PnL,
      // listing only traders who made money there (GOLD's −10 is left out).
      expect(home.markets.map((m) => m.coin)).toEqual(["BTC", "ETH", "SOL", "HYPE", "xyz:SP500", "xyz:GOLD", "xyz:NVDA", "xyz:TSLA"]);
      expect(home.markets.filter((m) => m.items.length > 0).map((m) => [m.coin, m.market, m.items.map((t) => t.pnl)]))
        .toEqual([["BTC", "crypto", [300, 70]], ["xyz:TSLA", "stocks", [40]]]);
      // Calculator: named traders (KOLs first) with ROI > 5%; addr(1) has no name.
      expect(home.calculator.map((t) => t.address)).toEqual([addr(2)]);
    });

    it("reports freshness from displayed performance, using trade analysis for coin boards", async () => {
      await seedPool();
      const old = new Date("2026-09-01T00:00:00Z");
      const recent = new Date("2026-09-29T00:00:00Z");
      await db.update(discoveryTraders).set({ portfolioAt: recent, tradesAt: old }).where(eq(discoveryTraders.address, addr(1)));
      const candidates = (await repository.boardRows()).map(toCandidate);
      const query = { market: "crypto" as const, board: "BTC", sort: "pnl" as const, window: "all" as const };
      const coin = buildBoard(candidates, query, { total: 4, ready: 3 });
      expect(coin.freshness).toEqual({ oldestUpdatedAt: old, newestUpdatedAt: old, missingTimestamps: 1 });
      expect(coin.items.find(t => t.address === addr(1))?.metricsUpdatedAt).toEqual(old);
      const top = buildBoard(candidates, { ...query, board: "top100", sort: "copyScore" }, { total: 4, ready: 3 }, 1);
      expect(top.items.map(t => t.address)).toEqual([addr(1)]);
      expect(top.freshness).toEqual({ oldestUpdatedAt: recent, newestUpdatedAt: recent, missingTimestamps: 0 });
      expect(top.eligibleCount).toBe(2);
      expect(top.rankingScope).toBe("candidate_pool");
    });

    it("returns null freshness for empty results rather than borrowing the pool timestamp", async () => {
      await seedPool();
      const candidates = (await repository.boardRows()).map(toCandidate);
      const empty = buildBoard(candidates, { market: "crypto", board: "ETH", sort: "pnl", window: "all" }, { total: 4, ready: 3 });
      expect(empty.freshness).toEqual({ oldestUpdatedAt: null, newestUpdatedAt: null, missingTimestamps: 0 });
      expect(empty.eligibleCount).toBe(0);
    });

    it("serves CopyDog's market index and one coin's leaderboard from the pool's coin stats", async () => {
      await seedPool();
      const server = app.getHttpServer();
      const index = wireCoinIndexSchema.parse((await request(server).get("/discover/coins").expect(200)).body.data);
      // GOLD (−10) has no trader who made money on it, so it isn't listed.
      expect(index.items).toEqual([
        { coin: "BTC", market: "crypto", traders: 2, profit: 370 },
        { coin: "xyz:TSLA", market: "stocks", traders: 1, profit: 40 },
      ]);
      expect(index.pool).toEqual({ total: 4, ready: 3, tradesReady: 0 });

      const btc = wireCoinBoardSchema.parse((await request(server).get("/discover/coins/BTC").expect(200)).body.data);
      expect(btc).toMatchObject({ coin: "BTC", market: "crypto", stats: { traders: 2, profit: 370, volume: 1700, trades: 4 } });
      expect(btc.items.map((t) => [t.address, t.pnl, t.winRate, t.trades, t.volume])).toEqual([
        [addr(2), 300, 1, 1, 1000],
        [addr(1), 70, 2 / 3, 3, 700],
      ]);
      expect(btc.items[0]).toMatchObject({ displayName: "KOL Two", kol: true, verified: true, xHandle: "two" });

      const tsla = wireCoinBoardSchema.parse((await request(server).get("/discover/coins/xyz%3ATSLA").expect(200)).body.data);
      expect(tsla).toMatchObject({ coin: "xyz:TSLA", market: "stocks", stats: { traders: 1, profit: 40, volume: 400, trades: 2 } });
      expect(tsla.items.map((t) => [t.address, t.winRate])).toEqual([[addr(2), 0.5]]);

      const gold = wireCoinBoardSchema.parse((await request(server).get("/discover/coins/xyz:GOLD").expect(200)).body.data);
      expect(gold).toMatchObject({ market: "stocks", items: [], stats: { traders: 0, profit: 0, volume: 0, trades: 0 } });
      await request(server).get("/discover/coins/..%2Fx").expect(400);
      await request(server).get("/discover/coins/BTC-USD").expect(400);
    });

    it("finds traders by KOL name, X handle, leaderboard name or address prefix, by PnL", async () => {
      await seedPool();
      await db.update(traderStats).set({ displayName: "x.com/AlphaBtc" }).where(eq(traderStats.address, addr(1)));
      const server = app.getHttpServer();
      const search = async (q: string, limit?: number) => {
        const qs = new URLSearchParams({ q, ...(limit ? { limit: String(limit) } : {}) });
        return wireDiscoverSearchSchema.parse((await request(server).get(`/discover/search?${qs}`).expect(200)).body.data).items;
      };
      expect((await search("kol tw")).map((r) => [r.address, r.displayName, r.kol, r.pnl])).toEqual([[addr(2), "KOL Two", true, 900]]);
      expect((await search("@TWO")).map((r) => r.address)).toEqual([addr(2)]);
      expect((await search("https://x.com/two")).map((r) => r.address)).toEqual([addr(2)]);
      expect((await search("alphabtc")).map((r) => [r.address, r.displayName, r.pnl, r.roi])).toEqual([[addr(1), "x.com/AlphaBtc", 100, 1]]);
      // An address prefix matches every row; highest all-time PnL first.
      const prefix = await search("0x00000000", 2);
      expect(prefix.map((r) => r.address)).toEqual([addr(2), addr(1)]);
      expect(await search("100%")).toEqual([]);
      expect(await search("nobody")).toEqual([]);
      await request(server).get("/discover/search").expect(400);
      await request(server).get(`/discover/search?q=${"a".repeat(65)}`).expect(400);
      await request(server).get("/discover/search?q=a&limit=11").expect(400);
    });

    it("computes any trader's copy score from the portfolio", async () => {
      const res = await request(app.getHttpServer()).get(`/traders/${addr(7).toUpperCase().replace("0X", "0x")}/copy-score`).expect(200);
      const body = wireCopyScoreSchema.parse(res.body.data);
      expect(body.address).toBe(addr(7));
      expect(body.copyScore).toEqual(expect.any(Number));
      expect(body.components.returnSamples).toBe(D70C.copydog.return_sample_count);
    });

    it("lets only admins manage KOLs", async () => {
      const server = app.getHttpServer();
      await request(server).get("/admin/kols").expect(401);
      await request(server).get("/admin/kols").set("Authorization", "Bearer user-token").expect(403);
      const admin = (r: request.Test) => r.set("Authorization", "Bearer admin-token");
      await admin(request(server).post("/admin/kols").send({ address: addr(5).toUpperCase().replace("0X", "0x"), displayName: "Five", xHandle: "five" })).expect(201);
      await admin(request(server).post("/admin/kols").send({ address: addr(5), xHandle: "not a handle" })).expect(400);
      await admin(request(server).patch(`/admin/kols/${addr(5)}`).send({ verified: true, sortOrder: 3 })).expect(200);
      await admin(request(server).patch(`/admin/kols/${addr(6)}`).send({ verified: true })).expect(404);
      const list = await admin(request(server).get("/admin/kols")).expect(200);
      expect(list.body.data).toEqual([expect.objectContaining({ address: addr(5), displayName: "Five", xHandle: "five", verified: true, sortOrder: 3 })]);
      const imported = await admin(request(server).post("/admin/kols/import").send({ csv: `address,display_name\n${addr(6)},Six\nbad,row` })).expect(201);
      expect(imported.body.data).toMatchObject({ inserted: 1, updated: 0, removed: 0, errors: [expect.objectContaining({ line: 3 })] });
      await admin(request(server).delete(`/admin/kols/${addr(5)}`)).expect(204);
      expect((await db.select().from(kolTraders)).map((k) => k.address)).toEqual([addr(6)]);
      const events = (await db.select({ e: adminAuditLogs.event }).from(adminAuditLogs)).map((r) => r.e);
      expect(events).toEqual(["kol.upsert", "kol.upsert", "kol.import", "kol.delete"]);
    });
  });
});
