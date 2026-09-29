import { sql } from "drizzle-orm";
import { users } from "@trading-dashboard/shared/database";

import type { TestDb } from "./db-test-utils.js";

/** The tables the admin specs touch. `truncateAll` doesn't know the Stage 2
 * tables yet, so these specs clean up after themselves. */
export async function truncateAdminTables(db: TestDb): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE
      admin_audit_logs,
      users, user_favorites, notification_channels, app_settings, revenue_snapshots,
      alerts, alert_rules, leaders
    RESTART IDENTITY CASCADE
  `);
}

let seq = 0;

export async function insertUser(
  db: TestDb,
  values: Partial<typeof users.$inferInsert> = {},
): Promise<typeof users.$inferSelect> {
  seq += 1;
  const [row] = await db
    .insert(users)
    .values({ privyUserId: `did:privy:test-${seq}-${Math.random().toString(36).slice(2)}`, ...values })
    .returning();
  return row;
}
