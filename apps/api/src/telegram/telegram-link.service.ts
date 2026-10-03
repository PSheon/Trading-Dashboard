import { AppConfig } from "../config/app-config.js";
import { createHash, randomBytes } from "node:crypto";

import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  type Locale,
  type TelegramLinkResponse,
  type TelegramStatus,
  type TelegramTestResponse,
} from "@trading-dashboard/shared/contracts";

import { TelegramLinkRepository } from "./telegram-link.repository.js";
import { UnitOfWork } from "../db/unit-of-work.js";
import { NotifyService } from "../notify/notify.service.js";

export const LINK_TOKEN_TTL_MS = 10 * 60_000;
/** Link requests per user per window; beyond it, 429. */
export const LINK_RATE_LIMIT = 5;
export const LINK_RATE_WINDOW_MS = 10 * 60_000;
/** Token rows are kept this long after expiring (they back the rate
 * limit), then deleted on the user's next link request. */
const TOKEN_RETENTION_MS = 24 * 60 * 60_000;

/** Only this is stored; the token itself exists in the t.me link alone. */
export function hashLinkToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** What `/start <token>` shows before anything is linked. */
export type StartPreview =
  | { kind: "confirm"; account: string; moved: boolean }
  | { kind: "already_linked" }
  | { kind: "invalid" };

/**
 * An account as its owner would recognise it, without giving it away to
 * whoever else sees the prompt: `p***@gmail.com`, `0x12…abcd`, or its
 * number when it has neither.
 */
export function maskAccount(userId: number, account: { email: string | null; walletAddress: string | null } | undefined): string {
  const email = account?.email;
  const at = email?.lastIndexOf("@") ?? -1;
  if (email && at > 0) return `${email[0]}***${email.slice(at)}`;
  const wallet = account?.walletAddress;
  if (wallet && wallet.length > 10) return `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
  return `#${userId}`;
}

/** What confirming `/start <token>` amounted to. */
export type StartResult =
  | { kind: "linked"; userId: number; moved: boolean }
  | { kind: "already_linked" }
  | { kind: "invalid" };

export function notLinked(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: "telegram_not_linked",
    message: "No Telegram chat is linked",
  });
}

/**
 * Linking a user's Telegram chat through the official bot:
 * 1. POST /me/telegram/link issues a one-time token (32 random bytes,
 *    base64url, 10 minutes) and returns `t.me/<bot>?start=<token>`;
 * 2. the user presses Start; the bot receives `/start <token>` and, via
 *    `previewStartToken`, asks in the chat whether to link it to the
 *    token's account, shown masked (`p***@gmail.com`), with Confirm and
 *    Cancel buttons. Nothing is linked yet: a link someone else created
 *    and sent you would otherwise move your chat to their account and
 *    show them your Telegram username;
 * 3. Confirm calls `consumeStartToken`, which links that chat (Cancel
 *    ends the token);
 * 4. the page, polling GET /me/telegram, sees `linked: true`.
 *
 * One chat belongs to one user: linking a chat that another account had
 * moves it. A user has one Telegram channel (the unique (user, kind) row).
 */
@Injectable()
export class TelegramLinkService {
  constructor(
    private readonly config: AppConfig,
    private readonly repository: TelegramLinkRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly notify: NotifyService,
  ) {}

  /** The bot's username when the bot is usable (token and username set). */
  bot(): string | null {
    const username = this.config.value.telegram.botUsername?.replace(/^@/, "");
    return username && this.config.value.telegram.botToken ? username : null;
  }

  async status(userId: number): Promise<TelegramStatus> {
    const channel = await this.repository.channelOf(userId);
    return {
      copyAlertsEnabled: channel?.copyAlertsEnabled ?? false,
      bot: this.bot(),
      linked: channel !== undefined,
      username: channel?.username ?? null,
      enabled: channel?.enabled ?? false,
      linkedAt: channel?.createdAt ?? null,
    };
  }

  async setCopyAlerts(userId: number, enabled: boolean): Promise<TelegramStatus> {
    if (!(await this.repository.setCopyAlerts(userId, enabled))) throw notLinked();
    return this.status(userId);
  }

