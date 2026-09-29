import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  adminSettingsSchema,
  appSettings,
  type AdminSettings,
  type AppSettingsKey,
  type PatchAdminSettingsRequest,
  type PublicSettings,
} from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

const CACHE_TTL_MS = 30_000;

/**
 * Site-wide settings an admin edits (`app_settings`, one jsonb row per
 * section). Reads merge the stored row over the zod defaults, so a section
 * nobody has saved yet, or a field added to the schema later, still gets a
 * value. Cached per process for 30 s; `patch` refreshes the cache.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private cache: { value: AdminSettings; expiresAt: number } | undefined;
  private inflight: Promise<AdminSettings> | undefined;

  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async getAll(): Promise<AdminSettings> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.value;
    this.inflight ??= this.load().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  async get<K extends AppSettingsKey>(key: K): Promise<AdminSettings[K]> {
    return (await this.getAll())[key];
  }

  async getPublic(): Promise<PublicSettings> {
    const { general, discovery, revenue } = await this.getAll();
    return {
      announcement: general.announcement,
      signupsOpen: general.signupsOpen,
      copyTradingEnabled: general.copyTradingEnabled,
      featuredAddresses: discovery.featuredAddresses,
      homeMarkets: discovery.homeMarkets,
      hideVaults: discovery.hideVaults,
      lowSampleThreshold: discovery.lowSampleThreshold,
      referralCode: revenue.referralCode,
    };
  }

  /** Merges each given section over its current value, validates the result
   * (throws ZodError on invalid input) and saves only those sections. */
  async patch(request: PatchAdminSettingsRequest, userId: number | null): Promise<AdminSettings> {
    const current = await this.load();
    const merged = adminSettingsSchema.parse({
      general: { ...current.general, ...request.general },
      discovery: { ...current.discovery, ...request.discovery },
      notifications: { ...current.notifications, ...request.notifications },
      revenue: { ...current.revenue, ...request.revenue },
    });
    const keys = (Object.keys(request) as AppSettingsKey[]).filter((k) => request[k] !== undefined);
    const now = new Date();
    for (const key of keys) {
      await this.db
        .insert(appSettings)
        .values({ key, value: merged[key], updatedAt: now, updatedByUserId: userId })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: merged[key], updatedAt: now, updatedByUserId: userId },
        });
    }
    this.cache = { value: merged, expiresAt: Date.now() + CACHE_TTL_MS };
    return merged;
  }

  private async load(): Promise<AdminSettings> {
    const rows = await this.db.select().from(appSettings);
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const raw = {
      general: stored.general ?? {},
      discovery: stored.discovery ?? {},
      notifications: stored.notifications ?? {},
      revenue: stored.revenue ?? {},
    };
    const parsed = adminSettingsSchema.safeParse(raw);
    let value: AdminSettings;
    if (parsed.success) {
      value = parsed.data;
    } else {
      // A stored section no longer fits the schema: fall back per section so
      // one bad row doesn't reset the others.
      this.logger.warn(`app_settings failed validation, using defaults where invalid: ${parsed.error.message}`);
      const shape = adminSettingsSchema.shape;
      value = {
        general: shape.general.safeParse(raw.general).data ?? shape.general.parse({}),
        discovery: shape.discovery.safeParse(raw.discovery).data ?? shape.discovery.parse({}),
        notifications:
          shape.notifications.safeParse(raw.notifications).data ?? shape.notifications.parse({}),
        revenue: shape.revenue.safeParse(raw.revenue).data ?? shape.revenue.parse({}),
      };
    }
    this.cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  }
}
