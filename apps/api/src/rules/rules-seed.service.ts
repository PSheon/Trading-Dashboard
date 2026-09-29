import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { alertRules, type AlertRuleKind, type Tier } from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

interface SeedRow {
  kind: AlertRuleKind;
  scope: "address" | "group";
  paramsJson: Record<string, unknown>;
  cooldownS: number;
  tiers: Tier[];
  enabled: boolean;
}

/** R1/R2/R3 defaults per §1 of the M2 task ("Seed defaults"). Applies to
 * every tier initially — the PRD doesn't set a narrower M2 default. */
const DEFAULT_RULES: SeedRow[] = [
  {
    kind: "R1",
    scope: "address",
    paramsJson: { flatThresholdUsd: 50_000, pctThreshold: 0.1 },
    cooldownS: 900,
    tiers: ["A", "B", "C"],
    enabled: true,
  },
  {
    kind: "R2",
    scope: "address",
    paramsJson: {},
    cooldownS: 900,
    tiers: ["A", "B", "C"],
    enabled: true,
  },
  {
    kind: "R3",
    scope: "address",
    paramsJson: { flatThresholdUsd: 100_000, pctThreshold: 0.2 },
    cooldownS: 900,
    tiers: ["A", "B", "C"],
    enabled: true,
  },
];

/**
 * Idempotent one-time seed for the M2 default rules. Runs on app bootstrap
 * (skipped under `NODE_ENV=test`, same pattern as `WatcherService` — tests
 * call `seedDefaultRules()` directly against a controlled db instance).
 * Idempotency relies on `alert_rules.kind` being UNIQUE (see
 * packages/shared/src/schema/db.ts) — `onConflictDoNothing` means re-running
 * this on every restart never duplicates rows, and never clobbers params
 * Paul has since edited via D5.
 */
@Injectable()
export class RulesSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RulesSeedService.name);

  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return;
    void this.seedDefaultRules();
  }

  async seedDefaultRules(): Promise<void> {
    const inserted = await this.db
      .insert(alertRules)
      .values(DEFAULT_RULES)
      .onConflictDoNothing({ target: alertRules.kind })
      .returning({ kind: alertRules.kind });

    if (inserted.length > 0) {
      this.logger.log(`Seeded default alert rules: ${inserted.map((r) => r.kind).join(", ")}`);
    }
  }
}
