import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RETENTION_DEFAULTS, adminSettingsSchema, deploymentTuningSchema } from "@trading-dashboard/shared/contracts";
import { appSettings } from "@trading-dashboard/shared/database";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { AppConfig } from "../src/config/app-config.js";
import { TUNING_DEFAULTS, tuningConfig, validateEnvironment } from "../src/config/runtime-config.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { SettingsRepository } from "../src/settings/settings.repository.js";
import { SettingsService } from "../src/settings/settings.service.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

/**
 * Admin simplification (Paul, 2026-10-05): fifteen developer knobs moved
 * from the admin settings to the environment, two unread settings were
 * deleted, and migration 0061 strips them from the stored JSON.
 */
const db = getTestDb();
const migration = readFileSync(fileURLToPath(new URL("../../../packages/shared/drizzle/0061_settings_env_moved.sql", import.meta.url)), "utf8");
const BASE = { DATABASE_URL: "postgres://u@localhost/db" };

beforeEach(async () => { await truncateAll(db); });
afterAll(closeTestDb);

describe("deploy-time tuning (DISCOVERY_*, HYPERLIQUID_*_WEIGHT_PER_MIN, RETENTION_*)", () => {
  it("defaults to the values Stage and local ran with, so nothing changes until a variable is set", () => {
    const tuning = validateEnvironment(BASE).tuning;
    expect(tuning).toEqual(TUNING_DEFAULTS);
    expect(tuning).toEqual({
      discovery: { leaderboardRefreshMinutes: 15, candidatePoolSize: 1000, cohortMembersPerTier: 500, cohortRefreshMinutes: 40 },
      weights: { poolLedger: 100, poolPerformance: 240, history: 120, backfill: 120, cohort: 150 },
      retention: RETENTION_DEFAULTS,
    });
    expect(deploymentTuningSchema.parse(tuning)).toEqual(tuning);
  });

  it("reads every variable, within the bounds the admin form had", () => {
    const tuning = tuningConfig({
      DISCOVERY_LEADERBOARD_REFRESH_MINUTES: "30", DISCOVERY_CANDIDATE_POOL_SIZE: "2000", DISCOVERY_COHORT_MEMBERS_PER_TIER: "800",
      DISCOVERY_COHORT_REFRESH_MINUTES: "60", HYPERLIQUID_POOL_LEDGER_WEIGHT_PER_MIN: "0", HYPERLIQUID_POOL_PERFORMANCE_WEIGHT_PER_MIN: "300",
      HYPERLIQUID_HISTORY_WEIGHT_PER_MIN: "60", HYPERLIQUID_BACKFILL_WEIGHT_PER_MIN: "90", HYPERLIQUID_COHORT_WEIGHT_PER_MIN: "60",
      RETENTION_ENABLED: "false", RETENTION_SNAPSHOT_DAYS: "120", RETENTION_AUDIT_DAYS: "730", RETENTION_ACCOUNT_DELETION_DAYS: "400",
      RETENTION_QUEUE_DAYS: "14", RETENTION_ALERT_DAYS: "21",
    });
    expect(tuning).toEqual({
      discovery: { leaderboardRefreshMinutes: 30, candidatePoolSize: 2000, cohortMembersPerTier: 800, cohortRefreshMinutes: 60 },
      weights: { poolLedger: 0, poolPerformance: 300, history: 60, backfill: 90, cohort: 60 },
      retention: { enabled: false, snapshotDays: 120, auditDays: 730, accountDeletionDays: 400, queueDays: 14, alertDays: 21 },
    });
    for (const [key, value, message] of [
      ["DISCOVERY_LEADERBOARD_REFRESH_MINUTES", "4", "between 5 and 240"],
      ["DISCOVERY_CANDIDATE_POOL_SIZE", "49", "between 50 and 5000"],
      ["DISCOVERY_COHORT_MEMBERS_PER_TIER", "2001", "between 0 and 2000"],
      ["HYPERLIQUID_COHORT_WEIGHT_PER_MIN", "601", "between 0 and 600"],
      ["HYPERLIQUID_POOL_LEDGER_WEIGHT_PER_MIN", "1.5", "between 0 and 600"],
      ["RETENTION_AUDIT_DAYS", "29", "between 30 and 3650"],
      ["RETENTION_ALERT_DAYS", "6", "between 7 and 3650"],
    ] as const) {
      expect(() => validateEnvironment({ ...BASE, [key]: value }), key).toThrow(`${key} must be an integer ${message}`);
    }
  });

  it("the budgeter's per-loop caps and the pool's acknowledgement come from the deployment, not the settings", async () => {
    const config = new AppConfig(validateEnvironment({ ...BASE, HYPERLIQUID_POOL_LEDGER_WEIGHT_PER_MIN: "40", HYPERLIQUID_COHORT_WEIGHT_PER_MIN: "70", DISCOVERY_CANDIDATE_POOL_SIZE: "300" }));
    const service = new SettingsService(new SettingsRepository(db), new UnitOfWork(db), undefined, config);
    expect(await service.consumerCaps()).toEqual({ history: 120, backfill: 120, "pool.ledgers": 40, "pool.performance": 240, cohort: 70 });
    service.acknowledgeDiscovery("pool", await service.getAll());
    expect(service.appliedDiscovery()).toMatchObject([{ consumer: "pool", candidatePoolSize: 300, poolWeightPerMinute: 40, poolPerformanceWeightPerMinute: 240, leaderboardRefreshMinutes: 15 }]);
  });
});

