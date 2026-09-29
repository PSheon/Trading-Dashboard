import { Injectable, Logger } from "@nestjs/common";

import { env } from "../config/env.js";

/**
 * Thin wrapper around Telegram Bot API's `sendMessage` — plain `fetch`, no
 * SDK dependency (task explicit instruction: "no SDK dependency needed for
 * one endpoint"). Pulled out as its own injectable class (rather than a
 * bare function) purely so tests can substitute a mock via DI/manual
 * construction, matching this repo's existing test convention of
 * constructing services directly with fake collaborators (see
 * `watcher.spec.ts`'s `fakeInfo`).
 */
@Injectable()
export class TelegramHttpClient {
  private readonly logger = new Logger(TelegramHttpClient.name);

  async sendMessage(chatId: string, text: string): Promise<void> {
    const token = env.telegramBotToken();
    if (!token) {
      throw new Error("TELEGRAM_BOT_TOKEN is not configured");
    }

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      this.logger.error(`Telegram sendMessage failed: ${res.status} ${body}`);
      throw new Error(`Telegram sendMessage failed: ${res.status}`);
    }
  }
}
