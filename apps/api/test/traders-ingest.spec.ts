import { LeaderboardIngestRepository } from "../src/traders/leaderboard-ingest.repository.js";
import { testConfig } from "./config-test-utils.js";
import { SettingsRepository } from "../src/settings/settings.repository.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { readFileSync } from "node:fs";

import { appSettings, traderStats } from "@trading-dashboard/shared/database";
import { asc, count, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsService } from "../src/settings/settings.service.js";
import {
  chunk,
  LEADERBOARD_URL,
  parseLeaderboard,
  parseVaults,
  UPSERT_CHUNK_ROWS,
  VAULTS_URL,
  type LeaderboardPayload,
} from "../src/traders/leaderboard.js";
import { LeaderboardIngestService } from "../src/traders/leaderboard-ingest.service.js";
import { closeTestDb, getTestDb } from "./db-test-utils.js";

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
const sample = fixture<LeaderboardPayload>("leaderboard.json");
/** Real `Mainnet/vaults` entries (pnls dropped): two that are on the sample
 * leaderboard, two closed and two open ones that aren't. */
const vaultSample = fixture<Array<{ summary: { vaultAddress: string; isClosed: boolean } }>>("vaults.json");
const SAMPLE_VAULTS = ["0x654016a8c9fcf0c4cb7ed6078aba21f7f399f7b7", "0xc179e03922afe8fa9533d3f896338b9fb87ce0c8"];

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

function lbRow(address: string, pnlMonth: number, displayName: string | null = null) {
  return {
    ethAddress: address,
    accountValue: "1000",
    displayName,
    windowPerformances: [
      ["day", { pnl: "1", roi: "0.1", vlm: "10" }],
      ["week", { pnl: "2", roi: "0.2", vlm: "20" }],
      ["month", { pnl: String(pnlMonth), roi: "0.3", vlm: "30" }],
      ["allTime", { pnl: "4", roi: "0.4", vlm: "40" }],
    ] as Array<[string, { pnl: string; roi: string; vlm: string }]>,
  };
}

