import { recoverSettingsSection } from "./settings-recovery.js";
import { createHash } from "node:crypto";
import { recordAdminAudit, type AuditActor } from "../common/audit/admin-audit.js";
import { ConflictException, Injectable, Logger } from "@nestjs/common";
import {
  adminSettingsSchema,
  appSettingsKeyEnum,
  type AdminSettingsSnapshot,
  type AdminSettings,
  type AppSettingsKey,
  type PatchAdminSettingsRequest,
  type PublicSettings,
} from "@trading-dashboard/shared/contracts";

import { SettingsRepository } from "./settings.repository.js";
import { UnitOfWork } from "../db/unit-of-work.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

const CACHE_TTL_MS = 30_000;

/**
 * Site-wide settings an admin edits (`app_settings`, one jsonb row per
 * section). Reads merge the stored row over the zod defaults, so a section
 * nobody has saved yet still gets defaults. Damaged persisted security
 * switches fail closed; other fields recover individually. Cached per process for 30 s; `patch` invalidates the cache after commit.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private cache: { value: AdminSettingsSnapshot; expiresAt: number } | undefined;
  private revision = 0;
  private inflight: Promise<AdminSettingsSnapshot> | undefined;

  constructor(private readonly repository: SettingsRepository, private readonly uow: UnitOfWork) {}

  async getAll(): Promise<AdminSettingsSnapshot> {
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

  /** Admin reloads must see committed revisions, not another process's TTL cache. */
  getSnapshot(): Promise<AdminSettingsSnapshot> { return this.load(); }

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
  async patch(request: PatchAdminSettingsRequest, userId: number | null, actor: AuditActor = userId): Promise<AdminSettingsSnapshot> {
    const merged = await this.uow.run(async (tx) => {
      // One transaction-scoped lock also protects sections that have no row yet.
      await this.repository.lockSections(tx);
      const current = await this.load(tx);
      const keys = appSettingsKeyEnum.filter(key => request[key] !== undefined);
      for (const key of keys) {
        const expected = request.expectedRevisions?.[key];
        if (expected !== undefined && expected !== current.revisions[key]) {
          throw new ConflictException({ statusCode: 409, code: "settings_conflict", section: key,
            message: "Settings changed since you loaded them. Reload before saving." });
        }
      }
      const value = adminSettingsSchema.parse({
        general: { ...current.general, ...request.general },
        discovery: { ...current.discovery, ...request.discovery },
        notifications: { ...current.notifications, ...request.notifications },
        revenue: { ...current.revenue, ...request.revenue },
      });
      await this.repository.saveSections(tx, keys, value, userId);
      if (keys.length) await recordAdminAudit(tx, actor, "settings.update", "app_settings",
        Object.fromEntries(keys.map((key) => [key, current[key]])), Object.fromEntries(keys.map((key) => [key, value[key]])));
      return this.load(tx);
    });
    // An older in-flight read must not republish stale data after this commit.
    this.revision++;
    this.cache = undefined;
    this.inflight = undefined;
    return merged;
  }

  private async load(db?: Pick<DrizzleDb, "select">): Promise<AdminSettingsSnapshot> {
    const rows = await this.repository.readSections(db);
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const raw = {
      general: "general" in stored ? stored.general : {},
      discovery: "discovery" in stored ? stored.discovery : {},
      notifications: "notifications" in stored ? stored.notifications : {},
      revenue: "revenue" in stored ? stored.revenue : {},
    };
    const invalidSections: AppSettingsKey[] = [];
    const value = Object.fromEntries(appSettingsKeyEnum.map(key => {
      const recovered = recoverSettingsSection(key, raw[key], key in stored);
      if (recovered.invalid) {
        invalidSections.push(key);
        this.logger.warn(`Invalid app_settings section: ${key}`);
      }
      return [key, recovered.value];
    })) as AdminSettings;
    const revisions = Object.fromEntries(appSettingsKeyEnum.map(key => {
      const row = rows.find(row => row.key === key);
      const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical)
        : input !== null && typeof input === "object"
          ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
          : input;
      const representation = row ? [row.updatedAt.toISOString(), canonical(row.value)] : null;
      return [key, createHash("sha256").update(JSON.stringify(representation)).digest("hex")];
    })) as AdminSettingsSnapshot["revisions"];
    return { ...value, revisions, invalidSections };
  }
}
