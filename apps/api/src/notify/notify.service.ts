import { randomUUID } from "node:crypto";

import { Injectable, Logger, Optional } from "@nestjs/common";
import { notificationDeliveryPayloadSchema, type Locale } from "@trading-dashboard/shared/contracts";

import { AppConfig } from "../config/app-config.js";
import { recoverSettingsSection } from "../settings/settings-recovery.js";
import { UnitOfWork, type DbTransaction } from "../db/unit-of-work.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { forEachConcurrent } from "../runtime/concurrency.js";
import { DELIVERY_BATCH, NotifyRepository, type DeliveryRow } from "./notify.repository.js";
import { copyDeliveryPayloadSchema, renderCopyMessage, COPY_NOTIFICATION_TYPES } from "./copy-message.js";
import type { AlertContext } from "./notify.types.js";
import { renderAlertMessage, renderTestMessage, tradeSideOf } from "./message-template.js";
import { TelegramApiError, TelegramHttpClient } from "./telegram-http.client.js";

export type { AlertContext, AlertRecipient } from "./notify.types.js";

/** Deliveries sent at once within a drain; the Telegram client's pacing sets the actual rate. */
export const DELIVERY_CONCURRENCY = 8;
/** One drain call stops reading new batches after this long (the next call goes on). */
export const DELIVERY_DRAIN_BUDGET_MS = 30_000;
/**
 * An alert is evaluated and sent only while its trade is this recent
 * (review 51). An action is queued for alerts only when it is at most
 * `maxActionAgeSeconds` old (120 s; `insertActions`), but the queue is
 * durable: a row left by a worker that was down, by a restored backup or by
 * Telegram refusing for a long time used to be evaluated and sent whenever
 * it was next read, as if the trade had just happened. Ten minutes covers
 * the retry schedule (five attempts a minute apart) and a restart; past it
 * the evaluation is closed and the delivery dropped, both marked `expired`.
 */
export const ALERT_MAX_AGE_MS = 10 * 60_000;

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
 * Enqueue creates one alert row per matched default rule, or one rule-free
 * row for a favorite-only alert. Delivery updates those same rows, including
 * dry-run and failed outcomes; retries do not append duplicate alert rows.
 */
