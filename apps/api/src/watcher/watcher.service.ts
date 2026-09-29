import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { CHAIN_DEFAULT, leaders } from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { HlWsTrade } from "../hyperliquid/types.js";
import { AccountStateService } from "./account-state.service.js";
import { GROUP_GAP_MS } from "./action-classifier.js";
import { FillSyncService } from "./fill-sync.service.js";
import { TradeFeedService, type TradeFeedStatus } from "./trade-feed.service.js";

/** How far before the first seen trade a live sync starts. Trade and fill
 * times share the exchange clock, so this only needs to catch fills of the
 * same order that landed just before. */
const LIVE_LOOKBACK_MS = 10_000;
/** A trade seen on the feed can take a moment to show up in
 * `userFillsByTime`; retry these delays before leaving it to the sweep. */
const LIVE_RETRY_DELAYS_MS = [2_000, 5_000, 15_000];
/** The hourly sweep re-reads this much history for every address, so any
 * fill the feed missed is stored within about an hour. */
export const SWEEP_WINDOW_MS = 75 * 60_000;
/** Gap catch-up starts this long before the socket went down. */
const GAP_OVERLAP_MS = 60_000;
const WATCHED_REFRESH_MS = 15_000;
const FEED_START_RETRY_MS = 30_000;

interface Pending {
  minTime: number;
  tids: Set<bigint>;
}

/**
 * Leader watcher (§4.2 W1–W3).
 *
 * The `trades` feed reports that a leader traded; the leader's trades within
 * `GROUP_GAP_MS` are gathered and then one `userFillsByTime` (live priority)
 * stores the fills and derives actions. Nothing here polls per address:
 * REST weight is only spent on addresses that actually traded.
 *
 * Nothing is lost if the feed is: a socket outage triggers a catch-up sweep
 * from when it went down, the process start sweeps the last 75 minutes
 * (covering a deploy), and `SchedulerService` sweeps every address hourly.
 * Fill storage dedupes, so these overlaps cost weight, never duplicates.
 *
 * The watch list is re-read from `leaders` every 15 s (A2: a new address is
 * watched within a minute; A3: a deactivated one is dropped).
 */
@Injectable()
export class WatcherService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WatcherService.name);
  private readonly pending = new Map<string, Pending>();
  private watchedTimer: ReturnType<typeof setInterval> | undefined;
  private feedRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private lastSweepAt: Date | null = null;

  constructor(
    private readonly feed: TradeFeedService,
    private readonly fillSync: FillSyncService,
    private readonly accounts: AccountStateService,
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
  ) {}

  /** Starts on app boot; not under `NODE_ENV=test`, where tests drive the
   * pieces directly. */
  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return;
    void this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.refreshWatched();
    this.watchedTimer = setInterval(() => void this.refreshWatched(), WATCHED_REFRESH_MS);
    await this.startFeed();
    // Covers whatever happened while the process was down (e.g. a deploy).
    void this.sweep(Date.now() - SWEEP_WINDOW_MS);
  }

  stop(): void {
    this.running = false;
    clearInterval(this.watchedTimer);
    clearTimeout(this.feedRetryTimer);
    this.feed.stop();
  }

  private async startFeed(): Promise<void> {
    try {
      await this.feed.start({
        onTrade: (address, trade) => this.onTrade(address, trade),
        onGap: (since) => void this.sweep(since - GAP_OVERLAP_MS),
      });
    } catch (error) {
      this.logger.error(`Trade feed failed to start, retrying in 30s: ${(error as Error).message}`);
      this.feed.stop();
      if (this.running) this.feedRetryTimer = setTimeout(() => void this.startFeed(), FEED_START_RETRY_MS);
    }
  }

  async activeAddresses(): Promise<string[]> {
    const rows = await this.db
      .select({ address: leaders.address })
      .from(leaders)
      .where(and(eq(leaders.chain, CHAIN_DEFAULT), eq(leaders.active, true)));
    return rows.map((r) => r.address);
  }

  async refreshWatched(): Promise<void> {
    try {
      const addresses = await this.activeAddresses();
      this.feed.setWatched(addresses);
    } catch (error) {
      this.logger.error(`Watch list refresh failed: ${(error as Error).message}`);
    }
  }

  /** Called by the feed for every trade a watched address is part of. */
  onTrade(address: string, trade: HlWsTrade): void {
    let entry = this.pending.get(address);
    if (!entry) {
      entry = { minTime: trade.time, tids: new Set() };
      this.pending.set(address, entry);
      setTimeout(() => {
        this.pending.delete(address);
        void this.liveSync(address, entry!.minTime, entry!.tids, 0);
      }, GROUP_GAP_MS);
    }
    entry.minTime = Math.min(entry.minTime, trade.time);
    entry.tids.add(BigInt(trade.tid));
  }

  private async liveSync(address: string, minTime: number, tids: Set<bigint>, attempt: number): Promise<void> {
    let missing: bigint[] = [...tids];
    try {
      const result = await this.fillSync.sync(address, "live", minTime - LIVE_LOOKBACK_MS, tids);
      missing = result.missingTids;
    } catch (error) {
      this.logger.warn(`Live sync failed for ${address}: ${(error as Error).message}`);
    }
    if (missing.length === 0) return;
    if (attempt < LIVE_RETRY_DELAYS_MS.length) {
      setTimeout(
        () => void this.liveSync(address, minTime, new Set(missing), attempt + 1),
        LIVE_RETRY_DELAYS_MS[attempt],
      );
    } else {
      this.logger.warn(
        `${missing.length} trade(s) of ${address} still not in userFillsByTime after retries; the hourly sweep will pick them up`,
      );
    }
  }

  /** Re-reads fills since `startTime` for every active address. */
  async sweep(startTime: number): Promise<{ addresses: number; inserted: number; failed: number }> {
    let addresses: string[];
    try {
      addresses = await this.activeAddresses();
    } catch (error) {
      // Callers fire this without awaiting; it must never reject.
      this.logger.error(`Sweep could not read leaders: ${(error as Error).message}`);
      return { addresses: 0, inserted: 0, failed: 0 };
    }
    let inserted = 0;
    let failed = 0;
    await Promise.all(
      addresses.map(async (address) => {
        try {
          // Await first: `x += await f()` reads x before awaiting, so
          // concurrent sweeps would overwrite each other's counts.
          const result = await this.fillSync.sync(address, "sweep", startTime);
          inserted += result.inserted;
        } catch (error) {
          failed += 1;
          this.logger.warn(`Sweep failed for ${address}: ${(error as Error).message}`);
        }
      }),
    );
    this.lastSweepAt = new Date();
    if (inserted > 0) this.logger.warn(`Sweep stored ${inserted} fill(s) the feed had missed`);
    return { addresses: addresses.length, inserted, failed };
  }

  /** R1/R3 equity: account value across dexes, refreshed right before any
   * live action is written. Null until the address has been refreshed. */
  getEquityUsd(address: string): number | null {
    return this.accounts.getEquityUsd(address);
  }

  getHeartbeat(): { feed: TradeFeedStatus; lastFillAt: Date | null; lastSweepAt: Date | null } {
    return {
      feed: this.feed.status(),
      lastFillAt: this.fillSync.getLastFillAt(),
      lastSweepAt: this.lastSweepAt,
    };
  }
}
