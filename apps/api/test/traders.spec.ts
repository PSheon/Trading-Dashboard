import { readFileSync } from "node:fs";

import { BadGatewayException } from "@nestjs/common";
import { actions, appSettings, fills, leaders, userFavorites, users } from "@trading-dashboard/shared";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RoundTripService } from "../src/analytics/round-trip.service.js";
import type { RequestUser } from "../src/common/auth/current-user.js";
import { SettingsService } from "../src/settings/settings.service.js";
import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type {
  HlClearinghouseStateResponse,
  HlPerpDexsResponse,
  HlPortfolioResponse,
  HlUserFill,
} from "../src/hyperliquid/types.js";
import { parseLeaderboard } from "../src/traders/leaderboard.js";
import { LeaderboardIngestService } from "../src/traders/leaderboard-ingest.service.js";
import { TradersController } from "../src/traders/traders.controller.js";
import {
  downsample,
  portfolioKey,
  portfolioMetrics,
  portfolioSeries,
  sampleFromUserFills,
  toPortfolioResponse,
} from "../src/traders/traders.mappers.js";
import { TradersService } from "../src/traders/traders.service.js";
import { TtlCache } from "../src/traders/ttl-cache.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
const xyzState = fixture<HlClearinghouseStateResponse>("clearinghouse-xyz.json");
const portfolioFixture = fixture<HlPortfolioResponse>("portfolio.json");
const userFillsFixture = fixture<HlUserFill[]>("user-fills.json");

const A = `0x${"a1".repeat(20)}`;
const B = `0x${"b2".repeat(20)}`;
const C = `0x${"c3".repeat(20)}`;
const D = `0x${"d4".repeat(20)}`;
/** A vault: biggest account value and month PnL, hidden by default. */
const V = `0x${"f6".repeat(20)}`;
/** A holder: no volume in 30 days, the biggest account and month PnL of all
 * (its assets went up); hidden by the default activity filter (§12). */
const H = `0x${"09".repeat(20)}`;
const UNKNOWN = `0x${"e5".repeat(20)}`;

const mainState: HlClearinghouseStateResponse = {
  assetPositions: [
    {
      type: "oneWay",
      position: {
        coin: "BTC",
        szi: "2",
        entryPx: "60000",
        positionValue: "130000",
        leverage: { type: "cross", value: 10 },
        liquidationPx: "30000",
        marginUsed: "13000",
        unrealizedPnl: "10000",
      },
    },
    {
      type: "oneWay",
      position: {
        coin: "ETH",
        szi: "-10",
        entryPx: "4100",
        positionValue: "40000",
        leverage: { type: "isolated", value: 5 },
        liquidationPx: null,
        marginUsed: "8000",
        unrealizedPnl: "1000",
      },
    },
    {
      type: "oneWay",
      position: {
        coin: "SOL",
        szi: "0",
        leverage: { type: "cross", value: 3 },
        marginUsed: "0",
        unrealizedPnl: "0",
      },
    },
  ],
  marginSummary: { accountValue: "500000", totalMarginUsed: "21000", totalNtlPos: "170000", totalRawUsd: "0" },
  crossMarginSummary: { accountValue: "500000", totalMarginUsed: "21000", totalNtlPos: "170000", totalRawUsd: "0" },
  withdrawable: "100000",
  time: 0,
};

const perpDexsFixture: HlPerpDexsResponse = [
  null,
  { name: "xyz", assetToStreamingOiCap: [["xyz:TSLA", "1"]] },
  { name: "abcd", assetToStreamingOiCap: [] },
];

function fakeInfo() {
  return {
    perpDexs: vi.fn(async () => perpDexsFixture),
    clearinghouseState: vi.fn(async (_address: string, dex?: string) => (dex === "xyz" ? xyzState : mainState)),
    portfolio: vi.fn(async (_address: string) => portfolioFixture),
    userFills: vi.fn(async (_address: string) => userFillsFixture),
  };
}

function statsRow(
  address: string,
  o: {
    av: number;
    name?: string;
    day: number;
    week: number;
    month: number;
    roiMonth: number;
    vlmMonth: number;
    vlmDay?: number;
    vlmWeek?: number;
  },
) {
  return {
    ethAddress: address,
    accountValue: String(o.av),
    displayName: o.name ?? null,
    windowPerformances: [
      ["day", { pnl: String(o.day), roi: "0", vlm: String(o.vlmDay ?? 0) }],
      ["week", { pnl: String(o.week), roi: "0", vlm: String(o.vlmWeek ?? 0) }],
      ["month", { pnl: String(o.month), roi: String(o.roiMonth), vlm: String(o.vlmMonth) }],
      ["allTime", { pnl: "0", roi: "0", vlm: "0" }],
    ] as Array<[string, { pnl: string; roi: string; vlm: string }]>,
  };
}

const IMPORTED_AT = new Date("2026-09-29T06:00:00Z");

async function expectStatus(promise: Promise<unknown> | (() => unknown), status: number) {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    expect((error as { getStatus?: () => number }).getStatus?.()).toBe(status);
    return;
  }
  throw new Error(`expected HTTP ${status}`);
}

