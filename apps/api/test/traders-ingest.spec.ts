import { readFileSync } from "node:fs";

import { traderStats } from "@trading-dashboard/shared";
import { asc, count, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chunk, parseLeaderboard, UPSERT_CHUNK_ROWS, type LeaderboardPayload } from "../src/traders/leaderboard.js";
import { LeaderboardIngestService, LEADERBOARD_REFRESH_MS } from "../src/traders/leaderboard-ingest.service.js";
import { closeTestDb, getTestDb } from "./db-test-utils.js";

const sample = JSON.parse(
  readFileSync(new URL("./fixtures/leaderboard.json", import.meta.url), "utf8"),
) as LeaderboardPayload;

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

    const named = rows.filter((r) => r.displayName !== null).map((r) => r.displayName);
    expect(named).toContain("PURRINA Pro Plan");
    expect(rows.filter((r) => r.displayName === null).length).toBeGreaterThan(30);
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

  it("chunks under Postgres' 65,535-parameter cap", () => {
    expect(UPSERT_CHUNK_ROWS * 17).toBeLessThan(65_535);
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("LeaderboardIngestService — real Postgres", () => {
  const db = getTestDb();
  const service = new LeaderboardIngestService(db);

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE trader_stats`);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  const all = () => db.select().from(traderStats).orderBy(asc(traderStats.address));

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
    const n = UPSERT_CHUNK_ROWS * 2 + 500; // 4,500 × 17 params > 65,535
    const at = new Date();
    const rows = parseLeaderboard(
      { leaderboardRows: Array.from({ length: n }, (_, i) => lbRow(addr(i + 1), i)) },
      at,
    );
    await service.replaceAll(rows, at);
    const [{ total }] = await db.select({ total: count() }).from(traderStats);
    expect(total).toBe(n);
  });

  it("refuses an empty import and keeps the current table", async () => {
    const at = new Date();
    await service.replaceAll(parseLeaderboard({ leaderboardRows: [lbRow(addr(1), 1)] }, at), at);
    await expect(service.replaceAll([], new Date())).rejects.toThrow(/no rows/);
    expect(await all()).toHaveLength(1);
  });

  it("refresh() fetches the leaderboard and imports it; refreshIfStale() skips a fresh table", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify(sample), { status: 200 }));
    const result = await service.refresh();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard");
    expect(result.rows).toBe(sample.leaderboardRows.length);
    expect(await all()).toHaveLength(sample.leaderboardRows.length);

    expect(await service.refreshIfStale()).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // 16 minutes later it's stale again.
    await service.refreshIfStale(Date.now() + LEADERBOARD_REFRESH_MS + 60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("concurrent refreshes share one fetch; a failed fetch rejects without touching the table", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify(sample), { status: 200 }));
    await Promise.all([service.refresh(), service.refresh()]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockImplementation(async () => new Response("bad gateway", { status: 502 }));
    await expect(service.refresh()).rejects.toThrow(/502/);
    // The scheduled handler logs instead of throwing.
    await expect(service.onSchedule()).resolves.toBeUndefined();
    expect(await all()).toHaveLength(sample.leaderboardRows.length);
  });
});
