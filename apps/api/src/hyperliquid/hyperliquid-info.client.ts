import { readInfoJson, validateInfoResponse } from "./response-validation.js";
import { AppConfig } from "../config/app-config.js";
import { currentRequestSignal } from "../runtime/request-context.js";
import { Optional } from "@nestjs/common";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { Injectable, Logger } from "@nestjs/common";
import { HyperliquidGlobalTransport, settleListAnswer } from './hyperliquid-global-transport.js';
import { currentSourceLane } from './postgres-hyperliquid-quota.js';
import { LiveBoundaryError } from '../copy/live/wallet-authorization.js';

import { CONSUMER_ANALYTICS, currentBudgetConsumer, isPageWork, PAGE_WORK_MAX_RANK, RequestBudgeterService, type RequestPriority } from "./request-budgeter.service.js";
import type {
  HlAllMidsResponse,
  HlMetaAndAssetCtxsResponse,
  HlClearinghouseStateResponse,
  HlDelegatorSummary,
  HlFrontendOpenOrder,
  HlInfoRequestBody,
  HlLedgerUpdate,
  HlTwapHistoryEntry,
  HlSpotClearinghouseStateResponse,
  HlSpotMetaAndAssetCtxsResponse,
  HlUserAbstractionResponse,
  HlMetaResponse,
  HlPerpDexsResponse,
  HlPortfolioResponse,
  HlTwapSliceFill,
  HlUserFill,
  HlReferralResponse,
  HlUserFillsByTimeResponse,
  HlUserFundingEntry,
  HlCandle,
} from "./types.js";
import { infoListSurcharge, infoWeight, MAX_INFO_LIST_ITEMS } from "./info-weights.js";
import { ANALYTICS_CAPACITY_WAIT_MS, ESSENTIAL_CAPACITY_WAIT_MS, REQUEST_TIMEOUT_MS } from '../config/constants/hyperliquid.js';

/** Request weights, from the one table (info-weights.ts). List requests
 * (`*_BASE`) also pay 1 per 20 items returned (candles: 1 per 60);
 * twapHistory and userNonFundingLedgerUpdates are budgeted as lists, the
 * conservative reading of docs that don't list them. */
const WEIGHT_CLEARINGHOUSE_STATE = infoWeight({ type: "clearinghouseState" });
const WEIGHT_USER_FILLS_BY_TIME_BASE = infoWeight({ type: "userFillsByTime" });
const WEIGHT_META = infoWeight({ type: "meta" });
const WEIGHT_PERP_DEXS = infoWeight({ type: "perpDexs" });
const WEIGHT_META_AND_ASSET_CTXS = infoWeight({ type: "metaAndAssetCtxs" });
const WEIGHT_ALL_MIDS = infoWeight({ type: "allMids" });
const WEIGHT_PORTFOLIO = infoWeight({ type: "portfolio" });
const WEIGHT_SPOT_CLEARINGHOUSE_STATE = infoWeight({ type: "spotClearinghouseState" });
const WEIGHT_SPOT_META_AND_CTXS = infoWeight({ type: "spotMetaAndAssetCtxs" });
const WEIGHT_USER_ABSTRACTION = infoWeight({ type: "userAbstraction" });
const WEIGHT_DELEGATOR_SUMMARY = infoWeight({ type: "delegatorSummary" });
const WEIGHT_USER_FILLS_BASE = infoWeight({ type: "userFills" });
const WEIGHT_TWAP_SLICE_FILLS_BASE = infoWeight({ type: "userTwapSliceFills" });
const WEIGHT_REFERRAL = infoWeight({ type: "referral" });
const WEIGHT_CANDLE_SNAPSHOT_BASE = infoWeight({ type: "candleSnapshot" });
/** Per dex (spot orders come with the main one). */
const WEIGHT_FRONTEND_OPEN_ORDERS = infoWeight({ type: "frontendOpenOrders" });
const WEIGHT_TWAP_HISTORY_BASE = infoWeight({ type: "twapHistory" });
const WEIGHT_LEDGER_UPDATES_BASE = infoWeight({ type: "userNonFundingLedgerUpdates" });
/** Items prepaid for those two (a heavy TWAP user has ~170 TWAPs; a 90-day
 * ledger a few hundred); the difference is settled afterwards. */
