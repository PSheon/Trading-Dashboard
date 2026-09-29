import { Inject, Injectable } from "@nestjs/common";
import { eq, gte, sql } from "drizzle-orm";
import { alerts, leaders, users } from "@trading-dashboard/shared/database";
import { type AdminOverview } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { RevenueService } from "./revenue.service.js";

const DAY_MS = 86_400_000;

/** GET /admin/overview — the admin home's KPI row. */
@Injectable()
export class AdminOverviewService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly revenue: RevenueService,
  ) {}

  async overview(now = new Date()): Promise<AdminOverview> {
    const since7d = new Date(now.getTime() - 7 * DAY_MS);
    const since24h = new Date(now.getTime() - DAY_MS);

    const [[userCounts], [traderCounts], alertRows, revenue30dUsd] = await Promise.all([
      this.db
        .select({
          total: sql<number>`count(*)::int`,
          new7d: sql<number>`(count(*) filter (where ${users.createdAt} >= ${since7d}))::int`,
          active7d: sql<number>`(count(*) filter (where ${users.lastLoginAt} >= ${since7d}))::int`,
        })
        .from(users),
      this.db
        .select({
          total: sql<number>`count(*)::int`,
          imported: sql<number>`(count(*) filter (where ${leaders.source} = 'import'))::int`,
          favorited: sql<number>`(count(*) filter (where ${leaders.source} = 'favorite'))::int`,
        })
        .from(leaders)
        .where(eq(leaders.active, true)),
      this.db
        .select({ status: alerts.sendStatus, n: sql<number>`count(*)::int` })
        .from(alerts)
        .where(gte(alerts.sentAt, since24h))
        .groupBy(alerts.sendStatus),
      this.revenue.earned30dUsd(now),
    ]);

    const byStatus = new Map(alertRows.map((r) => [r.status, r.n]));
    return {
      users: userCounts,
      trackedTraders: traderCounts,
      alerts24h: {
        sent: byStatus.get("sent") ?? 0,
        failed: byStatus.get("failed") ?? 0,
        dryRun: byStatus.get("dry_run") ?? 0,
      },
      revenue30dUsd,
      generatedAt: now,
    };
  }
}
