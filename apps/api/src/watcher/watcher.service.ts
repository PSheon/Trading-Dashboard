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
  /** Retry round of the oldest trades in here (0 = first try). */
  attempt: number;
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
  /** Trades waiting for the address's next live sync. */
  private readonly pending = new Map<string, Pending>();
  /** Addresses with a live sync scheduled or running. */
  private readonly busy = new Set<string>();
  /** When each address's last live sync started: its budget rank, so the
   * least recently served address goes first. */
  private readonly lastServedAt = new Map<string, number>();
  /** Newest fill time each address's live syncs have already read; the next
   * live sync needn't reach further back than just before it. */
  private readonly readThrough = new Map<string, number>();
  /** Addresses whose feed trades Hyperliquid's info API never returned
   * (seen live 2026-09-29: an account whose userFills stopped six days
   * earlier while it kept trading). Cleared when a sync finds them all. */
  private readonly fillsUnavailable = new Map<string, { missedTrades: number; since: Date; loggedAt: number }>();
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
    this.enqueue(address, trade.time, [BigInt(trade.tid)], 0, GROUP_GAP_MS);
  }

  /**
   * At most one live sync per address is scheduled or running. Trades that
   * arrive meanwhile wait in `pending` and go in the next sync, which starts
   * as soon as the current one ends. So REST weight grows with the number of
   * active addresses, not with how often they trade: an address filling
   * every second costs one sync per sync duration, not one per second.
   */
  private enqueue(address: string, minTime: number, tids: Iterable<bigint>, attempt: number, delayMs: number): void {
    const entry = this.pending.get(address) ?? { minTime, tids: new Set<bigint>(), attempt };
    entry.minTime = Math.min(entry.minTime, minTime);
    for (const tid of tids) entry.tids.add(tid);
    entry.attempt = Math.max(entry.attempt, attempt);
    this.pending.set(address, entry);
    if (!this.busy.has(address)) {
      this.busy.add(address);
      if (delayMs === 0) void this.drain(address);
      else setTimeout(() => void this.drain(address), delayMs);
    }
  }

  private async drain(address: string): Promise<void> {
    const entry = this.pending.get(address);
    this.pending.delete(address);
    if (!entry) {
      this.busy.delete(address);
      return;
    }

    const rank = this.lastServedAt.get(address) ?? 0;
    this.lastServedAt.set(address, Date.now());
    // Reach back LIVE_LOOKBACK_MS before the first trade, but not past what
    // the previous live sync already read (keeps busy addresses cheap).
    const read = this.readThrough.get(address);
    const start = Math.min(entry.minTime, Math.max(entry.minTime - LIVE_LOOKBACK_MS, (read ?? 0) - 1000));
    let missing: bigint[] = [...entry.tids];
    try {
      const result = await this.fillSync.sync(address, "live", start, entry.tids, rank);
      missing = result.missingTids;
      if (result.latestFillTime !== null) {
        this.readThrough.set(address, Math.max(read ?? 0, result.latestFillTime));
      }
    } catch (error) {
      this.logger.warn(`Live sync failed for ${address}: ${(error as Error).message}`);
    }
    if (missing.length === 0) {
      this.fillsUnavailable.delete(address);
    } else if (entry.attempt < LIVE_RETRY_DELAYS_MS.length) {
      setTimeout(
        () => this.enqueue(address, entry.minTime, missing, entry.attempt + 1, 0),
        LIVE_RETRY_DELAYS_MS[entry.attempt],
      );
    } else {
      const record = this.fillsUnavailable.get(address) ?? { missedTrades: 0, since: new Date(), loggedAt: 0 };
      record.missedTrades += missing.length;
      this.fillsUnavailable.set(address, record);
      if (Date.now() - record.loggedAt > 3600_000) {
        record.loggedAt = Date.now();
        this.logger.warn(
          `Hyperliquid's info API isn't returning fills ${address} made on the trade feed (${record.missedTrades} so far); listed on /health`,
        );
      }
    }

    if (this.pending.has(address)) void this.drain(address);
    else this.busy.delete(address);
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

  getHeartbeat(): {
    feed: TradeFeedStatus;
    lastFillAt: Date | null;
    lastSweepAt: Date | null;
    fillsUnavailable: Array<{ address: string; missedTrades: number; since: Date }>;
  } {
    return {
      feed: this.feed.status(),
      lastFillAt: this.fillSync.getLastFillAt(),
      lastSweepAt: this.lastSweepAt,
      fillsUnavailable: [...this.fillsUnavailable].map(([address, r]) => ({
        address,
        missedTrades: r.missedTrades,
        since: r.since,
      })),
    };
  }
}
