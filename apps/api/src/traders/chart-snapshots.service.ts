import { Inject, Injectable } from "@nestjs/common";
import { CHAIN_DEFAULT, chartSnapshotsQuerySchema, type ChartSnapshotsResponse, type TraderWindow } from "@trading-dashboard/shared/contracts";
import { equitySnapshots } from "@trading-dashboard/shared/database";
import { and, eq, sql } from "drizzle-orm";

import { parseOr400 } from "../common/http/validation.js";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

export const MAX_CHART_SNAPSHOTS = 60;
export const MAX_SNAPSHOT_POSITIONS = 20;
const SPAN_MS: Record<Exclude<TraderWindow, "allTime">, number> = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 };

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * CopyDog's `chart-snapshots` (GET /api/hyperliquid/traders/:a/chart-snapshots,
 * read 2026-10-04: `{window, kind, coverageStartMs, snapshots: [{t, n, upnl,
 * positions: [{coin, szi, entryPx, markPx, notional, upnl}]}]}`), from the
 * snapshots the worker takes of watched traders every five minutes: a
 * database read, no Hyperliquid call.
 */
@Injectable()
export class ChartSnapshotsService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async read(address: string, query: unknown, now = new Date()): Promise<ChartSnapshotsResponse> {
    const { window, kind } = parseOr400(chartSnapshotsQuerySchema, query);
    const a = address.toLowerCase();
    const [first] = await this.db.select({ ts: sql<Date | string | null>`min(${equitySnapshots.ts})` }).from(equitySnapshots)
      .where(and(eq(equitySnapshots.chain, CHAIN_DEFAULT), eq(equitySnapshots.address, a)));
    const coverageStart = first?.ts ? new Date(first.ts) : null;
    if (!coverageStart) return { address: a, window, kind, coverageStart: null, snapshots: [] };
    const from = new Date(Math.max(coverageStart.getTime(), window === "allTime" ? 0 : now.getTime() - SPAN_MS[window]));
    const bucketMs = Math.max(60_000, Math.ceil((now.getTime() - from.getTime()) / MAX_CHART_SNAPSHOTS));
    const result = await this.db.execute(sql`
      with picked as (
        select distinct on (bucket) ts from (
          select ts, floor(extract(epoch from ts) * 1000 / ${bucketMs}) as bucket from equity_snapshots
          where chain = ${CHAIN_DEFAULT} and address = ${a} and ts >= ${from} and ts <= ${now}
        ) b order by bucket, ts desc
      )
      select p.ts, ps.coin, ps.szi::text as szi, ps.entry_px::text as entry_px, ps.unrealized_pnl::text as upnl
      from picked p left join position_snapshots ps on ps.chain = ${CHAIN_DEFAULT} and ps.address = ${a} and ps.ts = p.ts
      order by p.ts, ps.coin
    `);
    const byTime = new Map<number, ChartSnapshotsResponse["snapshots"][number]["positions"]>();
    for (const r of result.rows) {
      const t = new Date(r.ts as string | Date).getTime();
      const list = byTime.get(t) ?? [];
      byTime.set(t, list);
      if (r.coin === null) continue;
      const szi = num(r.szi) ?? 0;
      const entryPx = num(r.entry_px);
      const upnl = num(r.upnl);
      const markPx = entryPx !== null && upnl !== null && szi !== 0 ? entryPx + upnl / szi : null;
      list.push({ coin: String(r.coin), szi, entryPx, markPx, notional: markPx === null ? null : Math.abs(szi) * markPx, upnl });
    }
    const snapshots = [...byTime.entries()].map(([t, positions]) => {
      const sorted = positions.sort((x, y) => (y.notional ?? -1) - (x.notional ?? -1));
      const upnl = positions.every((p) => p.upnl !== null) ? positions.reduce((s, p) => s + p.upnl!, 0) : null;
      return { t, n: positions.length, upnl, positions: sorted.slice(0, MAX_SNAPSHOT_POSITIONS) };
    });
    return { address: a, window, kind, coverageStart, snapshots };
  }
}
