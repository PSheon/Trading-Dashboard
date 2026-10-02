import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appSettings, archiveCoverage, kolTraders } from "@trading-dashboard/shared/database";

import { RoundTripRepository } from "../src/analytics/round-trip.repository.js";
import { RoundTripService } from "../src/analytics/round-trip.service.js";
import type { AppConfig } from "../src/config/app-config.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type { HlUserFill } from "../src/hyperliquid/types.js";
import { SettingsRepository } from "../src/settings/settings.repository.js";
import { SettingsService } from "../src/settings/settings.service.js";
import { AnalysisHistoryRepository, HISTORY_BUILD_MAX_FILLS } from "../src/traders/analysis-history.repository.js";
import { AnalysisHistoryService } from "../src/traders/analysis-history.service.js";
import { HistoryFillStore } from "../src/traders/history-fill.store.js";
import { LeaderboardIngestRepository } from "../src/traders/leaderboard-ingest.repository.js";
import { LeaderboardIngestService } from "../src/traders/leaderboard-ingest.service.js";
import { TradeAnalyticsRepository } from "../src/traders/trade-analytics.repository.js";
import { TradeAnalyticsService } from "../src/traders/trade-analytics.service.js";
import { TradersRepository } from "../src/traders/traders.repository.js";
import { TradersService } from "../src/traders/traders.service.js";
import { testConfig } from "./config-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const X = `0x${"c0".repeat(20)}`;
const HOUR = 3_600_000;
const NOW = Date.now();
const hour = (hoursAgo: number) => Math.floor((NOW - hoursAgo * HOUR) / HOUR) * HOUR;
/** The archive holds 30 days up to two hours ago. */
const COVERED = { from: hour(30 * 24), through: hour(2) };

let tid = 1;
/** A flat → long → flat pair of fills every `step` ms from `start`. */
function trades(pairs: number, start: number, step: number): HlUserFill[] {
  return Array.from({ length: pairs * 2 }, (_, i): HlUserFill => ({
    coin: "BTC", px: i % 2 === 0 ? "100.0" : "101.0", sz: "1.0", side: i % 2 === 0 ? "B" : "A", time: start + i * step,
    startPosition: i % 2 === 0 ? "0.0" : "1.0", dir: i % 2 === 0 ? "Open Long" : "Close Long", closedPnl: i % 2 === 0 ? "0.0" : "1.0",
    hash: `0x${"ab".repeat(32)}`, oid: 7, crossed: true, fee: "0.01", tid: tid++, feeToken: "USDC", twapId: null,
  }));
}

function config(trust: "none" | "regular" | "all"): AppConfig {
  const base = testConfig().value;
  return { value: { ...base, archive: { ...base.archive, trust } } } as AppConfig;
}

