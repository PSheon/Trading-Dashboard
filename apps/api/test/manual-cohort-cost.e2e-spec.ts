import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Global, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { CohortTier } from "@trading-dashboard/shared/contracts";
import { describe, expect, it } from "vitest";

import { AppConfig } from "../src/config/app-config.js";
import { DRIZZLE_CLIENT } from "../src/db/db.constants.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { KolAvatarModule } from "../src/discovery/kol-avatar.module.js";
import { KolAvatarService } from "../src/discovery/kol-avatar.service.js";
import { RequestBudgeterService } from "../src/hyperliquid/request-budgeter.service.js";
import { CohortRepository } from "../src/insights/cohort.repository.js";
import { CohortService } from "../src/insights/cohort.service.js";
import { COHORT_TIERS } from "../src/insights/cohorts.js";
import { InsightsModule } from "../src/insights/insights.module.js";
import { SettingsModule } from "../src/settings/settings.module.js";
import { testConfig } from "./config-test-utils.js";
import { closeTestDb, getTestDb } from "./db-test-utils.js";

/**
 * MANUAL, against live Hyperliquid and a local test Postgres that already
 * holds a leaderboard and a discovery pool; not part of `pnpm test`, and it
 * does not truncate. Measures what the cohorts cost and fills the tables
 * for screenshots:
 *
 *   E2E_RUN_LIVE=1 HYPERLIQUID_WEIGHT_BUDGET_PER_MIN=200 E2E_TIERS=extremely_profitable,very_profitable,rekt \
 *   E2E_CYCLES=3 E2E_GAP_S=60 E2E_AVATARS=8 E2E_OUT=/tmp/cohort-cost.json \
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5435/<name>_test \
 *     pnpm --filter @trading-dashboard/api exec vitest run --config ./vitest.config.e2e.ts test/manual-cohort-cost.e2e-spec.ts
 *
 * Builds the members (150 per tier), refreshes every member of the chosen
 * tiers once per cycle and writes a history row per tier per cycle; fetches
 * `E2E_AVATARS` KOL avatars through the drip's own path first.
 */
const TIERS = (process.env.E2E_TIERS ?? "extremely_profitable").split(",") as CohortTier[];
const CYCLES = Number(process.env.E2E_CYCLES ?? 1);
const GAP_S = Number(process.env.E2E_GAP_S ?? 60);
const AVATARS = Number(process.env.E2E_AVATARS ?? 0);

describe.skipIf(!process.env.E2E_RUN_LIVE)("cohort cost (manual, live Hyperliquid)", () => {
  it("measures member refreshes and fills the cohort tables", { timeout: 3 * 3_600_000 }, async () => {
    const db = getTestDb();
    @Global()
    @Module({ providers: [{ provide: AppConfig, useValue: testConfig() }, { provide: DRIZZLE_CLIENT, useValue: db }, UnitOfWork],
      exports: [AppConfig, DRIZZLE_CLIENT, UnitOfWork] })
    class TestDbModule {}
    const ref = await Test.createTestingModule({ imports: [TestDbModule, SettingsModule, InsightsModule, KolAvatarModule] }).compile();
    const app = ref.createNestApplication({ logger: ["log", "warn", "error"] });
    await app.init();
    const out: Record<string, unknown> = {};
    try {
      const avatars = app.get(KolAvatarService);
      const outcomes: string[] = [];
      for (let i = 0; i < AVATARS; i++) {
        outcomes.push(await avatars.tick());
        await sleep(3_000);
      }
      out.avatars = { outcomes, pausedUntil: Object.fromEntries(avatars.pausedUntil) };
      console.log("avatars", out.avatars);

      const cohorts = app.get(CohortService);
      const repository = app.get(CohortRepository);
      const budgeter = app.get(RequestBudgeterService);
      out.build = await cohorts.build(150);
      console.log("build", out.build);
      const members: Record<string, number> = {};
      for (const tier of COHORT_TIERS) members[tier] = (await repository.membersOf(tier)).length;
      out.members = members;
      console.log("members", members);

      const cycles: Array<Record<string, unknown>> = [];
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        const perTier: Record<string, unknown> = {};
        for (const tier of TIERS) {
          const started = Date.now();
          const list = await repository.membersOf(tier);
          let weight = 0;
          let calls = 0;
          let failed = 0;
          for (const member of list) {
            const result = await cohorts.refreshOne(member);
            weight += result.weight;
            calls += cohorts.log.at(-1)?.calls ?? 0;
            if (!result.ok) failed++;
          }
          perTier[tier] = { members: list.length, weight, calls, failed, seconds: Math.round((Date.now() - started) / 1000),
            weightPerMember: list.length ? Math.round((10 * weight) / list.length) / 10 : 0, budgetLastMinute: budgeter.introspect().weightLastMinute };
          console.log("cycle", cycle, tier, perTier[tier]);
        }
        await cohorts.writeSnapshots(0);
        cycles.push(perTier);
        if (cycle < CYCLES - 1) await sleep(GAP_S * 1000);
      }
      out.cycles = cycles;
      for (const tier of TIERS) {
        const d = await cohorts.detail(tier);
        console.log("detail", tier, { walletCount: d.walletCount, markets: d.markets.length, hero: d.hero });
      }
      if (process.env.E2E_OUT) writeFileSync(process.env.E2E_OUT, JSON.stringify(out, null, 1));
      expect(cycles.length).toBe(CYCLES);
    } finally {
      await app.close();
      await closeTestDb();
    }
  });
});
