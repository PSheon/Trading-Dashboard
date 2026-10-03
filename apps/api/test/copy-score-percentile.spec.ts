import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBoard, toCandidate } from "../src/discovery/boards.js";
import type { BoardSourceRow } from "../src/discovery/discovery.repository.js";

const now = new Date("2026-10-03T00:00:00Z");
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(now.getTime()); });
afterEach(() => { vi.restoreAllMocks(); });
const address = (id: number) => `0x${id.toString(16).padStart(40, "0")}`;
const query = { market: "crypto" as const, board: "top100", sort: "copyScore" as const, window: "all" as const };
function candidate(id: number, overrides: Partial<BoardSourceRow> = {}) {
  return toCandidate({
    chain: "hyperliquid", address: address(id), poolRank: id, inPool: true,
    accountValue: "1000", leaderboardAccountValue: "1000", portfolioAt: now,
    pnlAll: "1", roiAll: "1", pnl30d: "0", roi30d: "0", sharpe: "1",
    maxDrawdown: "0", returnSamples: 10, spanDays: "1", copyScore: 99,
    style: "swing", topCoins: [], coinStats: {}, sparkline: [], sparkline30d: [],
    lastTradeAt: now, tradesFrom: now, tradesAt: now, attemptedAt: null,
    performanceAttemptedAt: null, lastError: null, kolName: null, kolAvatarEtag: null,
    kolXHandle: null, kolVerified: null, kolSortOrder: null, leaderboardName: null,
    ...overrides,
  });
}
const pool = { ready: 4, total: 4 };
function four() {
  return [
    candidate(1, { roiAll: "4", sharpe: "1", pnlAll: "2", spanDays: "3" }),
    candidate(2, { roiAll: "3", sharpe: "4", pnlAll: "1", spanDays: "2", style: "intraday", kolVerified: true }),
    candidate(3, { roiAll: "2", sharpe: "3", pnlAll: "4", spanDays: "1" }),
    candidate(4, { roiAll: "1", sharpe: "2", pnlAll: "3", spanDays: "4" }),
  ];
}

describe("candidate-pool copy-score percentiles", () => {
  it("blends the four component ranks at 30/30/20/20 then reranks the blend", () => {
    // Component ranks 0..3, weighted in units 3/3/2/2: A=15, B=17, C=15, D=13.
    // D rank 0 -> 0; tied A/C average rank 1.5 -> 49; B rank 3 -> 98.
    const board = buildBoard(four(), query, pool);
    expect(board.items.map(t => [t.address, t.copyScore])).toEqual([
      [address(2), 98], [address(3), 49], [address(1), 49], [address(4), 0],
    ]);
    expect(board.scoreEligibleCount).toBe(4);
  });

  it("keeps the same denominator through board, style, sort and limit changes", () => {
    const rows = four();
    expect(buildBoard(rows, { ...query, style: "swing" }, pool, 1).items.map(t => [t.address, t.copyScore]))
      .toEqual([[address(3), 49]]);
    expect(buildBoard(rows, { ...query, board: "kol" }, pool).items.map(t => [t.address, t.copyScore]))
      .toEqual([[address(2), 98]]);
    expect(buildBoard(rows, { ...query, sort: "pnl" }, pool).items.map(t => [t.address, t.copyScore]))
      .toEqual([[address(3), 49], [address(4), 0], [address(1), 49], [address(2), 98]]);
  });

  it("does not fabricate zero for missing or non-finite components, and keeps actual zero valid", () => {
    const rows = [candidate(1, { roiAll: "0", pnlAll: "0", sharpe: "0" }), candidate(2),
      candidate(3, { roiAll: null }), candidate(4, { pnlAll: "NaN" }),
      candidate(5, { sharpe: "Infinity" }), candidate(6, { spanDays: null }), candidate(7, { returnSamples: 0 })];
    expect(buildBoard(rows, query, pool).items.map(t => [t.address, t.copyScore])).toEqual([
      [address(2), 98], [address(1), 0], [address(3), null], [address(4), null],
      [address(5), null], [address(6), null], [address(7), null],
    ]);
  });

  it("reranks when the universe changes and resolves ties deterministically", () => {
    const rows = [candidate(2), candidate(1)];
    expect(buildBoard(rows, query, pool).items.map(t => [t.address, t.copyScore]))
      .toEqual([[address(1), 49], [address(2), 49]]);
    rows.push(candidate(3, { roiAll: "2", pnlAll: "2", sharpe: "2", spanDays: "2" }));
    expect(buildBoard(rows.reverse(), query, pool).items.map(t => [t.address, t.copyScore]))
      .toEqual([[address(3), 98], [address(1), 25], [address(2), 25]]);
  });

  it("leaves dust and evidence of dormancy or locally excluded high fill rates out of scores", () => {
    const rows = [candidate(1), candidate(2, { roiAll: "2", pnlAll: "2", sharpe: "2", spanDays: "2" }),
      candidate(3, { accountValue: "1", leaderboardAccountValue: "1" }),
      candidate(4, { lastTradeAt: new Date("2026-07-01") }),
      candidate(5, { archiveExcluded: true }), candidate(6, { lastTradeAt: null })];
    const board = buildBoard(rows, query, pool);
    expect(board.items.filter(t => t.copyScore !== null).map(t => [t.address, t.copyScore]))
      .toEqual([[address(2), 98], [address(1), 0]]);
    expect(board.scoreEligibleCount).toBe(2);
  });
});
