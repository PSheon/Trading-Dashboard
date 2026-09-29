import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { HlUserFill, HlWsTrade } from "../hyperliquid/types.js";
import { AccountStateService } from "./account-state.service.js";
import { classifyFills, fromScaled, toScaled, type ActionDraft } from "./action-classifier.js";
import { actionsCovering, emitRecent, insertActions, withActionLock } from "./action-store.js";
import { dexOf, type BookTrade } from "./position-book.js";

/** `dir` of a fill built from the feed (the feed has none; only spot dirs
 * mean anything to the classifier). */
export const FEED_FILL_DIR = "feed";

/**
 * The fast path (Stage 2 §5): actions straight from the `trades` feed.
 *
 * Hyperliquid's fill index lags the feed by up to seconds (sometimes
 * forever), but `clearinghouseState` doesn't: it includes every fill up to
 * its `time`. So each feed trade gets its `startPosition` from the
 * address's position book, the trades become fill-shaped objects, and the
 * same `classifyFills` as for real fills turns them into actions, which are
 * alerted on at once. No `userFillsByTime` here: `FillSyncService` stores the
 * real fills afterwards and corrects an action the book got wrong.
 *
 * The feed has no liquidation flag, fee or closedPnl; a liquidation is
 * first reported by its shape (reduce/close) and corrected later.
 */
@Injectable()
export class FeedActionsService {
  private readonly logger = new Logger(FeedActionsService.name);

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly accounts: AccountStateService,
    @Optional() private readonly events?: EventEmitter2,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
  ) {}

  /**
   * Turns one address's burst of feed trades (in feed order) into actions.
   * `rank` orders any `clearinghouseState` it needs in the live lane.
   * Returns the number of actions created. A trade that already has an
   * action (replayed, or stored by a sweep first) gets none.
   */
  async process(address: string, trades: HlWsTrade[], rank?: number): Promise<number> {
    if (this.jobs.stopping) return 0;
    return this.jobs.run(() => this.processBurst(address, trades, rank));
  }

  private async processBurst(address: string, trades: HlWsTrade[], rank?: number): Promise<number> {
    const burst = this.normalize(address, trades);
    if (burst.length === 0) return 0;
    const book = this.accounts.book(address);
    try {
      const missing = [...new Set(burst.map((t) => dexOf(t.trade.coin)))].filter((dex) => !book.has(dex));
      if (missing.length > 0) {
        // Never read yet: every dex (in parallel), so R1/R3 see the whole
        // account's equity, not one dex's.
        if (this.accounts.get(address)) await this.accounts.refreshDexes(address, missing, "live", rank);
        else await this.accounts.refresh(address, "live", missing, rank);
      }

      let drafts = this.classify(address, burst);
      const unlevered = drafts.filter((d) => (d.kind === "open" || d.kind === "flip") && d.leverage === null);
      if (unlevered.length > 0) {
        // A position the cached state doesn't have yet: read its dex again
        // for the leverage (the new state includes these trades).
        try {
          await this.accounts.refreshDexes(address, new Set(unlevered.map((d) => dexOf(d.coin))), "live", rank);
          drafts = this.classify(address, burst);
        } catch (error) {
          this.logger.warn(`Leverage refresh failed for ${address}: ${(error as Error).message}`);
        }
      }

      const rows = await withActionLock(this.db, address, async (tx) => {
        const tids = burst.map((t) => t.book.tid);
        const covering = await actionsCovering(tx, address, tids, Math.min(...burst.map((t) => t.book.time)));
        if (covering.length > 0) {
          const covered = new Set(covering.flatMap((a) => a.fillIds));
          drafts = this.classify(address, burst, covered);
        }
        return insertActions(tx, address, drafts);
      });
      emitRecent(this.events, rows);
      return rows.length;
    } finally {
      // Whether or not actions were written, the position moved.
      this.accounts.applyTrades(address, burst.map((t) => t.book));
    }
  }

  /** Dedupes by tid and orders by time, keeping feed order within a
   * millisecond: that is execution order (tids are not). */
  private normalize(address: string, trades: HlWsTrade[]): Array<{ trade: HlWsTrade; book: BookTrade; side: "A" | "B" }> {
    const seen = new Set<number>();
    const out: Array<{ trade: HlWsTrade; book: BookTrade; side: "A" | "B" }> = [];
    for (const trade of trades) {
      if (seen.has(trade.tid)) continue;
      seen.add(trade.tid);
      const side = trade.users[0]?.toLowerCase() === address.toLowerCase() ? "B" : "A";
      const sz = toScaled(trade.sz);
      out.push({
        trade,
        side,
        book: { tid: BigInt(trade.tid), coin: trade.coin, time: trade.time, signed: side === "B" ? sz : -sz },
      });
    }
    return out.sort((x, y) => x.trade.time - y.trade.time);
  }

  /** Fill-shaped trades with book-derived startPositions, classified.
   * `skip`: tids that already have an action (walked, not classified). */
  private classify(
    address: string,
    burst: Array<{ trade: HlWsTrade; book: BookTrade; side: "A" | "B" }>,
    skip: Set<bigint> = new Set(),
  ): ActionDraft[] {
    const starts = this.accounts.book(address).startPositions(burst.map((t) => t.book));
    if (!starts) throw new Error(`No position state for ${address}`);
    const fills: HlUserFill[] = burst
      .filter((t) => !skip.has(t.book.tid))
      .map(({ trade, book, side }) => ({
        coin: trade.coin,
        px: trade.px,
        sz: trade.sz,
        side,
        time: trade.time,
        startPosition: fromScaled(starts.get(book.tid)!),
        dir: FEED_FILL_DIR,
        closedPnl: "0",
        hash: trade.hash,
        oid: 0,
        crossed: false,
        fee: "0",
        tid: trade.tid,
      }));
    return classifyFills(address, fills, (coin) => this.accounts.leverageFor(address, coin));
  }
}
