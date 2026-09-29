import { Inject, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import {
  notificationChannels,
  type NotificationChannel,
  type PutTelegramChannelRequest,
} from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

type ChannelRow = typeof notificationChannels.$inferSelect;

function toChannel(row: ChannelRow): NotificationChannel {
  return { kind: row.kind, target: row.target, enabled: row.enabled };
}

/** Where a user's alerts go. One row per (user, kind); Telegram only. */
@Injectable()
export class NotificationChannelsService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async list(userId: number): Promise<NotificationChannel[]> {
    const rows = await this.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.userId, userId))
      .orderBy(asc(notificationChannels.kind));
    return rows.map(toChannel);
  }

  async putTelegram(userId: number, request: PutTelegramChannelRequest): Promise<NotificationChannel> {
    const [row] = await this.db
      .insert(notificationChannels)
      .values({ userId, kind: "telegram", target: request.target, enabled: request.enabled })
      .onConflictDoUpdate({
        target: [notificationChannels.userId, notificationChannels.kind],
        set: { target: request.target, enabled: request.enabled },
      })
      .returning();
    return toChannel(row);
  }
}
