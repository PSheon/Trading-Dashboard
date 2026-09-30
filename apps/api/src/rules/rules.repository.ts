import { Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, max, sql } from "drizzle-orm";
import {
  actionOutbox, notificationCooldowns, alertRules, alerts, leaders,
  notificationChannels, traderStats, userFavorites, users,
} from "@trading-dashboard/shared/database";
import type { Locale } from "@trading-dashboard/shared/contracts";

import type { DbTransaction } from "../db/unit-of-work.js";
import type { ActionCreatedEvent } from "../watcher/action-created.event.js";

export type AlertRuleRow = typeof alertRules.$inferSelect;
export type LeaderRow = typeof leaders.$inferSelect;

/** Evaluation persistence, always in the service-owned transaction. No root client fallback. */
@Injectable()
export class RulesRepository {
  /** Serialize cooldown reservation and enqueue, including first-ever cooldown keys. */
  async lockActionScope(tx: DbTransaction, action: ActionCreatedEvent): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(73105, hashtext(${`${action.chain}|${action.address}|${action.coin}`}))`);
  }

  async actionEvent(tx: DbTransaction, id: bigint) {
    const [event] = await tx.select().from(actionOutbox).where(eq(actionOutbox.actionId, id));
    return event;
  }

  /** Mark evaluation done in the same transaction that reserved delivery intents. */
  async markDone(tx: DbTransaction, id: bigint): Promise<void> {
    await tx.update(actionOutbox).set({ status: "done", lockedUntil: null, lastError: null })
      .where(eq(actionOutbox.actionId, id));
  }

  enabledAdmins(db: DbTransaction) {
    return db.select({ id: users.id }).from(users)
      .where(and(eq(users.role, "admin"), isNull(users.disabledAt)));
  }

  async favoriteCandidates(action: ActionCreatedEvent, db: DbTransaction) {
    const rows = await db
      .select({
        userId: userFavorites.userId,
        sides: userFavorites.alertSides,
        minUsd: userFavorites.alertMinUsd,
      })
      .from(userFavorites)
      .innerJoin(users, eq(users.id, userFavorites.userId))
      .where(
        and(
          eq(userFavorites.chain, action.chain),
          eq(userFavorites.address, action.address),
          eq(userFavorites.alertEnabled, true),
          isNull(users.disabledAt),
        ),
      );

    return rows;
  }

  /** Reserve under lockActionScope; rollback restores the previous cooldown. */
  async reserveCooldown(db: DbTransaction, key: string, milliseconds: number, now: number): Promise<boolean> {
    const rows = await db.insert(notificationCooldowns).values({ key, reservedAt: new Date(now) })
      .onConflictDoUpdate({ target: notificationCooldowns.key, set: { reservedAt: new Date(now) },
        setWhere: sql`${notificationCooldowns.reservedAt} <= ${new Date(now - milliseconds)}`,
      }).returning({ key: notificationCooldowns.key });
    return rows.length > 0;
  }

  /** Preserve cooldowns from pre-outbox alerts as well as new durable reservations.
   * Default rules are shared; cooldown remains per admin/address/coin. */
  async lastSent(userIds: number[], ruleIds: number[], action: ActionCreatedEvent, db: DbTransaction): Promise<Map<string, Date>> {
    const rows = await db
      .select({ userId: alerts.userId, ruleId: alerts.ruleId, lastSentAt: max(alerts.sentAt) })
      .from(alerts)
      .where(
        and(
          inArray(alerts.userId, userIds),
          inArray(alerts.ruleId, ruleIds),
          eq(alerts.address, action.address),
          eq(alerts.coin, action.coin),
        ),
      )
      .groupBy(alerts.userId, alerts.ruleId);
    const result = new Map<string, Date>();
    for (const row of rows) {
      if (row.lastSentAt) result.set(`${row.userId}|${row.ruleId}`, new Date(row.lastSentAt));
    }
    return result;
  }

  /** Each recipient's locale and linked, enabled Telegram chat (if any). */
  async contacts(userIds: number[], db: DbTransaction): Promise<Map<number, { locale: Locale; chatId: string | null }>> {
    const rows = await db
      .select({ userId: users.id, locale: users.locale, chatId: notificationChannels.target })
      .from(users)
      .leftJoin(
        notificationChannels,
        and(
          eq(notificationChannels.userId, users.id),
          eq(notificationChannels.kind, "telegram"),
          eq(notificationChannels.enabled, true),
        ),
      )
      .where(inArray(users.id, userIds));
    return new Map(rows.map((r) => [r.userId, { locale: r.locale, chatId: r.chatId }]));
  }

  async displayName(leader: LeaderRow, db: DbTransaction): Promise<string | null> {
    const [row] = await db
      .select({ displayName: traderStats.displayName })
      .from(traderStats)
      .where(and(eq(traderStats.chain, leader.chain), eq(traderStats.address, leader.address)));
    return row?.displayName ?? null;
  }

  async getLeader(chain: string, address: string, db: DbTransaction): Promise<LeaderRow | undefined> {
    const [row] = await db
      .select()
      .from(leaders)
      .where(and(eq(leaders.chain, chain), eq(leaders.address, address)))
      .limit(1);
    return row;
  }

  async enabledDefaultRules(db: DbTransaction): Promise<AlertRuleRow[]> {
    const rows = await db
      .select()
      .from(alertRules)
      .where(and(isNull(alertRules.userId), eq(alertRules.scope, "address"), eq(alertRules.enabled, true)));
    return rows;
  }
}
