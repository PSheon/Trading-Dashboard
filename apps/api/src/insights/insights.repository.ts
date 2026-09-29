import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

interface SnapshotRow {
  address: string;
  ts: Date;
  coin: string | null;
  szi: string | null;
  entry_px: string | null;
  unrealized_pnl: string | null;
}

@Injectable()
export class InsightsRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  /** Per active leader, the snapshot run in [from, to] closest to `target`,
   * with its position rows (one row with null coin when flat). */
  async snapshotSet(
    target: Date,
    from: number,
    to: number,
  ): Promise<{ rows: SnapshotRow[]; addresses: number; latestTs: Date | null }> {
    const result = await this.db.execute<{
      address: string;
      ts: Date;
      coin: string | null;
      szi: string | null;
      entry_px: string | null;
      unrealized_pnl: string | null;
    }>(sql`
      with chosen as (
        select distinct on (e.address) e.address, e.ts
        from equity_snapshots e
        join leaders l on l.chain = e.chain and l.address = e.address and l.active
        where e.chain = ${CHAIN_DEFAULT}
          and e.ts >= ${new Date(from).toISOString()}::timestamptz
          and e.ts <= ${new Date(to).toISOString()}::timestamptz
        order by e.address, abs(extract(epoch from (e.ts - ${target.toISOString()}::timestamptz))), e.ts desc
      )
      select c.address, c.ts, p.coin, p.szi, p.entry_px, p.unrealized_pnl
      from chosen c
      left join position_snapshots p
        on p.chain = ${CHAIN_DEFAULT} and p.address = c.address and p.ts = c.ts
    `);
    const rows = result.rows.map((r) => ({ ...r, ts: new Date(r.ts) }));
    const addresses = new Set(rows.map((r) => r.address));
    let latest: number | null = null;
    for (const r of rows) latest = Math.max(latest ?? 0, r.ts.getTime());
    return { rows, addresses: addresses.size, latestTs: latest === null ? null : new Date(latest) };
  }
}
