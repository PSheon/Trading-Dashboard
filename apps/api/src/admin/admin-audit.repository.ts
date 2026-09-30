import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { adminAuditLogs } from "@trading-dashboard/shared/database";
import type { AuditQuery, AuditResponse } from "@trading-dashboard/shared/contracts";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
@Injectable()
export class AdminAuditRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  async list(query: AuditQuery): Promise<AuditResponse> {
    const rows = await this.db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '2000ms'`);
      return tx.select().from(adminAuditLogs).where(and(
      query.beforeId ? lt(adminAuditLogs.id, BigInt(query.beforeId)) : undefined,
      query.event ? eq(adminAuditLogs.event, query.event) : undefined,
      query.actorKind ? eq(adminAuditLogs.actorKind, query.actorKind) : undefined,
      query.actorUserId ? eq(adminAuditLogs.actorUserId, query.actorUserId) : undefined,
      query.target ? eq(adminAuditLogs.target, query.target) : undefined,
    )).orderBy(desc(adminAuditLogs.id)).limit(query.limit + 1);
    }, { accessMode: "read only" });
    const items = rows.slice(0, query.limit).map(row => ({ id: String(row.id), actorKind: row.actorKind as AuditResponse["items"][number]["actorKind"],
      actorUserId: row.actorUserId, event: row.event, target: row.target, before: row.beforeJson, after: row.afterJson, createdAt: row.createdAt.toISOString() }));
    return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.id : null };
  }
}
