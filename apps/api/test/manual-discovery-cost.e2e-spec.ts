import { writeFileSync } from "node:fs";
import { Global, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { discoveryTraders } from "@trading-dashboard/shared/database";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { AppConfig } from "../src/config/app-config.js";
import { DRIZZLE_CLIENT } from "../src/db/db.constants.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { DiscoveryModule } from "../src/discovery/discovery.module.js";
import { DiscoveryPoolService } from "../src/discovery/discovery-pool.service.js";
import { RequestBudgeterService } from "../src/hyperliquid/request-budgeter.service.js";
import { SettingsModule } from "../src/settings/settings.module.js";
import { LeaderboardIngestService } from "../src/traders/leaderboard-ingest.service.js";
import { testConfig } from "./config-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

/**
 * MANUAL, against live Hyperliquid and a local test Postgres; not part of
 * `pnpm test`. Measures what the discovery pool costs per trader:
 *
 *   E2E_RUN_LIVE=1 HYPERLIQUID_WEIGHT_BUDGET_PER_MIN=280 E2E_SAMPLE=20 \
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5435/<name>_test \
 *     pnpm --filter @trading-dashboard/api exec vitest run --config ./vitest.config.e2e.ts test/manual-discovery-cost.e2e-spec.ts
 *
 * Imports the official leaderboard (no info weight), builds the pool of
 * 1,000, refreshes an evenly spread sample twice (cold, then incremental)
 * and writes each refresh's weight, calls and time to E2E_OUT (JSON).
 */
const SAMPLE = Number(process.env.E2E_SAMPLE ?? 20);

describe.skipIf(!process.env.E2E_RUN_LIVE)("discovery pool cost (manual, live Hyperliquid)", () => {
  it("measures cold and incremental refreshes", { timeout: 3 * 3_600_000 }, async () => {
    const db = getTestDb();
    await truncateAll(db);
    @Global()
    @Module({ providers: [{ provide: AppConfig, useValue: testConfig() }, { provide: DRIZZLE_CLIENT, useValue: db }, UnitOfWork],
      exports: [AppConfig, DRIZZLE_CLIENT, UnitOfWork] })
    class TestDbModule {}
    const ref = await Test.createTestingModule({ imports: [TestDbModule, SettingsModule, DiscoveryModule] }).compile();
    const app = ref.createNestApplication({ logger: ["warn", "error"] });
    await app.init();
    try {
      const ingest = app.get(LeaderboardIngestService);
      const pool = app.get(DiscoveryPoolService);
      const budgeter = app.get(RequestBudgeterService);
      console.log("leaderboard", await ingest.refresh());
      console.log("pool", await pool.build(1000));
      const rows = await db.select({ address: discoveryTraders.address, rank: discoveryTraders.poolRank }).from(discoveryTraders)
        .orderBy(sql`pool_rank nulls last`);
      const step = Math.max(1, Math.floor(rows.length / SAMPLE));
      const sample = rows.filter((_, i) => i % step === 0).slice(0, SAMPLE);
      const results: Array<Record<string, unknown>> = [];
      for (const pass of ["cold", "incremental"] as const) {
        for (const { address, rank } of sample) {
          const started = Date.now();
          const { weight, ok } = await pool.refreshOne(address);
          const log = pool.log.at(-1)!;
          results.push({ pass, address, rank, weight, ok, kind: log.kind, calls: log.calls, ms: Date.now() - started });
          console.log(pass, rank, address, log.kind, "weight", weight, "calls", log.calls, `${Date.now() - started} ms`, ok ? "" : "FAILED",
            "budget/min", budgeter.introspect().weightLastMinute);
        }
      }
      if (process.env.E2E_OUT) writeFileSync(process.env.E2E_OUT, JSON.stringify(results, null, 1));
      expect(results.filter((r) => r.ok).length).toBeGreaterThan(0);
    } finally {
      await app.close();
      await closeTestDb();
    }
  });
});
