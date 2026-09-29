import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { actions, CHAIN_DEFAULT, fills } from "@trading-dashboard/shared";

import { env } from "../config/env.js";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import type { RequestPriority } from "../hyperliquid/request-budgeter.service.js";
import type { HlUserFill } from "../hyperliquid/types.js";
import { AccountStateService, dexOf } from "./account-state.service.js";
import { classifyFills, isOutOfScopeSpotFill } from "./action-classifier.js";
import { ACTION_CREATED_EVENT } from "./action-created.event.js";
import { toFillRow } from "./fill-row.js";

/** Hyperliquid's per-call cap on `userFillsByTime` rows. */
export const PAGE_SIZE = 2000;
/** Only the latest 10,000 fills exist, so 5 full pages cover everything;
 * one spare page absorbs the overlap between pages. */
const MAX_PAGES = 6;

/**
 * - `live`: an address just traded (seen on the `trades` feed).
 * - `sweep`: the hourly safety net, and catch-up after a feed outage.
 * - `reconcile`: a 5-minute snapshot showed a position change with no fill.
 * - `backfill`: A5, full history of a newly added address.
 */
export type SyncReason = "live" | "sweep" | "reconcile" | "backfill";

export interface SyncResult {
  fetched: number;
  inserted: number;
  actions: number;
  /** Expected tids (from the trade feed) that Hyperliquid didn't return. */
  missingTids: bigint[];
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

  constructor(
    private readonly info: HyperliquidInfoClient,
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly accounts: AccountStateService,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  getLastFillAt(): Date | null {
    return this.lastFillAt;
  }

  sync(
    address: string,
    reason: SyncReason,
    startTime: number,
    expectTids: Iterable<bigint> = [],
  ): Promise<SyncResult> {
    if (reason === "backfill") return this.run(address, reason, startTime, expectTids);
    const previous = this.chains.get(address) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.run(address, reason, startTime, expectTids));
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
  ): Promise<SyncResult> {
    const priority: RequestPriority = reason === "live" ? "live" : "background";
    const fetchedTids = new Set<bigint>();
    const newFills: HlUserFill[] = [];
    let fetched = 0;
    let start = Math.max(0, startTime);

    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await this.info.userFillsByTime(address, start, undefined, priority);
      fetched += batch.length;
      for (const f of batch) fetchedTids.add(BigInt(f.tid));
      newFills.push(...(await this.store(address, batch)));
      if (batch.length < PAGE_SIZE) break;
      const last = batch[batch.length - 1].time;
      // Next page starts at the last timestamp, inclusive: fills sharing
      // that millisecond may straddle the page boundary. Dedupe absorbs it.
      start = last > start ? last : last + 1;
    }

    const missingTids = [...expectTids].filter((tid) => !fetchedTids.has(tid));
    const created = newFills.length > 0 ? await this.createActions(address, reason, newFills) : 0;
    return { fetched, inserted: newFills.length, actions: created, missingTids };
  }

  /** Inserts perp fills, returning only those that weren't stored yet. */
  private async store(address: string, batch: HlUserFill[]): Promise<HlUserFill[]> {
    const perps = batch.filter((f) => !isOutOfScopeSpotFill(f));
    if (perps.length === 0) return [];
    const inserted = await this.db
      .insert(fills)
      .values(perps.map((f) => toFillRow(address, f)))
      .onConflictDoNothing()
      .returning({ tid: fills.tid });
    const insertedTids = new Set(inserted.map((r) => r.tid));
    const fresh = perps.filter((f) => insertedTids.has(BigInt(f.tid)));
    if (fresh.length > 0) {
      this.accounts.noteCoins(address, fresh.map((f) => f.coin));
      const latest = new Date(Math.max(...fresh.map((f) => f.time)));
      if (!this.lastFillAt || latest > this.lastFillAt) this.lastFillAt = latest;
    }
    return fresh;
  }

  private async createActions(address: string, reason: SyncReason, newFills: HlUserFill[]): Promise<number> {
    if (reason === "live") {
      // Fresh positions and equity before the rules see the action: R1/R3
      // compare against equity, and the action records leverage.
      try {
        await this.accounts.refresh(address, "live", new Set(newFills.map((f) => dexOf(f.coin))));
      } catch (error) {
        this.logger.warn(`Account refresh failed for ${address}: ${(error as Error).message}`);
      }
    }

    const drafts = classifyFills(address, newFills, (coin) => this.accounts.leverageFor(address, coin));
    if (drafts.length === 0) return 0;

    const rows = await this.db
      .insert(actions)
      .values(
        drafts.map((d) => ({
          chain: CHAIN_DEFAULT,
          address,
          coin: d.coin,
          kind: d.kind,
          side: d.side,
          notionalUsd: d.notionalUsd,
          avgPx: d.avgPx,
          leverage: d.leverage,
          fillIds: d.fillIds,
          ts: d.ts,
        })),
      )
      .returning();

    // History (backfill) and anything older than the alert horizon is stored
    // for analytics but never alerted on: a notification about a trade from
    // an hour ago would read as if it just happened.
    if (reason !== "backfill") {
      const horizon = Date.now() - env.alertMaxActionAgeSeconds() * 1000;
      for (const row of rows) {
        if (row.ts.getTime() >= horizon) this.events?.emit(ACTION_CREATED_EVENT, row);
      }
    }
    return rows.length;
  }
}
