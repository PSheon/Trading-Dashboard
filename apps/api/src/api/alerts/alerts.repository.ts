import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { alerts } from "@trading-dashboard/shared/database";
import { type AlertEntry, type AlertsQuery } from "@trading-dashboard/shared/contracts";
import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import type { DrizzleDb } from "../../db/drizzle.provider.js";
import type { AlertsScope } from "../../common/auth/alerts-scope.js";
/** Enforces recipient ownership in the query, including every filter. */
@Injectable()
export class AlertsRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async findVisible(query: AlertsQuery, scope: AlertsScope): Promise<AlertEntry[]> {
    if (scope === "none") return [];
    const conditions = [];
    if (scope !== "all") conditions.push(eq(alerts.userId, scope.userId));
    if (query.ruleId !== undefined) conditions.push(eq(alerts.ruleId, Number(query.ruleId)));
    if (query.address) conditions.push(eq(alerts.address, query.address));
    if (query.coin) conditions.push(eq(alerts.coin, query.coin));

    const limit = query.limit ? Number(query.limit) : 100;

    const rows = await this.db
      .select()
      .from(alerts)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(alerts.sentAt))
      .limit(limit);

    return rows as unknown as AlertEntry[];
  }
}
