import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import {
  alertRules,
  type AlertRule,
  type UpsertAlertRuleRequest,
} from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import type { DrizzleDb } from "../../db/drizzle.provider.js";

/** D5 rule editor: list + enable/disable + inline edit of params/cooldown/
 * tiers for R1–R3 (R4–R9 will appear here automatically once seeded in a
 * later milestone — this is generic over `kind`). */
@Injectable()
export class AlertRulesService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async findAll(): Promise<AlertRule[]> {
    const rows = await this.db.select().from(alertRules).orderBy(asc(alertRules.kind));
    return rows as unknown as AlertRule[];
  }

  async upsert(request: UpsertAlertRuleRequest): Promise<AlertRule> {
    if (request.id !== undefined) {
      const [updated] = await this.db
        .update(alertRules)
        .set({
          scope: request.scope,
          kind: request.kind,
          paramsJson: request.paramsJson,
          cooldownS: request.cooldownS,
          quietHours: request.quietHours ?? null,
          tiers: request.tiers,
          enabled: request.enabled ?? true,
        })
        .where(eq(alertRules.id, request.id))
        .returning();

      if (!updated) {
        throw new NotFoundException(`No alert rule ${request.id}`);
      }
      return updated as unknown as AlertRule;
    }

    const [inserted] = await this.db
      .insert(alertRules)
      .values({
        scope: request.scope,
        kind: request.kind,
        paramsJson: request.paramsJson,
        cooldownS: request.cooldownS,
        quietHours: request.quietHours ?? null,
        tiers: request.tiers,
        enabled: request.enabled ?? true,
      })
      .returning();

    return inserted as unknown as AlertRule;
  }
}
