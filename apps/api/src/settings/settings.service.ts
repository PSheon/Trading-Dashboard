import { sql } from "drizzle-orm";
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
 * value. Cached per process for 30 s; `patch` invalidates the cache after commit.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private cache: { value: AdminSettings; expiresAt: number } | undefined;
  private revision = 0;
  private inflight: Promise<AdminSettings> | undefined;

  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async getAll(): Promise<AdminSettings> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.value;
    if (!this.inflight) {
      const revision = this.revision;
      const pending = this.load().then((value) => {
        if (revision === this.revision) this.cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
        return value;
      }).finally(() => {
        if (this.inflight === pending) this.inflight = undefined;
      });
      this.inflight = pending;
    }
    return this.inflight;
  }

  async get<K extends AppSettingsKey>(key: K): Promise<AdminSettings[K]> {
    return (await this.getAll())[key];
  }

  async getPublic(): Promise<PublicSettings> {
    const { general, discovery, notifications, revenue } = await this.getAll();
    return {
      announcement: general.announcement,
      signupsOpen: general.signupsOpen,
      copyTradingEnabled: general.copyTradingEnabled,
      featuredAddresses: discovery.featuredAddresses,
      homeMarkets: discovery.homeMarkets,
      hideVaults: discovery.hideVaults,
      lowSampleThreshold: discovery.lowSampleThreshold,
      defaultActiveWithin: discovery.defaultActiveWithin,
      maxAlertTraders: notifications.maxAlertTraders,
      referralCode: revenue.referralCode,
    };
  }

  /** Merges each given section over its current value, validates the result
   * (throws ZodError on invalid input) and saves only those sections. */
  async patch(request: PatchAdminSettingsRequest, userId: number | null): Promise<AdminSettings> {
    const merged = await this.db.transaction(async (tx) => {
      // One transaction-scoped lock also protects sections that have no row yet.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(73104, 1)`);
      const current = await this.load(tx);
      const value = adminSettingsSchema.parse({
        general: { ...current.general, ...request.general },
        discovery: { ...current.discovery, ...request.discovery },
        notifications: { ...current.notifications, ...request.notifications },
        revenue: { ...current.revenue, ...request.revenue },
      });
      const keys = (Object.keys(request) as AppSettingsKey[]).filter((k) => request[k] !== undefined);
      const now = new Date();
      for (const key of keys) {
        await tx.insert(appSettings)
          .values({ key, value: value[key], updatedAt: now, updatedByUserId: userId })
          .onConflictDoUpdate({ target: appSettings.key,
            set: { value: value[key], updatedAt: now, updatedByUserId: userId } });
      }
      return value;
    });
    // An older in-flight read must not republish stale data after this commit.
    this.revision++;
    this.cache = undefined;
    this.inflight = undefined;
    return merged;
  }

  private async load(db: Pick<DrizzleDb, "select"> = this.db): Promise<AdminSettings> {
    const rows = await db.select().from(appSettings);
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
    return value;
  }
}
