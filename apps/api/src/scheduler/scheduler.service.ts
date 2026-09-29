import { forEachConcurrent } from "../runtime/concurrency.js";
import { Optional } from "@nestjs/common";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { and, eq, gt, inArray } from "drizzle-orm";
import {
  CHAIN_DEFAULT,
  equitySnapshots,
  fills,
  positionSnapshots,
} from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { NotifyService } from "../notify/notify.service.js";
import { AccountStateService, MAIN_DEX, type AccountState } from "../watcher/account-state.service.js";
import { FillSyncService } from "../watcher/fill-sync.service.js";
import { TradeFeedService } from "../watcher/trade-feed.service.js";
import { SWEEP_WINDOW_MS, WatcherService } from "../watcher/watcher.service.js";

/** §8: feed down this long → Telegram self-alert. */
const FEED_DOWN_ALERT_MS = 10 * 60_000;
const RECONCILE_OVERLAP_MS = 60_000;

/**
 * Periodic jobs:
 * - every 5 min (W4): positions and equity of every active leader on every
 *   dex it uses → `position_snapshots` / `equity_snapshots`, and
 *   reconciliation: a position that changed with no stored fill since the
 *   previous snapshot triggers a fill sync;
 * - hourly: sweep every address's last 75 minutes of fills, and subscribe to
 *   newly listed markets;
 * - every minute: §8 self-alert when the trade feed has been down 10 min.
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private feedDownAlerted = false;
  private feedMissingSince: number | null = null;
  lastSnapshotAt: Date | null = null;
  lastSnapshotAttemptAt: Date | null = null;
  lastSnapshotFailureAt: Date | null = null;
  private snapshotFlight: Promise<{ written: number; reconciled: number; failed: number }> | undefined;

  constructor(
    private readonly watcher: WatcherService,
    private readonly accounts: AccountStateService,
    private readonly fillSync: FillSyncService,
    private readonly feed: TradeFeedService,
    private readonly notify: NotifyService,
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async snapshotAll(): Promise<{ written: number; reconciled: number; failed: number }> {
    if (this.jobs.stopping) return { written: 0, reconciled: 0, failed: 0 };
    this.snapshotFlight ??= this.jobs.run(() => this.takeSnapshots()).finally(() => { this.snapshotFlight = undefined; });
    return this.snapshotFlight;
  }
  private async takeSnapshots(): Promise<{ written: number; reconciled: number; failed: number }> {
    this.lastSnapshotAttemptAt = new Date();
    let addresses: string[];
    try {
      addresses = await this.watcher.activeAddresses();
    } catch (error) {
      this.logger.error(`Snapshot could not read leaders: ${(error as Error).message}`);
      this.lastSnapshotFailureAt = new Date();
      return { written: 0, reconciled: 0, failed: 1 };
    }
    let written = 0;
    let reconciled = 0;
    let failed = 0;
    await forEachConcurrent(addresses, 4, async (address) => {
        try {
          const previous = this.accounts.get(address);
          const state = await this.accounts.refresh(address, "background");
          await this.writeSnapshots(address, state);
          written += 1;
          if (previous && (await this.reconcile(address, previous, state))) reconciled += 1;
        } catch (error) {
          failed += 1;
          this.logger.error(`Snapshot failed for ${address}: ${(error as Error).message}`);
        }
      }, this.jobs.signal);
    if (written > 0) this.lastSnapshotAt = new Date();
    if (failed > 0) this.lastSnapshotFailureAt = new Date();
    this.logger.log(`Snapshots: ${written} written, ${reconciled} reconciled, ${failed} failed`);
    return { written, reconciled, failed };
  }

  @Cron(CronExpression.EVERY_HOUR)
  async hourly(): Promise<void> {
    if (this.jobs.stopping) return;
    try {
      await this.feed.refreshMarkets();
    } catch (error) {
      this.logger.error(`Market refresh failed: ${(error as Error).message}`);
    }
    const result = await this.watcher.sweep(Date.now() - SWEEP_WINDOW_MS);
    this.logger.log(`Hourly sweep: ${result.addresses} addresses, ${result.inserted} new fills, ${result.failed} failed`);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async checkFeed(now = Date.now()): Promise<void> {
    if (this.jobs.stopping) return;
    try {
      await this.checkFeedOnce(now);
    } catch (error) {
      this.logger.error(`Feed check failed: ${(error as Error).message}`);
    }
  }

  private async checkFeedOnce(now: number): Promise<void> {
    const status = this.feed.status();
    const down = status.socketsTotal === 0 || status.socketsOpen < status.socketsTotal;
    if (!down) {
      this.feedMissingSince = null;
      if (this.feedDownAlerted) {
        this.feedDownAlerted = false;
        await this.notify.sendSystemMessage("✅ Trade feed recovered; missed fills are being swept.");
      }
      return;
    }
    const since = status.disconnectedSince?.getTime() ?? (this.feedMissingSince ??= now);
    if (!this.feedDownAlerted && now - since >= FEED_DOWN_ALERT_MS) {
      this.feedDownAlerted = true;
      await this.notify.sendSystemMessage(
        `⚠️ Trade feed down for ${Math.round((now - since) / 60_000)} min (${status.socketsOpen}/${status.socketsTotal} sockets open). No alerts until it recovers.`,
      );
    }
  }

  /** True if a fill sync was needed: some coin's size changed since the
   * previous state, but no fill for that coin was stored since then. */
  private async reconcile(address: string, previous: AccountState, current: AccountState): Promise<boolean> {
    const before = AccountStateService.positions(previous);
    const after = AccountStateService.positions(current);
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
      (coin) => before.get(coin) !== after.get(coin),
    );
    if (changed.length === 0) return false;

    const seen = await this.db
      .selectDistinct({ coin: fills.coin })
      .from(fills)
      .where(
        and(
          eq(fills.chain, CHAIN_DEFAULT),
          eq(fills.address, address),
          inArray(fills.coin, changed),
          gt(fills.ts, previous.fetchedAt),
        ),
      );
    const covered = new Set(seen.map((r) => r.coin));
    const unexplained = changed.filter((coin) => !covered.has(coin));
    if (unexplained.length === 0) return false;

    this.logger.warn(`Reconcile ${address}: ${unexplained.join(",")} changed with no fill; syncing`);
    await this.fillSync.sync(address, "reconcile", previous.fetchedAt.getTime() - RECONCILE_OVERLAP_MS);
    return true;
  }

  /** One equity row per address (summed across dexes; `withdrawable` is the
   * main dex's) and one position row per open coin. */
  private async writeSnapshots(address: string, state: AccountState): Promise<void> {
    let accountValue = 0;
    let totalMarginUsed = 0;
    for (const response of state.byDex.values()) {
      accountValue += Number(response.marginSummary.accountValue);
      totalMarginUsed += Number(response.marginSummary.totalMarginUsed);
    }
    await this.db.transaction(async (tx) => {
      await tx
        .insert(equitySnapshots)
        .values({
          chain: CHAIN_DEFAULT,
          address,
          ts: state.fetchedAt,
          accountValue: accountValue.toString(),
          totalMarginUsed: totalMarginUsed.toString(),
          withdrawable: state.byDex.get(MAIN_DEX)?.withdrawable ?? "0",
        })
        .onConflictDoNothing();

      const rows = [...state.byDex.values()]
        .flatMap((response) => response.assetPositions)
        .filter((ap) => Number(ap.position.szi) !== 0)
        .map((ap) => ({
          chain: CHAIN_DEFAULT,
          address,
          coin: ap.position.coin,
          ts: state.fetchedAt,
          szi: ap.position.szi,
          entryPx: ap.position.entryPx ?? null,
          leverage: ap.position.leverage?.value?.toString() ?? null,
          marginMode: ap.position.leverage?.type ?? null,
          unrealizedPnl: ap.position.unrealizedPnl,
          liqPx: ap.position.liquidationPx ?? null,
        }));
      if (rows.length > 0) await tx.insert(positionSnapshots).values(rows).onConflictDoNothing();
    });
  }

  /** Refreshes coin_meta from `meta()` (szDecimals, max leverage). M3. */
  async refreshCoinMeta(): Promise<void> {
    throw new Error("not implemented");
  }

  /** N3: mid price 1h/4h/24h after a sent alert. M3. */
  async scoreAlert(_alertId: bigint): Promise<void> {
    throw new Error("not implemented");
  }
}
