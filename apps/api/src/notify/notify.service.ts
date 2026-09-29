import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  actions,
  alertRules,
  alerts,
  leaders,
} from "@trading-dashboard/shared";

import { RoundTripService } from "../analytics/round-trip.service.js";
import { env } from "../config/env.js";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { leaderDisplayLabel, renderRuleMessage } from "./message-template.js";
import { TelegramHttpClient } from "./telegram-http.client.js";

type ActionRow = typeof actions.$inferSelect;
type LeaderRow = typeof leaders.$inferSelect;
type AlertRuleRow = typeof alertRules.$inferSelect;

/** Every rule in `rules` belongs to `recipient` and matched this one
 * action — the caller (RulesService) groups by recipient, so one action
 * sends each person ONE Telegram message even when e.g. R1 and R3 both
 * match the same large `open`. One `alerts` row is still written per rule
 * (N2) — each rule's cooldown was already applied by the caller. */
export interface RulesFireContext {
  rules: AlertRuleRow[];
  action: ActionRow;
  leader: LeaderRow;
  recipient: {
    userId: number;
    /** The user's enabled Telegram channel, or null when they have none. */
    telegramChatId: string | null;
  };
}

/** Simple backoff schedule for N4 (task's own suggestion: "1s/2s/4s, don't
 * overthink it"). 3 retries after the first attempt = 4 attempts total. */
const RETRY_DELAYS_MS = [1000, 2000, 4000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Telegram sender (§4.4 N1/N2/N4). `TELEGRAM_DRY_RUN=true` (the default) makes sends
 * log-only; every attempt — dry-run or real — writes one `alerts` row per
 * matched rule (N2). A real send retries up to 3 times before recording
 * final failure (N4), without throwing back into RulesService (one rule/
 * address's send failure must never stop evaluation of the others — task's
 * explicit instruction).
 */
@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly roundTrip: RoundTripService,
    private readonly telegram: TelegramHttpClient,
  ) {}

  /** Entry point RulesService calls once it has decided which rules fire
   * for one action, already grouped to a single recipient. Never
   * throws — a failure here is recorded in each `alerts` row's
   * send_status, not propagated (so one destination's failure can't stop
   * other destinations/addresses in the same evaluateAction() call from
   * being notified). */
  async notifyRulesFire(ctx: RulesFireContext): Promise<void> {
    try {
      await this.doNotify(ctx);
    } catch (error) {
      this.logger.error(
        `notifyRulesFire failed for user ${ctx.recipient.userId} rules [${ctx.rules.map((r) => r.kind).join(",")}] / ${ctx.action.address} / ${ctx.action.coin}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async doNotify(ctx: RulesFireContext): Promise<void> {
    const { rules, action, leader, recipient } = ctx;
    const sinceTs = new Date(action.ts.getTime() - THIRTY_DAYS_MS);
    const winRate = await this.roundTrip.winRate(action.address, action.coin, sinceTs);

    const dashboardUrl = `${env.telegramLinkBaseUrl()}/trader/${action.address}`;
    const text = renderRuleMessage({
      rules,
      leader,
      action,
      winRate30dForCoin: winRate,
      dashboardUrl,
    });
    const chatId = recipient.telegramChatId;

    const values = {
      leaderLabel: leaderDisplayLabel(leader),
      actionKind: action.kind,
      coin: action.coin,
      side: action.side,
      notionalUsd: action.notionalUsd,
      leverage: action.leverage,
      avgPx: action.avgPx,
      winRate30d: winRate,
      dashboardUrl,
      matchedRuleKinds: rules.map((r) => r.kind),
    };
    const payloadJson = { text, chatId: chatId ?? null, values };

    if (env.telegramDryRun()) {
      this.logger.log(`[TELEGRAM_DRY_RUN] to user ${recipient.userId}: ${text}`);
      await this.insertAlertRows(recipient.userId, rules, action, payloadJson, "dry_run");
      return;
    }

    if (!chatId) {
      this.logger.warn(
        `User ${recipient.userId} has no enabled Telegram channel — recording [${rules.map((r) => r.kind).join(",")}] as failed`,
      );
      await this.insertAlertRows(
        recipient.userId,
        rules,
        action,
        { ...payloadJson, reason: "no enabled Telegram channel" },
        "failed",
      );
      return;
    }

    const sent = await this.sendWithRetry(chatId, text);
    await this.insertAlertRows(
      recipient.userId,
      rules,
      action,
      sent ? payloadJson : { ...payloadJson, reason: "Telegram send failed after retries" },
      sent ? "sent" : "failed",
    );
  }

  /** Operational message (e.g. §8 feed-down self-alert) to the operator's
   * TELEGRAM_SYSTEM_CHAT_ID chat — the only use of that env chat now that
   * user alerts go to each user's own channel. Not tied to a rule, so no
   * `alerts` row. Honors TELEGRAM_DRY_RUN; never throws. */
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

  /** N4: up to 3 retries (4 attempts total) with 1s/2s/4s backoff. Returns
   * whether the message was ultimately delivered — never throws. */
  private async sendWithRetry(chatId: string, text: string): Promise<boolean> {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        await this.telegram.sendMessage(chatId, text);
        return true;
      } catch (error) {
        this.logger.error(
          `Telegram send attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
        }
      }
    }
    return false;
  }

  /** One `alerts` row per matched rule (N2), all sharing the same rendered
   * payload/outcome since they were sent as a single combined message. */
  private async insertAlertRows(
    userId: number,
    rules: AlertRuleRow[],
    action: ActionRow,
    payloadJson: Record<string, unknown>,
    sendStatus: "sent" | "dry_run" | "failed",
  ): Promise<void> {
    // sent_at doubles as "when this notification attempt happened" for
    // every outcome (including 'failed') rather than only successful
    // sends — the D5 alerts log sorts/filters by this column regardless of
    // status, and a null timestamp on a failed row would sort oddly.
    // Documented judgment call; the PRD doesn't specify.
    const sentAt = new Date();
    await this.db.insert(alerts).values(
      rules.map((rule) => ({
        ruleId: rule.id,
        userId,
        chain: action.chain,
        address: action.address,
        coin: action.coin,
        actionId: action.id,
        payloadJson,
        sentAt,
        sendStatus,
      })),
    );
  }
}
