import { Injectable, Logger, Optional } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";

import { AppConfig } from "../config/app-config.js";
import { UnitOfWork, type DbTransaction } from "../db/unit-of-work.js";
import { HyperliquidInfoClient, twapSliceToFill } from "../hyperliquid/hyperliquid-info.client.js";
import type { RequestPriority } from "../hyperliquid/request-budgeter.service.js";
import type { HlUserFill } from "../hyperliquid/types.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { AccountStateService, dexOf } from "./account-state.service.js";
import { classifyFills, isOutOfScopeSpotFill } from "./action-classifier.js";
import { positionBreaks } from "../analytics/fill-integrity.js";
import { ACTION_CORRECTED_EVENT, type ActionCorrectedEvent } from "./action-created.event.js";
import { emitRecent } from "./action-store.js";
import { FillSyncRepository, type ActionRow, type FillCoverageBreak } from "./fill-sync.repository.js";

/** Hyperliquid's per-call cap on `userFillsByTime` (and TWAP slice) rows. */
export const PAGE_SIZE = 2000;
/** Only the latest 10,000 fills exist, so 5 full pages cover everything;
 * one spare page absorbs the overlap between pages. */
const MAX_PAGES = 6;
/** An address that used a TWAP this recently gets its slices read by the
 * hourly sweep too. */
export const TWAP_ACTIVE_MS = 48 * 3_600_000;

/** An address with no verified span yet starts this far back (what the
 * start-up sweep used to re-read for everyone). */
export const INITIAL_LOOKBACK_MS = 75 * 60_000;
/** A completed read certifies fills only up to this long before it was
 * sent: the fill index trails the exchange by seconds (p90 1.5 s). */
export const INDEX_LAG_MS = 60_000;
/** Backward backfill stops at this age (analytics read a year), where
 * REST's retention starts, or once the span holds this many fills. The
 * cap bounds a market maker's storage, not the sample: at 50,000 it
 * stopped a 10,000-fills-a-day address after a week while REST still held
 * three more (audit A2); the span is read in pages (`storedFillPages`), so
 * its size is not bounded by memory. The calls are paced by the backfill's
 * budget cap (`HYPERLIQUID_BACKFILL_WEIGHT_PER_MIN`). */
export const BACKFILL_LOOKBACK_MS = 365 * 86_400_000;
export const BACKFILL_MAX_FILLS = 500_000;
/** Most pages per endpoint in one backward window or targeted re-read.
 * Windows aim at a page and a half; the headroom lets a busier one finish
 * instead of being read for nothing. */
export const BACKFILL_STEP_PAGES = 12;
const MIN_SPAN_MS = 60_000;
const MAX_SPAN_MS = 30 * 86_400_000;
/** Position breaks re-read per continuity check. */
const MAX_REPAIRS_PER_CHECK = 25;
/** Emitted when history inside an address's verified span changed. */
export const FILLS_REVISED_EVENT = "fills.revised";

interface RangeRead {
  fills: HlUserFill[];
  /** A short page ended the read: everything in the range was returned. */
  complete: boolean;
  /** When not complete, the last millisecond the pages hold in full. */
  through: number;
  /** Milliseconds that alone held a whole page: the first PAGE_SIZE fills
   * of each were returned, the rest cannot be read through this API. */
  dense: number[];
}

/** The earliest fill an endpoint returns, and whether that can be where its
 * retained history was cut off. Hyperliquid keeps an address's most recent
 * 10,000 fills per endpoint. `bounded` is false when the read from the
 * beginning came back short (the endpoint returned everything it has: fewer
 * fills than one page, far fewer than are retained) and, for ordinary
 * fills, the first one starts from a flat position: nothing older was
 * dropped, and that first fill is no limit on the span. */
interface RetentionProbe { time: number; bounded: boolean }

/** What bounds the verified span from below: the latest first fill among
 * the endpoints whose history may have been cut (review 45). An endpoint
 * that is not bounded says nothing: an account whose first TWAP was last
 * week still has its year of ordinary fills backfilled. */
