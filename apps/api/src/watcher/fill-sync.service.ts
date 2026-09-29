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
/** Postgres caps one statement at 65,535 bind parameters (a fills row has
 * 13, an actions row 10); a high-frequency address can produce thousands of
 * rows in one sync, so inserts go in chunks. */
const INSERT_CHUNK_ROWS = 1000;
/** A live sync reuses account state younger than this (equity for R1/R3),
 * unless the action opened a position the cached state doesn't have yet. */
const ACCOUNT_REUSE_MS = 10_000;

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_ROWS) out.push(rows.slice(i, i + INSERT_CHUNK_ROWS));
  return out;
}

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

  constructor(
    private readonly info: HyperliquidInfoClient,
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly accounts: AccountStateService,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  getLastFillAt(): Date | null {
    return this.lastFillAt;
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
    const fetchedTids = new Set<bigint>();
    const fetchedTimes = new Set<number>();
    const newFills: HlUserFill[] = [];
    let fetched = 0;
    let start = Math.max(0, startTime);

    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await this.info.userFillsByTime(address, start, undefined, priority, rank);
      fetched += batch.length;
      for (const f of batch) {
        fetchedTids.add(BigInt(f.tid));
        fetchedTimes.add(f.time);
      }
      newFills.push(...(await this.store(address, batch)));
      if (batch.length < PAGE_SIZE) break;
      const last = batch[batch.length - 1].time;
      // Next page starts at the last timestamp, inclusive: fills sharing
      // that millisecond may straddle the page boundary. Dedupe absorbs it.
      start = last > start ? last : last + 1;
    }

    const missingTids = [...expectTids].filter((tid) => !fetchedTids.has(tid));
    const created = newFills.length > 0 ? await this.createActions(address, reason, newFills, rank) : 0;
    let latestFillTime: number | null = null;
    for (const time of fetchedTimes) if (latestFillTime === null || time > latestFillTime) latestFillTime = time;
    return { fetched, inserted: newFills.length, actions: created, missingTids, latestFillTime };
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

  private async createActions(address: string, reason: SyncReason, newFills: HlUserFill[], rank?: number): Promise<number> {
    const leverage = (coin: string) => this.accounts.leverageFor(address, coin);
    let drafts = classifyFills(address, newFills, leverage);
    if (reason === "live" && this.needsAccountRefresh(address, newFills, drafts)) {
      // Positions and equity as of right after these fills: R1/R3 compare
      // against equity, and the action records the position's leverage.
      try {
        await this.accounts.refresh(address, "live", new Set(newFills.map((f) => dexOf(f.coin))), rank);
        drafts = classifyFills(address, newFills, leverage);
      } catch (error) {
        this.logger.warn(`Account refresh failed for ${address}: ${(error as Error).message}`);
      }
    }
    if (drafts.length === 0) return 0;

    const rows: (typeof actions.$inferSelect)[] = [];
    for (const chunk of chunks(drafts)) {
      rows.push(
        ...(await this.db
          .insert(actions)
          .values(
            chunk.map((d) => ({
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
          .returning()),
      );
    }

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
