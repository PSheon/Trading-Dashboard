import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import { UnitOfWork } from "../db/unit-of-work.js";
import { budgetConsumer } from "../hyperliquid/request-budgeter.service.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { forEachConcurrent } from "../runtime/concurrency.js";
import { SchedulerRepository } from "./scheduler.repository.js";
import { AccountStateService, MAIN_DEX, type AccountState } from "../watcher/account-state.service.js";
import { FillSyncService } from "../watcher/fill-sync.service.js";
import { WatcherService } from "../watcher/watcher.service.js";
import { safeErrorText } from "../runtime/safe-error-text.js";
import { SNAPSHOT_QUEUE_MS, SNAPSHOT_RECONCILE_OVERLAP_MS, SWEEP_QUEUE_MS } from '../config/constants/background.js';


/**
 * Periodic jobs:
 * - every 5 min (W4): positions and equity of every active leader on every
 *   dex it uses → `position_snapshots` / `equity_snapshots`, and
 *   reconciliation: a position that changed with no stored fill since the
 *   previous snapshot triggers a fill sync;
 * - hourly, and at :15/:30/:45: sweep every address from its verified cursor;
 * - every minute: one backward backfill window for an address whose stored
 *   history has not reached its floor yet.
 *
 * None of these needs the trade feed: a `read` worker runs them with the
 * watcher's capabilities and no feed. The feed's own schedules (the §8
 * self-alert, new markets) are FeedMonitorService's, beside the feed.
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  lastSnapshotAt: Date | null = null;
  lastSnapshotAttemptAt: Date | null = null;
  lastSnapshotFailureAt: Date | null = null;
  private snapshotFlight: Promise<{ written: number; reconciled: number; failed: number }> | undefined;

  constructor(
    private readonly watcher: WatcherService,
    private readonly accounts: AccountStateService,
    private readonly fillSync: FillSyncService,
    private readonly repository: SchedulerRepository,
    private readonly unitOfWork: UnitOfWork,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async snapshotAll(): Promise<{ written: number; reconciled: number; failed: number }> {
    if (this.jobs.stopping) return { written: 0, reconciled: 0, failed: 0 };
    this.snapshotFlight ??= budgetConsumer("snapshots", () => this.jobs.run(() => this.takeSnapshots()), { queueMs: SNAPSHOT_QUEUE_MS }).finally(() => { this.snapshotFlight = undefined; });
    return this.snapshotFlight;
  }
  private async takeSnapshots(): Promise<{ written: number; reconciled: number; failed: number }> {
    this.lastSnapshotAttemptAt = new Date();
    let addresses: string[];
    try {
      addresses = await this.watcher.activeAddresses();
    } catch (error) {
      this.logger.error(`Snapshot could not read leaders: ${safeErrorText(error)}`);
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
          this.logger.error(`Snapshot failed for ${address}: ${safeErrorText(error)}`);
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
    const result = await budgetConsumer("sweep", () => this.watcher.sweep(), { queueMs: SWEEP_QUEUE_MS });
    this.logger.log(`Hourly sweep: ${result.addresses} addresses, ${result.inserted} new fills, ${result.failed} failed`);
  }

  /** Between the hourly sweeps: keeps every verified cursor, and with it
   * the figures of watched traders, at most a quarter of an hour behind. */
  @Cron("0 15,30,45 * * * *")
  async catchUp(): Promise<void> {
    if (this.jobs.stopping) return;
    await budgetConsumer("sweep", () => this.watcher.sweep(), { queueMs: SWEEP_QUEUE_MS });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async backfillTick(): Promise<void> {
    if (this.jobs.stopping) return;
    try {
      await budgetConsumer("backfill", () => this.fillSync.backfillTick());
    } catch (error) {
      // Progress is in fill_coverage; the next minute retries the same window.
      this.logger.warn(`Backfill window failed: ${safeErrorText(error)}`);
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

    const covered = await this.repository.coinsWithFillsSince(address, changed, previous.fetchedAt);
    const unexplained = changed.filter((coin) => !covered.has(coin));
    if (unexplained.length === 0) return false;

    this.logger.warn(`Reconcile ${address}: ${unexplained.join(",")} changed with no fill; syncing`);
    await this.fillSync.sync(address, "reconcile", previous.fetchedAt.getTime() - SNAPSHOT_RECONCILE_OVERLAP_MS);
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
    const equity = {
      chain: CHAIN_DEFAULT,
      address,
      ts: state.fetchedAt,
      accountValue: accountValue.toString(),
      totalMarginUsed: totalMarginUsed.toString(),
      withdrawable: state.byDex.get(MAIN_DEX)?.withdrawable ?? "0",
    };
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
    await this.unitOfWork.run((tx) => this.repository.save(tx, equity, rows));
  }

  /** Deferred coin metadata refresh; throws until persistence and scheduling are implemented. */
  async refreshCoinMeta(): Promise<void> {
    throw new Error("not implemented");
  }

  /** Deferred post-alert price scoring (1h/4h/24h); not an active scheduled job. */
  async scoreAlert(_alertId: bigint): Promise<void> {
    throw new Error("not implemented");
  }
}
