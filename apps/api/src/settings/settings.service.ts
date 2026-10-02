import { recoverSettingsSection } from "./settings-recovery.js";
import { createHash, randomUUID } from "node:crypto";
import { recordAdminAudit, type AuditActor } from "../common/audit/admin-audit.js";
import { ConflictException, Injectable, Logger } from "@nestjs/common";
import {
  adminSettingsSchema,
  appSettingsKeyEnum,
  type AdminSettingsSnapshot,
  type AppliedDiscovery,
  type AdminSettings,
  type AppSettingsKey,
  type PatchAdminSettingsRequest,
  type PublicSettings,
} from "@trading-dashboard/shared/contracts";

import { SettingsRepository } from "./settings.repository.js";
import { UnitOfWork } from "../db/unit-of-work.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { Optional } from "@nestjs/common";
import { RequestBudgeterService, type ConsumerCapSource } from "../hyperliquid/request-budgeter.service.js";

const CACHE_TTL_MS = 30_000;
/** NOTIFY channel a save is announced on; the payload is the saving process's `origin`. */
export const SETTINGS_CHANNEL = "orbie_settings";

/**
 * Site-wide settings an admin edits (`app_settings`, one jsonb row per
 * section). Reads merge the stored row over the zod defaults, so a section
 * nobody has saved yet still gets defaults. Damaged persisted security
 * switches fail closed; other fields recover individually.
 *
 * Cached per process. A save drops this process's cache after commit and
 * announces itself on SETTINGS_CHANNEL in the same transaction;
 * SettingsRelay drops every other process's cache when that arrives, so
 * the switches (signupsOpen, alertsEnabled, copyTradingEnabled,
 * maintenance) apply everywhere within the notification's delivery time,
 * not after a TTL. The 30 s TTL remains as a bound should a notification
 * ever be lost, and while the relay's connection is down nothing is cached.
 */
@Injectable()
export class SettingsService implements ConsumerCapSource {
  private readonly logger = new Logger(SettingsService.name);
  private cache: { value: AdminSettingsSnapshot; expiresAt: number } | undefined;
  private revision = 0;
  private inflight: Promise<AdminSettingsSnapshot> | undefined;
  /** Identifies this process's saves, so its own notification isn't acted on twice. */
  readonly origin = randomUUID();
  /** undefined: no relay in this process (plain TTL cache). false: the relay lost its connection. */
  private relayConnected: boolean | undefined;

  constructor(private readonly repository: SettingsRepository, private readonly uow: UnitOfWork,
    @Optional() budgeter?: RequestBudgeterService) {
    // The budgeter enforces the per-job weight caps the admin sets here.
    budgeter?.useConsumerCaps(this);
  }

  /** Weight-per-minute caps of the budget consumers the budgeter enforces
   * itself (the pool and cohort loops pace themselves by their settings). */
  async consumerCaps(): Promise<Record<string, number>> {
    const { historyWeightPerMinute, backfillWeightPerMinute } = await this.get("discovery");
    return { history: historyWeightPerMinute, backfill: backfillWeightPerMinute };
  }

  private readonly applied = new Map<AppliedDiscovery["consumer"], AppliedDiscovery>();
  /** Called by the consumer after accepting this exact snapshot, never by reads/saves. */
  acknowledgeDiscovery(consumer: AppliedDiscovery["consumer"], snapshot: AdminSettingsSnapshot): void {
    const { candidatePoolSize, poolWeightPerMinute, poolPerformanceWeightPerMinute, leaderboardRefreshMinutes } = snapshot.discovery;
    this.applied.set(consumer, { consumer, revision: snapshot.revisions.discovery, checkedAt: new Date().toISOString(),
      recovered: snapshot.invalidSections.includes("discovery"), candidatePoolSize, poolWeightPerMinute, poolPerformanceWeightPerMinute, leaderboardRefreshMinutes });
  }
  appliedDiscovery(): AppliedDiscovery[] { return [...this.applied.values()].map(row => ({ ...row })); }

  /** Drop the cached snapshot: another process saved (SettingsRelay), or this one did. */
  invalidate(): void {
    // An older in-flight read must not republish stale data afterwards.
    this.revision++;
    this.cache = undefined;
    this.inflight = undefined;
  }

  /** SettingsRelay reports its LISTEN connection. Either way the cache is
   * dropped: on a loss it can no longer be trusted, on a (re)connect a
   * save made in the gap must be picked up. */
  setRelayConnected(connected: boolean): void {
    this.relayConnected = connected;
    this.invalidate();
  }

  async getAll(): Promise<AdminSettingsSnapshot> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.value;
    if (!this.inflight) {
      const revision = this.revision;
      const pending = this.load().then((value) => {
        // Not while the relay is down: a save elsewhere would go unnoticed.
        if (revision === this.revision && this.relayConnected !== false) this.cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
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
      cryptoBoards: discovery.cryptoBoards,
      stockBoards: discovery.stockBoards,
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
      // Delivered by PostgreSQL at commit, and not at all on rollback.
      if (keys.length) await this.repository.announceChange(tx, SETTINGS_CHANNEL, this.origin);
      return this.load(tx);
    });
    this.invalidate();
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
