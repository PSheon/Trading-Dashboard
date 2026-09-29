import { AppConfig } from "../config/app-config.js";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { DbOrTx } from "../watcher/action-store.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import {
  actions,
  alertRules,
  alerts,
  notificationOutbox,
  notificationChannels,
  userFavorites,
  appSettings,
  users,
} from "@trading-dashboard/shared/database";
import { notificationDeliveryPayloadSchema, type Locale } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { renderAlertMessage, renderTestMessage, tradeSideOf } from "./message-template.js";
import { TelegramApiError, TelegramHttpClient } from "./telegram-http.client.js";

type ActionRow = typeof actions.$inferSelect;
type AlertRuleRow = typeof alertRules.$inferSelect;

export interface AlertRecipient {
  userId: number;
  /** The user's linked, enabled Telegram chat, or null when they have none. */
  telegramChatId: string | null;
  locale: Locale;
}

/**
 * One action, one recipient, one message. RulesService has already decided
 * this person gets it and why:
 * - `favorite`: their own alert on this trader matched (side, minimum);
 * - `rules`: default rules that matched, for an admin on an imported leader.
 * Both can be true for an admin who also set an alert; they still get one
 * message.
 */
export interface AlertContext {
  action: ActionRow;
  /** Leader label or leaderboard name; null → the short address. */
  traderName: string | null;
  recipient: AlertRecipient;
  rules: AlertRuleRow[];
  favorite: boolean;
}

/** Backoff between attempts for alerts and system messages: 3 retries
 * after the first attempt = 4 attempts in all. */
const RETRY_DELAYS_MS = [1000, 2000, 4000];

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sends alerts and system messages to Telegram. `TELEGRAM_DRY_RUN=true`
 * (the default) makes these log-only. The bot's conversation replies
 * (linking, /stop) don't come through here and are always sent; see
 * TelegramBotService.
 *
 * Every alert attempt — dry run, sent, failed, no chat — writes `alerts`
 * rows (N2): one per matched default rule, or a single row with no rule
 * for an alert that only a favorite triggered.
 */
