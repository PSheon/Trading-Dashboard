import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { alertRules, type AlertRule } from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { parsePatchRule } from "../rules/rule-validation.js";

/** A user's own alert rules (copied from the defaults at first sign-in). */
@Injectable()
export class UserAlertRulesService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async list(userId: number): Promise<AlertRule[]> {
    const rows = await this.db
      .select()
      .from(alertRules)
      .where(eq(alertRules.userId, userId))
      .orderBy(asc(alertRules.kind));
    return rows as AlertRule[];
  }

  /** Only the caller's own rows: someone else's id is a 404, not a 403, so
   * ids don't leak. */
  async patch(userId: number, ruleId: number, body: unknown): Promise<AlertRule> {
    const owned = and(eq(alertRules.id, ruleId), eq(alertRules.userId, userId));
    const [current] = await this.db.select().from(alertRules).where(owned);
    if (!current) throw new NotFoundException(`No alert rule ${ruleId}`);

    const patch = parsePatchRule(body, current);
    const set = {
      ...(patch.paramsJson !== undefined && { paramsJson: patch.paramsJson }),
      ...(patch.cooldownS !== undefined && { cooldownS: patch.cooldownS }),
      ...(patch.quietHours !== undefined && { quietHours: patch.quietHours }),
      ...(patch.tiers !== undefined && { tiers: patch.tiers }),
      ...(patch.enabled !== undefined && { enabled: patch.enabled }),
    };
    if (Object.keys(set).length === 0) return current as AlertRule;

    const [updated] = await this.db.update(alertRules).set(set).where(owned).returning();
    if (!updated) throw new NotFoundException(`No alert rule ${ruleId}`);
    return updated as AlertRule;
  }
}
