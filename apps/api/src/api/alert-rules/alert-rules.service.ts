import { recordAdminAudit, type AuditActor } from "../../common/audit/admin-audit.js";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { alertRules } from "@trading-dashboard/shared/database";
import { type AlertRule, type UpsertAlertRuleRequest } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import type { DrizzleDb } from "../../db/drizzle.provider.js";

/** D5 rule editor for the DEFAULT rules (`user_id IS NULL`), which
 * RulesService evaluates for admins on imported leaders. Rows with an
 * owner are no longer created (migration 0006 removed the old per-user
 * copies) and are never listed or edited here. */
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

  async upsert(request: UpsertAlertRuleRequest, actor: AuditActor = null): Promise<AlertRule> {
    return this.db.transaction(async (tx) => {
      if (request.id !== undefined) {
        const [before] = await tx.select().from(alertRules).where(and(eq(alertRules.id, request.id), isNull(alertRules.userId))).for("update");
        const [updated] = await tx
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
        await recordAdminAudit(tx, actor, "rule.update", String(updated.id), before, updated);
        return updated as unknown as AlertRule;
      }

      const [inserted] = await tx
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
      await recordAdminAudit(tx, actor, "rule.create", String(inserted.id), null, inserted);
      return inserted as unknown as AlertRule;
    });
  }
}