describe("migration 0061: the moved and removed settings leave the stored JSON", () => {
  async function apply() {
    for (const statement of migration.split("--> statement-breakpoint")) await db.execute(sql.raw(statement));
  }

  it("strips exactly the moved/removed keys and keeps every other saved value", async () => {
    await db.insert(appSettings).values([
      { key: "general", value: { signupsOpen: false, copyTradingEnabled: true, maxWatchedAddresses: 250, retention: { ...RETENTION_DEFAULTS, snapshotDays: 30 } } },
      { key: "discovery", value: {
        hideVaults: false, lowSampleThreshold: 7, homeMarkets: ["ETH"], featuredAddresses: [`0x${"ab".repeat(20)}`],
        leaderboardRefreshMinutes: 20, candidatePoolSize: 800, poolWeightPerMinute: 100, poolPerformanceWeightPerMinute: 240,
        historyWeightPerMinute: 120, backfillWeightPerMinute: 120, cohortMembersPerTier: 500, cohortRefreshMinutes: 40, cohortWeightPerMinute: 60,
      } },
      { key: "notifications", value: { alertsEnabled: true, maxAlertTraders: 5 } },
      { key: "revenue", value: { builderFeeTenthsBps: 10, referralCode: "ORBIE", builderAddress: null } },
    ]);
    await apply();
    const rows = Object.fromEntries((await db.select().from(appSettings)).map((r) => [r.key, r.value]));
    expect(rows).toEqual({
      general: { signupsOpen: false, copyTradingEnabled: true, maxWatchedAddresses: 250 },
      discovery: { hideVaults: false, lowSampleThreshold: 7, homeMarkets: ["ETH"] },
      notifications: { alertsEnabled: true, maxAlertTraders: 5 },
      revenue: { builderFeeTenthsBps: 10, builderAddress: null },
    });
    // Each stripped section is valid as stored (no field recovered).
    const snapshot = await new SettingsService(new SettingsRepository(db), new UnitOfWork(db)).getAll();
    expect(snapshot.invalidSections).toEqual([]);
    expect(snapshot.discovery).toEqual(adminSettingsSchema.shape.discovery.parse({ hideVaults: false, lowSampleThreshold: 7, homeMarkets: ["ETH"] }));
    // Idempotent: running it again changes nothing.
    await apply();
    expect(Object.fromEntries((await db.select().from(appSettings)).map((r) => [r.key, r.value]))).toEqual(rows);
  });

  it("leaves a database with no saved settings, or a non-object value, alone", async () => {
    await apply();
    expect(await db.select().from(appSettings)).toEqual([]);
    await db.execute(sql`insert into app_settings (key, value) values ('discovery', '"oops"'::jsonb)`);
    await apply();
    expect((await db.select().from(appSettings))[0].value).toBe("oops");
  });
});