describe("what a cold trader page costs for an address the archive covers", () => {
  const db = getTestDb();
  const settings = new SettingsService(new SettingsRepository(db), new UnitOfWork(db));
  // A busy account: 2,500 fills older than the archive, 6,000 inside its span, 4 since.
  let older: HlUserFill[];
  let inside: HlUserFill[];
  let tail: HlUserFill[];

  /** Hyperliquid, with its weight formula: 20 per call (+1 per 20 items on lists), 2 for an account state. */
  function hyperliquid() {
    const calls: Array<{ type: string; weight: number }> = [];
    const all = () => [...older, ...inside, ...tail];
    const list = (type: string, items: HlUserFill[]) => {
      calls.push({ type, weight: 20 + Math.ceil(items.length / 20) });
      return items;
    };
    const info = {
      userFills: async () => list("userFills", all().sort((a, b) => b.time - a.time).slice(0, 2000)),
      userTwapSliceFills: async () => list("userTwapSliceFills", []),
      userFillsByTime: async (_: string, start: number, end = Infinity) => list("userFillsByTime", all().filter((f) => f.time >= start && f.time <= end).sort((a, b) => a.time - b.time).slice(0, 2000)),
      userTwapSliceFillsByTime: async () => list("userTwapSliceFillsByTime", []),
      clearinghouseState: async () => { calls.push({ type: "clearinghouseState", weight: 2 }); return { time: Date.now(), marginSummary: { accountValue: "1000" }, assetPositions: [] }; },
      perpDexs: async () => { calls.push({ type: "perpDexs", weight: 20 }); return [null]; },
      userFunding: async () => { calls.push({ type: "userFunding", weight: 20 }); return []; },
      portfolio: async () => { calls.push({ type: "portfolio", weight: 20 }); return [["allTime", { accountValueHistory: [[NOW, "1000"]], pnlHistory: [[NOW, "5"]], vlm: "0" }]]; },
    } as unknown as HyperliquidInfoClient;
    const weight = (types?: string[]) => calls.filter((call) => !types || types.includes(call.type)).reduce((sum, call) => sum + call.weight, 0);
    return { info, calls, weight, count: (type: string) => calls.filter((call) => call.type === type).length };
  }

  /** The services of one process. `archive: false`: as before this change
   * (the page's lists come from REST; the analytics build is driven by hand). */
  function services(info: HyperliquidInfoClient, trust: "none" | "regular" | "all", archive = true) {
    const history = new AnalysisHistoryService(new AnalysisHistoryRepository(db), info, undefined, config(trust));
    const traders = new TradersService(testConfig(), new TradersRepository(db), info, new RoundTripService(new RoundTripRepository(db)),
      new LeaderboardIngestService(testConfig(), new LeaderboardIngestRepository(db), new UnitOfWork(db), settings), settings, undefined, undefined, undefined, archive ? history : undefined);
    const analytics = new TradeAnalyticsService(new TradeAnalyticsRepository(db), traders, info, undefined, history);
    return { history, traders, analytics };
  }

  /** The fills tab, the activity strip and the analytics of one page load. */
  async function page({ traders, analytics }: ReturnType<typeof services>) {
    const [fills, activity] = await Promise.all([traders.fills(X, 50), traders.activity(X)]);
    const result = await analytics.analytics(X, "all");
    await analytics.settled();
    return { fills, activity, result };
  }

  beforeEach(async () => {
    await truncateAll(db);
    await db.delete(appSettings);
    await settings.patch({ discovery: {} }, null);
    tid = 1;
    older = trades(1250, COVERED.from - 40 * 24 * HOUR, 60_000);
    inside = trades(3000, COVERED.from + HOUR, 5 * 60_000);
    tail = trades(2, COVERED.through + 10 * 60_000, 60_000);
    await db.insert(kolTraders).values({ address: X });
    await db.insert(archiveCoverage).values({ address: X, coveredFrom: new Date(COVERED.from), coveredThrough: new Date(COVERED.through) });
    await new HistoryFillStore(db).insert(inside.map((fill) => ({ address: X, source: "regular" as const, origin: "s3" as const, fill })));
  });
  afterAll(async () => { await closeTestDb(); });

  it("before: both lists from REST and a history job read page by page; after: stored fills plus the tail", async () => {
    // --- Before (the previous release): userFills + TWAP slices for the
    // tabs, then the history job caught up within 8 pages, then the build.
    const before = hyperliquid();
    const old = services(before.info, "regular", false);
    await Promise.all([old.traders.fills(X, 50), old.traders.activity(X)]);
    const job = { calls: 0, weight: 0 };
    expect(await old.history.catchUp(X, 8, job)).toBe(true);
    const beforeLists = before.weight(["userFills", "userTwapSliceFills"]);
    const beforeHistory = before.weight(["userFillsByTime", "userTwapSliceFillsByTime"]);
    // 2,000 newest fills: 120; no TWAP slices: 20.
    expect(beforeLists).toBe(140);
    // 2,500 fills before the span in two pages (120 + 46), its tail (21), the TWAP scan (20).
    expect([before.count("userFillsByTime"), before.count("userTwapSliceFillsByTime"), beforeHistory, job.weight]).toEqual([3, 1, 207, 207]);

    // --- After: a new database state, the page as it now runs.
    await truncateAll(db);
    await db.insert(kolTraders).values({ address: X });
    await db.insert(archiveCoverage).values({ address: X, coveredFrom: new Date(COVERED.from), coveredThrough: new Date(COVERED.through) });
    await new HistoryFillStore(db).insert(inside.map((fill) => ({ address: X, source: "regular" as const, origin: "s3" as const, fill })));
    const after = hyperliquid();
    const now = services(after.info, "regular");
    const { fills, activity, result } = await page(now);

    // The tabs show exactly what REST's newest page shows.
    const newest = [...inside, ...tail].sort((a, b) => b.time - a.time || b.tid - a.tid);
    expect(fills.map((fill) => fill.tid)).toEqual(newest.slice(0, 50).map((fill) => String(fill.tid)));
    expect(activity.lastTradeAt).toEqual(new Date(tail.at(-1)!.time));
    // 30 days at one fill per 5 minutes is more than a page: the count is capped, as from REST.
    expect(activity.sample).toMatchObject({ fills30d: 2000, capped: true });

    // No `userFills`: the list is the stored page plus one tail call (20 + 1).
    expect(after.count("userFills")).toBe(0);
    const afterLists = after.weight(["userFills", "userTwapSliceFills"]) + 21;
    // Analytics: the same tail again for the build (21); no page before the span, no cold read.
    const ranges = after.calls.filter((call) => call.type === "userFillsByTime");
    expect(ranges.map((call) => call.weight)).toEqual([21, 21]);
    expect(after.count("userTwapSliceFillsByTime")).toBe(0);
    const afterHistory = after.weight(["userFillsByTime", "userTwapSliceFillsByTime"]) - 21;
    expect([afterLists, afterHistory]).toEqual([41, 21]);
    // 347 weight of fill reads before, 62 after, for the same page.
    expect([beforeLists + beforeHistory, afterLists + afterHistory]).toEqual([347, 62]);

    // The figures are those of the covered span and the tail: 3,002 round trips, all wins.
    expect(now.analytics.lastLog.get(X)!.find((entry) => entry.kind !== "funding")).toMatchObject({ kind: "archive", fills: 6004, trades: 3002 });
    expect(result.summary).toMatchObject({ trades: 3002, wins: 3002 });
    expect(result.coverage).toMatchObject({ source: "hyperliquid", fills: 6004, truncated: true, completeness: "partial",
      partialSince: new Date(inside[0].time), archiveFrom: new Date(COVERED.from + 5 * 60_000), archiveThrough: new Date(COVERED.through - 5 * 60_000) });
    // The tail was kept, and the durable job exists to bring the older fills later.
    expect(await new HistoryFillStore(db).count(X)).toBe(6004);
    expect((await now.history.status(X))?.status).toBe("pending");
  });

  it("an account that fills a page faster than the archive lags gets REST's one list, not tail calls first", async () => {
    // 2,200 fills in the span's last 37 minutes; the span ended two hours ago.
    const dense = trades(1100, COVERED.through - 40 * 60_000, 1_000);
    await new HistoryFillStore(db).insert(dense.map((fill) => ({ address: X, source: "regular" as const, origin: "s3" as const, fill })));
    const hl = hyperliquid();
    await services(hl.info, "regular").traders.latestFills(X);
    expect([hl.count("userFills"), hl.count("userFillsByTime")]).toEqual([1, 0]);
  });

  it("with S3_ARCHIVE_TRUST=all the TWAP list also comes from stored slices; with none nothing changes", async () => {
    const slices = trades(1100, COVERED.from + 2 * HOUR, 10 * 60_000).map((fill) => ({ ...fill, coin: "ETH", twapId: 9, hash: `0x${"0".repeat(64)}` }));
    await new HistoryFillStore(db).insert(slices.map((fill) => ({ address: X, source: "twap" as const, origin: "s3" as const, fill })));

    const trusted = hyperliquid();
    const all = services(trusted.info, "all");
    const [regular, twap] = await all.traders.latestFills(X);
    expect([regular.length, twap.length, twap[0].twapId]).toEqual([2000, 2000, 9]);
    expect([trusted.count("userFills"), trusted.count("userTwapSliceFills"), trusted.weight()]).toEqual([0, 0, 21 + 20]);

    const untrusted = hyperliquid();
    const none = services(untrusted.info, "none");
    await none.traders.latestFills(X);
    expect([untrusted.count("userFills"), untrusted.count("userTwapSliceFills"), untrusted.weight()]).toEqual([1, 1, 140]);
  });

  it("a span with less than a page of fills leaves the list to REST: its page reaches further back", async () => {
    await truncateAll(db);
    await db.insert(archiveCoverage).values({ address: X, coveredFrom: new Date(COVERED.from), coveredThrough: new Date(COVERED.through) });
    await new HistoryFillStore(db).insert(inside.slice(0, 1999).map((fill) => ({ address: X, source: "regular" as const, origin: "s3" as const, fill })));
    const rest = hyperliquid();
    await services(rest.info, "regular").traders.latestFills(X);
    expect([rest.count("userFills"), rest.count("userFillsByTime")]).toEqual([1, 0]);
  });

  it("an address with more stored fills than a build can hold is read from its newest fills, and says where it starts", async () => {
    const store = new HistoryFillStore(db);
    const repository = new AnalysisHistoryRepository(db);
    const span = { from: COVERED.from, through: COVERED.through };
    expect(HISTORY_BUILD_MAX_FILLS).toBe(100_000);
    const cut = await repository.archivedFills(X, span, 1000);
    expect([cut.length, cut.capped, cut[0].tid, cut.at(-1)!.tid]).toEqual([1000, true, inside[5000].tid, inside[5999].tid]);
    const whole = await repository.archivedFills(X, span);
    expect([whole.length, whole.capped]).toEqual([6000, false]);
    expect((await store.read(X, { newest: 3, source: "regular" })).map((row) => row.fill.tid)).toEqual(inside.slice(-3).map((fill) => fill.tid));
  });
});
