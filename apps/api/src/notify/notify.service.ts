import { Inject, Injectable, Logger } from "@nestjs/common";
import { actions, alertRules, alerts, alertPayloadSchema, type Locale } from "@trading-dashboard/shared";

import { env } from "../config/env.js";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly telegram: TelegramHttpClient,
  ) {}

  /** Never throws: a failure is recorded in the `alerts` rows, so one
   * recipient can't stop the others. */
  async notifyAlert(ctx: AlertContext): Promise<void> {
    try {
      await this.doNotify(ctx);
    } catch (error) {
      this.logger.error(
        `Alert to user ${ctx.recipient.userId} for ${ctx.action.address} / ${ctx.action.coin} failed: ${errorText(error)}`,
      );
    }
  }

  private async doNotify(ctx: AlertContext): Promise<void> {
    const { action, recipient, rules } = ctx;
    const dashboardUrl = `${env.telegramLinkBaseUrl()}/trader/${action.address}`;
    const ruleKinds = rules.map((r) => r.kind);
    const text = renderAlertMessage({
      locale: recipient.locale,
      traderName: ctx.traderName,
      action,
      dashboardUrl,
      ruleKinds,
    });
    const chatId = recipient.telegramChatId;
    const payloadJson = alertPayloadSchema.parse({
      version: 1,
      text,
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

    // Dry run covers alerts: logged and recorded, never sent.
    if (env.telegramDryRun()) {
      this.logger.log(`[TELEGRAM_DRY_RUN] to user ${recipient.userId}: ${text}`);
      await this.insertAlertRows(ctx, payloadJson, "dry_run");
      return;
    }

    if (!chatId) {
      this.logger.warn(`User ${recipient.userId} has no linked Telegram chat — alert recorded as failed`);
      await this.insertAlertRows(ctx, { ...payloadJson, reason: "no enabled Telegram channel" }, "failed");
      return;
    }

    const sent = await this.sendWithRetry(chatId, text);
    await this.insertAlertRows(
      ctx,
      sent ? payloadJson : { ...payloadJson, reason: "Telegram send failed" },
      sent ? "sent" : "failed",
    );
  }

  /** POST /me/telegram/test: one attempt, so the page answers quickly.
   * Honors dry run like any alert. */
  async sendTestMessage(chatId: string, locale: Locale): Promise<{ sent: boolean; dryRun: boolean }> {
    const text = renderTestMessage(locale, env.telegramLinkBaseUrl());
    if (env.telegramDryRun()) {
      this.logger.log(`[TELEGRAM_DRY_RUN] test message to ${chatId}: ${text}`);
      return { sent: false, dryRun: true };
    }
    try {
      await this.telegram.sendMessage(chatId, text);
      return { sent: true, dryRun: false };
    } catch (error) {
      this.logger.warn(`Test message to ${chatId} failed: ${errorText(error)}`);
      return { sent: false, dryRun: false };
    }
  }

  /** Operational message (e.g. §8 feed-down self-alert) to the operator's
   * TELEGRAM_SYSTEM_CHAT_ID chat. Not an alert, so no `alerts` row.
   * Honors TELEGRAM_DRY_RUN; never throws. */
  async sendSystemMessage(text: string): Promise<void> {
    const chatId = env.telegramSystemChatId();
    if (env.telegramDryRun() || !chatId) {
      this.logger.warn(`[${env.telegramDryRun() ? "TELEGRAM_DRY_RUN" : "no chat id"}] system message: ${text}`);
      return;
    }
    if (!(await this.sendWithRetry(chatId, text))) {
      this.logger.error(`System message could not be delivered: ${text}`);
    }
  }

  /** N4: up to 3 retries with 1s/2s/4s backoff, only for errors that can
   * pass (network, 429, 5xx); "blocked by the user" fails at once. Returns
   * whether the message was delivered — never throws. */
  private async sendWithRetry(chatId: string, text: string): Promise<boolean> {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        await this.telegram.sendMessage(chatId, text);
        return true;
      } catch (error) {
        this.logger.error(
          `Telegram send attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1} failed: ${errorText(error)}`,
        );
        if (error instanceof TelegramApiError && !error.retryable) return false;
        if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
    return false;
  }

  private async insertAlertRows(
    ctx: AlertContext,
    payloadJson: Record<string, unknown>,
    sendStatus: "sent" | "dry_run" | "failed",
  ): Promise<void> {
    // sent_at is "when this attempt happened" for every outcome, so the log
    // sorts failed rows in place too.
    const sentAt = new Date();
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
    await this.db.insert(alerts).values(ruleIds.map((ruleId) => ({ ...row, ruleId })));
  }
}
