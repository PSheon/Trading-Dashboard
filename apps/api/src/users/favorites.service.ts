import { AppConfig } from "../config/app-config.js";
import { ConflictException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { type Favorite, type PatchFavoriteAlertRequest } from "@trading-dashboard/shared/contracts";

import { FavoritesRepository, type FavoriteUpdate } from "./favorites.repository.js";
import { UnitOfWork } from "../db/unit-of-work.js";
import { SettingsService } from "../settings/settings.service.js";
import { toTraderStats } from "../traders/traders.mappers.js";

/** A user's favorites changed (after commit), so live `scope=favorites`
 * streams (GET /actions/stream) reload the set they filter by. */
export const FAVORITES_CHANGED_EVENT = "favorites.changed";
export interface FavoritesChangedEvent { userId: number }

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

  constructor(
    private readonly config: AppConfig,
    private readonly repository: FavoritesRepository,
    private readonly uow: UnitOfWork,
    private readonly settings: SettingsService,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  async list(userId: number, address?: string): Promise<Favorite[]> {
    const rows = await this.repository.listOwned(userId, address);
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
    const limit = (await this.settings.get("notifications")).maxAlertTraders;

    await this.uow.run(async (tx) => {
      await this.repository.lockUser(tx, userId);
      const current = await this.repository.findOwned(tx, userId, address);
      if (!current) throw new NotFoundException(`${address} is not a favorite`);

      if (patch.enabled === true && !current.alertEnabled) {
        const channel = await this.repository.hasTelegram(tx, userId);
        if (!channel) {
          throw new ConflictException({
            statusCode: 409,
            code: "telegram_not_linked",
            message: "Link Telegram before turning on alerts",
          });
        }
        const n = await this.repository.countAlerts(tx, userId);
        if (n >= limit) {
          throw new ConflictException({
            statusCode: 409,
            code: "alert_limit",
            limit,
            message: `Alerts are limited to ${limit} traders`,
          });
        }
      }

      const set: FavoriteUpdate = {};
      if (patch.enabled !== undefined) set.alertEnabled = patch.enabled;
      if (patch.sides !== undefined) set.alertSides = patch.sides;
      if (patch.minUsd !== undefined) set.alertMinUsd = patch.minUsd === null ? null : String(patch.minUsd);
      if (Object.keys(set).length > 0) await this.repository.updateAlert(tx, userId, address, set);
    });

    const [favorite] = await this.list(userId, address);
    if (!favorite) throw new NotFoundException(`${address} is not a favorite`);
    return favorite;
  }

  /** Idempotent. `address` must already be validated and lowercased. */
  async add(userId: number, address: string): Promise<Favorite> {
    await this.uow.run(async (tx) => {
      await this.repository.lockUser(tx, userId);
      if (!await this.repository.findOwned(tx, userId, address) && await this.repository.countOwned(tx, userId) >= this.config.value.limits.favoritesPerUser) {
        throw new ConflictException({ statusCode: 409, code: "favorite_limit", limit: this.config.value.limits.favoritesPerUser, message: "Favorite trader limit reached" });
      }
      return this.repository.addAndWatch(tx, userId, address);
    });

    this.events?.emit(FAVORITES_CHANGED_EVENT, { userId } satisfies FavoritesChangedEvent);
    const [favorite] = await this.list(userId, address);
    // Just written in this request; only a concurrent DELETE could remove it.
    return favorite ?? { address, createdAt: new Date(), stats: null, alert: { enabled: false, sides: "both", minUsd: null } };
  }

  /** Idempotent; returns whether a favorite was removed. */
  async remove(userId: number, address: string): Promise<boolean> {
    const removed = await this.uow.run((tx) => this.repository.removeAndUnwatch(tx, userId, address));
    if (removed) this.events?.emit(FAVORITES_CHANGED_EVENT, { userId } satisfies FavoritesChangedEvent);
    return removed;
  }
}
