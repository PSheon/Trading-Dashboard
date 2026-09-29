import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { alerts, type AlertEntry, type AlertsQuery } from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import type { DrizzleDb } from "../../db/drizzle.provider.js";

/** D5 Alerts log (N2) — filterable by rule/address/coin. */
@Injectable()
export class AlertsService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async findAll(query: AlertsQuery): Promise<AlertEntry[]> {
    const conditions = [];
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
