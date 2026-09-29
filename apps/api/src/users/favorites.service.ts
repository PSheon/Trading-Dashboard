import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, sql } from "drizzle-orm";
import {
  CHAIN_DEFAULT,
  leaders,
  notificationChannels,
  traderStats,
  userFavorites,
  users,
  type Favorite,
  type PatchFavoriteAlertRequest,
} from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { SettingsService } from "../settings/settings.service.js";
import { BackfillService } from "../watcher/backfill.service.js";
import { toTraderStats } from "../traders/traders.mappers.js";

/**
 * A user's favorites. A favorited address joins the watch list (`leaders`):
 * - not there yet → created with `source='favorite'` and backfilled;
 * - there, favorite-sourced but inactive → reactivated;
 * - imported by an admin → left exactly as it is.
 * Removing the last favorite of a favorite-sourced leader deactivates it;
 * imported leaders are never touched.
 */
@Injectable()
export class FavoritesService {
  private readonly logger = new Logger(FavoritesService.name);

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly backfill: BackfillService,
    private readonly settings: SettingsService,
  ) {}

  async list(userId: number, address?: string): Promise<Favorite[]> {
    const rows = await this.db
      .select({ favorite: userFavorites, stats: traderStats })
      .from(userFavorites)
      .leftJoin(
        traderStats,
        and(eq(traderStats.chain, userFavorites.chain), eq(traderStats.address, userFavorites.address)),
      )
      .where(
        and(eq(userFavorites.userId, userId), address === undefined ? undefined : eq(userFavorites.address, address)),
      )
      .orderBy(desc(userFavorites.createdAt));
    return rows.map((r) => ({
      address: r.favorite.address,
      createdAt: r.favorite.createdAt,
      stats: r.stats ? toTraderStats(r.stats) : null,
      alert: {
        enabled: r.favorite.alertEnabled,
        sides: r.favorite.alertSides,
        minUsd: r.favorite.alertMinUsd === null ? null : Number(r.favorite.alertMinUsd),
      },
    }));
  }

  /**
   * PATCH /me/favorites/:address/alert. Switching an alert on needs a
   * linked, enabled Telegram chat (409 `telegram_not_linked`) and room
   * under `notifications.maxAlertTraders` (409 `alert_limit`). The user's
   * row is locked first, so two concurrent requests count one after the
   * other and can't both take the last slot. Lowering the limit later
   * doesn't switch existing alerts off; editing one that is already on
   * isn't counted again.
   */
  async setAlert(userId: number, address: string, patch: PatchFavoriteAlertRequest): Promise<Favorite> {
    const chain = CHAIN_DEFAULT;
    const limit = (await this.settings.get("notifications")).maxAlertTraders;

    await this.db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");

      const mine = and(eq(userFavorites.userId, userId), eq(userFavorites.chain, chain), eq(userFavorites.address, address));
      const [current] = await tx.select().from(userFavorites).where(mine);
      if (!current) throw new NotFoundException(`${address} is not a favorite`);

      if (patch.enabled === true && !current.alertEnabled) {
        const [channel] = await tx
          .select({ id: notificationChannels.id })
          .from(notificationChannels)
          .where(
            and(
              eq(notificationChannels.userId, userId),
              eq(notificationChannels.kind, "telegram"),
              eq(notificationChannels.enabled, true),
            ),
          );
        if (!channel) {
          throw new ConflictException({
            statusCode: 409,
            code: "telegram_not_linked",
            message: "Link Telegram before turning on alerts",
          });
        }
        const [{ n }] = await tx
          .select({ n: count() })
          .from(userFavorites)
          .where(and(eq(userFavorites.userId, userId), eq(userFavorites.alertEnabled, true)));
        if (n >= limit) {
          throw new ConflictException({
            statusCode: 409,
            code: "alert_limit",
            limit,
            message: `Alerts are limited to ${limit} traders`,
          });
        }
      }

      const set: Partial<typeof userFavorites.$inferInsert> = {};
      if (patch.enabled !== undefined) set.alertEnabled = patch.enabled;
      if (patch.sides !== undefined) set.alertSides = patch.sides;
      if (patch.minUsd !== undefined) set.alertMinUsd = patch.minUsd === null ? null : String(patch.minUsd);
      if (Object.keys(set).length > 0) await tx.update(userFavorites).set(set).where(mine);
    });

    const [favorite] = await this.list(userId, address);
    if (!favorite) throw new NotFoundException(`${address} is not a favorite`);
    return favorite;
  }

  /** Idempotent. `address` must already be validated and lowercased. */
  async add(userId: number, address: string): Promise<Favorite> {
    const chain = CHAIN_DEFAULT;
    const createdLeader = await this.db.transaction(async (tx) => {
      await tx.insert(userFavorites).values({ userId, chain, address }).onConflictDoNothing();

      const inserted = await tx
        .insert(leaders)
        .values({ chain, address, active: true, source: "favorite" })
        .onConflictDoNothing({ target: [leaders.chain, leaders.address] })
        .returning({ address: leaders.address });
      if (inserted.length > 0) return true;

      await tx
        .update(leaders)
        .set({ active: true })
        .where(
          and(
            eq(leaders.chain, chain),
            eq(leaders.address, address),
            eq(leaders.source, "favorite"),
            eq(leaders.active, false),
          ),
        );
      return false;
    });

    if (createdLeader) {
      this.logger.log(`New favorite-sourced leader ${address} — starting backfill`);
      this.backfill.trigger(address);
    }

    const [favorite] = await this.list(userId, address);
    // Just written in this request; only a concurrent DELETE could remove it.
    return favorite ?? { address, createdAt: new Date(), stats: null, alert: { enabled: false, sides: "both", minUsd: null } };
  }

  /** Idempotent; returns whether a favorite was removed. */
  async remove(userId: number, address: string): Promise<boolean> {
    const chain = CHAIN_DEFAULT;
    return this.db.transaction(async (tx) => {
      const removed = await tx
        .delete(userFavorites)
        .where(
          and(eq(userFavorites.userId, userId), eq(userFavorites.chain, chain), eq(userFavorites.address, address)),
        )
        .returning({ address: userFavorites.address });

      // Lock the leader first so the check below runs on a fresh snapshot
      // and can't miss a favorite another user is adding right now.
      await tx
        .select({ address: leaders.address })
        .from(leaders)
        .where(and(eq(leaders.chain, chain), eq(leaders.address, address)))
        .for("update");

      await tx
        .update(leaders)
        .set({ active: false })
        .where(
          and(
            eq(leaders.chain, chain),
            eq(leaders.address, address),
            eq(leaders.source, "favorite"),
            sql`not exists (
              select 1 from ${userFavorites}
              where ${userFavorites.chain} = ${chain} and ${userFavorites.address} = ${address}
            )`,
          ),
        );
      return removed.length > 0;
    });
  }
}
