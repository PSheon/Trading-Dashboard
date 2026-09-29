import { Injectable } from "@nestjs/common";

import { env } from "../config/env.js";

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

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  my_chat_member?: TelegramChatMemberUpdated;
}

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
  /** Whether a bot token is configured at all. */
  configured(): boolean {
    return Boolean(env.telegramBotToken());
  }

  /** Calls `method` and returns its `result`; throws TelegramApiError on
   * `ok: false` or an HTTP error, and the fetch error on network failure
   * or abort. */
  async call<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const token = env.telegramBotToken();
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");

    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal,
    });
    const body = (await res.json().catch(() => null)) as BotApiResponse<T> | null;
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

  /** Plain text; Telegram links bare URLs by itself. */
  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.call("sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true } });
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
