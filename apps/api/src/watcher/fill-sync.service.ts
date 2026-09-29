import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { actions, CHAIN_DEFAULT, fills } from "@trading-dashboard/shared";
import { and, eq, gte, sql } from "drizzle-orm";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { HyperliquidInfoClient, twapSliceToFill } from "../hyperliquid/hyperliquid-info.client.js";
import type { RequestPriority } from "../hyperliquid/request-budgeter.service.js";
import type { HlUserFill } from "../hyperliquid/types.js";
import { AccountStateService, dexOf } from "./account-state.service.js";
import { classifyFills, isOutOfScopeSpotFill } from "./action-classifier.js";
import {
  actionsCovering,
  chunks,
  draftToRow,
  emitRecent,
  insertActions,
  storedFills,
  withActionLock,
  type ActionRow,
  type DbOrTx,
} from "./action-store.js";
import { toFillRow } from "./fill-row.js";

/** Hyperliquid's per-call cap on `userFillsByTime` (and TWAP slice) rows. */
export const PAGE_SIZE = 2000;
/** Only the latest 10,000 fills exist, so 5 full pages cover everything;
 * one spare page absorbs the overlap between pages. */
const MAX_PAGES = 6;
/** An address that used a TWAP this recently gets its slices read by the
 * hourly sweep too. */
export const TWAP_ACTIVE_MS = 48 * 3_600_000;

/** Reads time-ascending pages from `startTime` until a short page. */
async function readPages(
  startTime: number,
  fetchPage: (start: number) => Promise<HlUserFill[]>,
  onPage: (batch: HlUserFill[]) => Promise<void>,
): Promise<void> {
  let start = Math.max(0, startTime);
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await fetchPage(start);
    await onPage(batch);
    if (batch.length < PAGE_SIZE) break;
    const last = batch[batch.length - 1].time;
    // Next page starts at the last timestamp, inclusive: fills sharing
    // that millisecond may straddle the page boundary. Dedupe absorbs it.
    start = last > start ? last : last + 1;
  }
}
/** A live sync reuses account state younger than this (equity for R1/R3),
 * unless the action opened a position the cached state doesn't have yet. */
const ACCOUNT_REUSE_MS = 10_000;

/**
 * - `confirm`: after the fast path alerted on feed trades, store their fills
 *   and check its actions (background lane).
 * - `live`: store an address's fills at live priority and alert on them
 *   (the pre-fast-path route; kept for callers that need it).
 * - `sweep`: the hourly safety net, and catch-up after a feed outage.
 * - `reconcile`: a 5-minute snapshot showed a position change with no fill.
 * - `backfill`: A5, full history of a newly added address.
 */
export type SyncReason = "confirm" | "live" | "sweep" | "reconcile" | "backfill";

/** How often the fast path's actions matched their real fills. */
export interface FastPathStats {
  /** Fast-path actions whose fills are all stored and were re-derived. */
  verified: number;
  /** Of those, how many had the wrong kind or side and were corrected. */
  corrected: number;
}

export interface SyncResult {
  fetched: number;
  inserted: number;
  actions: number;
  /** Expected tids (from the trade feed) that Hyperliquid didn't return. */
  missingTids: bigint[];
  /** Newest fill time returned (stored or not), or null if none. */
  latestFillTime: number | null;
}

/**
 * Pulls an address's fills from `startTime` to now into `fills`, and turns
 * the ones that were not already stored into `actions`.
 *
 * Windows overlap on purpose (every caller starts a little before the time it
 * cares about): insert-with-returning makes the overlap free, since only rows
 * that were actually inserted get classified. That is what makes fills
 * exactly-once regardless of clock skew or which path saw them first.
 *
 * Syncs of one address run one at a time (except backfill, which only
 * touches history and runs alongside), so two overlapping windows never race
 * to classify the same burst.
 */
@Injectable()
export class FillSyncService {
  private readonly logger = new Logger(FillSyncService.name);
  private readonly chains = new Map<string, Promise<unknown>>();
  private lastFillAt: Date | null = null;
  private readonly fastPath: FastPathStats = { verified: 0, corrected: 0 };
  /** When a sync last found TWAP slice fills for each address. */
  private readonly twapSeenAt = new Map<string, number>();

