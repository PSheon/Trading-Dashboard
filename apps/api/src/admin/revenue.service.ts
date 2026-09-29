import { Optional } from "@nestjs/common";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import { revenueSnapshots } from "@trading-dashboard/shared/database";
import { type AdminRevenueResponse } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import { SettingsService } from "../settings/settings.service.js";
import { toUnits, unitsToNumber } from "./decimal.js";
import { parseReferral } from "./referral.js";
import {
  dailyRevenue,
  rangeStartDay,
  taipeiDayStart,
  type RevenuePoint,
  type RevenueRange,
} from "./revenue-daily.js";

export type SnapshotResult =
  | { status: "skipped"; reason: "no_address" }
  | { status: "written"; address: string; takenAt: Date }
  | { status: "failed"; error: string };

/** Ahead of the other background work: one call an hour. */
const SNAPSHOT_RANK = 0;

/**
 * Platform revenue (Stage 2 §6 收入): an hourly snapshot of the platform
 * address's cumulative builder fees and referral rebates from Hyperliquid's
 * `referral` info request into `revenue_snapshots`, and the admin revenue
 * report built from them (daily = increase between adjacent Taipei days).
 */
@Injectable()
export class RevenueService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RevenueService.name);

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly settings: SettingsService,
    private readonly info: HyperliquidInfoClient,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
  ) {}

  onApplicationBootstrap(): void {
    this.triggerSnapshot("startup");
  }

  /** Minute 7 of every hour, off the top of the hour where the watcher's
   * sweep queues its burst. */
  @Cron("0 7 * * * *", { name: "revenue-snapshot" })
  async hourlySnapshot(): Promise<void> {
    await this.snapshot();
  }

  /** Fire-and-forget snapshot (startup, builder address changed). */
  triggerSnapshot(reason: string): void {
    this.logger.log(`Revenue snapshot requested (${reason})`);
    this.snapshot().catch((error: unknown) => {
      // `snapshot()` already catches; this guards against a bug there
      // becoming an unhandled rejection that kills the process.
      this.logger.error(`Revenue snapshot crashed: ${(error as Error)?.message ?? String(error)}`);
    });
  }

  /** Takes one snapshot of the configured address. Never throws. */
  async snapshot(): Promise<SnapshotResult> {
    if (this.jobs.stopping) return { status: "failed", error: "Shutting down" };
    return this.jobs.run(() => this.takeSnapshot());
  }
  private async takeSnapshot(): Promise<SnapshotResult> {
    try {
      const { builderAddress } = await this.settings.get("revenue");
      if (!builderAddress) return { status: "skipped", reason: "no_address" };
      const address = builderAddress.toLowerCase();

      const response = await this.info.referral(address, "background", SNAPSHOT_RANK);
      const values = parseReferral(response);
      const takenAt = new Date(Math.floor(Date.now() / 1000) * 1000);
      const row = { ...values, raw: response };
      await this.db
        .insert(revenueSnapshots)
        .values({ address, takenAt, ...row })
        .onConflictDoUpdate({ target: [revenueSnapshots.address, revenueSnapshots.takenAt], set: row });
      this.logger.log(
        `Revenue snapshot ${address}: builder ${values.builderRewards}, referral ${values.referralRewards}`,
      );
      return { status: "written", address, takenAt };
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      this.logger.error(`Revenue snapshot failed: ${message}`);
      return { status: "failed", error: message };
    }
  }

  async report(range: RevenueRange, now = new Date()): Promise<AdminRevenueResponse> {
    const revenue = await this.settings.get("revenue");
    const address = revenue.builderAddress?.toLowerCase() ?? null;
    const empty: AdminRevenueResponse = {
      address,
      builderFeeTenthsBps: revenue.builderFeeTenthsBps,
      referralCode: revenue.referralCode,
      totals: {
        builderUsd: 0,
        referralUsd: 0,
        claimedUsd: 0,
        unclaimedUsd: 0,
        referredUsers: 0,
        referredVolumeUsd: 0,
      },
      rangeUsd: { builder: 0, referral: 0 },
      daily: [],
      lastSnapshotAt: null,
    };
    if (!address) return empty;

    const [latest] = await this.db
      .select()
      .from(revenueSnapshots)
      .where(eq(revenueSnapshots.address, address))
      .orderBy(desc(revenueSnapshots.takenAt))
      .limit(1);
    if (!latest) return empty;

    const { daily, total } = await this.earned(address, range, now);
    return {
      ...empty,
      totals: {
        builderUsd: num(latest.builderRewards),
        referralUsd: num(latest.referralRewards),
        claimedUsd: num(latest.claimedRewards),
        unclaimedUsd: num(latest.unclaimedRewards),
        referredUsers: latest.referredUsers,
        referredVolumeUsd: num(latest.referredVolume),
      },
      rangeUsd: total,
      daily,
      lastSnapshotAt: latest.takenAt,
    };
  }

  /** Builder + referral earned in the last 30 Taipei days (admin overview). */
  async earned30dUsd(now = new Date()): Promise<number> {
    const { builderAddress } = await this.settings.get("revenue");
    if (!builderAddress) return 0;
    const { totalUnits } = await this.earned(builderAddress.toLowerCase(), "30d", now);
    return unitsToNumber(totalUnits);
  }

  private async earned(address: string, range: RevenueRange, now: Date) {
    const fromDay = rangeStartDay(range, now);
    const columns = {
      takenAt: revenueSnapshots.takenAt,
      builder: revenueSnapshots.builderRewards,
      referral: revenueSnapshots.referralRewards,
    };
    const points: RevenuePoint[] = [];
    let where = eq(revenueSnapshots.address, address);
    if (fromDay !== null) {
      const start = taipeiDayStart(fromDay);
      // The baseline for the range's first day: the last snapshot before it.
      const [baseline] = await this.db
        .select(columns)
        .from(revenueSnapshots)
        .where(and(eq(revenueSnapshots.address, address), lt(revenueSnapshots.takenAt, start)))
        .orderBy(desc(revenueSnapshots.takenAt))
        .limit(1);
      if (baseline) points.push(baseline);
      where = and(where, gte(revenueSnapshots.takenAt, start))!;
    }
    points.push(
      ...(await this.db.select(columns).from(revenueSnapshots).where(where).orderBy(asc(revenueSnapshots.takenAt))),
    );
    return dailyRevenue(points, fromDay);
  }
}

function num(value: string): number {
  return unitsToNumber(toUnits(value));
}
