import { adminSettingsSchema } from "@trading-dashboard/shared/contracts";
import * as schema from "@trading-dashboard/shared/database";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";

import { HistoryFillStore, type StoredHistoryFill } from "../src/traders/history-fill.store.js";

export type TestDb = NodePgDatabase<typeof schema>;

/** Destructive tests may only use an explicitly named, local test database.
 * Never inherit DATABASE_URL: it may belong to a development or live service.
 * Query options are forbidden because pg supports host/database overrides. */
function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error("TEST_DATABASE_URL is required for the test database");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid test database URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/[a-zA-Z0-9_]+_test$/.test(url.pathname) || url.search || url.hash
  ) {
    throw new Error("Unsafe test database: use a loopback host, a database ending in _test, and no URL options");
  }
  return raw;
}

let pool: Pool | undefined;

/** Real PostgreSQL; setup and migration instructions are in apps/api/README.md. */
export function getTestDb(): TestDb {
  if (!pool) {
    pool = new Pool({ connectionString: testDatabaseUrl() });
  }
  return drizzle(pool, { schema });
}

/** Clears every table between tests so specs don't leak state into each
 * other. RESTART IDENTITY resets serial/bigserial PKs too. */
export async function truncateAll(db: TestDb): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE
      favorite_group_members, favorite_groups, backfill_jobs, admin_audit_logs,
      alerts, alert_rules, actions, position_snapshots, equity_snapshots,
      fill_coverage, archive_coverage, archive_ingest_state, history_fills, history_accounts, history_terms, analysis_history_jobs, fills, coin_meta, leader_list_items, leader_lists, leaders, trader_trades, trader_analytics, kol_traders, kol_avatars, discovery_traders, cohort_members, cohort_snapshots,
      notification_channels, user_favorites, users, trader_stats,
      app_settings, revenue_snapshots, telegram_link_tokens, notification_cooldowns, notification_outbox, action_outbox,
      copy_ledger, copy_paper_fills, copy_reservations, copy_orders, copy_signal_legs, copy_positions, copy_strategy_versions, copy_strategies,
      copy_signal_outbox, copy_consumer_checkpoints, copy_controls, copy_control_events, copy_risk_policies, paper_accounts
    RESTART IDENTITY CASCADE
  `);
}

/** Every stored history fill with its key, through the store (the only
 * reader of `history_fills`). */
export async function storedFills(db: TestDb, only?: string): Promise<Array<StoredHistoryFill & { address: string; tid: number }>> {
  const store = new HistoryFillStore(db);
  const accounts = await db.select().from(schema.historyAccounts).orderBy(schema.historyAccounts.address);
  const rows = [];
  for (const { address } of accounts) {
    if (only !== undefined && address !== only) continue;
    for (const row of await store.read(address)) rows.push({ ...row, address, tid: row.fill.tid });
  }
  return rows;
}

/** Opens copy trading (`general.copyTradingEnabled`, off until an admin
 * turns it on) by writing the stored setting, without the audit entry a
 * save through the service makes. The caller drops the service's cache. */
export async function openCopyTrading(db: TestDb, open = true): Promise<void> {
  // The whole section: a stored row without its other switches reads as damaged.
  const value = { ...adminSettingsSchema.shape.general.parse({}), copyTradingEnabled: open };
  await db.insert(schema.appSettings).values({ key: "general", value }).onConflictDoUpdate({ target: schema.appSettings.key, set: { value } });
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
