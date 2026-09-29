import { adminOverviewSchema, alertRules, alerts, leaders } from "@trading-dashboard/shared";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminOverviewService } from "../src/admin/admin-overview.service.js";
import type { RevenueService } from "../src/admin/revenue.service.js";
import { insertUser, truncateAdminTables } from "./admin-test-utils.js";
import { closeTestDb, getTestDb } from "./db-test-utils.js";

const MIN = 60_000;
const DAY = 86_400_000;

describe("GET /admin/overview — real Postgres", () => {
  const db = getTestDb();
  const now = new Date("2026-09-29T12:00:00Z");
  const at = (msAgo: number) => new Date(now.getTime() - msAgo);
  let earned30dUsd: ReturnType<typeof vi.fn>;
  let service: AdminOverviewService;

  beforeEach(async () => {
    await truncateAdminTables(db);
    earned30dUsd = vi.fn(async () => 12.5);
    service = new AdminOverviewService(db, { earned30dUsd } as unknown as RevenueService);
  });

  afterAll(async () => {
    await truncateAdminTables(db);
    await closeTestDb();
  });

  it("counts everything as zero on an empty database", async () => {
    earned30dUsd.mockResolvedValue(0);
    const overview = await service.overview(now);
    expect(overview).toEqual({
      users: { total: 0, new7d: 0, active7d: 0 },
      trackedTraders: { total: 0, imported: 0, favorited: 0 },
      alerts24h: { sent: 0, failed: 0, dryRun: 0 },
      revenue30dUsd: 0,
      generatedAt: now,
    });
  });

  it("counts users, tracked traders and alerts inside the 7 d and 24 h windows", async () => {
    // Users: created / last seen just inside and just outside 7 days.
    await insertUser(db, { createdAt: at(7 * DAY - MIN), lastLoginAt: at(7 * DAY - MIN) }); // new, active
    await insertUser(db, { createdAt: at(7 * DAY + MIN), lastLoginAt: at(7 * DAY + MIN) }); // neither
    await insertUser(db, { createdAt: at(30 * DAY), lastLoginAt: at(MIN) }); // active only
    await insertUser(db, { createdAt: at(MIN), lastLoginAt: at(MIN), disabledAt: at(MIN) }); // new, active

    await db.insert(leaders).values([
      { address: "0x1", source: "import" },
      { address: "0x2", source: "import" },
      { address: "0x3", source: "favorite" },
      { address: "0x4", source: "import", active: false },
      { address: "0x5", source: "favorite", active: false },
    ]);

    const [rule] = await db
      .insert(alertRules)
      .values({ scope: "address", kind: "R1", paramsJson: {}, cooldownS: 0, tiers: ["A"] })
      .returning();
    const alert = (sendStatus: "sent" | "failed" | "dry_run" | "pending", sentAt: Date | null) => ({
      ruleId: rule.id,
      payloadJson: {},
      sendStatus,
      sentAt,
    });
    await db.insert(alerts).values([
      alert("sent", at(DAY - MIN)),
      alert("sent", at(MIN)),
      alert("sent", at(DAY + MIN)), // outside
      alert("failed", at(2 * MIN)),
      alert("dry_run", at(3 * MIN)),
      alert("dry_run", at(4 * MIN)),
      alert("dry_run", at(5 * DAY)), // outside
      alert("pending", null),
    ]);

    const overview = await service.overview(now);
    expect(adminOverviewSchema.parse(overview)).toEqual(overview);
    expect(overview.users).toEqual({ total: 4, new7d: 2, active7d: 3 });
    expect(overview.trackedTraders).toEqual({ total: 3, imported: 2, favorited: 1 });
    expect(overview.alerts24h).toEqual({ sent: 2, failed: 1, dryRun: 2 });
    expect(overview.revenue30dUsd).toBe(12.5);
    expect(earned30dUsd).toHaveBeenCalledWith(now);
  });
});
