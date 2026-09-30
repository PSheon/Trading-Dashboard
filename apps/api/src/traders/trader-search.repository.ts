import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import {
  traderSearchQuerySchema,
  type TraderSearchResponse,
} from "@trading-dashboard/shared/contracts";
import { parseOr400 } from "../common/http/validation.js";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
/** Identity lookup only: no upstream fetch, warm-up or fabricated financial rows. */
@Injectable()
export class TraderSearchRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  async search(input: string): Promise<TraderSearchResponse> {
    const q = parseOr400(traderSearchQuerySchema, { q: input })
      .q.replace(/^@/, "")
      .toLowerCase();
    const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
    const prefix = escaped + "%";
    const contains = "%" + escaped + "%";
    const rows = await this.db.transaction(
      async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '2000ms'`);
        const result = await tx.execute(sql`SELECT
        coalesce(k.address, s.address) AS address,
        coalesce(nullif(k.display_name, ''), s.display_name) AS "displayName",
        k.x_handle AS "xHandle", CASE WHEN k.address IS NOT NULL THEN 'kol' ELSE 'leaderboard' END AS source,
        s.address IS NOT NULL AS "hasLeaderboardData"
        FROM (SELECT * FROM kol_traders WHERE chain = 'hyperliquid') k
        FULL JOIN (SELECT * FROM trader_stats WHERE chain = 'hyperliquid') s ON s.address = k.address
        WHERE coalesce(k.address, s.address) LIKE ${prefix}
          OR k.display_name ILIKE ${contains} OR s.display_name ILIKE ${contains} OR k.x_handle ILIKE ${contains}
        ORDER BY CASE WHEN lower(k.x_handle) = ${q} OR lower(k.display_name) = ${q} OR lower(s.display_name) = ${q} OR coalesce(k.address, s.address) = ${q} THEN 0 ELSE 1 END,
          CASE WHEN k.address IS NOT NULL THEN 0 ELSE 1 END,
          lower(coalesce(nullif(k.display_name, ''), s.display_name, '')), coalesce(k.address, s.address)
        LIMIT 21`);
        return result.rows as TraderSearchResponse["items"];
      },
      { accessMode: "read only" },
    );
    return { items: rows.slice(0, 20), hasMore: rows.length > 20 };
  }
}
