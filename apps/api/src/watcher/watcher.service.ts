import { Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";

import { AppConfig } from "../config/app-config.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { budgetConsumer } from "../hyperliquid/request-budgeter.service.js";
import { forEachConcurrent } from "../runtime/concurrency.js";
import { WatcherRepository } from "./watcher.repository.js";
import type { HlWsTrade } from "../hyperliquid/types.js";
import { AccountStateService } from "./account-state.service.js";
import { GROUP_GAP_MS } from "./action-classifier.js";
import { FeedActionsService } from "./feed-actions.service.js";
import { FillSyncService, type FastPathStats } from "./fill-sync.service.js";
import { TradeFeedService, type TradeFeedStatus } from "./trade-feed.service.js";
import { COPY_LEADER_TRADED_EVENT, COPY_LEADER_VERIFIED_EVENT, type CopyLeaderTradedEvent, type CopyLeaderVerifiedEvent } from "./copy-leader-events.js";

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
/** Catch-up rounds per address in one sweep (each reads up to six pages
 * per endpoint); a longer backlog continues in the next sweep. */
const SWEEP_MAX_ROUNDS = 10;
const WATCHED_REFRESH_MS = 15_000;
/** A copied leader's verified span is caught up this often (besides the
 * quarter-hourly sweeps), and its copy stream audited after each. */
export const COPIED_CATCH_UP_MS = 120_000;
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
 * the feed missed into actions. For an address someone copies the stored
 * fills are the copy signals, so its slow path uses the live lane
 * (`FillSyncService.lane`).
 *
 * Nothing is lost if the feed is, or the process: a sweep reads each
 * address from its verified cursor in `fill_coverage`, which only a
 * completed read moves. A socket outage drops the position books and
 * sweeps, the process start sweeps (covering any length of downtime), and
 * `SchedulerService` sweeps every address hourly. Storage dedupes fills,
 * and an action covers each fill once, so overlaps cost weight, never
 * duplicates.
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
  private sweepFlight: Promise<{ addresses: number; inserted: number; failed: number }> | undefined;
  private sweepPending = false;
  /** Leaders a live copy follows, and those followed by a testnet copy of a
   * mainnet leader (their feed trades are copy triggers). */
  private copied = new Set<string>();
  private copiedMainnet = new Set<string>();
  private copiedTimer: ReturnType<typeof setInterval> | undefined;
  private copiedFlight: Promise<void> | undefined;
  private watched = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly feed: TradeFeedService,
    private readonly fillSync: FillSyncService,
    private readonly accounts: AccountStateService,
    private readonly feedActions: FeedActionsService,
    private readonly repository: WatcherRepository,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  /** Starts on the worker's boot (WatcherModule is imported by the worker
   * process only); not under `NODE_ENV=test`, where tests drive the pieces
   * directly. */
  onApplicationBootstrap(): void {
    if (this.config.value.app.nodeEnv === "test") return;
    void this.start();
  }

  onModuleDestroy(): void {
    this.jobs.stop();
    this.stop();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.refreshWatched();
    if (!this.running || this.jobs.stopping) return;
    this.watchedTimer = setInterval(() => void this.refreshWatched(), WATCHED_REFRESH_MS);
    this.copiedTimer = setInterval(() => void this.catchUpCopied(), COPIED_CATCH_UP_MS);
    await this.startFeed();
    if (!this.running || this.jobs.stopping) { this.feed.stop(); return; }
    // Covers whatever happened while the process was down, however long.
    void this.sweep();
  }

  stop(): void {
    this.running = false;
    clearInterval(this.watchedTimer);
    clearInterval(this.copiedTimer);
    clearTimeout(this.feedRetryTimer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.feed.stop();
  }

  private later(ms: number, fn: () => void): void {
    if (this.jobs.stopping) return;
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
    return this.repository.activeAddresses();
  }

  async refreshWatched(): Promise<void> {
    try {
      const addresses = await this.activeAddresses();
      this.feed.setWatched(addresses);
      this.watched = new Set(addresses);
    } catch (error) {
      this.logger.error(`Watch list refresh failed: ${(error as Error).message}`);
    }
    await this.refreshCopied();
  }

  /** Re-reads which leaders live copies follow (with the watch list). */
  async refreshCopied(): Promise<void> {
    try {
      const { copied, mainnet } = await this.repository.copiedAddresses();
      this.copied = copied;
      this.copiedMainnet = mainnet;
    } catch (error) {
      this.logger.error(`Copied leader refresh failed: ${(error as Error).message}`);
    }
  }

  /** Called by the feed for every trade a watched address is part of. */
  onTrade(address: string, trade: HlWsTrade): void {
    if (this.jobs.stopping) return;
    if (this.copiedMainnet.has(address)) {
      // Realtime copy trigger (the copy engine reads the fill itself).
      try {
        this.events?.emit(COPY_LEADER_TRADED_EVENT, { address, time: trade.time, tid: trade.tid } satisfies CopyLeaderTradedEvent);
      } catch (error) {
        this.logger.warn(`Copy trigger for ${address} failed: ${(error as Error).message}`);
      }
    }
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
  onGap(_since: number): void {
    if (this.jobs.stopping) return;
    this.accounts.dropBooks();
    void this.sweep();
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
      // An essential consumer: waits for room in the shared lane, never fails at once.
      const result = await budgetConsumer("confirm", () => this.fillSync.sync(address, "confirm", start, entry.keys()));
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

  /** Catches every active address up from its verified cursor. */
  async sweep(): Promise<{ addresses: number; inserted: number; failed: number }> {
    if (this.jobs.stopping) return { addresses: 0, inserted: 0, failed: 0 };
    // Fills may arrive after an address was processed earlier in the
    // active sweep. Retain a follow-up pass.
    this.sweepPending = true;
    this.sweepFlight ??= this.jobs.run(async () => {
      const total = { addresses: 0, inserted: 0, failed: 0 };
      while (this.sweepPending && !this.jobs.stopping) {
        this.sweepPending = false;
        const result = await this.runSweep();
        total.addresses += result.addresses; total.inserted += result.inserted; total.failed += result.failed;
      }
      return total;
    }).finally(() => { this.sweepFlight = undefined; });
    return this.sweepFlight;
  }

  private async runSweep(): Promise<{ addresses: number; inserted: number; failed: number }> {
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
    // Copied leaders first: their verified span gates copy signals.
    addresses = [...addresses.filter((a) => this.copied.has(a)), ...addresses.filter((a) => !this.copied.has(a))];
    await forEachConcurrent(addresses, 4, async (address) => {
        try {
          for (let round = 0; round < SWEEP_MAX_ROUNDS && !this.jobs.stopping; round++) {
            // Await first: `x += await f()` reads x before awaiting, so
            // concurrent sweeps would overwrite each other's counts.
            const result = await this.fillSync.catchUp(address);
            inserted += result.inserted;
            if (result.complete) break;
          }
          if (this.copied.has(address)) this.verified(address);
        } catch (error) {
          // The cursor did not move: the next sweep reads from the same place.
          failed += 1;
          this.logger.warn(`Sweep failed for ${address}: ${(error as Error).message}`);
        }
      }, this.jobs.signal);
    if (addresses.length > 0 && failed < addresses.length) this.lastSweepAt = new Date();
    if (inserted > 0) this.logger.warn(`Sweep stored ${inserted} fill(s) the feed had missed`);
    return { addresses: addresses.length, inserted, failed };
  }

  private verified(address: string): void {
    try {
      this.events?.emit(COPY_LEADER_VERIFIED_EVENT, { address } satisfies CopyLeaderVerifiedEvent);
    } catch (error) {
      this.logger.warn(`Copy audit trigger for ${address} failed: ${(error as Error).message}`);
    }
  }

  /** Catches up every copied leader's verified span (every 2 min), then
   * has its copy stream audited. One run at a time. */
  catchUpCopied(): Promise<void> {
    if (this.jobs.stopping) return Promise.resolve();
    this.copiedFlight ??= this.jobs.run(async () => {
      await forEachConcurrent([...this.copied].filter((a) => this.watched.has(a)), 2, async (address) => {
        try {
          for (let round = 0; round < SWEEP_MAX_ROUNDS && !this.jobs.stopping; round++) {
            if ((await this.fillSync.catchUp(address)).complete) break;
          }
          this.verified(address);
        } catch (error) {
          this.logger.warn(`Copied leader catch-up failed for ${address}: ${(error as Error).message}`);
        }
      }, this.jobs.signal);
    }).catch(() => undefined).finally(() => { this.copiedFlight = undefined; });
    return this.copiedFlight;
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