const TWAP_HISTORY_MAX_ITEMS = 2000;
export const LEDGER_MAX_ITEMS = 2000;
const WEIGHT_USER_FUNDING_BASE = infoWeight({ type: "userFunding" });
/** `userFunding` returns at most 500 entries per call (verified live). */
export const USER_FUNDING_PAGE_SIZE = 500;
/** Every fill list endpoint returns at most 2,000 items per call. */
export const MAX_LIST_ITEMS = MAX_INFO_LIST_ITEMS;
/** Items a recent-window fills read prepays (`userFillsSince`). */
const RECENT_FILLS_ITEMS = 200;
/** Budget consumers whose calls wait for room in the shared background lane
 * instead of failing at once: snapshots and sweeps of watched leaders, and
 * the confirms that store the fills the trade feed alerted on. */
const ESSENTIAL_LANE_CONSUMERS = new Set(["snapshots", "confirm", "sweep"]);
/** The budget consumer of a trade-analytics job a request started. */
export const ANALYTICS_CONSUMER = CONSUMER_ANALYTICS;

/** 1 more weight per 20 items (info-weights.ts). */
const surcharge = (items: number) => infoListSurcharge("userFills", items);

/** A TWAP slice as a regular fill, tagged with its TWAP's id. */
export function twapSliceToFill(slice: HlTwapSliceFill): HlUserFill {
  return { ...slice.fill, twapId: slice.twapId };
}

/**
 * Read-only wrapper around Hyperliquid's `POST /info` endpoint.
 *
 * Every call routes through `RequestBudgeterService` (W6, §4.2): the
 * budgeter's `acquire()` paces the call before it goes out, a real 429
 * triggers backoff, and a successful response feeds gradual recovery.
 */
@Injectable()
export class HyperliquidInfoClient {
  private readonly logger = new Logger(HyperliquidInfoClient.name);

  constructor(private readonly config: AppConfig, private readonly budgeter: RequestBudgeterService, @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
    @Optional() private readonly globalTransport?: HyperliquidGlobalTransport) {}

  private async post<T>(
    body: HlInfoRequestBody,
    weight: number,
    priority: RequestPriority = "background",
    rank?: number,
    /** The part of `weight` that is certain (list calls: the base). */
    known?: number,
    /** Another info host (the wallet network's), still under this budget. */
    apiUrl?: string,
    /** Set once the budget was taken: only then is there anything to refund.
     * `at`: when the request left, after every budget wait. */
    admission?: { admitted: boolean; at?: number },
  ): Promise<T> {
    const caller = currentRequestSignal();
    // Time in the budget queue doesn't count against the request timeout:
    // a heavy background load (home warm-up, trade analytics) may wait
    // longer than that for its turn, and still has to run. A page load is
    // bounded by its own request's deadline (`caller`) instead.
    const queued = AbortSignal.any([this.jobs.signal, ...(caller ? [caller] : [])]);
    // Shared per-IP window: page work may use all of it and waits briefly
    // when it is full; background work is capped below it so pages keep room.
    // A trade-analytics job (PAGE_RANK.analytics) goes to the background
    // lane and waits there: it is not the page's own request, and its many
    // list calls must not take the pages' room.
    const consumer = currentBudgetConsumer() ?? "";
    const page = priority === "background" && rank !== undefined && rank <= PAGE_WORK_MAX_RANK;
    // Its own reads (a shared page read it joins stays the page's).
    const analytics = consumer === ANALYTICS_CONSUMER && !page;
    // One analytics read at a time, in arrival order, before any budget is
    // taken (a read waiting minutes for the lane holds no local tokens).
    const done = analytics && priority === "background" ? await this.analyticsTurn(queued) : undefined;
    try {
      return await this.sendInfo<T>(body, weight, priority, rank, known, apiUrl, admission, queued, page, analytics, consumer);
    } finally {
      done?.();
    }
  }

