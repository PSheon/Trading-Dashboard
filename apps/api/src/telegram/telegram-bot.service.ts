import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";

import { env } from "../config/env.js";
import {
  TelegramApiError,
  TelegramHttpClient,
  type TelegramMessage,
  type TelegramUpdate,
} from "../notify/telegram-http.client.js";
import { botMessages } from "./bot-messages.js";
import { TelegramLinkService } from "./telegram-link.service.js";

/** Long-poll wait per getUpdates call (Telegram allows up to 50 s). */
const LONG_POLL_S = 30;
/** The HTTP request may take the long poll plus this before we give up. */
const REQUEST_SLACK_MS = 15_000;
const ALLOWED_UPDATES = ["message", "my_chat_member"];
/** A deep-link payload: [A-Za-z0-9_-], at most 64 chars. Ours are 43. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const COMMAND_PATTERN = /^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/;

/** 409 from getUpdates: another process polls this token (or a webhook is
 * set). Back off, doubling, up to a minute; it may be a deploy overlap. */
const CONFLICT_BACKOFF_MS = { first: 5_000, max: 60_000 };
/** Network errors, 429, 5xx. */
const ERROR_BACKOFF_MS = { first: 1_000, max: 30_000 };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The official bot's side of the conversation: receives updates by long
 * polling `getUpdates` (with an offset, so each update is confirmed once
 * handled) in the background, and answers `/start <token>` (link a chat),
 * `/start` (welcome, or resume a paused chat), `/stop` (pause) and
 * `/help`. Blocking the bot pauses the chat's alerts too.
 *
 * Polls only with TELEGRAM_BOT_POLLING (default true) and a token set.
 * Telegram allows one poller per token: a 409 means another process has
 * it, which is logged and backed off from, never fatal. A 401/404 means the
 * token itself is wrong, and polling stops.
 *
 * Replies here are always sent, whatever TELEGRAM_DRY_RUN says: they answer
 * a person who just pressed Start, and without them nobody could link a
 * chat on a dry-run deployment. Dry run covers alerts and system messages
 * only (NotifyService).
 */