@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);

  constructor(
    private readonly config: AppConfig,
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly telegram: TelegramHttpClient,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
  ) {}

  /** Persist intent before any external delivery. Transaction callers enqueue
   * only; the rules engine commits cooldowns and intent together. */
  async notifyAlert(ctx: AlertContext, tx?: DbOrTx): Promise<void> {
    if (tx) { await this.enqueue(ctx, tx); return; }
    await this.db.transaction((tx) => this.enqueue(ctx, tx));
    await this.deliverAction(ctx.action.id);
  }

  private async enqueue(ctx: AlertContext, db: DbOrTx): Promise<void> {
    const { action, recipient, rules } = ctx;
    const dashboardUrl = `${this.config.value.telegram.linkBaseUrl}/trader/${action.address}`;
    const ruleKinds = rules.map((r) => r.kind);
    const text = renderAlertMessage({
      locale: recipient.locale,
      traderName: ctx.traderName,
      action,
      dashboardUrl,
      ruleKinds,
    });
    const chatId = recipient.telegramChatId;
    const payloadJson = notificationDeliveryPayloadSchema.parse({
      version: 1,
      text: `${text}\n${action.ts.toISOString()}`,
      chatId,
      locale: recipient.locale,
      reasons: { favorite: ctx.favorite, rules: ruleKinds },
      values: {
        traderName: ctx.traderName,
        actionKind: action.kind,
        tradeSide: tradeSideOf(action),
        coin: action.coin,
        side: action.side,
        notionalUsd: action.notionalUsd,
        avgPx: action.avgPx,
        dashboardUrl,
      },
    });

    const inserted = await db.insert(notificationOutbox).values({
      actionId: action.id, userId: recipient.userId, payloadJson,
    }).onConflictDoNothing().returning({ id: notificationOutbox.id });
    if (inserted.length) await this.insertAlertRows(ctx, payloadJson, "pending", db);
  }

  async deliverAction(actionId?: bigint): Promise<void> {
    if (this.jobs.stopping) return;
    const now = new Date();
    const due = or(
      and(eq(notificationOutbox.status, "pending"), lte(notificationOutbox.availableAt, now)),
      and(eq(notificationOutbox.status, "processing"), lte(notificationOutbox.lockedUntil, now)),
    );
    const rows = await this.db.select({ id: notificationOutbox.id }).from(notificationOutbox)
      .where(and(due, actionId === undefined ? undefined : eq(notificationOutbox.actionId, actionId)))
      .orderBy(notificationOutbox.id).limit(20);
    for (const row of rows) {
      if (this.jobs.stopping) break;
      await this.deliverOne(row.id);
    }
  }

  private async deliverOne(id: bigint): Promise<void> {
    const now = new Date();
    const leaseToken = randomUUID();
    const [row] = await this.db.update(notificationOutbox).set({ status: "processing", leaseToken,
      lockedUntil: new Date(now.getTime() + 300_000), attempts: sql`${notificationOutbox.attempts} + 1`,
    }).where(and(eq(notificationOutbox.id, id), or(
      and(eq(notificationOutbox.status, "pending"), lte(notificationOutbox.availableAt, now)),
      and(eq(notificationOutbox.status, "processing"), lte(notificationOutbox.lockedUntil, now)),
    ))).returning();
    if (!row) return;
    const retry = { delayMs: 0, permanent: false };
    let status: "sent" | "dry_run" | "failed" = "failed";
    let reason: string | undefined;
    try {
      const [recipient] = await this.db.select({ id: users.id, role: users.role }).from(users)
        .where(and(eq(users.id, row.userId), isNull(users.disabledAt)));
      const payload = notificationDeliveryPayloadSchema.parse(row.payloadJson);
      if (row.attempts > 5) { retry.permanent = true; reason = "attempt limit"; }
      else if (!recipient) { retry.permanent = true; reason = "recipient disabled"; }
      else if (!(await this.deliveryStillAllowed(row, payload, recipient.role))) {
        retry.permanent = true; reason = "alert authorization withdrawn";
      }
      else if (this.config.value.telegram.dryRun) { status = "dry_run"; }
      else {
        const [channel] = await this.db.select().from(notificationChannels).where(and(
          eq(notificationChannels.userId, row.userId), eq(notificationChannels.kind, "telegram"), eq(notificationChannels.enabled, true),
        ));
        if (!channel || channel.target !== payload.chatId || typeof payload.text !== "string") {
          retry.permanent = true; reason = "no enabled Telegram channel";
        } else if (await this.sendWithRetry(channel.target, payload.text, retry, async () => {
          const [current] = await this.db.select().from(users).where(and(eq(users.id, row.userId), isNull(users.disabledAt)));
          const [linked] = await this.db.select().from(notificationChannels).where(and(
            eq(notificationChannels.userId, row.userId), eq(notificationChannels.kind, "telegram"),
            eq(notificationChannels.enabled, true), eq(notificationChannels.target, channel.target),
          ));
          return Boolean(current && linked && await this.deliveryStillAllowed(row, payload, current.role));
        })) status = "sent";
        else reason = "Telegram send failed";
      }
    } catch (error) {
      reason = "delivery failed";
      this.logger.error(`Delivery ${id} failed: ${errorText(error)}`);
    }
    const pending = status === "failed" && !retry.permanent && row.attempts < 5;
    await this.db.transaction(async (tx) => {
      const updated = await tx.update(notificationOutbox).set({ status: pending ? "pending" : status,
        availableAt: new Date(Date.now() + Math.max(60_000, retry.delayMs)), lockedUntil: null, leaseToken: null,
        lastError: reason ?? null,
      }).where(and(eq(notificationOutbox.id, id), eq(notificationOutbox.leaseToken, leaseToken))).returning({ id: notificationOutbox.id });
      if (!updated.length) return;
      await tx.update(alerts).set({ sendStatus: status, sentAt: new Date(),
        payloadJson: reason ? { ...row.payloadJson, reason } : row.payloadJson,
      }).where(and(eq(alerts.actionId, row.actionId), eq(alerts.userId, row.userId)));
    });
  }

  private async deliveryStillAllowed(
    row: typeof notificationOutbox.$inferSelect,
    payload: ReturnType<typeof notificationDeliveryPayloadSchema.parse>,
    role: string,
  ): Promise<boolean> {
    const [config] = await this.db.select().from(appSettings).where(eq(appSettings.key, "notifications"));
    if (config?.value && typeof config.value === "object" && "alertsEnabled" in config.value && config.value.alertsEnabled === false) return false;
    if (role === "admin" && payload.reasons.rules.length > 0) return true;
    if (!payload.reasons.favorite) return false;
    const [action] = await this.db.select().from(actions).where(eq(actions.id, row.actionId));
    if (!action) return false;
    const [favorite] = await this.db.select().from(userFavorites).where(and(
      eq(userFavorites.userId, row.userId), eq(userFavorites.chain, action.chain),
      eq(userFavorites.address, action.address), eq(userFavorites.alertEnabled, true),
    ));
    return Boolean(favorite && (favorite.alertSides === "both" || favorite.alertSides === payload.values.tradeSide)
      && (favorite.alertMinUsd === null || Number(payload.values.notionalUsd) >= Number(favorite.alertMinUsd)));
  }

  /** POST /me/telegram/test: one attempt, so the page answers quickly.
   * Honors dry run like any alert. */
  async sendTestMessage(chatId: string, locale: Locale): Promise<{ sent: boolean; dryRun: boolean }> {
    const text = renderTestMessage(locale, this.config.value.telegram.linkBaseUrl);
    if (this.config.value.telegram.dryRun) {
      this.logger.log("[TELEGRAM_DRY_RUN] test message suppressed");
      return { sent: false, dryRun: true };
    }
    try {
      await this.telegram.sendMessage(chatId, text);
      return { sent: true, dryRun: false };
    } catch (error) {
      this.logger.warn(`Test message failed: ${errorText(error)}`);
      return { sent: false, dryRun: false };
    }
  }

  /** Operational message (e.g. §8 feed-down self-alert) to the operator's
   * TELEGRAM_SYSTEM_CHAT_ID chat. Not an alert, so no `alerts` row.
   * Honors TELEGRAM_DRY_RUN; never throws. */
  async sendSystemMessage(text: string): Promise<void> {
    const chatId = this.config.value.telegram.systemChatId;
    if (this.config.value.telegram.dryRun || !chatId) {
      this.logger.warn(`[${this.config.value.telegram.dryRun ? "TELEGRAM_DRY_RUN" : "no chat id"}] system message suppressed`);
      return;
    }
    if (!(await this.sendWithRetry(chatId, text))) {
      this.logger.error("System message could not be delivered");
    }
  }

  /** N4: up to 3 retries with 1s/2s/4s backoff, only for errors that can
   * pass (network, 429, 5xx); "blocked by the user" fails at once. Returns
   * whether the message was delivered — never throws. */
  private async sendWithRetry(chatId: string, text: string, result = { delayMs: 0, permanent: false }, preflight?: () => Promise<boolean>): Promise<boolean> {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (this.jobs.stopping) return false;
      try {
        if (preflight && !(await preflight())) { result.permanent = true; return false; }
        await this.telegram.sendMessage(chatId, text);
        return true;
      } catch (error) {
        this.logger.error(
          `Telegram send attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1} failed: ${errorText(error)}`,
        );
        if (error instanceof TelegramApiError && !error.retryable) { result.permanent = true; return false; }
        const retryAfterMs = error instanceof TelegramApiError && Number.isFinite(error.retryAfterS)
            ? Math.max(0, error.retryAfterS! * 1000) : 0;
        // Long rate limits are recorded as failed, never retried earlier than Telegram permits.
          result.delayMs = Math.max(result.delayMs, retryAfterMs);
        if (retryAfterMs > 60_000) return false;
        if (attempt < RETRY_DELAYS_MS.length) {
          try { await delay(Math.max(RETRY_DELAYS_MS[attempt], retryAfterMs), this.jobs.signal); }
          catch { return false; }
        }
      }
    }
    return false;
  }

  private async insertAlertRows(
    ctx: AlertContext,
    payloadJson: Record<string, unknown>,
    sendStatus: "sent" | "dry_run" | "failed" | "pending",
    db: DbOrTx = this.db,
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
