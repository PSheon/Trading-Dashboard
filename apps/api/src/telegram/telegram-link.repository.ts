import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gt, isNull, lt, ne } from "drizzle-orm";
import { notificationChannels, telegramLinkTokens, users } from "@trading-dashboard/shared/database";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";

@Injectable()
export class TelegramLinkRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async disableChat(chatId: string): Promise<boolean> {
    const rows = await this.db
      .update(notificationChannels)
      .set({ enabled: false })
      .where(and(eq(notificationChannels.kind, "telegram"), eq(notificationChannels.target, chatId)))
      .returning({ id: notificationChannels.id });
    return rows.length > 0;
  }

  async channelOf(userId: number) {
    const [row] = await this.db
      .select()
      .from(notificationChannels)
      .where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.kind, "telegram")));
    return row;
  }

  async resumePausedChat(chatId: string) {
    const rows = await this.db.update(notificationChannels).set({ enabled: true })
      .where(and(eq(notificationChannels.kind, "telegram"), eq(notificationChannels.target, chatId), eq(notificationChannels.enabled, false)))
      .returning({ id: notificationChannels.id });
    return rows.length > 0;
  }

  async hasChat(chatId: string) {
    const [row] = await this.db.select({ id: notificationChannels.id }).from(notificationChannels)
      .where(and(eq(notificationChannels.kind, "telegram"), eq(notificationChannels.target, chatId)));
    return row !== undefined;
  }

  async unlink(userId: number) {
    await this.db
      .delete(notificationChannels)
      .where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.kind, "telegram")));
  }

  async testDestination(userId: number) {
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
    return row;
  }

  async lockUser(tx: DbTransaction, userId: number) {
    // Serializes one user's requests, so the count below can't be raced.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
  }

  async recentTokenCount(tx: DbTransaction, userId: number, since: Date) {
    const [{ n }] = await tx
      .select({ n: count() })
      .from(telegramLinkTokens)
      .where(
        and(
          eq(telegramLinkTokens.userId, userId),
          gt(telegramLinkTokens.createdAt, since),
        ),
      );
    return n;
  }

  async replaceToken(tx: DbTransaction, userId: number, tokenHash: string, now: Date, expiresAt: Date, retainedSince: Date) {
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
          lt(telegramLinkTokens.expiresAt, retainedSince),
        ),
      );
    await tx
      .insert(telegramLinkTokens)
      .values({ tokenHash, userId, createdAt: now, expiresAt });
  }

  async lockToken(tx: DbTransaction, tokenHash: string) {
    const [row] = await tx
      .select()
      .from(telegramLinkTokens)
      .where(eq(telegramLinkTokens.tokenHash, tokenHash))
      .for("update");
    return row;
  }

  async linkedTo(tx: DbTransaction, userId: number, chatId: string) {
    const [same] = await tx
      .select({ id: notificationChannels.id })
      .from(notificationChannels)
      .where(
        and(
          eq(notificationChannels.userId, userId),
          eq(notificationChannels.kind, "telegram"),
          eq(notificationChannels.target, chatId),
        ),
      );
    return same !== undefined;
  }

  async linkChat(tx: DbTransaction, tokenHash: string, userId: number, chatId: string, username: string | null, now: Date) {
    await tx.update(telegramLinkTokens).set({ usedAt: now }).where(eq(telegramLinkTokens.tokenHash, tokenHash));

    const movedFrom = await tx
      .delete(notificationChannels)
      .where(
        and(
          eq(notificationChannels.kind, "telegram"),
          eq(notificationChannels.target, chatId),
          ne(notificationChannels.userId, userId),
        ),
      )
      .returning({ userId: notificationChannels.userId });

    await tx
      .insert(notificationChannels)
      .values({ userId, kind: "telegram", target: chatId, username, enabled: true, createdAt: now })
      .onConflictDoUpdate({
        target: [notificationChannels.userId, notificationChannels.kind],
        set: { target: chatId, username, enabled: true, createdAt: now },
      });

    return movedFrom.length > 0;
  }
}
