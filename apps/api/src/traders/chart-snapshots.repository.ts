import { Inject, Injectable } from "@nestjs/common";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";
import { equitySnapshots } from "@trading-dashboard/shared/database";
import { and, eq, sql } from "drizzle-orm";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

export interface SnapshotPositionRow { ts: Date; coin: string | null; szi: string | null; entryPx: string | null; upnl: string | null }

/** The worker's five-minute equity and position snapshots, read for the chart. */
@Injectable()
export class ChartSnapshotsRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  /** When the address's snapshots begin, or null when it was never watched. */
  async coverageStart(address: string): Promise<Date | null> {
    const [first] = await this.db.select({ ts: sql<Date | string | null>`min(${equitySnapshots.ts})` }).from(equitySnapshots)
      .where(and(eq(equitySnapshots.chain, CHAIN_DEFAULT), eq(equitySnapshots.address, address)));
    return first?.ts ? new Date(first.ts) : null;
  }

  /** The latest snapshot in each bucket of `bucketMs` between from and to,
   * one row per position (a flat snapshot gives one row with no coin). */
  async positionsByBucket(address: string, from: Date, to: Date, bucketMs: number): Promise<SnapshotPositionRow[]> {
    const result = await this.db.execute(sql`
      with picked as (
        select distinct on (bucket) ts from (
          select ts, floor(extract(epoch from ts) * 1000 / ${bucketMs}) as bucket from equity_snapshots
          where chain = ${CHAIN_DEFAULT} and address = ${address} and ts >= ${from} and ts <= ${to}
        ) b order by bucket, ts desc
      )
      select p.ts, ps.coin, ps.szi::text as szi, ps.entry_px::text as entry_px, ps.unrealized_pnl::text as upnl
      from picked p left join position_snapshots ps on ps.chain = ${CHAIN_DEFAULT} and ps.address = ${address} and ps.ts = p.ts
      order by p.ts, ps.coin
    `);
    return result.rows.map((r) => ({
      ts: new Date(r.ts as string | Date),
      coin: (r.coin as string | null) ?? null,
      szi: (r.szi as string | null) ?? null,
      entryPx: (r.entry_px as string | null) ?? null,
      upnl: (r.upnl as string | null) ?? null,
    }));
  }
}
