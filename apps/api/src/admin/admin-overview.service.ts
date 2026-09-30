import { Injectable } from "@nestjs/common";
import { type AdminOverview } from "@trading-dashboard/shared/contracts";

import { AdminOverviewRepository } from "./admin-overview.repository.js";
import { RevenueService } from "./revenue.service.js";

const DAY_MS = 86_400_000;

/** GET /admin/overview — the admin home's KPI row. */
@Injectable()
export class AdminOverviewService {
  constructor(
    private readonly repository: AdminOverviewRepository,
    private readonly revenue: RevenueService,
  ) {}

  async overview(now = new Date()): Promise<AdminOverview> {
    const since7d = new Date(now.getTime() - 7 * DAY_MS);
    const since24h = new Date(now.getTime() - DAY_MS);

    const [[userCounts], [traderCounts], alertRows, revenue30dUsd] = await Promise.all([
      this.repository.userCounts(since7d),
      this.repository.traderCounts(),
      this.repository.alertCounts(since24h),
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