describe("TradersModule — real Postgres, fake Hyperliquid", () => {
  const db = getTestDb();
  const settings = new SettingsService(db);
  const ingest = new LeaderboardIngestService(db, settings);
  let info: ReturnType<typeof fakeInfo>;
  let service: TradersService;
  let controller: TradersController;
  let user: RequestUser;

  beforeEach(async () => {
    await truncateAll(db);
    await db.execute(sql`TRUNCATE TABLE trader_stats, user_favorites, users RESTART IDENTITY CASCADE`);
    await db.delete(appSettings);
    await settings.patch({ discovery: {} }, null); // resets the 30 s settings cache to the defaults
    info = fakeInfo();
    service = new TradersService(
      db,
      info as unknown as HyperliquidInfoClient,
      new RoundTripService(db),
      ingest,
      settings,
    );
    controller = new TradersController(service);

    await ingest.replaceAll(
      parseLeaderboard(
        {
          leaderboardRows: [
            // Activity: A traded today, B this week, C and D this month, H not in 30 days.
            statsRow(A, { av: 1_000_000, name: "Alpha Whale", day: 5, week: 100, month: 50, roiMonth: 0.5, vlmMonth: 10, vlmWeek: 4, vlmDay: 2 }),
            statsRow(B, { av: 50_000, day: 30, week: 10, month: 300, roiMonth: 3, vlmMonth: 40, vlmWeek: 5 }),
            statsRow(C, { av: 10, name: "alphabet", day: 1, week: 50, month: 200, roiMonth: -0.1, vlmMonth: 30 }),
            statsRow(D, { av: 2_000_000, name: "Delta_1", day: -5, week: -20, month: -10, roiMonth: 0.2, vlmMonth: 20 }),
            statsRow(V, { av: 9_000_000, name: "HLP-like", day: 9, week: 900, month: 900, roiMonth: 0.1, vlmMonth: 1 }),
            statsRow(H, { av: 2_860_000_000, name: "Holder", day: 1e6, week: 5e6, month: 9e7, roiMonth: 0.04, vlmMonth: 0 }),
          ],
        },
        IMPORTED_AT,
        new Set([V]),
      ),
      IMPORTED_AT,
    );
    const [u] = await db.insert(users).values({ privyUserId: "did:privy:traders-test" }).returning();
    await db.insert(userFavorites).values([
      { userId: u.id, address: A },
      { userId: u.id, address: C },
    ]);
    user = { kind: "user", id: u.id, privyUserId: u.privyUserId, role: "user" };
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const addresses = (r: { items: Array<{ address: string }> }) => r.items.map((i) => i.address);

  // --- GET /traders ---------------------------------------------------------

  describe("GET /traders", () => {
    it("defaults to month PnL, descending, with total and updatedAt", async () => {
      const res = await controller.list({}, null);
      expect(addresses(res)).toEqual([B, C, A, D]);
      expect(res.total).toBe(4);
      expect(res.updatedAt).toEqual(IMPORTED_AT);
      expect(res.items[2]).toMatchObject({
        address: A,
        displayName: "Alpha Whale",
        accountValue: 1_000_000,
        pnl: { day: 5, week: 100, month: 50, allTime: 0 },
        roi: { month: 0.5 },
        volume: { month: 10 },
        favorite: false,
      });
    });

    it("sorts by the chosen window's column, either direction", async () => {
      expect(addresses(await controller.list({ window: "week" }, null))).toEqual([A, C, B, D]);
      expect(addresses(await controller.list({ window: "day", order: "asc" }, null))).toEqual([D, C, A, B]);
      expect(addresses(await controller.list({ sort: "roi" }, null))).toEqual([B, A, D, C]);
      expect(addresses(await controller.list({ sort: "volume", order: "asc" }, null))).toEqual([A, D, C, B]);
      expect(addresses(await controller.list({ sort: "accountValue" }, null))).toEqual([D, A, B, C]);
    });

    it("searches by address prefix (any case) or display-name substring (case-insensitive)", async () => {
      expect(addresses(await controller.list({ q: "0xB2B2" }, null))).toEqual([B]);
      expect(addresses(await controller.list({ q: "ALPHA" }, null))).toEqual([C, A]);
      expect(addresses(await controller.list({ q: "lta_" }, null))).toEqual([D]);
      // LIKE wildcards are literal.
      expect((await controller.list({ q: "%" }, null)).total).toBe(0);
      expect((await controller.list({ q: "_" }, null)).total).toBe(1);
    });

    it("filters by minimum account value and paginates", async () => {
      const rich = await controller.list({ minAccountValue: "100000" }, null);
      expect(addresses(rich)).toEqual([A, D]);
      expect(rich.total).toBe(2);

      const page = await controller.list({ limit: "2", offset: "1" }, null);
      expect(addresses(page)).toEqual([C, A]);
      expect(page.total).toBe(4);
    });

    it("flags the signed-in caller's favorites only", async () => {
      const mine = await controller.list({}, user);
      expect(mine.items.filter((i) => i.favorite).map((i) => i.address).sort()).toEqual([A, C]);
      expect((await controller.list({}, null)).items.some((i) => i.favorite)).toBe(false);
      expect((await controller.list({}, { kind: "service", permissions: [] })).items.some((i) => i.favorite)).toBe(false);
    });

    it("rejects an invalid query with 400", async () => {
      await expectStatus(() => controller.list({ limit: "500" }, null), 400);
      await expectStatus(() => controller.list({ window: "year" }, null), 400);
      await expectStatus(() => controller.list({ minAccountValue: "-1" }, null), 400);
    });
  });

  // --- GET /traders/:address -------------------------------------------------

  describe("GET /traders/:address", () => {
    it("maps positions across the main dex and every HIP-3 dex with listed markets", async () => {
      const res = await controller.profile(A.toUpperCase().replace("0X", "0x"), user);

      expect(info.perpDexs).toHaveBeenCalledTimes(1);
      const dexesQueried = info.clearinghouseState.mock.calls.map((c) => c[1] ?? "(main)");
      expect(dexesQueried.sort()).toEqual(["(main)", "xyz"]); // "abcd" lists no markets
      for (const call of info.clearinghouseState.mock.calls) {
        expect(call[0]).toBe(A);
        expect(call.slice(2)).toEqual(["background", 0]);
      }

      expect(res.address).toBe(A);
      expect(res.displayName).toBe("Alpha Whale");
      expect(res.stats?.pnl.month).toBe(50);
      expect(res.favorite).toBe(true);
      expect(res.tracked).toBe(false);
      expect(res.analytics).toBeNull();

      const xyzPositions = xyzState.assetPositions.map((a) => a.position);
      expect(res.positions).toHaveLength(2 + xyzPositions.length); // SOL (szi 0) omitted
      expect(res.accountValue).toBeCloseTo(500_000 + Number(xyzState.marginSummary.accountValue), 2);
      expect(res.marginUsed).toBeCloseTo(21_000 + Number(xyzState.marginSummary.totalMarginUsed), 2);
      expect(res.withdrawable).toBeCloseTo(100_000 + Number(xyzState.withdrawable), 2);

      const sum = (sign: 1 | -1) =>
        xyzPositions.filter((p) => Math.sign(Number(p.szi)) === sign).reduce((s, p) => s + Number(p.positionValue), 0);
      expect(res.longNotional).toBeCloseTo(130_000 + sum(1), 2);
      expect(res.shortNotional).toBeCloseTo(40_000 + sum(-1), 2);

      const byCoin = new Map(res.positions.map((p) => [p.coin, p]));
      expect(byCoin.get("BTC")).toEqual({
        coin: "BTC",
        szi: 2,
        side: "long",
        entryPx: 60000,
        positionValue: 130000,
        unrealizedPnl: 10000,
        leverage: 10,
        marginMode: "cross",
        liqPx: 30000,
      });
      expect(byCoin.get("ETH")).toMatchObject({ side: "short", szi: -10, marginMode: "isolated", liqPx: null });
      expect(byCoin.get("xyz:TSLA")).toMatchObject({ side: "short", szi: -17680.262, leverage: 3 });
      expect(byCoin.get("xyz:XYZ100")).toMatchObject({ side: "long", liqPx: null });
      // Largest first.
      expect(res.positions[0].coin).toBe("xyz:GOLD");
    });

    it("caches the profile 60 s per address (favorite still per caller) and the dex list across addresses", async () => {
      await controller.profile(A, user);
      const anon = await controller.profile(A, null);
      expect(anon.favorite).toBe(false);
      expect(info.clearinghouseState).toHaveBeenCalledTimes(2);

      const [x, y] = await Promise.all([controller.profile(UNKNOWN, null), controller.profile(UNKNOWN, null)]);
      expect(x).toEqual(y);
      expect(info.clearinghouseState).toHaveBeenCalledTimes(4);
      expect(info.perpDexs).toHaveBeenCalledTimes(1);
      expect(x.stats).toBeNull();
      expect(x.displayName).toBeNull();
    });

    it("includes 30-day analytics from our own records when the address is tracked", async () => {
      await db.insert(leaders).values({ address: B, source: "favorite" });
      const now = Date.now();
      const ago = (h: number) => new Date(now - h * 3_600_000);
      let tid = 1n;
      const trip = async (coin: string, pnl: string, openH: number, closeH: number) => {
        const openTid = tid++;
        const closeTid = tid++;
        await db.insert(fills).values([
          { tid: openTid, address: B, coin, side: "B", dir: "Open Long", px: "1", sz: "1", fee: "0", closedPnl: "0", ts: ago(openH), raw: {} },
          { tid: closeTid, address: B, coin, side: "A", dir: "Close Long", px: "1", sz: "1", fee: "0", closedPnl: pnl, ts: ago(closeH), raw: {} },
        ]);
        await db.insert(actions).values([
          { address: B, coin, kind: "open", side: "long", notionalUsd: "1", avgPx: "1", fillIds: [openTid], ts: ago(openH) },
          { address: B, coin, kind: "close", side: "long", notionalUsd: "1", avgPx: "1", fillIds: [closeTid], ts: ago(closeH) },
        ]);
      };
      await trip("BTC", "1000", 24 * 41, 24 * 40); // older than 30 days: ignored
      await trip("BTC", "100", 10, 8);
      await trip("ETH", "-50", 6, 5);
      await trip("SOL", "30", 4, 2);
      await trip("HYPE", "20", 3, 1);
      await trip("DOGE", "10", 3, 1);

      const res = await controller.profile(B, null);
      expect(res.tracked).toBe(true);
      expect(res.analytics).not.toBeNull();
      const a = res.analytics!;
      expect(a.roundTrips30d).toBe(5);
      expect(a.winRate30d).toBeCloseTo(4 / 5);
      expect(a.realizedPnl30d).toBeCloseTo(110);
      expect(a.avgHoldSeconds).toBeCloseTo(((2 + 1 + 2 + 2 + 2) * 3600) / 5, 0);
      expect(a.bestCoins).toEqual([
        { coin: "BTC", pnl: 100 },
        { coin: "SOL", pnl: 30 },
        { coin: "HYPE", pnl: 20 },
      ]);
      expect(a.worstCoins).toEqual([{ coin: "ETH", pnl: -50 }]);

      // An inactive leader row isn't "tracked".
      await db.update(leaders).set({ active: false });
      expect(await service.isTracked(B)).toBe(false);
    });

    it("rejects an invalid address with 400 and maps upstream failure to 502", async () => {
      await expectStatus(() => controller.profile("0x123", null), 400);
      await expectStatus(() => controller.profile(`${A}00`, null), 400);
      await expectStatus(() => controller.portfolio("nope", {}), 400);
      await expectStatus(() => controller.fills("0xZZ", undefined), 400);
      expect(info.clearinghouseState).not.toHaveBeenCalled();

      info.clearinghouseState.mockRejectedValueOnce(new Error("Hyperliquid info request failed: 429"));
      await expect(controller.profile(UNKNOWN, null)).rejects.toBeInstanceOf(BadGatewayException);
    });
  });

  // --- GET /traders/:address/portfolio ------------------------------------------

  describe("GET /traders/:address/portfolio", () => {
    it("maps window + market onto the portfolio keys", async () => {
      const perp = await controller.portfolio(A, {});
      const raw = new Map(portfolioFixture);
      expect(perp.window).toBe("month");
      expect(perp.market).toBe("perp");
      expect(perp.pnl).toHaveLength(raw.get("perpMonth")!.pnlHistory.length);
      expect(perp.volume).toBeCloseTo(Number(raw.get("perpMonth")!.vlm));
      const [ts, v] = raw.get("perpMonth")!.accountValueHistory[1];
      expect(perp.accountValue[1]).toEqual([ts, Number(v)]);

      const all = await controller.portfolio(A, { window: "allTime", market: "all" });
      expect(all.pnl).toHaveLength(raw.get("allTime")!.pnlHistory.length);
      expect(all.volume).toBeCloseTo(Number(raw.get("allTime")!.vlm));

      expect(portfolioKey("day", "perp")).toBe("perpDay");
      expect(portfolioKey("allTime", "perp")).toBe("perpAllTime");
      expect(portfolioKey("week", "all")).toBe("week");

      // One upstream call served both (60 s cache), in the background lane at rank 0.
      expect(info.portfolio).toHaveBeenCalledTimes(1);
      expect(info.portfolio.mock.calls[0]).toEqual([A, "background", 0]);
      await expectStatus(() => controller.portfolio(A, { window: "year" }), 400);
    });

    it("returns empty series for a window Hyperliquid didn't send", async () => {
      info.portfolio.mockResolvedValueOnce([]);
      expect(await controller.portfolio(UNKNOWN, { window: "day" })).toEqual({
        window: "day",
        market: "perp",
        accountValue: [],
        pnl: [],
        volume: 0,
        maxDrawdownUsd: 0,
        maxDrawdownPct: null,
        sharpe: null,
      });
    });
  });

  // --- GET /traders/sparklines ----------------------------------------------------

  describe("GET /traders/sparklines", () => {
    it("returns ≤ 40-point PnL series per address, cached 10 min", async () => {
      const res = await controller.sparklines({ addresses: `${A},${B.toUpperCase().replace("0X", "0x")},${A}`, window: "allTime" });
      expect(Object.keys(res).sort()).toEqual([A, B]);
      const full = new Map(portfolioFixture).get("allTime")!.pnlHistory;
      expect(full.length).toBeGreaterThan(40);
      expect(res[A]).toHaveLength(40);
      expect(res[A][0]).toEqual([full[0][0], Number(full[0][1])]);
      expect(res[A][39]).toEqual([full.at(-1)![0], Number(full.at(-1)![1])]);
      expect(info.portfolio).toHaveBeenCalledTimes(2);

      const week = await controller.sparklines({ addresses: `${A},${B}`, window: "week" });
      expect(week[A]).toHaveLength(Math.min(40, new Map(portfolioFixture).get("week")!.pnlHistory.length));
      expect(info.portfolio).toHaveBeenCalledTimes(2);
    });

    it("reuses a fresh trader-page portfolio and survives one address failing", async () => {
      await controller.portfolio(A, {});
      info.portfolio.mockRejectedValueOnce(new Error("boom"));
      const res = await controller.sparklines({ addresses: `${A},${C}` });
      expect(info.portfolio).toHaveBeenCalledTimes(2);
      expect(res[A].length).toBeGreaterThan(0);
      expect(res[C]).toEqual([]);
    });

    it("rejects more than 30 addresses, invalid ones, or none", async () => {
      const many = Array.from({ length: 31 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`).join(",");
      await expectStatus(() => controller.sparklines({ addresses: many }), 400);
      await expectStatus(() => controller.sparklines({ addresses: `${A},0xbad` }), 400);
      await expectStatus(() => controller.sparklines({}), 400);
      expect(info.portfolio).not.toHaveBeenCalled();
    });

    it("downsample keeps the ends and never exceeds the cap", () => {
      const pts = Array.from({ length: 100 }, (_, i) => i);
      const d = downsample(pts, 40);
      expect(d).toHaveLength(40);
      expect(d[0]).toBe(0);
      expect(d[39]).toBe(99);
      expect([...d].sort((x, y) => x - y)).toEqual(d);
      expect(new Set(d).size).toBe(40);
      expect(downsample([1, 2, 3], 40)).toEqual([1, 2, 3]);
    });
  });

  // --- GET /traders/:address/fills -------------------------------------------------

  describe("GET /traders/:address/fills", () => {
    it("reads our fills table for a tracked address: perps only, this address only, newest first", async () => {
      await db.insert(leaders).values({ address: A });
      const t = (m: number) => new Date(Date.UTC(2026, 8, 29, 0, m));
      await db.insert(fills).values([
        { tid: 1n, address: A, coin: "BTC", side: "B", dir: "Open Long", px: "60000", sz: "0.5", fee: "3", closedPnl: "0", ts: t(1), raw: {} },
        { tid: 2n, address: A, coin: "xyz:TSLA", side: "A", dir: "Open Short", px: "400", sz: "10", fee: "1", closedPnl: null, ts: t(2), raw: {} },
        { tid: 3n, address: A, coin: "@107", side: "B", dir: "Buy", px: "40", sz: "1", fee: "0", closedPnl: "0", ts: t(3), raw: {} },
        { tid: 4n, address: A, coin: "PURR/USDC", side: "B", dir: "Buy", px: "1", sz: "1", fee: "0", closedPnl: "0", ts: t(4), raw: {} },
        // Counterparty's copy of the same trade.
        { tid: 2n, address: B, coin: "xyz:TSLA", side: "B", dir: "Open Long", px: "400", sz: "10", fee: "1", closedPnl: "0", ts: t(2), raw: {} },
      ]);

      const res = await controller.fills(A, undefined);
      expect(res.map((f) => f.tid)).toEqual(["2", "1"]);
      expect(res[0]).toEqual({
        tid: "2",
        coin: "xyz:TSLA",
        side: "sell",
        dir: "Open Short",
        px: 400,
        sz: 10,
        notionalUsd: 4000,
        closedPnl: null,
        fee: 1,
        ts: t(2),
      });
      expect(res[1]).toMatchObject({ side: "buy", notionalUsd: 30000, closedPnl: 0 });
      expect(await controller.fills(A, "1")).toHaveLength(1);
      expect(info.userFills).not.toHaveBeenCalled();
    });

    it("asks Hyperliquid for an untracked address (cached 60 s)", async () => {
      const res = await controller.fills(UNKNOWN, "200");
      const perps = userFillsFixture.filter((f) => !f.coin.startsWith("@"));
      expect(perps.length).toBeLessThan(userFillsFixture.length);
      expect(res).toHaveLength(perps.length);
      expect(res.every((f) => !f.coin.startsWith("@"))).toBe(true);
      for (let i = 1; i < res.length; i++) expect(res[i - 1].ts.getTime()).toBeGreaterThanOrEqual(res[i].ts.getTime());
      const sample = perps[0];
      const mapped = res.find((f) => f.tid === String(sample.tid))!;
      expect(mapped).toMatchObject({
        coin: sample.coin,
        side: sample.side === "B" ? "buy" : "sell",
        px: Number(sample.px),
        sz: Number(sample.sz),
        closedPnl: Number(sample.closedPnl),
        fee: Number(sample.fee),
      });
      expect(mapped.notionalUsd).toBeCloseTo(Number(sample.px) * Number(sample.sz));

      expect(await controller.fills(UNKNOWN, "3")).toHaveLength(3);
      expect(info.userFills).toHaveBeenCalledTimes(1);
      expect(info.userFills.mock.calls[0]).toEqual([UNKNOWN, "background", 0]);
    });

    it("validates limit (1–200, default 50)", async () => {
      await expectStatus(() => controller.fills(A, "201"), 400);
      await expectStatus(() => controller.fills(A, "0"), 400);
      await expectStatus(() => controller.fills(A, "abc"), 400);
      const many = Array.from({ length: 80 }, (_, i) => ({ ...userFillsFixture[0], coin: "BTC", tid: i + 1, time: i }));
      info.userFills.mockResolvedValueOnce(many);
      const res = await controller.fills(UNKNOWN, undefined);
      expect(res).toHaveLength(50);
      expect(res[0].tid).toBe("80");
    });
  });
  // --- Stage 2 §10: vaults, sample size, warming ------------------------------

  describe("vaults", () => {
    it("hides vaults by default (discovery.hideVaults), overridable per query and by the admin", async () => {
      const byDefault = await controller.list({}, null);
      expect(addresses(byDefault)).toEqual([B, C, A, D]);
      expect(byDefault.total).toBe(4);
      expect(byDefault.items.every((i) => i.isVault === false)).toBe(true);

      const shown = await controller.list({ hideVaults: "false" }, null);
      expect(addresses(shown)).toEqual([V, B, C, A, D]);
      expect(shown.items[0].isVault).toBe(true);

      await settings.patch({ discovery: { hideVaults: false } }, null);
      expect(addresses(await controller.list({}, null))[0]).toBe(V);
      expect(addresses(await controller.list({ hideVaults: "true" }, null))).not.toContain(V);

      await expectStatus(() => controller.list({ hideVaults: "yes" }, null), 400);
    });

    it("flags a vault's profile from trader_stats, or from the vault list for addresses not on the leaderboard", async () => {
      expect((await controller.profile(V, null)).isVault).toBe(true);
      expect((await controller.profile(A, null)).isVault).toBe(false);

      const spy = vi.spyOn(ingest, "isVault").mockImplementation((a) => a === UNKNOWN);
      expect((await controller.profile(UNKNOWN, null)).isVault).toBe(true);
      expect(spy).toHaveBeenCalledWith(UNKNOWN);
      spy.mockRestore();
    });
  });

  describe("activity (§12)", () => {
    it("tags each row with the latest leaderboard window that has volume", async () => {
      const res = await controller.list({ active: "any" }, null);
      const activity = Object.fromEntries(res.items.map((i) => [i.address, i.activity]));
      expect(activity).toEqual({ [H]: "inactive", [B]: "week", [C]: "month", [A]: "day", [D]: "month" });
    });

    it("filters by each `active` value, and `total` counts the filtered rows", async () => {
      const day = await controller.list({ active: "day" }, null);
      expect(addresses(day)).toEqual([A]);
      expect(day.total).toBe(1);

      const week = await controller.list({ active: "week" }, null);
      expect(addresses(week)).toEqual([B, A]);
      expect(week.total).toBe(2);

      const month = await controller.list({ active: "month" }, null);
      expect(addresses(month)).toEqual([B, C, A, D]);
      expect(month.total).toBe(4);

      const any = await controller.list({ active: "any" }, null);
      expect(addresses(any)).toEqual([H, B, C, A, D]);
      expect(any.total).toBe(5);

      // Combined with the other filters and pagination.
      const page = await controller.list({ active: "any", sort: "accountValue", limit: "1" }, null);
      expect(addresses(page)).toEqual([H]);
      expect(page.total).toBe(5);
      const rich = await controller.list({ active: "week", minAccountValue: "100000" }, null);
      expect(addresses(rich)).toEqual([A]);
      expect(rich.total).toBe(1);
      const withVaults = await controller.list({ active: "any", hideVaults: "false" }, null);
      expect(withVaults.total).toBe(6);
    });

    it("defaults to the admin's discovery.defaultActiveWithin (month) when `active` is omitted", async () => {
      expect((await settings.get("discovery")).defaultActiveWithin).toBe("month");
      const byDefault = await controller.list({}, null);
      expect(addresses(byDefault)).not.toContain(H);
      expect(byDefault.total).toBe(4);

      await settings.patch({ discovery: { defaultActiveWithin: "week" } }, null);
      const week = await controller.list({}, null);
      expect(addresses(week)).toEqual([B, A]);
      expect(week.total).toBe(2);
      // The query still overrides the setting.
      expect((await controller.list({ active: "month" }, null)).total).toBe(4);

      await settings.patch({ discovery: { defaultActiveWithin: "any" } }, null);
      const all = await controller.list({}, null);
      expect(addresses(all)[0]).toBe(H);
      expect(all.total).toBe(5);
      expect(addresses(await controller.list({ active: "day" }, null))).toEqual([A]);

      await settings.patch({ discovery: { defaultActiveWithin: "day" } }, null);
      expect((await controller.list({}, null)).total).toBe(1);
    });

    it("rejects an unknown `active` value with 400", async () => {
      await expectStatus(() => controller.list({ active: "year" }, null), 400);
      await expectStatus(() => controller.list({ active: "inactive" }, null), 400);
    });
  });

  describe("profile sample", () => {
    const hl = (hoursAgo: number, coin = "BTC", tid = Math.floor(Math.random() * 1e12)): HlUserFill => ({
      ...userFillsFixture[0],
      coin,
      tid,
      time: Date.now() - hoursAgo * 3_600_000,
    });

    it("counts an untracked address's perp fills in 30 days from userFills, shared with the fills tab", async () => {
      info.userFills.mockResolvedValue([
        hl(1),
        hl(2, "xyz:TSLA"),
        hl(3, "@107"), // spot
        hl(4, "PURR/USDC"), // spot
        hl(24 * 29),
        hl(24 * 31), // outside the window
      ]);
      const res = await controller.profile(UNKNOWN, null);
      expect(res.sample).toEqual({ fills30d: 3, capped: false, lowSample: true });
      await controller.fills(UNKNOWN, undefined);
      expect(info.userFills).toHaveBeenCalledTimes(1);
      expect(info.userFills.mock.calls[0]).toEqual([UNKNOWN, "background", 0]);
    });

    it("is capped when userFills hit 2,000 and the oldest is still inside the window", async () => {
      const full = Array.from({ length: 2000 }, (_, i) => hl(i * 0.1, "ETH", i + 1)); // all within ~8 days
      info.userFills.mockResolvedValueOnce(full);
      const capped = await controller.profile(UNKNOWN, null);
      expect(capped.sample).toEqual({ fills30d: 2000, capped: true, lowSample: false });

      const reachesPast = [...full.slice(1), hl(24 * 40, "ETH", 99_999)];
      info.userFills.mockResolvedValueOnce(reachesPast);
      const other = `0x${"07".repeat(20)}`;
      expect((await controller.profile(other, null)).sample).toEqual({ fills30d: 1999, capped: false, lowSample: false });

      const short = full.slice(0, 1999);
      info.userFills.mockResolvedValueOnce(short);
      const third = `0x${"08".repeat(20)}`;
      expect((await controller.profile(third, null)).sample.capped).toBe(false);
    });

    it("counts our own fills for a tracked address and applies the admin's threshold per request", async () => {
      vi.mocked(info.userFills).mockResolvedValueOnce([]);
      await db.insert(leaders).values({ address: C });
      const ago = (h: number) => new Date(Date.now() - h * 3_600_000);
      const row = (tid: bigint, address: string, coin: string, ts: Date) => ({
        tid,
        address,
        coin,
        side: "B",
        dir: "Open Long",
        px: "1",
        sz: "1",
        fee: "0",
        closedPnl: "0",
        ts,
        raw: {},
      });
      await db.insert(fills).values([
        row(1n, C, "BTC", ago(1)),
        row(2n, C, "xyz:GOLD", ago(100)),
        row(3n, C, "ETH", ago(24 * 29)),
        row(4n, C, "@107", ago(2)), // spot
        row(5n, C, "BTC", ago(24 * 31)), // too old
        row(1n, D, "BTC", ago(1)), // someone else
      ]);
      const res = await controller.profile(C, null);
      expect(res.tracked).toBe(true);
      expect(res.sample).toEqual({ fills30d: 3, capped: false, lowSample: true });

      await settings.patch({ discovery: { lowSampleThreshold: 3 } }, null);
      expect((await controller.profile(C, null)).sample.lowSample).toBe(false);
      expect(info.clearinghouseState).toHaveBeenCalledTimes(2); // still the cached profile
    });

    it("uses Hyperliquid's count for a tracked address when ours has holes, and ours if Hyperliquid fails", async () => {
      await db.insert(leaders).values({ address: C });
      // No fills of ours at all (e.g. imported today): the upstream sample wins.
      const upstream = sampleFromUserFills(userFillsFixture, Date.now() - 30 * 86_400_000);
      expect(upstream.fills30d).toBeGreaterThan(0);
      expect((await controller.profile(C, null)).sample).toMatchObject({ fills30d: upstream.fills30d });

      await db.delete(leaders);
      await db.insert(leaders).values({ address: D });
      await db.insert(fills).values({
        tid: 9n, address: D, coin: "BTC", side: "B", dir: "Open Long", px: "1", sz: "1",
        fee: "0", closedPnl: "0", ts: new Date(Date.now() - 3_600_000), raw: {},
      });
      vi.mocked(info.userFills).mockRejectedValueOnce(new Error("502"));
      expect((await controller.profile(D, null)).sample).toMatchObject({ fills30d: 1, capped: false });
    });
  });

  describe("home warm-up", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("warms the top 24 by month PnL (no vaults while hidden) so card sparklines hit the cache for 15 min", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      expect(await service.homeAddresses()).toEqual([B, C, A, D]);
      expect(await service.warmHome()).toBe(4);
      expect(info.portfolio).toHaveBeenCalledTimes(4);
      for (const call of info.portfolio.mock.calls) expect(call.slice(1)).toEqual(["background", 1]);

      vi.setSystemTime(Date.now() + 12 * 60_000); // past the normal 10 min TTL
      const res = await controller.sparklines({ addresses: [A, B, C, D].join(","), window: "month" });
      expect(Object.values(res).every((s) => s.length > 0)).toBe(true);
      expect(info.portfolio).toHaveBeenCalledTimes(4);

      // A warm run re-fetches even while entries are fresh.
      await service.warmHome();
      expect(info.portfolio).toHaveBeenCalledTimes(8);

      await settings.patch({ discovery: { hideVaults: false } }, null);
      expect((await service.homeAddresses())[0]).toBe(V);
    });

    it("skips accounts outside the default activity window in the fallback (a holder isn't warmed)", async () => {
      // H has the highest month PnL but no volume in 30 days.
      const fallback = await service.homeAddresses();
      expect(fallback).not.toContain(H);
      expect(fallback).toEqual([B, C, A, D]);
      await service.warmHome();
      expect(info.portfolio.mock.calls.map((c) => c[0])).not.toContain(H);

      await settings.patch({ discovery: { defaultActiveWithin: "week" } }, null);
      expect(await service.homeAddresses()).toEqual([B, A]);
      await settings.patch({ discovery: { defaultActiveWithin: "any" } }, null);
      expect((await service.homeAddresses())[0]).toBe(H);
    });

    it("always keeps explicitly featured addresses, inactive ones included", async () => {
      await settings.patch({ discovery: { featuredAddresses: [H, A], defaultActiveWithin: "day" } }, null);
      expect(await service.homeAddresses()).toEqual([H, A]);
      expect(await service.warmHome()).toBe(2);
      expect(info.portfolio.mock.calls.map((c) => c[0]).sort()).toEqual([A, H].sort());
    });

    it("uses the admin's featured list when set, and survives a failing address", async () => {
      await settings.patch({ discovery: { featuredAddresses: [D, A.toUpperCase().replace("0X", "0x")] } }, null);
      expect(await service.homeAddresses()).toEqual([D, A]);
      info.portfolio.mockRejectedValueOnce(new Error("boom"));
      expect(await service.warmHome()).toBe(1);
      await expect(service.onWarmSchedule()).resolves.toBeUndefined();
    });
  });

});

describe("TtlCache", () => {
  it("expires entries after the TTL", async () => {
    let now = 1_000;
    const cache = new TtlCache<number>(60_000, 100, () => now);
    const load = vi.fn(async () => now);
    expect(await cache.get("k", load)).toBe(1_000);
    now += 59_999;
    expect(await cache.get("k", load)).toBe(1_000);
    expect(load).toHaveBeenCalledTimes(1);
    now += 1;
    expect(await cache.get("k", load)).toBe(61_000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("de-duplicates concurrent loads for one key and doesn't cache failures", async () => {
    const cache = new TtlCache<string>(60_000);
    let release!: (v: string) => void;
    const load = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const a = cache.get("k", load);
    const b = cache.get("k", load);
    expect(load).toHaveBeenCalledTimes(1);
    release("v");
    expect(await Promise.all([a, b])).toEqual(["v", "v"]);

    const failing = vi.fn(async () => {
      throw new Error("x");
    });
    await expect(Promise.all([cache.get("f", failing), cache.get("f", failing)])).rejects.toThrow("x");
    expect(failing).toHaveBeenCalledTimes(1);
    expect(await cache.get("f", async () => "ok")).toBe("ok");
  });

  it("refresh() reloads a fresh key with its own TTL and joins a load in flight", async () => {
    let now = 0;
    const cache = new TtlCache<number>(10_000, 100, () => now);
    await cache.get("k", async () => 1);
    expect(await cache.refresh("k", async () => 2, 15_000)).toBe(2);
    now = 14_999;
    expect(cache.peek("k")).toEqual({ value: 2 });
    now = 15_000;
    expect(cache.peek("k")).toBeUndefined();

    let release!: (v: number) => void;
    const slow = vi.fn(() => new Promise<number>((resolve) => (release = resolve)));
    const a = cache.get("j", slow);
    const b = cache.refresh("j", async () => 99);
    release(3);
    expect(await Promise.all([a, b])).toEqual([3, 3]);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("stays within its size bound, dropping the oldest", async () => {
    const cache = new TtlCache<number>(60_000, 3);
    for (let i = 0; i < 5; i++) await cache.get(`k${i}`, async () => i);
    expect(cache.size).toBe(3);
    expect(cache.peek("k0")).toBeUndefined();
    expect(cache.peek("k4")).toEqual({ value: 4 });
  });
});

describe("portfolioMetrics — hand-computed", () => {
  const H = 3_600_000;
  const T0 = 1_790_000_000_000;

  it("hourly series: drawdown from the 150 peak, Sharpe annualized by 8,760 periods", () => {
    // t:        0h    1h    2h    3h    4h
    // pnl:       0   100    50   150    30
    // account: 1000  1100  1050  1150  1030
    const pnl: Array<[number, number]> = [0, 100, 50, 150, 30].map((v, i) => [T0 + i * H, v]);
    const av: Array<[number, number]> = [1000, 1100, 1050, 1150, 1030].map((v, i) => [T0 + i * H, v]);
    const m = portfolioMetrics(pnl, av);

    // Peaks 100→50 (fall 50) and 150→30 (fall 120): max 120, from the 150
    // peak where account value was 1150.
    expect(m.maxDrawdownUsd).toBe(120);
    expect(m.maxDrawdownPct).toBeCloseTo(120 / 1150, 12); // 0.104347826…

    // Returns: 100/1000 = 0.1, −50/1100 = −0.0454545…, 100/1050 = 0.0952380…,
    // −120/1150 = −0.1043478…; mean 0.0113589309…, sample stdev
    // 0.1024837842…; × √(365·24) → 10.3737161021.
    expect(m.sharpe).toBeCloseTo(10.3737161021, 8);
  });

  it("daily series: skips returns whose prior account value is 0; annualized by 365", () => {
    const D = 24 * H;
    const pnl: Array<[number, number]> = [0, 10, -5, 20, 20, 40].map((v, i) => [T0 + i * D, v]);
    const av: Array<[number, number]> = [0, 500, 490, 520, 520, 540].map((v, i) => [T0 + i * D, v]);
    const m = portfolioMetrics(pnl, av);
    // Peak 10 (account 500) → −5: fall 15, 3%.
    expect(m.maxDrawdownUsd).toBe(15);
    expect(m.maxDrawdownPct).toBeCloseTo(0.03, 12);
    // Returns (first skipped: prior account 0): −15/500 = −0.03, 25/490,
    // 0/520 = 0, 20/520; mean 0.0148704867, stdev 0.0369587450; × √365.
    expect(m.sharpe).toBeCloseTo(7.6869560544, 8);
  });

  it("returns 0 / null at the edges", () => {
    const pts = (vals: number[]): Array<[number, number]> => vals.map((v, i) => [T0 + i * H, v]);
    // Empty.
    expect(portfolioMetrics([], [])).toEqual({ maxDrawdownUsd: 0, maxDrawdownPct: null, sharpe: null });
    // Monotonic up: no drawdown (0 % of the first point's account), fewer than 5 points → no Sharpe.
    expect(portfolioMetrics(pts([0, 1, 2, 3]), pts([100, 101, 102, 103]))).toEqual({
      maxDrawdownUsd: 0,
      maxDrawdownPct: 0,
      sharpe: null,
    });
    // Constant returns: zero variance → null Sharpe.
    expect(portfolioMetrics(pts([0, 10, 20, 30, 40]), pts([100, 100, 100, 100, 100])).sharpe).toBeNull();
    // Account value ≤ 0 at the peak → null %.
    expect(portfolioMetrics(pts([5, 0]), pts([0, -5])).maxDrawdownPct).toBeNull();
    // Account series sampled at other times: the latest earlier value is used.
    const m = portfolioMetrics(pts([0, 100, 40]), [[T0 + 0.5 * H, 2000]]);
    expect(m.maxDrawdownUsd).toBe(60);
    expect(m.maxDrawdownPct).toBeCloseTo(0.03, 12);
  });

  it("the portfolio endpoint returns the metrics of the window it serves", async () => {
    const series = portfolioSeries(portfolioFixture, "week", "all");
    const res = toPortfolioResponse(portfolioFixture, "week", "all");
    expect(res).toMatchObject(portfolioMetrics(series.pnl, series.accountValue));
    expect(res.maxDrawdownUsd).toBeGreaterThan(0);
    expect(res.sharpe).not.toBeNull();
  });
});