export function retainedFrom(probe: { regular: RetentionProbe | null; twap: RetentionProbe | null }): number {
  return Math.max(probe.regular?.bounded ? probe.regular.time : 0, probe.twap?.bounded ? probe.twap.time : 0);
}

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
 *   and check its actions (background lane; live for a copied leader, see
 *   `FillSyncService.lane`).
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

export interface CatchUpResult {
  inserted: number;
  actions: number;
  /** False when the read stopped at the page cap: call again. */
  complete: boolean;
  /** The verified span's end after this read. */
  through: number;
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
 * fills not already covered by actions into `actions`.
 *
 * Windows overlap on purpose (every caller starts a little before the time it
 * cares about): the fill primary key dedupes raw data, and the
 * address action lock dedupes derived actions. Replaying a window also
 * repairs action creation interrupted after raw fills were committed.
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
  private backfilling = false;
  /** Coverage capped under an earlier, smaller cap was re-opened (`backfillTick`). */
  private reopened = false;
  /** Each endpoint's retention start, read when this process began an address's backfill. */
  private readonly retention = new Map<string, { regular: RetentionProbe | null; twap: RetentionProbe | null }>();

  constructor(
    private readonly config: AppConfig,
    private readonly info: HyperliquidInfoClient,
    private readonly repository: FillSyncRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly accounts: AccountStateService,
    @Optional() private readonly events?: EventEmitter2,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
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
    if (this.jobs.stopping) return Promise.reject(new Error("Shutting down"));
    if (reason === "backfill") return this.jobs.run(() => this.run(address, reason, startTime, expectTids, rank));
    return this.chained(address, () => this.run(address, reason, startTime, expectTids, rank));
  }

  /**
   * The budget lane and rank of one read in an address's sync chain.
   *
   * Stored fills of a copied leader are copy signals, and an open older
   * than the risk policy's maxSignalAgeSeconds (120 s) is refused as
   * `stale_signal`. In the background lane a confirm queues, unranked,
   * behind every pool, cohort, sweep and backfill call waiting for its
   * worst-case weight (2026-10-01 19:51Z: a copied leader's ZEC fills were
   * stored 157 s late and three opens were rejected). So every read in a
   * copied leader's chain goes in the live lane: the confirm, and the
   * sweep, reconcile and continuity reads the confirm would otherwise wait
   * behind (one sync per address at a time). They rank by arrival time,
   * after the watcher's fast-path calls, which rank by an earlier time.
   * History backfill stays in the background lane.
   */
  private async lane(address: string, reason: SyncReason, rank?: number): Promise<{ priority: RequestPriority; rank: number | undefined }> {
    if (reason === "live") return { priority: "live", rank };
    if (reason !== "backfill" && (await this.repository.isCopied(address))) return { priority: "live", rank: Date.now() };
    return { priority: "background", rank };
  }

