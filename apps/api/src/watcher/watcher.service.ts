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
import { FeedActionsService } from "./feed-actions.service.js";
import { FillSyncService, type FastPathStats } from "./fill-sync.service.js";
import { TradeFeedService, type TradeFeedStatus } from "./trade-feed.service.js";

/** The fill index usually has a feed trade within 1.5 s (measured live
 * 2026-09-29: p50 0.6 s, p90 1.5 s); the first confirm waits this long. */
export const CONFIRM_DELAY_MS = 2_000;
/** Confirms of one address start at least this far apart: an address that
 * trades every second costs one `userFillsByTime` per 15 s, not per trade. */
export const CONFIRM_MIN_INTERVAL_MS = 15_000;
/** A trade whose fill Hyperliquid hasn't returned yet is looked for again
 * after these delays, then the address is listed as `fillsUnavailable`. */
export const CONFIRM_RETRY_DELAYS_MS = [5_000, 15_000, 60_000];
/** How far before the first trade a confirm starts reading. Trade and fill
 * times share the exchange clock, so this only needs to catch fills of the
 * same order that landed just before. */
const CONFIRM_LOOKBACK_MS = 10_000;
/** The hourly sweep re-reads this much history for every address, so any
 * fill the feed missed is stored within about an hour. */
export const SWEEP_WINDOW_MS = 75 * 60_000;
/** Gap catch-up starts this long before the socket went down. */
const GAP_OVERLAP_MS = 60_000;
const WATCHED_REFRESH_MS = 15_000;
const FEED_START_RETRY_MS = 30_000;

interface Expected {
  time: number;
  /** Confirms that already missed this trade's fill. */
  attempt: number;
}

/**
 * Leader watcher (§4.2 W1–W3, Stage 2 §5).
 *
 * Fast path: the `trades` feed reports that a leader traded; the leader's
 * trades within `GROUP_GAP_MS` are gathered and `FeedActionsService` turns
 * them into actions (and alerts) from the feed and the position book, with
 * no fill query in between.
 *
 * Slow path: a few seconds later, in the background lane, one
 * `userFillsByTime` per address (coalesced, at least 15 s apart) stores the
 * real fills, corrects any action the fast path got wrong, and turns fills
 * the feed missed into actions.
 *
 * Nothing is lost if the feed is: a socket outage drops the position books
 * and triggers a catch-up sweep from when it went down, the process start
 * sweeps the last 75 minutes (covering a deploy), and `SchedulerService`
 * sweeps every address hourly. Storage dedupes fills, and an action covers
 * each fill once, so these overlaps cost weight, never duplicates.
 *
 * The watch list is re-read from `leaders` every 15 s (A2: a new address is
 * watched within a minute; A3: a deactivated one is dropped).
 */