  constructor(
    private readonly info: HyperliquidInfoClient,
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly accounts: AccountStateService,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  getLastFillAt(): Date | null {
    return this.lastFillAt;
  }

  getFastPathStats(): FastPathStats {
    return { ...this.fastPath };
  }

  /** `rank` orders this address's requests within its budget lane (lower
   * first); see `RequestBudgeterService.acquire`. */
  sync(
    address: string,
    reason: SyncReason,
    startTime: number,
    expectTids: Iterable<bigint> = [],
    rank?: number,
  ): Promise<SyncResult> {
    if (reason === "backfill") return this.run(address, reason, startTime, expectTids, rank);
    const previous = this.chains.get(address) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.run(address, reason, startTime, expectTids, rank));
    this.chains.set(address, next);
    // `.finally()` returns a promise that rejects when `next` does; the
    // caller handles `next`, so swallow this copy or Node exits on an
    // unhandled rejection.
    next
      .finally(() => {
        if (this.chains.get(address) === next) this.chains.delete(address);
      })
      .catch(() => undefined);
    return next;
  }

  private async run(
    address: string,
    reason: SyncReason,
    startTime: number,
    expectTids: Iterable<bigint>,
    rank?: number,
  ): Promise<SyncResult> {
    const priority: RequestPriority = reason === "live" ? "live" : "background";
    const expected = [...expectTids];
    const fetchedTids = new Set<bigint>();
    let latestFillTime: number | null = null;
    const newFills: HlUserFill[] = [];
    let fetched = 0;
    const take = async (batch: HlUserFill[]) => {
      fetched += batch.length;
      for (const f of batch) {
        fetchedTids.add(BigInt(f.tid));
        if (latestFillTime === null || f.time > latestFillTime) latestFillTime = f.time;
      }
      newFills.push(...(await this.store(address, batch)));
    };

    await readPages(startTime, (start) => this.info.userFillsByTime(address, start, undefined, priority, rank), take);

    // TWAP slice fills are only in their own endpoint. Read it when the
    // feed saw trades userFillsByTime didn't return, and on the paths that
    // must be complete without the feed's help.
    let missingTids = expected.filter((tid) => !fetchedTids.has(tid));
    if (missingTids.length > 0 || (await this.wantsTwapSlices(address, reason).catch(() => true))) {
      let slices = 0;
      try {
        await readPages(
          startTime,
          async (start) =>
            (await this.info.userTwapSliceFillsByTime(address, start, undefined, priority, rank)).map(twapSliceToFill),
          async (batch) => {
            slices += batch.length;
            await take(batch);
          },
        );
      } catch (error) {
        // The fills stored so far still become actions below (they are
        // stored now, so no later sync would see them as new); what is
        // still missing is looked for again by the caller's retry.
        this.logger.warn(`TWAP slice fills for ${address} failed: ${(error as Error).message}`);
      }
      if (slices > 0) this.twapSeenAt.set(address, Date.now());
      missingTids = expected.filter((tid) => !fetchedTids.has(tid));
    }

    const created = newFills.length > 0 ? await this.createActions(address, reason, newFills, rank) : 0;
    return { fetched, inserted: newFills.length, actions: created, missingTids, latestFillTime };
  }

  /**
   * Without expected tids, whether a sync should also read TWAP slices:
   * always for backfill (history) and reconcile (a position moved with no
   * fill, which is what a TWAP looks like to userFillsByTime); for the
   * hourly sweep only when the address used a TWAP in the last two days,
   * since slices cost a second request per address. The feed plus the
   * 5-minute reconcile cover an address's first TWAP.
   */
  private async wantsTwapSlices(address: string, reason: SyncReason): Promise<boolean> {
    if (reason === "backfill" || reason === "reconcile") return true;
    if (reason !== "sweep") return false;
    const cutoff = Date.now() - TWAP_ACTIVE_MS;
    if ((this.twapSeenAt.get(address) ?? 0) >= cutoff) return true;
    const [row] = await this.db
      .select({ ts: fills.ts })
      .from(fills)
      .where(
        and(
          eq(fills.chain, CHAIN_DEFAULT),
          eq(fills.address, address),
          gte(fills.ts, new Date(cutoff)),
          sql`${fills.raw}->>'twapId' is not null`,
        ),
      )
      .limit(1);
    if (row) this.twapSeenAt.set(address, row.ts.getTime());
    return row !== undefined;
  }