  async createLink(userId: number): Promise<TelegramLinkResponse> {
    const bot = this.bot();
    if (!bot) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: "telegram_not_configured",
        message: "The Telegram bot is not configured",
      });
    }

    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LINK_TOKEN_TTL_MS);

    await this.unitOfWork.run(async (tx) => {
      await this.repository.lockUser(tx, userId);
      const n = await this.repository.recentTokenCount(tx, userId, new Date(now.getTime() - LINK_RATE_WINDOW_MS));
      if (n >= LINK_RATE_LIMIT) {
        throw new HttpException(
          {
            statusCode: 429,
            code: "rate_limited",
            message: `At most ${LINK_RATE_LIMIT} Telegram links per ${LINK_RATE_WINDOW_MS / 60_000} minutes`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      await this.repository.replaceToken(tx, userId, hashLinkToken(token), now, expiresAt,
        new Date(now.getTime() - TOKEN_RETENTION_MS));
    });

    return { url: `https://t.me/${bot}?start=${token}`, expiresAt };
  }

  /** DELETE /me/telegram. Alerts stay configured; they record as failed
   * until a chat is linked again. */
  async unlink(userId: number): Promise<void> {
    await this.repository.unlink(userId);
  }

  /** POST /me/telegram/test: 409 without a linked, enabled chat. */
  async sendTest(userId: number): Promise<TelegramTestResponse> {
    const row = await this.repository.testDestination(userId);
    if (!row) throw notLinked();
    return this.notify.sendTestMessage(row.chatId, row.locale as Locale);
  }

  /**
   * `/start <token>` from `chatId`, before confirmation: whether the token
   * is usable, the masked account it would link to, and whether the chat
   * belongs to another account now (so the prompt can say it would move).
   * Changes nothing.
   */
  async previewStartToken(token: string, chatId: string): Promise<StartPreview> {
    const row = await this.repository.findToken(hashLinkToken(token));
    if (!row) return { kind: "invalid" };
    if (row.usedAt) {
      const same = await this.unitOfWork.run((tx) => this.repository.linkedTo(tx, row.userId, chatId));
      return same ? { kind: "already_linked" } : { kind: "invalid" };
    }
    if (row.expiresAt <= new Date()) return { kind: "invalid" };
    const [account, owner] = await Promise.all([this.repository.accountOf(row.userId), this.repository.chatOwner(chatId)]);
    return { kind: "confirm", account: maskAccount(row.userId, account), moved: owner !== undefined && owner !== row.userId };
  }

  /** Cancel on the prompt: the token can't be used any more. */
  async cancelStartToken(token: string): Promise<void> {
    await this.repository.expireToken(hashLinkToken(token), new Date());
  }

  /**
   * Confirm on the `/start <token>` prompt in `chatId`. A valid token (unused, unexpired) is
   * marked used and links the chat to its user, enabled, replacing that
   * user's previous chat; if another user had this chat, it moves. A token
   * that was already used to link this very chat (a redelivered update)
   * answers `already_linked`.
   */
  async consumeStartToken(token: string, chatId: string, username: string | null): Promise<StartResult> {
    const tokenHash = hashLinkToken(token);
    const now = new Date();
    return this.unitOfWork.run(async (tx) => {
      const row = await this.repository.lockToken(tx, tokenHash);
      if (!row) return { kind: "invalid" } as const;

      if (row.usedAt) {
        const same = await this.repository.linkedTo(tx, row.userId, chatId);
        return same ? ({ kind: "already_linked" } as const) : ({ kind: "invalid" } as const);
      }
      if (row.expiresAt <= now) return { kind: "invalid" } as const;

      const moved = await this.repository.linkChat(tx, tokenHash, row.userId, chatId, username, now);

      return { kind: "linked", userId: row.userId, moved } as const;
    });
  }

  /** /stop: pauses the chat's channel. Returns whether one was linked. */
  disableChat(chatId: string): Promise<boolean> {
    return this.repository.disableChat(chatId);
  }

  /** Resume a paused chat, or report its existing linkage. */
  async resumeChat(chatId: string): Promise<"none" | "linked" | "resumed"> {
    if (await this.repository.resumePausedChat(chatId)) return "resumed";
    return await this.repository.hasChat(chatId) ? "linked" : "none";
  }
}
