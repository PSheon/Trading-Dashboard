import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { AdminSources } from "@trading-dashboard/shared/contracts";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
@Injectable()
export class AdminSourcesRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  async list(): Promise<AdminSources> {
    return this.db.transaction(
      async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '2000ms'`);
        const { rows } = await tx.execute(sql`
    SELECT 'leaderboard' AS id,count(*)::int AS count,max(updated_at) AS "latestAt" FROM trader_stats WHERE chain='hyperliquid'
    UNION ALL SELECT 'discovery',count(*)::int,max(portfolio_at) FROM discovery_traders WHERE chain='hyperliquid' AND in_pool
    UNION ALL SELECT 'kol',count(*)::int,max(updated_at) FROM kol_traders WHERE chain='hyperliquid'
    UNION ALL SELECT 'watched',count(*)::int,NULL::timestamptz FROM leaders WHERE chain='hyperliquid' AND active
    UNION ALL SELECT 'favorites',count(DISTINCT address)::int,max(created_at) FROM user_favorites WHERE chain='hyperliquid'
    UNION ALL SELECT 'imports',count(*)::int,max(imported_at) FROM leader_lists
   `);
        return {
          sampledAt: new Date().toISOString(),
          items: rows.map((r) => ({
            id: r.id as AdminSources["items"][number]["id"],
            count: Number(r.count),
            latestAt:
              r.latestAt === null
                ? null
                : new Date(r.latestAt as string).toISOString(),
          })),
        };
      },
      { accessMode: "read only" },
    );
  }
}