  /** Inserts perp fills, returning only those that weren't stored yet. */
  private async store(address: string, batch: HlUserFill[]): Promise<HlUserFill[]> {
    const perps = batch.filter((f) => !isOutOfScopeSpotFill(f));
    if (perps.length === 0) return [];
    const insertedTids = new Set<bigint>();
    for (const chunk of chunks(perps)) {
      const inserted = await this.db
        .insert(fills)
        .values(chunk.map((f) => toFillRow(address, f)))
        .onConflictDoNothing()
        .returning({ tid: fills.tid });
      for (const r of inserted) insertedTids.add(r.tid);
    }
    const fresh = perps.filter((f) => insertedTids.has(BigInt(f.tid)));
    if (fresh.length > 0) {
      this.accounts.noteCoins(address, fresh.map((f) => f.coin));
      const latest = new Date(Math.max(...fresh.map((f) => f.time)));
      if (!this.lastFillAt || latest > this.lastFillAt) this.lastFillAt = latest;
    }
    return fresh;
  }

  private needsAccountRefresh(address: string, newFills: HlUserFill[], drafts: { kind: string; leverage: string | null }[]): boolean {
    const cached = this.accounts.get(address);
    if (!cached || Date.now() - cached.fetchedAt.getTime() > ACCOUNT_REUSE_MS) return true;
    if (newFills.some((f) => !cached.byDex.has(dexOf(f.coin)))) return true;
    return drafts.some((d) => (d.kind === "open" || d.kind === "flip") && d.leverage === null);
  }

  /**
   * Fresh fills → actions. A fill the fast path already made an action for
   * (its tid is in one of the address's `fill_ids`) gets no second one; once
   * all of such an action's fills are stored, it is re-derived from them and
   * corrected in place, without an alert, if the fast path got it wrong.
   * Fills no action covers (the feed missed them) become actions as before.
   */
  private async createActions(address: string, reason: SyncReason, newFills: HlUserFill[], rank?: number): Promise<number> {
    const leverage = (coin: string) => this.accounts.leverageFor(address, coin);
    if (reason === "live" && this.needsAccountRefresh(address, newFills, classifyFills(address, newFills, leverage))) {
      // Positions and equity as of right after these fills: R1/R3 compare
      // against equity, and the action records the position's leverage.
      try {
        await this.accounts.refresh(address, "live", new Set(newFills.map((f) => dexOf(f.coin))), rank);
      } catch (error) {
        this.logger.warn(`Account refresh failed for ${address}: ${(error as Error).message}`);
      }
    }

    const rows = await withActionLock(this.db, address, async (tx) => {
      const tids = newFills.map((f) => BigInt(f.tid));
      const covering = await actionsCovering(tx, address, tids, Math.min(...newFills.map((f) => f.time)));
      const covered = new Set(covering.flatMap((a) => a.fillIds));
      const drafts = classifyFills(
        address,
        newFills.filter((f) => !covered.has(BigInt(f.tid))),
        leverage,
      );
      for (const action of covering) await this.verify(tx, address, action);
      return drafts.length > 0 ? insertActions(tx, address, drafts) : [];
    });

    // Backfill is history: stored for analytics, never alerted on.
    if (reason !== "backfill") emitRecent(this.events, rows);
    return rows.length;
  }

  /** Re-derives a fast-path action from its real fills once all are stored,
   * and corrects kind/side (a liquidation, or a book that was off) in place.
   * No event: the alert already went out, and a second one would read as a
   * new trade. */
  private async verify(tx: DbOrTx, address: string, action: ActionRow): Promise<void> {
    const real = await storedFills(tx, address, action.fillIds);
    if (real.length < action.fillIds.length) return; // the rest come in a later sync
    const drafts = classifyFills(address, real);
    if (drafts.length === 0) return;
    this.fastPath.verified += 1;
    const [first, ...rest] = drafts;
    if (rest.length === 0 && first.kind === action.kind && first.side === action.side) return;

    this.fastPath.corrected += 1;
    const { leverage: _leverage, ...shape } = draftToRow(address, first);
    await tx.update(actions).set(shape).where(eq(actions.id, action.id));
    // Real fills can split what the feed saw as one action (a liquidation
    // among them); the other parts are stored, not alerted on.
    if (rest.length > 0) await insertActions(tx, address, rest.map((d) => ({ ...d, leverage: action.leverage })));
    this.logger.warn(
      `Fast path corrected action ${action.id} (${address} ${action.coin}): ${action.kind} ${action.side} → ` +
        `${drafts.map((d) => `${d.kind} ${d.side}`).join(" + ")} (${this.fastPath.corrected} of ${this.fastPath.verified} checked)`,
    );
  }
}