describe("parseLeaderboard — real sample", () => {
  const at = new Date("2026-09-29T00:00:00Z");

  it("maps every window of every row", () => {
    const rows = parseLeaderboard(sample, at);
    expect(rows).toHaveLength(sample.leaderboardRows.length);

    const raw = sample.leaderboardRows[0];
    const perf = new Map(raw.windowPerformances!);
    const row = rows[0];
    expect(row.address).toBe(raw.ethAddress.toLowerCase());
    expect(Number(row.accountValue)).toBeCloseTo(Number(raw.accountValue), 2);
    expect(Number(row.pnlDay)).toBeCloseTo(Number(perf.get("day")!.pnl), 4);
    expect(Number(row.pnlWeek)).toBeCloseTo(Number(perf.get("week")!.pnl), 4);
    expect(Number(row.pnlMonth)).toBeCloseTo(Number(perf.get("month")!.pnl), 4);
    expect(Number(row.pnlAllTime)).toBeCloseTo(Number(perf.get("allTime")!.pnl), 4);
    expect(Number(row.roiMonth)).toBeCloseTo(Number(perf.get("month")!.roi), 8);
    expect(Number(row.volumeAllTime)).toBeCloseTo(Number(perf.get("allTime")!.vlm), 2);
    expect(row.updatedAt).toBe(at);
    expect(row.isVault).toBe(false);

    const named = rows.filter((r) => r.displayName !== null).map((r) => r.displayName);
    expect(named).toContain("PURRINA Pro Plan");
    expect(rows.filter((r) => r.displayName === null).length).toBeGreaterThan(30);
  });

  it("flags rows whose address is in the vault list", () => {
    const rows = parseLeaderboard(sample, at, parseVaults(vaultSample));
    expect(rows.filter((r) => r.isVault).map((r) => r.address).sort()).toEqual(SAMPLE_VAULTS);
  });

  it("lowercases, de-duplicates, drops invalid addresses and zero-fills missing windows", () => {
    const upper = `0x${"AB".repeat(20)}`;
    const rows = parseLeaderboard(
      {
        leaderboardRows: [
          { ethAddress: upper, accountValue: "5", displayName: "  Whale  ", windowPerformances: [["week", { pnl: "7" }]] },
          { ethAddress: upper.toLowerCase(), accountValue: "9", windowPerformances: [] },
          { ethAddress: "not-an-address", accountValue: "1" },
          { ethAddress: addr(1), accountValue: "NaN", displayName: "   " },
        ],
      },
      at,
    );
    expect(rows.map((r) => r.address)).toEqual([upper.toLowerCase(), addr(1)]);
    expect(rows[0]).toMatchObject({
      displayName: "Whale",
      accountValue: "5",
      pnlWeek: "7",
      roiWeek: "0",
      volumeWeek: "0",
      pnlDay: "0",
      pnlMonth: "0",
      pnlAllTime: "0",
    });
    expect(rows[1]).toMatchObject({ displayName: null, accountValue: "0", volumeAllTime: "0" });
  });

  it("rejects a payload without leaderboardRows", () => {
    expect(() => parseLeaderboard({ nope: [] }, at)).toThrow(/leaderboardRows/);
  });

  it("parses the vault list: lowercased, closed vaults included, junk skipped", () => {
    const set = parseVaults([
      ...vaultSample,
      { summary: { vaultAddress: `0x${"CD".repeat(20)}` } },
      { summary: { vaultAddress: "0x12" } },
      { summary: {} },
      null,
    ]);
    expect(set.size).toBe(vaultSample.length + 1);
    expect(set.has(`0x${"cd".repeat(20)}`)).toBe(true);
    for (const v of vaultSample) expect(set.has(v.summary.vaultAddress.toLowerCase())).toBe(true);
    expect(vaultSample.some((v) => v.summary.isClosed)).toBe(true);
    expect(() => parseVaults({ vaults: [] })).toThrow(/not an array/);
  });

  it("chunks under Postgres' 65,535-parameter cap", () => {
    expect(UPSERT_CHUNK_ROWS * 18).toBeLessThan(65_535); // 18 trader_stats columns
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("LeaderboardIngestService — real Postgres", () => {
  const db = getTestDb();
  let settings: SettingsService;
  let service: LeaderboardIngestService;

  /** Routes the two stats-host URLs; `vaults` may be a failure status. */
  function mockFetch(vaults: unknown = vaultSample, vaultStatus = 200) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === LEADERBOARD_URL) return new Response(JSON.stringify(sample), { status: 200 });
      if (url === VAULTS_URL) return new Response(JSON.stringify(vaults), { status: vaultStatus });
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  afterEach(() => { delete process.env.DISCOVERY_LEADERBOARD_REFRESH_MINUTES; });
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE trader_stats`);
    await db.delete(appSettings);
    settings = new SettingsService(new SettingsRepository(db), new UnitOfWork(db));
    service = new LeaderboardIngestService(testConfig(), new LeaderboardIngestRepository(db), new UnitOfWork(db), settings);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  const all = () => db.select().from(traderStats).orderBy(asc(traderStats.address));
  const vaultRows = async () => (await all()).filter((r) => r.isVault).map((r) => r.address);

  it("replaces the table: upserts new values and removes rows the import didn't include", async () => {
    const t1 = new Date("2026-09-29T00:00:00Z");
    await service.replaceAll(
      parseLeaderboard({ leaderboardRows: [lbRow(addr(1), 10), lbRow(addr(2), 20), lbRow(addr(3), 30)] }, t1),
      t1,
    );
    expect((await all()).map((r) => r.address)).toEqual([addr(1), addr(2), addr(3)]);

    const t2 = new Date("2026-09-29T00:15:00Z");
    const removed = await service.replaceAll(
      parseLeaderboard({ leaderboardRows: [lbRow(addr(2), 200, "Two"), lbRow(addr(3), 300), lbRow(addr(4), 400)] }, t2),
      t2,
    );
    expect(removed).toBe(1);
    const rows = await all();
    expect(rows.map((r) => r.address)).toEqual([addr(2), addr(3), addr(4)]);
    expect(rows[0]).toMatchObject({ pnlMonth: "200", displayName: "Two", updatedAt: t2 });
    expect(rows.every((r) => r.updatedAt.getTime() === t2.getTime())).toBe(true);
    expect(await service.lastImportAt()).toEqual(t2);
  });

  it("imports more rows than one statement could bind (chunked)", async () => {
    const n = UPSERT_CHUNK_ROWS * 2 + 500; // 4,500 × 18 params > 65,535
    const at = new Date();
    const rows = parseLeaderboard(
      { leaderboardRows: Array.from({ length: n }, (_, i) => lbRow(addr(i + 1), i)) },
      at,
    );
    await service.replaceAll(rows, at);
    const [{ total }] = await db.select({ total: count() }).from(traderStats);
    expect(total).toBe(n);
  });

  it("rolls back earlier chunks when a later leaderboard chunk fails", async () => {
    const beforeAt = new Date("2026-09-29T00:00:00Z");
    await service.replaceAll(parseLeaderboard({ leaderboardRows: [lbRow(addr(1), 10), lbRow(addr(99999), 20)] }, beforeAt), beforeAt);
    const before = await all();
    const at = new Date("2026-09-29T00:15:00Z");
    const rows = parseLeaderboard({ leaderboardRows: Array.from({ length: UPSERT_CHUNK_ROWS + 1 }, (_, i) => lbRow(addr(i + 1), 200)) }, at);
    rows[rows.length - 1].accountValue = "not-a-number";
    await expect(service.replaceAll(rows, at)).rejects.toThrow();
    expect(await all()).toEqual(before);
    expect(await service.lastImportAt()).toEqual(beforeAt);
  });

  it("refuses an empty import and keeps the current table", async () => {
    const at = new Date();
    await service.replaceAll(parseLeaderboard({ leaderboardRows: [lbRow(addr(1), 1)] }, at), at);
    await expect(service.replaceAll([], new Date())).rejects.toThrow(/no rows/);
    expect(await all()).toHaveLength(1);
  });

  it("refresh() imports the leaderboard and flags vaults from the vault list", async () => {
    const fetchSpy = mockFetch();
    const result = await service.refresh();
    expect(fetchSpy.mock.calls.map((c) => String(c[0])).sort()).toEqual([LEADERBOARD_URL, VAULTS_URL].sort());
    expect(result).toMatchObject({ rows: sample.leaderboardRows.length, vaults: 2 });
    expect(await all()).toHaveLength(sample.leaderboardRows.length);
    expect(await vaultRows()).toEqual(SAMPLE_VAULTS);
    // Off-leaderboard vaults are answered from the in-memory set.
    expect(service.isVault(vaultSample.at(-1)!.summary.vaultAddress.toLowerCase())).toBe(true);
    expect(service.isVault(addr(1))).toBe(false);
  });

  it("keeps the previous vault flags when the vault list fails", async () => {
    mockFetch();
    await service.refresh();
    vi.restoreAllMocks();

    // A fresh process (no in-memory list) whose vault fetch fails.
    const restarted = new LeaderboardIngestService(testConfig(), new LeaderboardIngestRepository(db), new UnitOfWork(db), settings);
    mockFetch("oops", 503);
    const result = await restarted.refresh();
    expect(result.vaults).toBeNull();
    expect(await vaultRows()).toEqual(SAMPLE_VAULTS);

    // A malformed list counts as a failure too.
    vi.restoreAllMocks();
    mockFetch({ not: "an array" });
    expect((await restarted.refresh()).vaults).toBeNull();
    expect(await vaultRows()).toEqual(SAMPLE_VAULTS);
  });

  it("new rows use this process's last vault list when the current fetch fails", async () => {
    mockFetch();
    await service.refresh();
    await db.execute(sql`DELETE FROM trader_stats WHERE is_vault`);
    vi.restoreAllMocks();
    mockFetch("oops", 500);
    await service.refresh();
    expect(await vaultRows()).toEqual(SAMPLE_VAULTS);
  });

  it("imports when older than DISCOVERY_LEADERBOARD_REFRESH_MINUTES (default 15), read on every check", async () => {
    const fetchSpy = mockFetch();
    const leaderboardFetches = () => fetchSpy.mock.calls.filter((c) => String(c[0]) === LEADERBOARD_URL).length;
    expect(await service.refreshIfStale()).not.toBeNull(); // empty table
    expect(leaderboardFetches()).toBe(1);

    const t = Date.now();
    expect(await service.refreshIfStale(t + 14 * 60_000)).toBeNull();
    expect(await service.refreshIfStale(t + 16 * 60_000)).not.toBeNull();
    expect(leaderboardFetches()).toBe(2);

    process.env.DISCOVERY_LEADERBOARD_REFRESH_MINUTES = "60"; // deploy-time since 2026-10-05; testConfig() reads it per access
    const t2 = Date.now();
    expect(await service.refreshIfStale(t2 + 30 * 60_000)).toBeNull();
    expect(await service.refreshIfStale(t2 + 61 * 60_000)).not.toBeNull();
    expect(leaderboardFetches()).toBe(3);
  });

  it("concurrent refreshes share one fetch; a failed leaderboard rejects without touching the table", async () => {
    const fetchSpy = mockFetch();
    await Promise.all([service.refresh(), service.refresh()]);
    expect(fetchSpy.mock.calls.filter((c) => String(c[0]) === LEADERBOARD_URL)).toHaveLength(1);

    fetchSpy.mockImplementation(async () => new Response("bad gateway", { status: 502 }));
    await expect(service.refresh()).rejects.toThrow(/502/);
    // The scheduled tick logs instead of throwing; make the table stale first.
    process.env.DISCOVERY_LEADERBOARD_REFRESH_MINUTES = "5";
    await db.execute(sql`UPDATE trader_stats SET updated_at = now() - interval '1 hour'`);
    await expect(service.onTick()).resolves.toBeUndefined();
    expect(await all()).toHaveLength(sample.leaderboardRows.length);
  });
});
