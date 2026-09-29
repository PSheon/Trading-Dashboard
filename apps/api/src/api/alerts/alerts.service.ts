import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { alerts, type AlertEntry, type AlertsQuery } from "@trading-dashboard/shared";

import type { RequestUser } from "../../common/auth/current-user.js";
import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import type { DrizzleDb } from "../../db/drizzle.provider.js";

/** Whose alerts a caller may read: everyone's (`"all"`), one user's, or
 * none (anonymous). Alerts carry the recipient's Telegram chat id and
 * message, so they are private to that recipient. */
export type AlertsScope = "all" | { userId: number } | "none";

export function alertsVisibleTo(user: RequestUser | null): AlertsScope {
  if (!user) return "none";
  if (user.kind === "service" || user.role === "admin") return "all";
  return { userId: user.id };
}

/** D5 Alerts log (N2) — filterable by rule/address/coin. */
@Injectable()
export class AlertsService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async findAll(query: AlertsQuery, scope: AlertsScope): Promise<AlertEntry[]> {
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
