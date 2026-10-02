import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { historyTerms } from "@trading-dashboard/shared/database";

import { canonicalJson } from "../src/analytics/fill-codec.js";
import type { HlUserFill } from "../src/hyperliquid/types.js";
import { AnalysisHistoryRepository } from "../src/traders/analysis-history.repository.js";
import { HistoryFillStore, HistoryNotConvertedError } from "../src/traders/history-fill.store.js";
import { ALL_SHAPES, SEEN_SHAPES } from "./fill-shapes.js";
import { closeTestDb, getTestDb, storedFills, truncateAll } from "./db-test-utils.js";

const A = `0x${"a1".repeat(20)}`;
const B = `0x${"b2".repeat(20)}`;
const rows = (address: string, fills: HlUserFill[], origin: "rest" | "s3" = "rest") =>
  fills.map((fill) => ({ address, source: fill.twapId == null ? "regular" as const : "twap" as const, origin, fill }));

describe("history fill store: Postgres hands back the fill that was stored", () => {
  const db = getTestDb();
  const store = new HistoryFillStore(db);

  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS analysis_history_fills`);
    await closeTestDb();
  });

  it("every shape, seen or not, reads back value for value (decimal strings as written, unknown keys kept)", async () => {
    await store.insert(rows(A, ALL_SHAPES));
    const read = await store.read(A);
    expect(read).toHaveLength(ALL_SHAPES.length);
    const byTid = new Map(read.map((row) => [row.fill.tid, row.fill]));
    for (const fill of ALL_SHAPES) expect(canonicalJson(byTid.get(fill.tid)), String(fill.tid)).toBe(canonicalJson(fill));
  });

  it("what Hyperliquid sends today lands in typed columns only: no row uses the overflow", async () => {
    await store.insert(rows(A, SEEN_SHAPES));
    const [stats] = (await db.execute<{ n: string; overflow: string; zero_hash: string }>(sql`
      SELECT count(*) AS n, count(extra) AS overflow, count(*) FILTER (WHERE hash = ''::bytea) AS zero_hash FROM history_fills`)).rows;
    expect([Number(stats.n), Number(stats.overflow), Number(stats.zero_hash)]).toEqual([SEEN_SHAPES.length, 0, 1]);
    // The columns are queryable as numbers: Σ closedPnl in SQL.
    const [{ pnl }] = (await db.execute<{ pnl: string }>(sql`SELECT sum(closed_pnl)::text AS pnl FROM history_fills`)).rows;
    expect(pnl).toBe("-0.00000001");
  });

  it("the key is (address, source, tid): a second insert changes nothing and the first origin stays", async () => {
    const [fill] = SEEN_SHAPES;
    await store.insert(rows(A, [fill], "s3"));
    await store.insert(rows(A, [{ ...fill, px: "1.0" }], "rest"));
    await store.insert(rows(B, [fill], "rest"));
    expect((await storedFills(db)).map((row) => [row.address, row.source, row.origin, row.fill.px])).toEqual([[A, "regular", "s3", fill.px], [B, "regular", "rest", fill.px]]);
    // The same tid from the TWAP endpoint is a second row; one fill per tid prefers it.
    const slice = { ...fill, twapId: 77 };
    await store.insert(rows(A, [slice]));
    expect((await store.read(A)).map((row) => row.source)).toEqual(["regular", "twap"]);
    expect(await store.fills(A)).toEqual([slice]);
    expect(await store.count(A)).toBe(2);
  });

  it("known addresses and terms take no new dictionary id", async () => {
    await store.insert(rows(A, SEEN_SHAPES));
    const sequence = async () => (await db.execute<{ last: string }>(sql`SELECT last_value AS last FROM history_terms_id_seq`)).rows[0].last;
    const [terms, before] = [await db.select().from(historyTerms), await sequence()];
    await store.insert(rows(B, SEEN_SHAPES));
    await store.insert(rows(A, SEEN_SHAPES));
    expect(await db.select().from(historyTerms)).toEqual(terms);
    expect(await sequence()).toBe(before);
    expect(new Set(terms.map((row) => row.term))).toEqual(new Set(SEEN_SHAPES.flatMap((fill) => [fill.coin, fill.dir, fill.feeToken!])));
  });

  it("reads a time range in time order, pages one stream in tid order, and removes by address", async () => {
    const at = (tid: number, time: number): HlUserFill => ({ ...SEEN_SHAPES[0], tid, time });
    await store.insert(rows(A, [at(5, 3000), at(9, 1000), at(7, 2000), at(8, 2000)]));
    await store.insert(rows(B, [at(1, 1500)]));
    expect((await store.read(A)).map((row) => row.fill.tid)).toEqual([9, 7, 8, 5]);
    expect((await store.read(A, { from: new Date(2000), before: new Date(3000) })).map((row) => row.fill.tid)).toEqual([7, 8]);
    expect((await store.read(A, { through: new Date(2000) })).map((row) => row.fill.tid)).toEqual([9, 7, 8]);
    expect((await store.page(A, "regular", null, 3)).map((row) => row.fill.tid)).toEqual([5, 7, 8]);
    expect((await store.page(A, "regular", 8n, 3)).map((row) => row.fill.tid)).toEqual([9]);
    expect(await store.page(A, "twap", null, 3)).toEqual([]);
    expect(await store.read(`0x${"00".repeat(20)}`)).toEqual([]);
    expect(await store.remove([A])).toBe(4);
    expect((await storedFills(db)).map((row) => row.address)).toEqual([B]);
  });

  it("concurrent writers of the same new fills and terms store each row once", async () => {
    const fills = Array.from({ length: 300 }, (_, i): HlUserFill => ({ ...SEEN_SHAPES[0], tid: i + 1, coin: `COIN${i % 40}` }));
    await Promise.all([store.insert(rows(A, fills)), new HistoryFillStore(db).insert(rows(A, fills)), new HistoryFillStore(db).insert(rows(B, fills))]);
    expect(await store.count(A)).toBe(300);
    expect(await store.count(B)).toBe(300);
    expect((await db.select().from(historyTerms)).filter((row) => row.term.startsWith("COIN"))).toHaveLength(40);
  });

  it("while unconverted raw rows exist nothing is read or written; once they are retired the same store works", async () => {
    await db.execute(sql`CREATE TABLE analysis_history_fills (tid bigint)`);
    const fresh = new HistoryFillStore(db);
    await expect(fresh.insert(rows(A, SEEN_SHAPES))).rejects.toThrow(HistoryNotConvertedError);
    await expect(fresh.read(A)).rejects.toThrow(HistoryNotConvertedError);
    await expect(new AnalysisHistoryRepository(db).preserve(A, SEEN_SHAPES)).rejects.toThrow(HistoryNotConvertedError);
    // The converter's own store writes regardless.
    await new HistoryFillStore(db, "ignore").insert(rows(A, SEEN_SHAPES.slice(0, 1)));
    await db.execute(sql`ALTER TABLE analysis_history_fills RENAME TO analysis_history_fills_retired`);
    expect(await fresh.read(A)).toHaveLength(1);
    await db.execute(sql`DROP TABLE analysis_history_fills_retired`);
  });
});