@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);

  constructor(
    private readonly config: AppConfig,
    private readonly repository: NotifyRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly telegram: TelegramHttpClient,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
  ) {}

  /** Persist intent before any external delivery. Transaction callers enqueue
   * only; the rules engine commits cooldowns and intent together. */
  async notifyAlert(ctx: AlertContext, tx?: DbTransaction): Promise<void> {
    if (tx) { await this.enqueue(ctx, tx); return; }
    await this.unitOfWork.run((tx) => this.enqueue(ctx, tx));
    await this.deliverAction(ctx.action.id);
  }

  private async enqueue(ctx: AlertContext, db: DbTransaction): Promise<void> {
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

    await this.repository.enqueue(ctx, payloadJson, db);
  }

  /**
   * Drains the due deliveries (of one action, or all of them): batches of
   * DELIVERY_BATCH, DELIVERY_CONCURRENCY at a time, until nothing is due,
   * the drain's time budget is spent or the process is stopping. Each send
   * requires an owned lease, so drains may overlap.
   *
   * How fast it goes is Telegram's limit, not a batch size: the client
   * paces every `sendMessage` (about 25 a second in all, one a second to a
   * chat), so an action with 200 recipients is delivered in about 8
   * seconds. It was 20 rows at once and then 20 every 5 seconds (review 49:
   * 45 seconds for the same 200, and a backlog under load).
   */
  async deliverAction(actionId?: bigint): Promise<void> {
    if (actionId === undefined) {
      for (const { event, chatId, locale, leaderAddress } of await this.repository.copyCandidates(ALERT_MAX_AGE_MS)) {
        const payload = copyDeliveryPayloadSchema.parse({ version: 2, kind: "copy", mode: "paper", eventId: String(event.id), chatId,
          text: renderCopyMessage(event, this.config.value.telegram.linkBaseUrl, locale, leaderAddress) });
        await this.unitOfWork.run(tx => this.repository.enqueueCopy(event.id, event.userId, payload, tx));
      }
    }
    const deadline = Date.now() + DELIVERY_DRAIN_BUDGET_MS;
    while (!this.jobs.stopping) {
      const rows = await this.repository.findDue(actionId);
      if (rows.length === 0) return;
      await forEachConcurrent(rows, DELIVERY_CONCURRENCY, (row) => this.deliverOne(row.id), this.jobs.signal);
      if (rows.length < DELIVERY_BATCH || Date.now() >= deadline) return;
    }
  }

  private async deliverOne(id: bigint): Promise<void> {
    const leaseToken = randomUUID();
    const row = await this.repository.claim(id, leaseToken, 300_000);
    if (!row) return;
    if (row.copyEventId !== null) { await this.deliverCopy(row, leaseToken); return; }
    const retry = { delayMs: 0, permanent: false };
    let status: "sent" | "dry_run" | "failed" = "failed";
    let reason: string | undefined;
    try {
      const recipient = await this.repository.enabledRecipient(row.userId);
      const payload = notificationDeliveryPayloadSchema.parse(row.payloadJson);
      // A trade alert is about now. One that waited this long (the worker
      // was down, Telegram kept refusing) is dropped, not sent as if fresh.
      if (Date.now() - row.createdAt.getTime() > ALERT_MAX_AGE_MS) { retry.permanent = true; reason = "expired"; }
      else if (row.attempts > 5) { retry.permanent = true; reason = "attempt limit"; }
      else if (!recipient) { retry.permanent = true; reason = "recipient disabled"; }
      else if (!(await this.deliveryStillAllowed(row, payload, recipient.role))) {
        retry.permanent = true; reason = "alert authorization withdrawn";
      }
      else if (this.config.value.telegram.dryRun) { status = "dry_run"; }
      else {
        const channel = await this.repository.enabledChannel(row.userId);
        if (!channel || channel.target !== payload.chatId || typeof payload.text !== "string") {
          retry.permanent = true; reason = "no enabled Telegram channel";
        } else if (await this.sendWithRetry(channel.target, payload.text, retry, async () => {
          const current = await this.repository.enabledRecipient(row.userId);
          const linked = await this.repository.enabledChannel(row.userId, channel.target);
          return Boolean(current && linked && await this.deliveryStillAllowed(row, payload, current.role));
        })) status = "sent";
        else reason = "Telegram send failed";
      }
    } catch (error) {
      reason = "delivery failed";
      this.logger.error(`Delivery ${id} failed: ${errorText(error)}`);
    }
    const pending = status === "failed" && !retry.permanent && row.attempts < 5;
    await this.unitOfWork.run((tx) => this.repository.recordDelivery(tx, row, leaseToken, {
      status, pending, availableAt: new Date(Date.now() + Math.max(60_000, retry.delayMs)), reason,
    }));
  }

  private async deliverCopy(row: DeliveryRow, leaseToken: string): Promise<void> {
    const retry = { delayMs: 0, permanent: false };
    let status: "sent" | "dry_run" | "failed" = "failed";
    let reason: string | undefined;
    try {
      const payload = copyDeliveryPayloadSchema.parse(row.payloadJson);
      const allowed = async () => {
        const [recipient, channel, event, settings] = await Promise.all([
          this.repository.enabledRecipient(row.userId), this.repository.enabledChannel(row.userId, payload.chatId),
          this.repository.copyEvent(row.copyEventId!, row.userId), this.repository.notificationSettings(),
        ]);
        return Boolean(recipient && channel?.copyAlertsEnabled && channel.copyAlertsSince && event
          && String(event.id) === payload.eventId && event.payload.mode === "paper"
          && (COPY_NOTIFICATION_TYPES as readonly string[]).includes(event.type)
          && event.createdAt >= channel.copyAlertsSince && Date.now() - event.createdAt.getTime() <= ALERT_MAX_AGE_MS
          && recoverSettingsSection("notifications", settings ? settings.value : {}, Boolean(settings)).value.alertsEnabled);
      };
      // Like a trade alert: one that waited past the cut-off is dropped, not sent as if fresh.
      if (Date.now() - row.createdAt.getTime() > ALERT_MAX_AGE_MS) { retry.permanent = true; reason = "expired"; }
      else if (row.attempts > 5 || !(await allowed())) { retry.permanent = true; reason = "copy notification authorization withdrawn or expired"; }
      else if (this.config.value.telegram.dryRun) status = "dry_run";
      else if (await this.sendWithRetry(payload.chatId, payload.text, retry, allowed)) status = "sent";
      else reason = "Telegram send failed";
    } catch (error) {
      reason = "copy delivery failed";
      if (error instanceof Error && error.name === "ZodError") retry.permanent = true;
      this.logger.error(`Copy delivery ${row.id} failed: ${errorText(error)}`);
    }
    await this.unitOfWork.run(tx => this.repository.recordDelivery(tx, row, leaseToken, {
      status, pending: status === "failed" && !retry.permanent && row.attempts < 5,
      availableAt: new Date(Date.now() + Math.max(60_000, retry.delayMs)), reason,
    }));
  }

  private async deliveryStillAllowed(
    row: DeliveryRow,
    payload: ReturnType<typeof notificationDeliveryPayloadSchema.parse>,
    role: string,
  ): Promise<boolean> {
    const config = await this.repository.notificationSettings();
    if (!recoverSettingsSection("notifications", config ? config.value : {}, Boolean(config)).value.alertsEnabled) return false;
    if (role === "admin" && payload.reasons.rules.length > 0) return true;
    if (!payload.reasons.favorite) return false;
    if (row.actionId === null) return false;
    const action = await this.repository.action(row.actionId);
    if (!action) return false;
    const favorite = await this.repository.enabledFavorite(row.userId, action.chain, action.address);
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

}
