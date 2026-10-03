import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  actions, alerts, copyEvents, notificationOutbox, notificationChannels, userFavorites, appSettings, users,
} from "@trading-dashboard/shared/database";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";
import { COPY_NOTIFICATION_TYPES } from "./copy-message.js";
import type { AlertContext } from "./notify.types.js";

export type DeliveryRow = typeof notificationOutbox.$inferSelect;
/** Deliveries read per pass of a drain. */
export const DELIVERY_BATCH = 100;

/** Durable delivery persistence; services own authorization, retry policy and transactions. */
@Injectable()
export class NotifyRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  copyCandidates() {
    return this.db.select({ event: copyEvents, chatId: notificationChannels.target }).from(copyEvents)
      .innerJoin(users, and(eq(users.id, copyEvents.userId), isNull(users.disabledAt)))
      .innerJoin(notificationChannels, and(eq(notificationChannels.userId, copyEvents.userId), eq(notificationChannels.kind, "telegram")))
      .where(and(isNull(copyEvents.notificationQueuedAt), eq(notificationChannels.enabled, true), eq(notificationChannels.copyAlertsEnabled, true),
        gte(copyEvents.createdAt, notificationChannels.copyAlertsSince), sql`${copyEvents.createdAt} >= now() - interval '24 hours'`,
        inArray(copyEvents.type, [...COPY_NOTIFICATION_TYPES]), sql`${copyEvents.payload}->>'mode' = 'paper'`))
      .orderBy(copyEvents.id).limit(DELIVERY_BATCH);
  }

  async enqueueCopy(eventId: bigint, userId: number, payloadJson: Record<string, unknown>, tx: DbTransaction): Promise<void> {
    const claimed = await tx.update(copyEvents).set({ notificationQueuedAt: sql`now()` })
      .where(and(eq(copyEvents.id, eventId), eq(copyEvents.userId, userId), isNull(copyEvents.notificationQueuedAt))).returning({ id: copyEvents.id });
    if (claimed.length) await tx.insert(notificationOutbox).values({ copyEventId: eventId, userId, payloadJson }).onConflictDoNothing();
  }

  async copyEvent(id: bigint, userId: number) {
    const [event] = await this.db.select().from(copyEvents).where(and(eq(copyEvents.id, id), eq(copyEvents.userId, userId)));
    return event;
  }

  /** Insert intent and pending alert rows in the caller's cooldown transaction.
   * A duplicate action/recipient inserts neither another intent nor another log. */
  async enqueue(ctx: AlertContext, payloadJson: Record<string, unknown>, tx: DbTransaction): Promise<void> {
    const inserted = await tx.insert(notificationOutbox).values({
      actionId: ctx.action.id, userId: ctx.recipient.userId, payloadJson,
    }).onConflictDoNothing().returning({ id: notificationOutbox.id });
    if (inserted.length) await this.insertAlertRows(ctx, payloadJson, "pending", tx);
  }

  /** Due by the database's own clock: a row inserted a moment ago has an
   * `available_at` with microseconds, which a millisecond JS time taken
   * right after the commit can still be behind (the first drain then found
   * nothing and the alert waited for the 5 s poll). */
  private due() {
    return or(
      and(eq(notificationOutbox.status, "pending"), lte(notificationOutbox.availableAt, sql`now()`)),
      and(eq(notificationOutbox.status, "processing"), lte(notificationOutbox.lockedUntil, sql`now()`)),
    );
  }

  /** Candidates only, oldest first: each row still needs an atomic claim before sending. */
  findDue(actionId?: bigint, limit = DELIVERY_BATCH) {
    return this.db.select({ id: notificationOutbox.id }).from(notificationOutbox)
      .where(and(this.due(), actionId === undefined ? undefined : eq(notificationOutbox.actionId, actionId)))
      .orderBy(notificationOutbox.id).limit(limit);
  }

  /** Return undefined when another sender already owns the unexpired lease. */
  async claim(id: bigint, leaseToken: string, leaseMs: number) {
    const [row] = await this.db.update(notificationOutbox).set({ status: "processing", leaseToken,
      lockedUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})`, attempts: sql`${notificationOutbox.attempts} + 1`,
    }).where(and(eq(notificationOutbox.id, id), this.due())).returning();
    return row;
  }

  /** Always query current persisted authorization, including before an immediate retry. */
  async enabledRecipient(userId: number) {
    const [row] = await this.db.select({ id: users.id, role: users.role }).from(users)
      .where(and(eq(users.id, userId), isNull(users.disabledAt)));
    return row;
  }

  async enabledChannel(userId: number, target?: string) {
    const [row] = await this.db.select().from(notificationChannels).where(and(
      eq(notificationChannels.userId, userId), eq(notificationChannels.kind, "telegram"),
      eq(notificationChannels.enabled, true), target === undefined ? undefined : eq(notificationChannels.target, target),
    ));
    return row;
  }

  async notificationSettings() {
    const [row] = await this.db.select().from(appSettings).where(eq(appSettings.key, "notifications"));
    return row;
  }

  async action(id: bigint) {
    const [row] = await this.db.select().from(actions).where(eq(actions.id, id));
    return row;
  }

  async enabledFavorite(userId: number, chain: string, address: string) {
    const [row] = await this.db.select().from(userFavorites).where(and(
      eq(userFavorites.userId, userId), eq(userFavorites.chain, chain),
      eq(userFavorites.address, address), eq(userFavorites.alertEnabled, true),
    ));
    return row;
  }

  /** Atomically publish the owning lease's result and matching alert log state.
   * An expired sender whose lease was replaced updates neither table. */
  async recordDelivery(tx: DbTransaction, row: DeliveryRow, leaseToken: string, result: {
    status: "sent" | "dry_run" | "failed";
    pending: boolean;
    availableAt: Date;
    reason?: string;
  }): Promise<void> {
    const { status, pending, availableAt, reason } = result;
    const updated = await tx.update(notificationOutbox).set({ status: pending ? "pending" : status,
      availableAt, lockedUntil: null, leaseToken: null, lastError: reason ?? null,
    }).where(and(eq(notificationOutbox.id, row.id), eq(notificationOutbox.leaseToken, leaseToken))).returning({ id: notificationOutbox.id });
    if (!updated.length || row.actionId === null) return;
    await tx.update(alerts).set({ sendStatus: status, sentAt: new Date(),
      payloadJson: reason ? { ...row.payloadJson, reason } : row.payloadJson,
    }).where(and(eq(alerts.actionId, row.actionId), eq(alerts.userId, row.userId)));
  }

  private async insertAlertRows(
    ctx: AlertContext,
    payloadJson: Record<string, unknown>,
    sendStatus: "sent" | "dry_run" | "failed" | "pending",
    db: DbTransaction,
  ): Promise<void> {
    // sent_at is "when this attempt happened" for every outcome, so the log
    // sorts failed rows in place too.
    const sentAt = sendStatus === "pending" ? null : new Date();
    const row = {
      userId: ctx.recipient.userId,
      chain: ctx.action.chain,
      address: ctx.action.address,
      coin: ctx.action.coin,
      actionId: ctx.action.id,
      payloadJson,
      sentAt,
      sendStatus,
    };
    const ruleIds: (number | null)[] = ctx.rules.length > 0 ? ctx.rules.map((r) => r.id) : [null];
    await db.insert(alerts).values(ruleIds.map((ruleId) => ({ ...row, ruleId })));
  }
}