@Injectable()
export class WatcherService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WatcherService.name);
  /** Feed trades waiting for the address's next fast-path run, by tid. */
  private readonly pending = new Map<string, Map<number, HlWsTrade>>();
  /** Addresses with a fast-path run scheduled or running. */
  private readonly busy = new Set<string>();
  /** When each address's last fast-path run started: its budget rank, so
   * the least recently served address goes first. */
  private readonly lastServedAt = new Map<string, number>();
  /** Trades waiting for the address's next confirm, by tid. */
  private readonly confirmPending = new Map<string, Map<bigint, Expected>>();
  /** Addresses with a confirm scheduled or running. */
  private readonly confirmBusy = new Set<string>();
  private readonly lastConfirmAt = new Map<string, number>();
  /** Newest fill time each address's confirms have already read; the next
   * one needn't reach further back than just before it. */
  private readonly readThrough = new Map<string, number>();
  /** Addresses whose feed trades Hyperliquid's info API never returned
   * (seen live 2026-09-29: an account whose userFills stopped six days
   * earlier while it kept trading). Cleared when a confirm finds them all. */
  private readonly fillsUnavailable = new Map<string, { missedTrades: number; since: Date; loggedAt: number }>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private watchedTimer: ReturnType<typeof setInterval> | undefined;
  private feedRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private lastSweepAt: Date | null = null;

  constructor(
    private readonly feed: TradeFeedService,
    private readonly fillSync: FillSyncService,
    private readonly accounts: AccountStateService,
    private readonly feedActions: FeedActionsService,
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
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.feed.stop();
  }

  private later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  private async startFeed(): Promise<void> {
    try {
      await this.feed.start({
        onTrade: (address, trade) => this.onTrade(address, trade),
        onGap: (since) => this.onGap(since),
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
    const burst = this.pending.get(address) ?? new Map<number, HlWsTrade>();
    if (!burst.has(trade.tid)) burst.set(trade.tid, trade);
    this.pending.set(address, burst);
    if (!this.busy.has(address)) {
      this.busy.add(address);
      this.later(GROUP_GAP_MS, () => void this.drain(address));
    }
  }

  /** A socket was down: any address may have traded unseen, so every
   * position book is dropped (the next burst reads state afresh) and the
   * outage is swept. */
  onGap(since: number): void {
    this.accounts.dropBooks();
    void this.sweep(since - GAP_OVERLAP_MS);
  }

  /**
   * At most one fast-path run per address is scheduled or running. Trades
   * that arrive meanwhile wait in `pending` and go in the next run, which
   * starts as soon as the current one ends.
   */
  private async drain(address: string): Promise<void> {
    const burst = this.pending.get(address);
    this.pending.delete(address);
    if (!burst) {
      this.busy.delete(address);
      return;
    }

    const rank = this.lastServedAt.get(address) ?? 0;
    this.lastServedAt.set(address, Date.now());
    const trades = [...burst.values()];
    try {
      await this.feedActions.process(address, trades, rank);
    } catch (error) {
      // The confirm below still stores the fills and makes their actions.
      this.logger.warn(`Fast path failed for ${address}: ${(error as Error).message}`);
    }
    this.expect(
      address,
      trades.map((t) => [BigInt(t.tid), { time: t.time, attempt: 0 }]),
      CONFIRM_DELAY_MS,
    );

    if (this.pending.has(address)) void this.drain(address);
    else this.busy.delete(address);
  }

  /** Queues trades for the address's next confirm: at most one scheduled
   * or running per address, starting no sooner than `delayMs` from now and
   * `CONFIRM_MIN_INTERVAL_MS` after the previous one. */
  private expect(address: string, trades: Iterable<[bigint, Expected]>, delayMs: number): void {
    const entry = this.confirmPending.get(address) ?? new Map<bigint, Expected>();
    for (const [tid, expected] of trades) {
      const current = entry.get(tid);
      if (!current || current.attempt < expected.attempt) entry.set(tid, expected);
    }
    this.confirmPending.set(address, entry);
    if (this.confirmBusy.has(address)) return;
    this.confirmBusy.add(address);
    this.later(Math.max(delayMs, this.nextConfirmAt(address) - Date.now()), () => void this.confirm(address));
  }

  private nextConfirmAt(address: string): number {
    return (this.lastConfirmAt.get(address) ?? -Infinity) + CONFIRM_MIN_INTERVAL_MS;
  }

  private async confirm(address: string): Promise<void> {
    const entry = this.confirmPending.get(address);
    this.confirmPending.delete(address);
    if (!entry || entry.size === 0) {
      this.confirmBusy.delete(address);
      return;
    }
    this.lastConfirmAt.set(address, Date.now());

    const minTime = Math.min(...[...entry.values()].map((e) => e.time));
    const read = this.readThrough.get(address);
    const start = Math.min(minTime, Math.max(minTime - CONFIRM_LOOKBACK_MS, (read ?? 0) - 1000));
    let missing: bigint[] = [...entry.keys()];
    try {
      const result = await this.fillSync.sync(address, "confirm", start, entry.keys());
      missing = result.missingTids;
      if (result.latestFillTime !== null) this.readThrough.set(address, Math.max(read ?? 0, result.latestFillTime));
    } catch (error) {
      this.logger.warn(`Confirm failed for ${address}: ${(error as Error).message}`);
    }

    if (missing.length === 0) this.fillsUnavailable.delete(address);
    const retries = new Map<number, Array<[bigint, Expected]>>();
    let givenUp = 0;
    for (const tid of missing) {
      const expected = entry.get(tid);
      if (!expected) continue;
      if (expected.attempt >= CONFIRM_RETRY_DELAYS_MS.length) {
        givenUp += 1;
        continue;
      }
      const list = retries.get(expected.attempt) ?? [];
      list.push([tid, { time: expected.time, attempt: expected.attempt + 1 }]);
      retries.set(expected.attempt, list);
    }
    for (const [attempt, list] of retries) {
      this.later(CONFIRM_RETRY_DELAYS_MS[attempt], () => this.expect(address, list, 0));
    }
    if (givenUp > 0) this.noteUnavailable(address, givenUp);

    if (this.confirmPending.has(address)) {
      this.later(Math.max(0, this.nextConfirmAt(address) - Date.now()), () => void this.confirm(address));
    } else {
      this.confirmBusy.delete(address);
    }
  }

  private noteUnavailable(address: string, trades: number): void {
    const record = this.fillsUnavailable.get(address) ?? { missedTrades: 0, since: new Date(), loggedAt: 0 };
    record.missedTrades += trades;
    this.fillsUnavailable.set(address, record);
    if (Date.now() - record.loggedAt > 3600_000) {
      record.loggedAt = Date.now();
      this.logger.warn(
        `Hyperliquid's info API isn't returning fills ${address} made on the trade feed (${record.missedTrades} so far); listed on /health`,
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

  /** R1/R3 equity: account value across dexes, as of the address's latest
   * state read. Null until the address has been read. */
  getEquityUsd(address: string): number | null {
    return this.accounts.getEquityUsd(address);
  }

  getHeartbeat(): {
    feed: TradeFeedStatus;
    lastFillAt: Date | null;
    lastSweepAt: Date | null;
    fillsUnavailable: Array<{ address: string; missedTrades: number; since: Date }>;
    fastPath: FastPathStats;
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
      fastPath: this.fillSync.getFastPathStats(),
    };
  }
}
