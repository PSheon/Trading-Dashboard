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
import { chatIdForRuleKind } from "./chat-routing.js";
import { leaderDisplayLabel, renderRuleMessage } from "./message-template.js";
import { TelegramHttpClient } from "./telegram-http.client.js";

type ActionRow = typeof actions.$inferSelect;
type LeaderRow = typeof leaders.$inferSelect;
type AlertRuleRow = typeof alertRules.$inferSelect;

/** Every rule in `rules` must route to the same chat destination — the
 * caller (RulesService) groups by `chatIdForRuleKind` before calling this,
 * so one action never sends two Telegram messages even when e.g. R1 and R3
 * both match the same large `open` (or R2 and R3 both match the same
 * `flip`). One combined message is sent, but one `alerts` row is still
 * written per rule (N2) — each rule's cooldown was already applied
 * independently by the caller when deciding whether it "matched". */
export interface RulesFireContext {
  rules: AlertRuleRow[];
  action: ActionRow;
  leader: LeaderRow;
}

/** Simple backoff schedule for N4 (task's own suggestion: "1s/2s/4s, don't
 * overthink it"). 3 retries after the first attempt = 4 attempts total. */
const RETRY_DELAYS_MS = [1000, 2000, 4000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Telegram sender (§4.4 N1/N2/N4). `DRY_RUN=true` (the default) makes sends
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
   * for one action, already grouped to a single chat destination. Never
   * throws — a failure here is recorded in each `alerts` row's
   * send_status, not propagated (so one destination's failure can't stop
   * other destinations/addresses in the same evaluateAction() call from
   * being notified). */
  async notifyRulesFire(ctx: RulesFireContext): Promise<void> {
    try {
      await this.doNotify(ctx);
    } catch (error) {
      this.logger.error(
        `notifyRulesFire failed for rules [${ctx.rules.map((r) => r.kind).join(",")}] / ${ctx.action.address} / ${ctx.action.coin}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async doNotify(ctx: RulesFireContext): Promise<void> {
    const { rules, action, leader } = ctx;
    const sinceTs = new Date(action.ts.getTime() - THIRTY_DAYS_MS);
    const winRate = await this.roundTrip.winRate(action.address, action.coin, sinceTs);

    const dashboardUrl = `${env.dashboardBaseUrl()}/leaders/${action.address}`;
    const text = renderRuleMessage({
      rules,
      leader,
      action,
      winRate30dForCoin: winRate,
      dashboardUrl,
    });
    // Every rule in `rules` was grouped by the same chat destination by the
    // caller — any one of them resolves to the same chatId.
    const chatId = chatIdForRuleKind(rules[0].kind);

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

    if (env.dryRun()) {
      this.logger.log(`[DRY_RUN] ${text}`);
      await this.insertAlertRows(rules, action, payloadJson, "dry_run");
      return;
    }

    if (!chatId) {
      this.logger.error(
        `No chat id configured for rule kinds [${rules.map((r) => r.kind).join(",")}] — recording as failed without attempting a send`,
      );
      await this.insertAlertRows(rules, action, payloadJson, "failed");
      return;
    }

    const sent = await this.sendWithRetry(chatId, text);
    await this.insertAlertRows(rules, action, payloadJson, sent ? "sent" : "failed");
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
