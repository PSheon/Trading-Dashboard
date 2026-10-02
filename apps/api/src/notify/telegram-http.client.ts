import { AppConfig } from "../config/app-config.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { Injectable, Optional } from "@nestjs/common";


/** Messages a second across all chats (Telegram allows about 30). */
export const TELEGRAM_MESSAGES_PER_SECOND = 25;
/** Between two messages to one chat (Telegram allows about one a second). */
export const TELEGRAM_CHAT_INTERVAL_MS = 1_000;

/** A Bot API call that Telegram answered with `ok: false`, or an HTTP
 * error. `status` is the HTTP status (409 = another getUpdates poller or a
 * webhook, 403 = the user blocked the bot, 429 = rate limited). */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
    readonly retryAfterS?: number,
  ) {
    super(`Telegram ${method} failed: ${status} ${description}`);
    this.name = "TelegramApiError";
  }

  /** Worth retrying: rate limits, server errors. A 4xx like "chat not
   * found" or "bot was blocked" will fail the same way again. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** What `getUpdates` returns that the bot reads. */
export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  date: number;
}

export interface TelegramChatMemberUpdated {
  chat: TelegramChat;
  from: TelegramUser;
  new_chat_member: { status: string };
}

/** A press on an inline keyboard button under one of the bot's messages. */
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  my_chat_member?: TelegramChatMemberUpdated;
  callback_query?: TelegramCallbackQuery;
}

/** One row of inline keyboard buttons (`callback_data` ≤ 64 bytes). */
export type InlineKeyboard = { text: string; callback_data: string }[][];

interface BotApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/**
 * Telegram Bot API over plain `fetch` (no SDK: the bot needs four methods).
 * The token is read per call and never logged. An injectable class so
 * tests can substitute it; tests of the class itself stub `globalThis.fetch`.
 */
@Injectable()
export class TelegramHttpClient {
  /** Telegram's own limits for a bot, with a margin: about 30 messages a
   * second in all, and one a second to a single chat. Settable for tests. */
  pacing = { perSecond: TELEGRAM_MESSAGES_PER_SECOND, chatIntervalMs: TELEGRAM_CHAT_INTERVAL_MS };
  private nextSendAt = 0;
  private readonly chatNextAt = new Map<string, number>();

  constructor(private readonly config: AppConfig, @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs()) {}

  /**
   * Waits for this message's turn: the next free slot of the global rate,
   * and a full interval after the last message to the same chat. Slots are
   * handed out in call order, so concurrent senders are spread out instead
   * of bursting. Rejects when the process is stopping.
   */
  private async pace(chatId: string): Promise<void> {
    const now = Date.now();
    // A slot of the global rate, in call order…
    const slot = Math.max(now, this.nextSendAt);
    this.nextSendAt = slot + 1000 / this.pacing.perSecond;
    // …or later, when this chat had a message less than its interval ago.
    // That wait is the chat's own: it does not push back the global slots,
    // so one chat with several messages never holds the others up. (Such a
    // message then shares its second with the slots already handed out; a
    // chat adds at most one a second, well inside the margin to 30.)
    const at = Math.max(slot, this.chatNextAt.get(chatId) ?? 0);
    this.chatNextAt.set(chatId, at + this.pacing.chatIntervalMs);
    if (this.chatNextAt.size > 10_000) for (const [chat, next] of this.chatNextAt) if (next <= now) this.chatNextAt.delete(chat);
    if (at <= now) return;
    const signal = this.jobs.signal;
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, at - now);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  /** Whether a bot token is configured at all. */
  configured(): boolean {
    return Boolean(this.config.value.telegram.botToken);
  }

  /** Calls `method` and returns its `result`; throws TelegramApiError on
   * `ok: false` or an HTTP error, and the fetch error on network failure
   * or abort. */
  async call<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const token = this.config.value.telegram.botToken;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");

    const timeoutMs = method === "getUpdates" && typeof params.timeout === "number"
      ? (Math.max(0, Math.min(params.timeout, 50)) + 15) * 1000 : 15_000;
    const requestSignal = AbortSignal.any([this.jobs.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: requestSignal,
    });
    const body = (await res.json()) as BotApiResponse<T> | null;
    if (!res.ok || !body?.ok) {
      throw new TelegramApiError(
        method,
        body?.error_code ?? res.status,
        body?.description ?? res.statusText,
        body?.parameters?.retry_after,
      );
    }
    return body.result as T;
  }

  /** Plain text; Telegram links bare URLs by itself. `keyboard` adds
   * inline buttons whose presses arrive as `callback_query` updates.
   * Every message, alert or bot reply, waits for its turn under
   * Telegram's limits ({@link pace}). */
  async sendMessage(chatId: string, text: string, keyboard?: InlineKeyboard): Promise<void> {
    await this.pace(chatId);
    await this.call("sendMessage", {
      chat_id: chatId, text, link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  /** Acknowledges a button press (stops the client's spinner). */
  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackQueryId });
  }

  /** Removes the inline buttons from one of the bot's messages. */
  async removeKeyboard(chatId: string, messageId: number): Promise<void> {
    await this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  }

  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>("getMe");
  }

  /** Long poll: waits up to `timeoutS` for updates after `offset`. */
  getUpdates(
    params: { offset?: number; timeoutS: number; allowedUpdates: string[] },
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      { offset: params.offset, timeout: params.timeoutS, allowed_updates: params.allowedUpdates },
      signal,
    );
  }
}
