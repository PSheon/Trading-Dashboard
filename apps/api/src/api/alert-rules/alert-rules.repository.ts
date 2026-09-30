import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { alertRules } from "@trading-dashboard/shared/database";
import type { UpsertAlertRuleRequest } from "@trading-dashboard/shared/contracts";

import { recordAdminAudit, type AuditActor } from "../../common/audit/admin-audit.js";
import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import type { DrizzleDb } from "../../db/drizzle.provider.js";
import type { DbTransaction } from "../../db/unit-of-work.js";

type RuleRow = typeof alertRules.$inferSelect;

/** Persistence is restricted to default rules; owned rules cannot be listed or edited here. */
@Injectable()
export class AlertRulesRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  findAll() {
    return this.db.select().from(alertRules).where(isNull(alertRules.userId)).orderBy(asc(alertRules.kind));
  }

  /** Lock the before-image in the same transaction as update and audit. */
  async lockDefault(tx: DbTransaction, id: number) {
    const [row] = await tx.select().from(alertRules)
      .where(and(eq(alertRules.id, id), isNull(alertRules.userId))).for("update");
    return row;
  }

  async update(tx: DbTransaction, id: number, values: Omit<UpsertAlertRuleRequest, "id">) {
    const [row] = await tx.update(alertRules).set(values)
      .where(and(eq(alertRules.id, id), isNull(alertRules.userId))).returning();
    return row;
  }

  /** Undefined means the partial default-kind uniqueness constraint won the conflict. */
  async insert(tx: DbTransaction, values: Omit<UpsertAlertRuleRequest, "id">) {
    const [row] = await tx.insert(alertRules).values(values)
      .onConflictDoNothing({ target: alertRules.kind, where: sql`${alertRules.userId} is null` }).returning();
    return row;
  }

  recordAudit(tx: DbTransaction, actor: AuditActor, event: "rule.create" | "rule.update", before: RuleRow | null, after: RuleRow) {
    return recordAdminAudit(tx, actor, event, String(after.id), before, after);
  }
}
