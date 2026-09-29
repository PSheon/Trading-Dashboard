import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from "@nestjs/common";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { sql } from "drizzle-orm";
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
 * Idempotency relies on the partial unique index on `alert_rules.kind` where
 * `user_id` is null (see packages/shared/src/schema/db.ts) — `onConflictDoNothing` means re-running
 * this on every restart never duplicates rows, and never clobbers params
 * Paul has since edited via D5.
 */
@Injectable()
export class RulesSeedService implements OnApplicationBootstrap, OnModuleDestroy {
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly logger = new Logger(RulesSeedService.name);

  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs()) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return;
    void this.seedWithRetry();
  }

  /** A database that isn't reachable yet at boot must not crash the
   * process (an unhandled rejection exits Node); keep trying. */
  private async seedWithRetry(): Promise<void> {
    try {
      if (this.stopped || this.jobs.stopping) return;
      await this.jobs.run(() => this.seedDefaultRules());
    } catch (error) {
      this.logger.error(`Seeding default rules failed, retrying in 30s: ${(error as Error).message}`);
      if (!this.stopped && !this.jobs.stopping) this.retryTimer = setTimeout(() => void this.seedWithRetry(), 30_000);
    }
  }

  onModuleDestroy(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
  }

  async seedDefaultRules(): Promise<void> {
    const inserted = await this.db
      .insert(alertRules)
      .values(DEFAULT_RULES)
      // Default rows are the ones with no owner; their uniqueness is a
      // partial index, so the conflict target repeats its predicate.
      .onConflictDoNothing({ target: alertRules.kind, where: sql`${alertRules.userId} is null` })
      .returning({ kind: alertRules.kind });

    if (inserted.length > 0) {
      this.logger.log(`Seeded default alert rules: ${inserted.map((r) => r.kind).join(", ")}`);
    }
  }
}