  private chained<T>(address: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(address) ?? Promise.resolve();
    const next = this.jobs.run(() => previous.catch(() => undefined).then(work));
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

  // --- verified coverage -------------------------------------------------------

  coverage(address: string) {
    return this.repository.coverage(address);
  }

  /**
   * Time-ascending pages of one endpoint from `start`. A page is read from
   * the last fill's millisecond inclusive, so a millisecond that alone
   * holds a whole page returns the same page again and cannot be paged
   * through. Backward backfill stops there (`blocked`). With `passDense`
   * (the forward cursor) the read steps over that millisecond instead: its
   * first PAGE_SIZE fills are kept, it is listed in `dense`, and the cursor
   * goes on, where before it stayed on that millisecond for ever and every
   * sweep re-read the same page (review 45).
   */
  private async readRange(address: string, twap: boolean, start: number, end: number | undefined, maxPages: number, rank?: number, priority: RequestPriority = "background", passDense = false): Promise<RangeRead> {
    const byTid = new Map<number, HlUserFill>();
    const dense: number[] = [];
    let cursor = Math.max(0, Math.floor(start));
    for (let page = 0; page < maxPages; page++) {
      const batch = twap
        ? (await this.info.userTwapSliceFillsByTime(address, cursor, end, priority, rank)).map(twapSliceToFill)
        : await this.info.userFillsByTime(address, cursor, end, priority, rank);
      for (const fill of batch) byTid.set(fill.tid, fill);
      if (batch.length < PAGE_SIZE) return { fills: [...byTid.values()], complete: true, through: end ?? Infinity, dense };
      const last = batch.reduce((max, fill) => Math.max(max, fill.time), cursor);
      if (last <= cursor) {
        // A millisecond holding a whole page cannot be paged through.
        if (!passDense) break;
        dense.push(cursor);
        cursor += 1;
        continue;
      }
      cursor = last;
    }
    return { fills: [...byTid.values()], complete: false, through: cursor - 1, dense };
  }

  private async ingest(address: string, reason: SyncReason, batch: HlUserFill[], rank?: number): Promise<{ inserted: number; actions: number }> {
    const fresh = await this.store(address, batch);
    const candidates = [...new Map(batch.filter((f) => !isOutOfScopeSpotFill(f)).map((f) => [BigInt(f.tid), f])).values()];
    const actions = candidates.length > 0 ? await this.createActions(address, reason, candidates, new Set(fresh.map((f) => BigInt(f.tid))), rank) : 0;
    return { inserted: fresh.length, actions };
  }

  private async failed(address: string): Promise<void> {
    await this.repository.patchCoverage(address, { lastError: "upstream_unavailable", failedAt: new Date() }).catch(() => undefined);
  }

  /**
   * Reads both fill endpoints from the address's verified cursor (not from
   * a fixed window) and moves the cursor only over what a completed read
   * returned. A failure, a restart or any length of downtime leaves the
   * cursor where it was, so the next call resumes there and no fill is
   * skipped. Runs in the address's sync chain.
   */
  catchUp(address: string, callerRank?: number): Promise<CatchUpResult> {
    if (this.jobs.stopping) return Promise.reject(new Error("Shutting down"));
    return this.chained(address, async () => {
      const { priority, rank } = await this.lane(address, "sweep", callerRank);
      const state = await this.repository.coverage(address);
      const requestedAt = Date.now();
      const start = state?.verifiedThrough?.getTime() ?? requestedAt - INITIAL_LOOKBACK_MS;
      let regular: RangeRead;
      let twap: RangeRead;
      try {
        regular = await this.readRange(address, false, start, undefined, MAX_PAGES, rank, priority, true);
        twap = await this.readRange(address, true, start, undefined, MAX_PAGES, rank, priority, true);
      } catch (error) {
        await this.failed(address);
        throw error;
      }
      const dense = [...regular.dense, ...twap.dense];
      if (dense.length > 0) {
        // Not silent: the fills past the first page of that millisecond are
        // not stored. The continuity check below records the position break
        // they leave, if any, as unexplained.
        this.logger.warn(`${address}: ${dense.length} millisecond(s) hold more than ${PAGE_SIZE} fills (${dense.map((t) => new Date(t).toISOString()).join(", ")}); the cursor moved past them`);
      }
      if (twap.fills.length > 0) this.twapSeenAt.set(address, Date.now());
      const stored = await this.ingest(address, "sweep", [...regular.fills, ...twap.fills], rank);
      const horizon = requestedAt - INDEX_LAG_MS;
      const through = Math.min(regular.complete ? horizon : regular.through, twap.complete ? horizon : twap.through);
      if (through > start) {
        await this.repository.extend(address, true, start, through, requestedAt - BACKFILL_LOOKBACK_MS);
        if (dense.length > 0) await this.repository.patchCoverage(address, { lastError: "dense_millisecond" }).catch(() => undefined);
        await this.checkContinuity(address, false, rank, priority).catch((error: Error) => this.logger.warn(`Continuity check for ${address} failed: ${error.message}`));
      }
      return { ...stored, complete: regular.complete && twap.complete, through: Math.max(through, start) };
    });
  }

  /**
   * One backward window: every fill of both endpoints in `[verified_from −
   * span, verified_from]`, stored, then the span's start moves back. The
   * window is sized from the density just read; one too dense for a step
   * is retried shorter and stores nothing, so the span never has a hole.
   */
  async backfillStep(address: string, rank?: number, maxFills = BACKFILL_MAX_FILLS): Promise<{ status: string; inserted: number }> {
    let state = await this.repository.coverage(address);
    if (!state?.verifiedFrom) {
      await this.catchUp(address, rank);
      state = await this.repository.coverage(address);
    }
    if (!state?.verifiedFrom) throw new Error("No verified span");
    if (state.backfillStatus !== "pending") return { status: state.backfillStatus, inserted: 0 };
    const end = state.verifiedFrom.getTime();
    let floor = state.backfillFloor.getTime();
    // REST keeps a moving window of history, per endpoint. Nothing before
    // its start can be verified, so the span never claims it.
    let probe = this.retention.get(address);
    if (!probe) {
      probe = await this.retentionStart(address, rank);
      const retained = retainedFrom(probe);
      if (retained > floor) {
        floor = Math.min(retained, end);
        await this.repository.patchCoverage(address, { backfillFloor: new Date(floor) });
      }
      this.retention.set(address, probe);
    }
    const finish = async (status: "complete" | "capped" | "blocked") => {
      // Retention only moves forward: a window read earlier is certain
      // only if each endpoint's history still reaches the span's start now.
      // One narrow read per endpoint answers that; the full probe is
      // repeated only when one no longer does.
      this.retention.delete(address);
      const spanFrom = (await this.repository.coverage(address))?.verifiedFrom?.getTime() ?? end;
      // An endpoint that was not bounded returned its whole history: there is nothing to re-check.
      const reaches = async (twap: boolean, first: RetentionProbe | null) => !first?.bounded || (await this.earliestFill(address, twap, spanFrom, rank)) !== null;
      let retained = 0;
      if (status !== "blocked" && !((await reaches(false, probe.regular)) && (await reaches(true, probe.twap)))) {
        retained = retainedFrom(await this.retentionStart(address, rank));
      }
      const from = Math.max(retained, spanFrom);
      // Stopped short of the one-year floor because REST holds nothing older.
      const reached = retained > spanFrom || (status === "complete" && from > Date.now() - BACKFILL_LOOKBACK_MS + 86_400_000) ? "retention" : status;
      await this.repository.patchCoverage(address, { verifiedFrom: new Date(from), backfillStatus: reached, revisedAt: new Date() });
      await this.checkContinuity(address, true, rank).catch((error: Error) => this.logger.warn(`Continuity check for ${address} failed: ${error.message}`));
      this.events?.emit(FILLS_REVISED_EVENT, { address });
      return { status: reached, inserted: 0 };
    };
    if (end <= floor) return finish("complete");
    if ((await this.repository.countFillsSince(address, state.verifiedFrom)) >= maxFills) return finish("capped");

    const span = state.backfillSpanMs;
    const start = Math.max(floor, end - span);
    let regular: RangeRead;
    let twap: RangeRead;
    try {
      regular = await this.readRange(address, false, start, end, BACKFILL_STEP_PAGES, rank);
      twap = await this.readRange(address, true, start, end, BACKFILL_STEP_PAGES, rank);
    } catch (error) {
      await this.failed(address);
      throw error;
    }
    if (!regular.complete || !twap.complete) {
      if (span <= MIN_SPAN_MS) return finish("blocked");
      const held = Math.min(regular.complete ? end : regular.through, twap.complete ? end : twap.through) - start;
      await this.repository.patchCoverage(address, { backfillSpanMs: Math.max(MIN_SPAN_MS, Math.min(Math.floor(span / 2), Math.floor(held * 0.75))) });
      return { status: "pending", inserted: 0 };
    }
    const fetched = [...regular.fills, ...twap.fills];
    const stored = await this.ingest(address, "backfill", fetched, rank);
    // An empty stretch is cheap to cross (two calls per window); a busy one
    // grows gently, since a window that overshoots the step is read for nothing.
    const next = fetched.length === 0 ? span * 8 : Math.min(span * 2, (span * 1.5 * PAGE_SIZE) / fetched.length);
    const done = start <= floor;
    await this.repository.extend(address, false, end, start, floor, {
      backfillSpanMs: Math.round(Math.max(MIN_SPAN_MS, Math.min(MAX_SPAN_MS, next))),
      revisedAt: new Date(),
    });
    if (done) return { ...(await finish("complete")), inserted: stored.inserted };
    return { status: "pending", inserted: stored.inserted };
  }

  /** The earliest fill an endpoint still returns up to `end`, read from
   * the beginning; null when it returns none. A full first page means the
   * endpoint has more than a page and its start may be where retention cut
   * it (`bounded`); a short one is the endpoint's whole history. */
  private async earliestFill(address: string, twap: boolean, end: number | undefined, rank?: number): Promise<RetentionProbe | null> {
    const batch = twap
      ? (await this.info.userTwapSliceFillsByTime(address, 0, end, "background", rank)).map(twapSliceToFill)
      : await this.info.userFillsByTime(address, 0, end, "background", rank);
    if (batch.length === 0) return null;
    const first = batch.reduce((min, fill) => (fill.time < min.time ? fill : min), batch[0]!);
    // An ordinary fill that starts mid-position has something before it that
    // this endpoint no longer returns. A TWAP slice often does (a TWAP out
    // of a position opened by ordinary orders), so there it proves nothing.
    const midPosition = !twap && first.startPosition !== undefined && Number(first.startPosition) !== 0;
    return { time: first.time, bounded: batch.length >= PAGE_SIZE || midPosition };
  }

  /** Where each endpoint's retained history starts for the address. REST
   * keeps a moving window per endpoint; {@link retainedFrom} turns the two
   * into the span's lower bound. */
  private async retentionStart(address: string, rank?: number): Promise<{ regular: RetentionProbe | null; twap: RetentionProbe | null }> {
    return { regular: await this.earliestFill(address, false, undefined, rank), twap: await this.earliestFill(address, true, undefined, rank) };
  }

  /** The scheduler's backfill turn: one window for the address that has waited longest. */
  async backfillTick(): Promise<string | undefined> {
    if (this.jobs.stopping || this.backfilling) return undefined;
    if (!this.reopened) {
      // Spans stopped at the old 50,000 cap carry on (once per process).
      const reopened = await this.repository.reopenCapped(BACKFILL_MAX_FILLS);
      this.reopened = true;
      if (reopened.length > 0) this.logger.log(`Backfill resumed under the ${BACKFILL_MAX_FILLS}-fill cap: ${reopened.join(", ")}`);
    }
    const address = await this.repository.nextBackfill();
    if (!address) return undefined;
    this.backfilling = true;
    try {
      await this.jobs.run(() => this.backfillStep(address));
    } finally {
      this.backfilling = false;
    }
    return address;
  }

  /**
   * The gap detector. Checks per-coin position continuity of the stored
   * fills in the verified span (new fills only, or the whole span when
   * `full`). Each break is a hole between two stored fills of a coin: both
   * endpoints are re-read for exactly that interval and what was missing
   * is stored. A break that a completed re-read does not close is recorded
   * as unexplained (upstream has no fill there) and not retried.
   */
  async checkContinuity(address: string, full = false, rank?: number, priority: RequestPriority = "background"): Promise<{ breaks: number; repaired: number; unexplained: number }> {
    const state = await this.repository.coverage(address);
    if (!state?.verifiedFrom || !state.verifiedThrough) return { breaks: 0, repaired: 0, unexplained: 0 };
    const from = full || !state.checkedThrough || state.checkedThrough < state.verifiedFrom ? state.verifiedFrom : state.checkedThrough;
    const known = new Set(state.breaks.map((b) => b.tid));
    // Page by page: a span is no longer bounded by a 50,000-fill backfill cap.
    const load = async () => {
      const breaks: ReturnType<typeof positionBreaks> = [];
      for await (const batch of this.repository.fillPagesForCheck(address, state.verifiedFrom!, from, state.verifiedThrough!)) breaks.push(...positionBreaks(batch));
      return breaks.filter((b) => !known.has(b.tid));
    };
    const found = await load();
    if (found.length === 0) {
      await this.repository.patchCoverage(address, { checkedThrough: state.verifiedThrough });
      return { breaks: 0, repaired: 0, unexplained: 0 };
    }
    let inserted = 0;
    const reread = new Set<number>();
    for (const hole of found.slice(0, MAX_REPAIRS_PER_CHECK)) {
      const regular = await this.readRange(address, false, hole.after, hole.time, BACKFILL_STEP_PAGES, rank, priority);
      const twap = await this.readRange(address, true, hole.after, hole.time, BACKFILL_STEP_PAGES, rank, priority);
      inserted += (await this.ingest(address, "backfill", [...regular.fills, ...twap.fills], rank)).inserted;
      reread.add(hole.tid);
    }
    const left = inserted > 0 ? await load() : found;
    const unexplained: FillCoverageBreak[] = left.filter((b) => reread.has(b.tid));
    const settled = left.length === unexplained.length;
    await this.repository.patchCoverage(address, {
      breaks: [...state.breaks, ...unexplained],
      ...(settled ? { checkedThrough: state.verifiedThrough } : {}),
      ...(inserted > 0 ? { revisedAt: new Date() } : {}),
    });
    this.logger.warn(`Continuity ${address}: ${found.length} break(s), ${inserted} missing fill(s) stored, ${unexplained.length} unexplained`);
    if (inserted > 0) this.events?.emit(FILLS_REVISED_EVENT, { address });
    return { breaks: found.length, repaired: found.length - left.length, unexplained: unexplained.length };
  }

  private async run(
    address: string,
    reason: SyncReason,
    startTime: number,
    expectTids: Iterable<bigint>,
    callerRank?: number,
  ): Promise<SyncResult> {
    const { priority, rank } = await this.lane(address, reason, callerRank);
    const expected = [...expectTids];
    const fetchedTids = new Set<bigint>();
    let latestFillTime: number | null = null;
    const newFills: HlUserFill[] = [];
    const candidates = new Map<bigint, HlUserFill>();
    let fetched = 0;
    const take = async (batch: HlUserFill[]) => {
      fetched += batch.length;
      for (const f of batch) {
        fetchedTids.add(BigInt(f.tid));
        if (latestFillTime === null || f.time > latestFillTime) latestFillTime = f.time;
        if (!isOutOfScopeSpotFill(f)) candidates.set(BigInt(f.tid), f);
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

    // Revisit returned fills even when they were already stored: a previous
    // sync may have failed after storing a page but before deriving actions.
    // The action lock and coverage check make replay idempotent.
    const candidateFills = [...candidates.values()];
    const created = candidateFills.length > 0 ? await this.createActions(address, reason, candidateFills, new Set(newFills.map((f) => BigInt(f.tid))), rank) : 0;
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
    const row = await this.repository.recentTwap(address, new Date(cutoff));
    if (row) this.twapSeenAt.set(address, row.ts.getTime());
    return row !== undefined;
  }

  /** Inserts perp fills, returning only those that weren't stored yet. */
  private async store(address: string, batch: HlUserFill[]): Promise<HlUserFill[]> {
    const perps = batch.filter((f) => !isOutOfScopeSpotFill(f));
    if (perps.length === 0) return [];
    const insertedTids = await this.repository.insertFills(address, perps);
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
  private async createActions(address: string, reason: SyncReason, newFills: HlUserFill[], freshTids: Set<bigint>, rank?: number): Promise<number> {
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

    const corrections: ActionCorrectedEvent = { updated: [], inserted: [] };
    const rows = await this.unitOfWork.run(async (tx) => {
      await this.repository.lock(tx, address);
      const tids = newFills.map((f) => BigInt(f.tid));
      const covering = await this.repository.covering(tx, address, tids, Math.min(...newFills.map((f) => f.time)));
      const covered = new Set(covering.flatMap((a) => a.fillIds));
      const drafts = classifyFills(
        address,
        newFills.filter((f) => !covered.has(BigInt(f.tid))),
        leverage,
      );
      // Replay may cover thousands of existing actions. Read their stored fills
      // once instead of holding the shared fast-path lock for N round trips.
      const realByTid = new Map((await this.repository.storedFills(tx, address, [...covered])).map((f) => [BigInt(f.tid), f]));
      for (const action of covering) {
        const real = action.fillIds.flatMap((tid) => {
          const fill = realByTid.get(tid);
          return fill ? [fill] : [];
        });
        await this.verify(tx, address, action, real, action.fillIds.some((tid) => freshTids.has(tid)), corrections);
      }
      return drafts.length > 0 ? this.repository.insertActions(tx, address, drafts, reason !== "backfill", this.accounts.getEquityUsd(address), this.config.value.alert.maxActionAgeSeconds) : [];
    });

    // Committed: pages showing a corrected row can fix it (never an alert).
    if (corrections.updated.length > 0 || corrections.inserted.length > 0) this.events?.emit(ACTION_CORRECTED_EVENT, corrections);
    // Backfill is history: stored for analytics, never alerted on.
    if (reason !== "backfill") emitRecent(this.events, rows, this.config.value.alert.maxActionAgeSeconds);
    return rows.length;
  }

  /** Re-derives a fast-path action from its real fills once all are stored,
   * and corrects kind/side (a liquidation, or a book that was off) in place.
   * No `action.created`: the alert already went out, and a second one would
   * read as a new trade. The changed rows are collected in `corrections`
   * for `action.corrected` once the transaction commits. */
  private async verify(
    tx: DbTransaction,
    address: string,
    action: ActionRow,
    real: HlUserFill[],
    hasFreshFill: boolean,
    corrections: ActionCorrectedEvent,
  ): Promise<void> {
    if (real.length < action.fillIds.length) return; // the rest come in a later sync
    const drafts = classifyFills(address, real);
    if (drafts.length === 0) return;
    const [first, ...rest] = drafts;
    const unchanged = rest.length === 0 && first.kind === action.kind && first.side === action.side;
    // Count new confirmations and recovered corrections, not unchanged history
    // on every overlapping sweep. Replay still repairs a failed correction.
    if (hasFreshFill || !unchanged) this.fastPath.verified += 1;
    if (unchanged) return;

    this.fastPath.corrected += 1;
    corrections.updated.push(...(await this.repository.correct(tx, address, action.id, first)));
    // Real fills can split what the feed saw as one action (a liquidation
    // among them); the other parts are stored, not alerted on.
    if (rest.length > 0) corrections.inserted.push(...(await this.repository.insertActions(tx, address, rest.map((d) => ({ ...d, leverage: action.leverage })))));
    this.logger.warn(
      `Fast path corrected action ${action.id} (${address} ${action.coin}): ${action.kind} ${action.side} → ` +
        `${drafts.map((d) => `${d.kind} ${d.side}`).join(" + ")} (${this.fastPath.corrected} of ${this.fastPath.verified} checked)`,
    );
  }
}
