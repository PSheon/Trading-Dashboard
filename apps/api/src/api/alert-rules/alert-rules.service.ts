import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  alertRules,
  type AlertRule,
  type UpsertAlertRuleRequest,
} from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import type { DrizzleDb } from "../../db/drizzle.provider.js";

/** D5 rule editor for the DEFAULT rules (`user_id IS NULL`): the template
 * copied to each new user at first sign-in. Editing a default doesn't
 * change existing users' copies. Users' own rules are never listed or
 * edited here (see users/user-alert-rules.service.ts). */
@Injectable()
export class AlertRulesService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async findAll(): Promise<AlertRule[]> {
    const rows = await this.db
      .select()
      .from(alertRules)
      .where(isNull(alertRules.userId))
      .orderBy(asc(alertRules.kind));
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
        .where(and(eq(alertRules.id, request.id), isNull(alertRules.userId)))
        .returning();

      if (!updated) {
        throw new NotFoundException(`No default alert rule ${request.id}`);
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
      .onConflictDoNothing({ target: alertRules.kind, where: sql`${alertRules.userId} is null` })
      .returning();

    if (!inserted) {
      throw new ConflictException(`A default ${request.kind} rule already exists; update it by id`);
    }
    return inserted as unknown as AlertRule;
  }
}
