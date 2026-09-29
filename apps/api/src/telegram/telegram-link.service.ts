import { AppConfig } from "../config/app-config.js";
import { createHash, randomBytes } from "node:crypto";

import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, count, eq, gt, isNull, lt, ne } from "drizzle-orm";
import { notificationChannels, telegramLinkTokens, users } from "@trading-dashboard/shared/database";
import {
  type Locale,
  type TelegramLinkResponse,
  type TelegramStatus,
  type TelegramTestResponse,
} from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
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

/** What `/start <token>` amounted to. */
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
 * 2. the user presses Start, the bot receives `/start <token>` and calls
 *    `consumeStartToken`, which links that chat;
 * 3. the page, polling GET /me/telegram, sees `linked: true`.
 *
 * One chat belongs to one user: linking a chat that another account had
 * moves it. A user has one Telegram channel (the unique (user, kind) row).
 */
@Injectable()
export class TelegramLinkService {
  constructor(
    private readonly config: AppConfig,
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly notify: NotifyService,
  ) {}

  /** The bot's username when the bot is usable (token and username set). */
  bot(): string | null {
    const username = this.config.value.telegram.botUsername?.replace(/^@/, "");
    return username && this.config.value.telegram.botToken ? username : null;
  }

  async status(userId: number): Promise<TelegramStatus> {
    const channel = await this.channelOf(userId);
    return {
      bot: this.bot(),
      linked: channel !== undefined,
      username: channel?.username ?? null,
      enabled: channel?.enabled ?? false,
      linkedAt: channel?.createdAt ?? null,
    };
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

    await this.db.transaction(async (tx) => {
      // Serializes one user's requests, so the count below can't be raced.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");

      const [{ n }] = await tx
        .select({ n: count() })
        .from(telegramLinkTokens)
        .where(
          and(
            eq(telegramLinkTokens.userId, userId),
            gt(telegramLinkTokens.createdAt, new Date(now.getTime() - LINK_RATE_WINDOW_MS)),
          ),
        );
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

      // Only the newest link works: older unused ones expire now.
      await tx
        .update(telegramLinkTokens)
        .set({ expiresAt: now })
        .where(
          and(
            eq(telegramLinkTokens.userId, userId),
            isNull(telegramLinkTokens.usedAt),
            gt(telegramLinkTokens.expiresAt, now),
          ),
        );
      await tx
        .delete(telegramLinkTokens)
        .where(
          and(
            eq(telegramLinkTokens.userId, userId),
            lt(telegramLinkTokens.expiresAt, new Date(now.getTime() - TOKEN_RETENTION_MS)),
          ),
        );
      await tx
        .insert(telegramLinkTokens)
        .values({ tokenHash: hashLinkToken(token), userId, createdAt: now, expiresAt });
    });

    return { url: `https://t.me/${bot}?start=${token}`, expiresAt };
  }

  /** DELETE /me/telegram. Alerts stay configured; they record as failed
   * until a chat is linked again. */
  async unlink(userId: number): Promise<void> {
    await this.db
      .delete(notificationChannels)
      .where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.kind, "telegram")));
  }

  /** POST /me/telegram/test: 409 without a linked, enabled chat. */
  async sendTest(userId: number): Promise<TelegramTestResponse> {
    const [row] = await this.db
      .select({ chatId: notificationChannels.target, locale: users.locale })
      .from(notificationChannels)
      .innerJoin(users, eq(users.id, notificationChannels.userId))
      .where(
        and(
          eq(notificationChannels.userId, userId),
          eq(notificationChannels.kind, "telegram"),
          eq(notificationChannels.enabled, true),
        ),
      );
    if (!row) throw notLinked();
    return this.notify.sendTestMessage(row.chatId, row.locale as Locale);
  }

  /**
   * `/start <token>` from `chatId`. A valid token (unused, unexpired) is
   * marked used and links the chat to its user, enabled, replacing that
   * user's previous chat; if another user had this chat, it moves. A token
   * that was already used to link this very chat (a redelivered update)
   * answers `already_linked`.
   */
  async consumeStartToken(token: string, chatId: string, username: string | null): Promise<StartResult> {
    const tokenHash = hashLinkToken(token);
    const now = new Date();
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(telegramLinkTokens)
        .where(eq(telegramLinkTokens.tokenHash, tokenHash))
        .for("update");
      if (!row) return { kind: "invalid" } as const;

      if (row.usedAt) {
        const [same] = await tx
          .select({ id: notificationChannels.id })
          .from(notificationChannels)
          .where(
            and(
              eq(notificationChannels.userId, row.userId),
              eq(notificationChannels.kind, "telegram"),
              eq(notificationChannels.target, chatId),
            ),
          );
        return same ? ({ kind: "already_linked" } as const) : ({ kind: "invalid" } as const);
      }
      if (row.expiresAt <= now) return { kind: "invalid" } as const;

      await tx.update(telegramLinkTokens).set({ usedAt: now }).where(eq(telegramLinkTokens.tokenHash, tokenHash));

      const movedFrom = await tx
        .delete(notificationChannels)
        .where(
          and(
            eq(notificationChannels.kind, "telegram"),
            eq(notificationChannels.target, chatId),
            ne(notificationChannels.userId, row.userId),
          ),
        )
        .returning({ userId: notificationChannels.userId });

      await tx
        .insert(notificationChannels)
        .values({ userId: row.userId, kind: "telegram", target: chatId, username, enabled: true, createdAt: now })
        .onConflictDoUpdate({
          target: [notificationChannels.userId, notificationChannels.kind],
          set: { target: chatId, username, enabled: true, createdAt: now },
        });

      return { kind: "linked", userId: row.userId, moved: movedFrom.length > 0 } as const;
    });
  }

  /** /stop: pauses the chat's channel. Returns whether one was linked. */
  async disableChat(chatId: string): Promise<boolean> {
    const rows = await this.db
      .update(notificationChannels)
      .set({ enabled: false })
      .where(and(eq(notificationChannels.kind, "telegram"), eq(notificationChannels.target, chatId)))
      .returning({ id: notificationChannels.id });
    return rows.length > 0;
  }

  /** `/start` with no token: "none" (not linked), "linked" (already on) or
   * "resumed" (was paused by /stop, now on again). */
  async resumeChat(chatId: string): Promise<"none" | "linked" | "resumed"> {
    const chat = and(eq(notificationChannels.kind, "telegram"), eq(notificationChannels.target, chatId));
    const resumed = await this.db
      .update(notificationChannels)
      .set({ enabled: true })
      .where(and(chat, eq(notificationChannels.enabled, false)))
      .returning({ id: notificationChannels.id });
    if (resumed.length > 0) return "resumed";
    const [linked] = await this.db.select({ id: notificationChannels.id }).from(notificationChannels).where(chat);
    return linked ? "linked" : "none";
  }

  private async channelOf(userId: number) {
    const [row] = await this.db
      .select()
      .from(notificationChannels)
      .where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.kind, "telegram")));
    return row;
  }
}
