import { Inject, Injectable } from "@nestjs/common";
import { eq, gte, isNull, sql } from "drizzle-orm";
import { alerts, leaders, users } from "@trading-dashboard/shared/database";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

/** Aggregate persisted admin metrics; reporting windows and response assembly stay in the service. */
@Injectable()
export class AdminOverviewRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  userCounts(since7d: Date) {
    return this.db
      .select({
        total: sql<number>`count(*)::int`,
        new7d: sql<number>`(count(*) filter (where ${users.createdAt} >= ${since7d}))::int`,
        active7d: sql<number>`(count(*) filter (where ${users.lastLoginAt} >= ${since7d}))::int`,
      })
      .from(users)
      // Account-deletion tombstones are not users.
      .where(isNull(users.deletedAt));
  }

  traderCounts() {
    return this.db
      .select({
        total: sql<number>`count(*)::int`,
        imported: sql<number>`(count(*) filter (where ${leaders.source} = 'import'))::int`,
        favorited: sql<number>`(count(*) filter (where ${leaders.source} = 'favorite'))::int`,
      })
      .from(leaders)
      .where(eq(leaders.active, true));
  }

  alertCounts(since24h: Date) {
    return this.db
      .select({ status: alerts.sendStatus, n: sql<number>`count(*)::int` })
      .from(alerts)
      .where(gte(alerts.sentAt, since24h))
      .groupBy(alerts.sendStatus);
  }
}