@Injectable()
export class TelegramBotService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private offset: number | undefined;
  private running = false;
  private abort: AbortController | undefined;
  private loopDone: Promise<void> | undefined;

  constructor(
    private readonly telegram: TelegramHttpClient,
    private readonly link: TelegramLinkService,
  ) {}

  onApplicationBootstrap(): void {
    // Tests start the loop themselves, against a stubbed Telegram.
    if (process.env.NODE_ENV === "test") return;
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  get polling(): boolean {
    return this.running;
  }

  /** The offset the next getUpdates call sends (last update id + 1). */
  get nextOffset(): number | undefined {
    return this.offset;
  }

  /** Starts the background poll loop if polling is enabled and a token is
   * set; returns whether it is running. */
  start(): boolean {
    if (this.running) return true;
    if (!env.telegramBotPolling()) {
      this.logger.log("TELEGRAM_BOT_POLLING=false: not receiving bot updates (linking happens on another process)");
      return false;
    }
    if (!this.telegram.configured()) {
      this.logger.warn("No TELEGRAM_BOT_TOKEN: the bot is not polling, so Telegram linking is unavailable");
      return false;
    }
    this.running = true;
    this.abort = new AbortController();
    this.logger.log("Telegram bot polling for updates");
    // Fire and forget, but never an unhandled rejection.
    this.loopDone = this.loop()
      .catch((error) => this.logger.error(`Telegram poll loop crashed: ${errorText(error)}`))
      .finally(() => {
        this.running = false;
      });
    return true;
  }

  /** Stops the loop and aborts an in-flight long poll. */
  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.loopDone;
    this.loopDone = undefined;
  }

  private async loop(): Promise<void> {
    let conflicts = 0;
    let errors = 0;
    while (this.running) {
      try {
        await this.pollOnce();
        if (conflicts > 0) this.logger.log("Telegram polling resumed: the other poller is gone");
        conflicts = 0;
        errors = 0;
      } catch (error) {
        if (!this.running) break; // aborted by stop()
        if (error instanceof TelegramApiError && error.status === 409) {
          conflicts += 1;
          const delay = backoff(CONFLICT_BACKOFF_MS, conflicts);
          this.logger.warn(
            `Telegram getUpdates 409 Conflict (${error.description}): another process is polling this bot token, ` +
              `or a webhook is set. Only one poller may run; set TELEGRAM_BOT_POLLING=false on the others. ` +
              `Retrying in ${delay / 1000}s.`,
          );
          await this.wait(delay);
        } else if (error instanceof TelegramApiError && (error.status === 401 || error.status === 404)) {
          this.logger.error(`Telegram rejected the bot token (${error.status}); polling stopped. Check TELEGRAM_BOT_TOKEN.`);
          this.running = false;
        } else {
          errors += 1;
          const retryAfterMs = error instanceof TelegramApiError && error.retryAfterS ? error.retryAfterS * 1000 : 0;
          const delay = Math.max(retryAfterMs, backoff(ERROR_BACKOFF_MS, errors));
          this.logger.warn(`Telegram getUpdates failed: ${errorText(error)}. Retrying in ${delay / 1000}s.`);
          await this.wait(delay);
        }
      }
    }
  }

  /** One getUpdates round: fetch, then handle each update in order. The
   * offset moves past an update before it is handled, so one that keeps
   * failing can't wedge the bot. Returns how many updates came. */
  async pollOnce(): Promise<number> {
    const signal = AbortSignal.any([
      ...(this.abort ? [this.abort.signal] : []),
      AbortSignal.timeout(LONG_POLL_S * 1000 + REQUEST_SLACK_MS),
    ]);
    const updates = await this.telegram.getUpdates(
      { offset: this.offset, timeoutS: LONG_POLL_S, allowedUpdates: ALLOWED_UPDATES },
      signal,
    );
    for (const update of updates) {
      if (signal.aborted) break;
      this.offset = update.update_id + 1;
      try {
        await this.handleUpdate(update);
      } catch (error) {
        this.logger.error(`Telegram update ${update.update_id} failed: ${errorText(error)}`);
      }
    }
    return updates.length;
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const member = update.my_chat_member;
    if (member && member.chat.type === "private" && member.new_chat_member.status === "kicked") {
      // The user blocked the bot: pause, as /stop would. No reply possible.
      if (await this.link.disableChat(String(member.chat.id))) {
        this.logger.log(`Telegram chat ${member.chat.id} blocked the bot; alerts paused`);
      }
      return;
    }
    if (update.message?.text) await this.handleMessage(update.message);
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    const site = env.telegramLinkBaseUrl();
    const chatId = String(message.chat.id);
    const command = COMMAND_PATTERN.exec(message.text?.trim() ?? "");
    const name = command?.[1].toLowerCase();

    if (message.chat.type !== "private") {
      if (name === "start" || name === "stop") await this.reply(chatId, botMessages.privateOnly());
      return;
    }

    if (name === "start") {
      const payload = command?.[2]?.trim();
      if (payload) {
        await this.reply(chatId, await this.startWithToken(payload, chatId, message.from?.username ?? null));
        return;
      }
      const state = await this.link.resumeChat(chatId);
      await this.reply(
        chatId,
        state === "resumed"
          ? botMessages.resumed(site)
          : state === "linked"
            ? botMessages.alreadyLinked(site)
            : botMessages.welcome(site),
      );
      return;
    }

    if (name === "stop") {
      const paused = await this.link.disableChat(chatId);
      await this.reply(chatId, paused ? botMessages.stopped(site) : botMessages.notLinked(site));
      return;
    }

    await this.reply(chatId, botMessages.help(site));
  }

  private async startWithToken(token: string, chatId: string, username: string | null): Promise<string> {
    const site = env.telegramLinkBaseUrl();
    if (!TOKEN_PATTERN.test(token)) return botMessages.invalidToken(site);
    const result = await this.link.consumeStartToken(token, chatId, username);
    switch (result.kind) {
      case "linked":
        this.logger.log(`Telegram chat linked to user ${result.userId}${result.moved ? " (moved from another user)" : ""}`);
        return botMessages.linked(site, result.moved);
      case "already_linked":
        return botMessages.alreadyLinked(site);
      case "invalid":
        return botMessages.invalidToken(site);
    }
  }

  /** Conversation replies: sent even under TELEGRAM_DRY_RUN (see the class
   * comment). One attempt; the caller logs a failure. */
  private async reply(chatId: string, text: string): Promise<void> {
    await this.telegram.sendMessage(chatId, text);
  }

  /** Resolves after `ms`, or at once when stop() is called. */
  protected wait(ms: number): Promise<void> {
    const signal = this.abort?.signal;
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

function backoff(schedule: { first: number; max: number }, attempt: number): number {
  return Math.min(schedule.max, schedule.first * 2 ** (attempt - 1));
}
