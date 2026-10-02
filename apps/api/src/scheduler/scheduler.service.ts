import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import { UnitOfWork } from "../db/unit-of-work.js";
import { budgetConsumer } from "../hyperliquid/request-budgeter.service.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { forEachConcurrent } from "../runtime/concurrency.js";
import { SchedulerRepository } from "./scheduler.repository.js";
import { NotifyService } from "../notify/notify.service.js";
import { AccountStateService, MAIN_DEX, type AccountState } from "../watcher/account-state.service.js";
import { FillSyncService } from "../watcher/fill-sync.service.js";
import { TradeFeedService } from "../watcher/trade-feed.service.js";
import { WatcherService } from "../watcher/watcher.service.js";

/** §8: feed down this long → Telegram self-alert. */
const FEED_DOWN_ALERT_MS = 10 * 60_000;
const RECONCILE_OVERLAP_MS = 60_000;

/**
 * Periodic jobs:
 * - every 5 min (W4): positions and equity of every active leader on every
 *   dex it uses → `position_snapshots` / `equity_snapshots`, and
 *   reconciliation: a position that changed with no stored fill since the
 *   previous snapshot triggers a fill sync;
 * - hourly: sweep every address from its verified cursor, and subscribe to
 *   newly listed markets;
 * - every minute: one backward backfill window for an address whose stored
 *   history has not reached its floor yet;
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
    private readonly repository: SchedulerRepository,
    private readonly unitOfWork: UnitOfWork,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async snapshotAll(): Promise<{ written: number; reconciled: number; failed: number }> {
    if (this.jobs.stopping) return { written: 0, reconciled: 0, failed: 0 };
    this.snapshotFlight ??= budgetConsumer("snapshots", () => this.jobs.run(() => this.takeSnapshots())).finally(() => { this.snapshotFlight = undefined; });
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
    const result = await budgetConsumer("sweep", () => this.watcher.sweep());
    this.logger.log(`Hourly sweep: ${result.addresses} addresses, ${result.inserted} new fills, ${result.failed} failed`);
  }

  /** Between the hourly sweeps: keeps every verified cursor, and with it
   * the figures of watched traders, at most a quarter of an hour behind. */
  @Cron("0 15,30,45 * * * *")
  async catchUp(): Promise<void> {
    if (this.jobs.stopping) return;
    await budgetConsumer("sweep", () => this.watcher.sweep());
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async backfillTick(): Promise<void> {
    if (this.jobs.stopping) return;
    try {
      await budgetConsumer("backfill", () => this.fillSync.backfillTick());
    } catch (error) {
      // Progress is in fill_coverage; the next minute retries the same window.
      this.logger.warn(`Backfill window failed: ${(error as Error).message}`);
    }
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

    const covered = await this.repository.coinsWithFillsSince(address, changed, previous.fetchedAt);
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