  /** The tail of this process's analytics reads (see `analyticsTurn`). */
  private analyticsQueue: Promise<void> = Promise.resolve();

  /** A member's complete perp snapshot: one local admission and one capped
   * shared admission for every venue, before any provider read is sent. */
  async clearinghouseStates(address: string, dexes: readonly string[], rank?: number, onDispatch?: () => void): Promise<HlClearinghouseStateResponse[]> {
    if (!(this.globalTransport instanceof HyperliquidGlobalTransport)) throw new LiveBoundaryError('hyperliquid_quota_egress_unconfigured');
    if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !Array.isArray(dexes) || dexes.length < 1 || dexes.length > 64 || dexes[0] !== ''
      || rank !== undefined && (!Number.isSafeInteger(rank) || rank <= PAGE_WORK_MAX_RANK)
      || new Set(dexes).size !== dexes.length || dexes.some(dex => typeof dex !== 'string' || dex.length > 256 || /[\p{Cc}\p{Cf}]/u.test(dex))) throw new Error('Invalid complete perp snapshot');
    const caller = currentRequestSignal();
    const queued = AbortSignal.any([this.jobs.signal, ...(caller ? [caller] : [])]);
    const weight = WEIGHT_CLEARINGHOUSE_STATE * dexes.length;
    await this.budgeter.acquire(weight, 'background', rank, { signal: queued });
    let dispatched = false;
    try {
      const bodies = dexes.map(dex => ({ type: 'clearinghouseState', user: address, ...(dex ? { dex } : {}) }));
      const signal = AbortSignal.any([queued, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
      const responses = await this.globalTransport.fetchBackgroundInfoBatch(this.config.value.hyperliquid.apiUrl, bodies, {
        signal, onDispatch: () => { dispatched = true; onDispatch?.(); return signal; },
      });
      if (responses.some(response => response.status === 429)) {
        this.budgeter.onRateLimited();
        throw new Error('Hyperliquid info request failed: 429');
      }
      const failure = responses.find(response => !response.ok);
      if (failure) throw new Error(`Hyperliquid info request failed: ${failure.status}`);
      const states = await Promise.all(responses.map(async response => validateInfoResponse('clearinghouseState', await readInfoJson(response, 'clearinghouseState')) as HlClearinghouseStateResponse));
      this.budgeter.onSuccess();
      return states;
    } catch (error) {
      // This refunds only local scheduling, only when the permit never
      // dispatched. Shared quota and any dispatched work stay charged.
      if (!dispatched) this.budgeter.adjust(-weight);
      throw error;
    }
  }

  /**
   * Waits until every trade-analytics read queued before this one has
   * finished, and returns the release of this one's turn. Racing for freed
   * lane slots let one cold computation starve another; in order, each read
   * waits for at most the charges ahead of it. An abort keeps the rest's order.
   */
  private async analyticsTurn(signal: AbortSignal): Promise<() => void> {
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const ahead = this.analyticsQueue;
    this.analyticsQueue = ahead.then(() => mine);
    if (signal.aborted) { release(); throw signal.reason; }
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([ahead, new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      })]);
    } catch (error) {
      release();
      throw error;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
    return release;
  }

  private async sendInfo<T>(
    body: HlInfoRequestBody,
    weight: number,
    priority: RequestPriority,
    rank: number | undefined,
    known: number | undefined,
    apiUrl: string | undefined,
    admission: { admitted: boolean; at?: number } | undefined,
    queued: AbortSignal,
    page: boolean,
    analytics: boolean,
    consumer: string,
  ): Promise<T> {
    await this.budgeter.acquire(weight, priority, rank, { known, signal: queued });
    if (admission) { admission.admitted = true; admission.at = Date.now(); }
    queued.throwIfAborted();
    // Snapshots and sweeps of watched leaders wait for room in the
    // background lane rather than fail at once (see fetchEssentialInfo).
    const essential = priority === "background" && !page && ESSENTIAL_LANE_CONSUMERS.has(consumer);
    const waitMs = priority === "live" || page ? 0 : analytics ? ANALYTICS_CAPACITY_WAIT_MS : essential ? ESSENTIAL_CAPACITY_WAIT_MS : 0;
    const signal = AbortSignal.any([queued, AbortSignal.timeout(REQUEST_TIMEOUT_MS + waitMs)]);

    const url = apiUrl ?? this.config.value.hyperliquid.apiUrl;
    if (!(this.globalTransport instanceof HyperliquidGlobalTransport)) throw new LiveBoundaryError('hyperliquid_quota_egress_unconfigured');
    // The fast leader source's reads (HyperliquidGlobalTransport.runSource) go in the shared meter's source lane.
    const send = priority === "live" ? (currentSourceLane() !== undefined ? this.globalTransport.fetchSourceInfo : this.globalTransport.fetchInfo) : page ? this.globalTransport.fetchPageInfo
      : analytics && priority === "background" ? this.globalTransport.fetchAnalyticsInfo
      : essential ? this.globalTransport.fetchEssentialInfo : this.globalTransport.fetchBackgroundInfo;
    const res = await send(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    });

    if (res.status === 429) {
      this.budgeter.onRateLimited();
      this.logger.error("Hyperliquid info request rate-limited (429)");
      throw new Error("Hyperliquid info request failed: 429");
    }

    if (!res.ok) {
      this.logger.error(
        `Hyperliquid info request failed: ${res.status} ${res.statusText}`,
      );
      throw new Error(`Hyperliquid info request failed: ${res.status}`);
    }

    const parsed = validateInfoResponse(body.type, await readInfoJson(res, body.type));
    // A list's real weight, for the shared meter (it prepaid the most).
    if (Array.isArray(parsed)) settleListAnswer(res, parsed.length);
    this.budgeter.onSuccess();
    return parsed as T;
  }

  /**
   * A list request (1 more weight per 20 items returned): acquires the base
   * plus the worst-case surcharge up front, then gives back what the
   * response didn't use. On failure the surcharge goes back and the base
   * stays spent (a failed call may still have been counted), except after a
   * 429, where the budgeter has just backed off and handing tokens back
   * would undo that. A call the budgeter refused (page busy, queue full,
   * aborted while waiting) took nothing, so nothing goes back.
   */
  private async postList<T extends unknown[]>(
    body: HlInfoRequestBody,
    base: number,
    priority: RequestPriority,
    rank: number | undefined,
    maxItems = MAX_LIST_ITEMS,
    apiUrl?: string,
    admission: { admitted: boolean; at?: number } = { admitted: false },
  ): Promise<T> {
    const worst = surcharge(maxItems);
    const page = isPageWork(priority, rank);
    let result: T;
    try {
      result = await this.post<T>(body, base + worst, priority, rank, base, apiUrl, admission);
    } catch (error) {
      if (admission.admitted && !(error as Error).message.endsWith(": 429")) this.budgeter.adjust(-worst, { page });
      throw error;
    }
    this.budgeter.adjust(surcharge(result.length) - worst, { page });
    return result;
  }

  /**
   * Funding payments of every position from `startTime`, oldest first, at
   * most 500 per call (paged by time; verified live 2026-09-29). Payments
   * older than about a week come as one entry per coin and day (stamped
   * 00:00 UTC, `nSamples` hours). In the docs' per-20-items surcharge list,
   * base 20.
   */
  userFunding(
    address: string,
    startTime: number,
    endTime?: number,
    priority: RequestPriority = "background",
    rank?: number,
  ): Promise<HlUserFundingEntry[]> {
    return this.postList<HlUserFundingEntry[]>(
      { type: "userFunding", user: address, startTime, endTime },
      WEIGHT_USER_FUNDING_BASE,
      priority,
      rank,
      USER_FUNDING_PAGE_SIZE,
    );
  }

  /** Coin universe metadata: szDecimals, max leverage (§5). `dex` selects a
   * HIP-3 dex; omitted means the main dex. */
  meta(dex?: string, priority: RequestPriority = "background"): Promise<HlMetaResponse> {
    return this.post<HlMetaResponse>(dex ? { type: "meta", dex } : { type: "meta" }, WEIGHT_META, priority);
  }

  /**
   * Candles of one coin, oldest first (`interval`: "1h", "4h", "12h", "1d",
   * …). Acquires the base plus the surcharge of `expected` candles up front
   * and settles the difference to the real count afterwards.
   */
  async candleSnapshot(
    coin: string,
    interval: string,
    startTime: number,
    endTime: number,
    expected: number,
    priority: RequestPriority = "background",
    rank?: number,
  ): Promise<HlCandle[]> {
    const extra = (n: number) => infoListSurcharge("candleSnapshot", n);
    const guess = extra(expected);
    const candles = await this.post<HlCandle[]>(
      { type: "candleSnapshot", req: { coin, interval, startTime, endTime } },
      WEIGHT_CANDLE_SNAPSHOT_BASE + guess,
      priority,
      rank,
      WEIGHT_CANDLE_SNAPSHOT_BASE,
    );
    this.budgeter.adjust(extra(candles.length) - guess);
    return candles;
  }

  /** All perp dexes: `[null, {name: "xyz"}, …]`, main dex first. */
  perpDexs(priority: RequestPriority = "background", rank?: number): Promise<HlPerpDexsResponse> {
    return this.post<HlPerpDexsResponse>({ type: "perpDexs" }, WEIGHT_PERP_DEXS, priority, rank);
  }
  /** All venue universes in one bounded provider request. Preserve source
   * indices and null slots; consumers must verify listed venue/coin identity. */
  allPerpMetas(priority: RequestPriority = 'background', rank?: number): Promise<Array<HlMetaResponse | null>> {
    return this.post<Array<HlMetaResponse | null>>({ type: 'allPerpMetas' }, WEIGHT_META, priority, rank);
  }

  /** Positions + equity for one address on ONE dex. Without `dex` only the
   * main dex is returned — HIP-3 positions ("xyz:TSLA") need their own call
   * (verified live 2026-09-29). */
  clearinghouseState(
    address: string,
    dex?: string,
    priority: RequestPriority = "background",
    rank?: number,
    apiUrl?: string,
  ): Promise<HlClearinghouseStateResponse> {
    return this.post<HlClearinghouseStateResponse>(
      dex ? { type: "clearinghouseState", user: address, dex } : { type: "clearinghouseState", user: address },
      WEIGHT_CLEARINGHOUSE_STATE,
      priority,
      rank,
      undefined,
      apiUrl,
    );
  }

  /** `userFillsByTime` from `startTime` to now, with the time the request
   * left (after every budget wait): what the answer can be certain of starts
   * there, not when the caller began waiting. */
  async userFillsSince(address: string, startTime: number, priority: RequestPriority): Promise<{ fills: HlUserFillsByTimeResponse; sentAt: number }> {
    const admission: { admitted: boolean; at?: number } = { admitted: false };
    // A short recent window: 200 rows' surcharge up front (30 in all), not the
    // 2,000-row worst case (120), so a busy bucket is waited on for less; a
    // longer answer settles the difference afterwards like every list.
    const fills = await this.postList<HlUserFillsByTimeResponse>({ type: "userFillsByTime", user: address, startTime }, WEIGHT_USER_FILLS_BY_TIME_BASE, priority, undefined, RECENT_FILLS_ITEMS, undefined, admission);
    return { fills, sentAt: admission.at ?? Date.now() };
  }

  /**
   * Fills for one address across every dex, oldest first (2,000 rows a call,
   * the latest 10,000 fills retained). TWAP slice fills are not included;
   * see `userTwapSliceFillsByTime`.
   */
  userFillsByTime(
    address: string,
    startTime: number,
    endTime?: number,
    priority: RequestPriority = "background",
    rank?: number,
  ): Promise<HlUserFillsByTimeResponse> {
    return this.postList<HlUserFillsByTimeResponse>(
      { type: "userFillsByTime", user: address, startTime, endTime },
      WEIGHT_USER_FILLS_BY_TIME_BASE,
      priority,
      rank,
    );
  }

  /**
   * The address's TWAP slice fills from `startTime`, oldest first, at most
   * 2,000 per call (paged like `userFillsByTime`; verified live 2026-09-29).
   * Not in the info-endpoint docs' request list, but named in the
   * rate-limit docs' per-20-items surcharge list.
   */
  userTwapSliceFillsByTime(
    address: string,
    startTime: number,
    endTime?: number,
    priority: RequestPriority = "background",
    rank?: number,
  ): Promise<HlTwapSliceFill[]> {
    return this.postList<HlTwapSliceFill[]>(
      { type: "userTwapSliceFillsByTime", user: address, startTime, endTime },
      WEIGHT_TWAP_SLICE_FILLS_BASE,
      priority,
      rank,
    );
  }

  /** The address's latest TWAP slice fills (at most 2,000, newest first). */
  userTwapSliceFills(
    address: string,
    priority: RequestPriority = "background",
    rank?: number,
  ): Promise<HlTwapSliceFill[]> {
    return this.postList<HlTwapSliceFill[]>(
      { type: "userTwapSliceFills", user: address },
      WEIGHT_TWAP_SLICE_FILLS_BASE,
      priority,
      rank,
    );
  }

  /** One dex's perp universe (sizes, leverage) with each asset's mark, mid,
   * oracle price and current hourly funding rate. Weight 20. `dex` selects
   * a HIP-3 dex (its coins come back prefixed, "xyz:TSLA"); omitted means
   * the main dex. */
  metaAndAssetCtxs(priority: RequestPriority = "background", rank?: number, dex?: string): Promise<HlMetaAndAssetCtxsResponse> {
    return this.post<HlMetaAndAssetCtxsResponse>(dex ? { type: "metaAndAssetCtxs", dex } : { type: "metaAndAssetCtxs" }, WEIGHT_META_AND_ASSET_CTXS, priority, rank);
  }

  /** Mid prices of one dex: the main dex (perps and spot pairs) when `dex`
   * is omitted, else that HIP-3 dex's markets ("xyz:TSLA"). Weight 2. */
  allMids(priority: RequestPriority = "background", rank?: number, dex?: string): Promise<HlAllMidsResponse> {
    return this.post<HlAllMidsResponse>(dex ? { type: "allMids", dex } : { type: "allMids" }, WEIGHT_ALL_MIDS, priority, rank);
  }

  /** Spot balances (and, in unified / portfolio-margin accounts, all
   * collateral). Weight 2. */
  spotClearinghouseState(
    address: string,
    priority: RequestPriority = "background",
    rank?: number,
    apiUrl?: string,
  ): Promise<HlSpotClearinghouseStateResponse> {
    return this.post<HlSpotClearinghouseStateResponse>(
      { type: "spotClearinghouseState", user: address },
      WEIGHT_SPOT_CLEARINGHOUSE_STATE,
      priority,
      rank,
      undefined,
      apiUrl,
    );
  }

  /** Spot tokens, pairs and each pair's mark / mid. Weight 20. */
  spotMetaAndAssetCtxs(priority: RequestPriority = "background", rank?: number): Promise<HlSpotMetaAndAssetCtxsResponse> {
    return this.post<HlSpotMetaAndAssetCtxsResponse>({ type: "spotMetaAndAssetCtxs" }, WEIGHT_SPOT_META_AND_CTXS, priority, rank);
  }

  /** The account's collateral mode ("unifiedAccount", "portfolioMargin",
   * "disabled", "default", "dexAbstraction"). Weight 20. */
  userAbstraction(address: string, priority: RequestPriority = "background", rank?: number): Promise<HlUserAbstractionResponse> {
    return this.post<HlUserAbstractionResponse>({ type: "userAbstraction", user: address }, WEIGHT_USER_ABSTRACTION, priority, rank);
  }

  /** HYPE staking totals. Weight 20. */
  delegatorSummary(address: string, priority: RequestPriority = "background", rank?: number): Promise<HlDelegatorSummary> {
    return this.post<HlDelegatorSummary>({ type: "delegatorSummary", user: address }, WEIGHT_DELEGATOR_SUMMARY, priority, rank);
  }

  /** Account value and PnL history per window (day/week/month/allTime, and
   * the same prefixed `perp`), used by the trader page and card sparklines.
   * Weight 20. */
  portfolio(
    address: string,
    priority: RequestPriority = "background",
    rank?: number,
  ): Promise<HlPortfolioResponse> {
    return this.post<HlPortfolioResponse>({ type: "portfolio", user: address }, WEIGHT_PORTFOLIO, priority, rank);
  }

  /** The address's most recent fills (up to 2000, newest first), spot and
   * every perp dex, TWAP slices excluded. Weight 20 plus the per-20-items
   * surcharge. */
  userFills(
    address: string,
    priority: RequestPriority = "background",
    rank?: number,
  ): Promise<HlUserFill[]> {
    return this.postList<HlUserFill[]>({ type: "userFills", user: address }, WEIGHT_USER_FILLS_BASE, priority, rank);
  }

  /** Resting orders on one perp dex ("" / omitted = the main dex, which
   * also carries the address's spot orders). Weight 20. */
  frontendOpenOrders(
    address: string,
    dex?: string,
    priority: RequestPriority = "background",
    rank?: number,
  ): Promise<HlFrontendOpenOrder[]> {
    return this.post<HlFrontendOpenOrder[]>(
      dex ? { type: "frontendOpenOrders", user: address, dex } : { type: "frontendOpenOrders", user: address },
      WEIGHT_FRONTEND_OPEN_ORDERS,
      priority,
      rank,
    );
  }

  /** Every TWAP the address ran, one entry per status change, oldest
   * first. */
  twapHistory(address: string, priority: RequestPriority = "background", rank?: number): Promise<HlTwapHistoryEntry[]> {
    return this.postList<HlTwapHistoryEntry[]>(
      { type: "twapHistory", user: address },
      WEIGHT_TWAP_HISTORY_BASE,
      priority,
      rank,
      TWAP_HISTORY_MAX_ITEMS,
    );
  }

  /** Deposits, withdrawals, transfers, vault and staking movements from
   * `startTime`, oldest first. */
  userNonFundingLedgerUpdates(
    address: string,
    startTime: number,
    endTime?: number,
    priority: RequestPriority = "background",
    rank?: number,
    apiUrl?: string,
  ): Promise<HlLedgerUpdate[]> {
    return this.postList<HlLedgerUpdate[]>(
      { type: "userNonFundingLedgerUpdates", user: address, startTime, endTime },
      WEIGHT_LEDGER_UPDATES_BASE,
      priority,
      rank,
      LEDGER_MAX_ITEMS,
      apiUrl,
    );
  }

  /** Referral and builder rewards for one address (the platform's revenue
   * snapshot). Top-level amounts are USDC; see `HlReferralResponse`. */
  referral(
    address: string,
    priority: RequestPriority = "background",
    rank?: number,
  ): Promise<HlReferralResponse> {
    return this.post<HlReferralResponse>({ type: "referral", user: address }, WEIGHT_REFERRAL, priority, rank);
  }
}
