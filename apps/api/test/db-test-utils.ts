import * as schema from "@trading-dashboard/shared";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";

export type TestDb = NodePgDatabase<typeof schema>;

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/trading_dashboard_test";

let pool: Pool | undefined;

/** Real Postgres connection for tests — see AGENT report for how the local
 * instance is stood up (`docker run postgres:16-alpine` + the drizzle
 * migration applied once). Every test that touches the DB uses this, not a
 * mock, per the task's explicit "exercise actual DB writes" requirement. */
export function getTestDb(): TestDb {
  if (!pool) {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
  }
  return drizzle(pool, { schema });
}

/** Clears every table between tests so specs don't leak state into each
 * other. RESTART IDENTITY resets serial/bigserial PKs too. */
export async function truncateAll(db: TestDb): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE
      alerts, alert_rules, actions, position_snapshots, equity_snapshots,
      fills, coin_meta, leader_list_items, leader_lists, leaders,
      notification_channels, user_favorites, users, trader_stats,
      app_settings, revenue_snapshots, telegram_link_tokens
    RESTART IDENTITY CASCADE
  `);
}

let userSeq = 0;

/** Inserts a user row directly (no Privy); returns it. */
export async function insertUser(
  db: TestDb,
  overrides: Partial<typeof schema.users.$inferInsert> = {},
): Promise<typeof schema.users.$inferSelect> {
  userSeq += 1;
  const [row] = await db
    .insert(schema.users)
    .values({ privyUserId: `did:privy:test-${userSeq}-${Date.now()}`, ...overrides })
    .returning();
  return row;
}

export async function closeTestDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
