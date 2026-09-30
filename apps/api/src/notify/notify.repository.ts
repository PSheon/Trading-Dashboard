import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import {
  actions, alerts, notificationOutbox, notificationChannels, userFavorites, appSettings, users,
} from "@trading-dashboard/shared/database";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";
import type { AlertContext } from "./notify.types.js";

export type DeliveryRow = typeof notificationOutbox.$inferSelect;

/** Durable delivery persistence; services own authorization, retry policy and transactions. */
@Injectable()
export class NotifyRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  /** Insert intent and pending alert rows in the caller's cooldown transaction.
   * A duplicate action/recipient inserts neither another intent nor another log. */
  async enqueue(ctx: AlertContext, payloadJson: Record<string, unknown>, tx: DbTransaction): Promise<void> {
    const inserted = await tx.insert(notificationOutbox).values({
      actionId: ctx.action.id, userId: ctx.recipient.userId, payloadJson,
    }).onConflictDoNothing().returning({ id: notificationOutbox.id });
    if (inserted.length) await this.insertAlertRows(ctx, payloadJson, "pending", tx);
  }

  /** Candidates only: each row still needs an atomic claim before sending. */
  findDue(now: Date, actionId?: bigint) {
    const due = or(
      and(eq(notificationOutbox.status, "pending"), lte(notificationOutbox.availableAt, now)),
      and(eq(notificationOutbox.status, "processing"), lte(notificationOutbox.lockedUntil, now)),
    );
    return this.db.select({ id: notificationOutbox.id }).from(notificationOutbox)
      .where(and(due, actionId === undefined ? undefined : eq(notificationOutbox.actionId, actionId)))
      .orderBy(notificationOutbox.id).limit(20);
  }

  /** Return undefined when another sender already owns the unexpired lease. */
  async claim(id: bigint, now: Date, leaseToken: string, lockedUntil: Date) {
    const [row] = await this.db.update(notificationOutbox).set({ status: "processing", leaseToken,
      lockedUntil, attempts: sql`${notificationOutbox.attempts} + 1`,
    }).where(and(eq(notificationOutbox.id, id), or(
      and(eq(notificationOutbox.status, "pending"), lte(notificationOutbox.availableAt, now)),
      and(eq(notificationOutbox.status, "processing"), lte(notificationOutbox.lockedUntil, now)),
    ))).returning();
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
    if (!updated.length) return;
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
