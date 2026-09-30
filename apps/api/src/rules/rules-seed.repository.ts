import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { alertRules } from "@trading-dashboard/shared/database";
import type { AlertRuleKind, Tier } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

export interface SeedRow {
  kind: AlertRuleKind;
  scope: "address" | "group";
  paramsJson: Record<string, unknown>;
  cooldownS: number;
  tiers: Tier[];
  enabled: boolean;
}

/** Insert-only bootstrap persistence; service supplies defaults and owns retry/shutdown policy. */
@Injectable()
export class RulesSeedRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  /** Match the partial default-kind index; existing administrator edits are never overwritten. */
  insertMissing(rows: SeedRow[]) {
    return this.db.insert(alertRules).values(rows)
      .onConflictDoNothing({ target: alertRules.kind, where: sql`${alertRules.userId} is null` })
      .returning({ kind: alertRules.kind });
  }
}
