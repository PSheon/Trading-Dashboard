import { and, asc, eq, gte, lte, notLike, type SQL } from "drizzle-orm";
import { fills } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { HlUserFill } from "../hyperliquid/types.js";

/** Fills per page when a whole verified span is walked (tracked rebuilds,
 * full continuity checks). A span is no longer bounded by a small backfill
 * cap, so it is never read into memory at once. */
export const SPAN_PAGE_FILLS = 20_000;

/** Each coin's fills at its latest millisecond (where a next page continues). */
export function lastMillisecondPerCoin(list: HlUserFill[]): HlUserFill[] {
  const latest = new Map<string, number>();
  for (const f of list) latest.set(f.coin, Math.max(latest.get(f.coin) ?? -Infinity, f.time));
  return list.filter((f) => f.time === latest.get(f.coin));
}

/**
 * The stored fills of `address` in `[from, through]` as Hyperliquid sent
 * them, oldest first, in pages of about `pageSize` that never split a
 * millisecond: a full page stops before its last millisecond and the next
 * one starts there; a millisecond that alone fills a page is read whole.
 * `perpOnly` leaves out spot fills (`@…` and `…/…` coins).
 */
export async function* storedFillPages(db: DrizzleDb, address: string, from: Date, through: Date,
  options: { pageSize?: number; perpOnly?: boolean } = {}): AsyncGenerator<HlUserFill[]> {
  const pageSize = options.pageSize ?? SPAN_PAGE_FILLS;
  const scope: SQL[] = [eq(fills.chain, CHAIN_DEFAULT), eq(fills.address, address), lte(fills.ts, through)];
  if (options.perpOnly) scope.push(notLike(fills.coin, "@%"), notLike(fills.coin, "%/%"));
  const raw = (rows: Array<{ raw: unknown }>) => rows.map((row) => row.raw as HlUserFill);
  let cursor = from;
  while (cursor.getTime() <= through.getTime()) {
    const rows = await db.select({ raw: fills.raw, ts: fills.ts }).from(fills)
      .where(and(...scope, gte(fills.ts, cursor))).orderBy(asc(fills.ts), asc(fills.tid)).limit(pageSize);
    if (rows.length < pageSize) {
      if (rows.length > 0) yield raw(rows);
      return;
    }
    const last = rows.at(-1)!.ts.getTime();
    const page = rows.filter((row) => row.ts.getTime() < last);
    if (page.length > 0) {
      yield raw(page);
      cursor = new Date(last);
    } else {
      yield raw(await db.select({ raw: fills.raw }).from(fills).where(and(...scope, eq(fills.ts, new Date(last)))).orderBy(asc(fills.tid)));
      cursor = new Date(last + 1);
    }
  }
}
