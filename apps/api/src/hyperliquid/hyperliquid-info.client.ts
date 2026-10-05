import { readInfoJson, validateInfoResponse } from "./response-validation.js";
import { AppConfig } from "../config/app-config.js";
import { currentRequestSignal } from "../runtime/request-context.js";
import { Optional } from "@nestjs/common";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { Injectable, Logger } from "@nestjs/common";
import { ANALYTICS_CAPACITY_WAIT_MS, ESSENTIAL_CAPACITY_WAIT_MS, HyperliquidGlobalTransport, settleListAnswer } from './hyperliquid-global-transport.js';
import { LiveBoundaryError } from '../copy/live/wallet-authorization.js';

import { currentBudgetConsumer, isPageWork, PAGE_WORK_MAX_RANK, RequestBudgeterService, type RequestPriority } from "./request-budgeter.service.js";
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

/** Hyperliquid `info` request weights (verified live against the docs —
 * see `request-budgeter.service.ts` for the full citation/reasoning). */
const WEIGHT_CLEARINGHOUSE_STATE = 2;
const WEIGHT_USER_FILLS_BY_TIME_BASE = 20;
const WEIGHT_META = 20;
const WEIGHT_PERP_DEXS = 20;
/** Not in the weight-2 list, so 20. */
const WEIGHT_META_AND_ASSET_CTXS = 20;
/** In the docs' weight-2 list with clearinghouseState (rate-limits-and-user-limits). */
const WEIGHT_ALL_MIDS = 2;
const WEIGHT_PORTFOLIO = 20;
/** In the docs' weight-2 list (rate-limits-and-user-limits, checked 2026-09-29). */
const WEIGHT_SPOT_CLEARINGHOUSE_STATE = 2;
/** Not in the weight-2 list, so 20 (checked 2026-09-29). */
const WEIGHT_SPOT_META_AND_CTXS = 20;
const WEIGHT_USER_ABSTRACTION = 20;
const WEIGHT_DELEGATOR_SUMMARY = 20;
const WEIGHT_USER_FILLS_BASE = 20;
/** `userTwapSliceFills` and `userTwapSliceFillsByTime` are both in the
 * docs' list of requests with "additional weight per 20 items returned"
 * (rate-limits-and-user-limits, checked 2026-09-29); base 20 like every
 * other request not in the weight-2 list. */
const WEIGHT_TWAP_SLICE_FILLS_BASE = 20;
/** Not in the weight-2 list, so "all other documented info requests" = 20
 * (rate-limits-and-user-limits, checked 2026-09-29). */
const WEIGHT_REFERRAL = 20;
/** `candleSnapshot`: base 20 plus 1 per 60 candles returned (rate-limits
 * docs, "additional weight per 60 items"). At most 5,000 candles a call. */
const WEIGHT_CANDLE_SNAPSHOT_BASE = 20;
const CANDLES_PER_EXTRA_WEIGHT = 60;
export const MAX_CANDLES = 5000;
/** `frontendOpenOrders`: not in the weight-2 list, so 20, per dex (the
 * request names one dex; spot orders come with the main one). */
const WEIGHT_FRONTEND_OPEN_ORDERS = 20;
/** `twapHistory` and `userNonFundingLedgerUpdates`: base 20, budgeted as
 * list requests (+1 per 20 items), the conservative reading of the
 * rate-limit docs, which don't list either explicitly. */
const WEIGHT_TWAP_HISTORY_BASE = 20;
const WEIGHT_LEDGER_UPDATES_BASE = 20;
/** Items acquired up front for those two: a TWAP history is every TWAP the
 * address ever ran (170 for a heavy TWAP user, checked 2026-09-30); a
 * 90-day ledger window rarely has more than a few hundred. The difference
 * to the real count is settled afterwards, as for every list. */
export const TWAP_HISTORY_MAX_ITEMS = 2000;
export const LEDGER_MAX_ITEMS = 2000;
/** Assumed per-docs multiplier for the "additional weight per 20 items
 * returned" surcharge on userFillsByTime — see the budgeter's doc comment
 * for why this is 1 and not something else. */
const EXTRA_WEIGHT_PER_20_ITEMS = 1;
/** `userFunding`: in the surcharge list, base 20 (rate-limits docs). */
const WEIGHT_USER_FUNDING_BASE = 20;
/** `userFunding` returns at most 500 entries per call (verified live). */
export const USER_FUNDING_PAGE_SIZE = 500;
/** Every fill list endpoint returns at most 2,000 items per call. */
export const MAX_LIST_ITEMS = 2000;
/** The worst-case surcharge of one list call, acquired up front. */
export const MAX_LIST_SURCHARGE = Math.ceil(MAX_LIST_ITEMS / 20) * EXTRA_WEIGHT_PER_20_ITEMS;
/** A dead connection must not hold a caller (and its per-address sync
 * chain) forever. */
const REQUEST_TIMEOUT_MS = 20_000;
/** Budget consumers whose calls wait for room in the shared background lane:
 * snapshots and sweeps of watched leaders, and the confirms that store the
 * fills the trade feed alerted on (they used to fail at once whenever the
 * pool's loops held the lane, 85 times in two hours on 2026-10-04). */
const ESSENTIAL_LANE_CONSUMERS = new Set(["snapshots", "confirm", "sweep"]);
/** The budget consumer of a trade-analytics job a request started. */
export const ANALYTICS_CONSUMER = "analytics";

const surcharge = (items: number) => Math.ceil(items / 20) * EXTRA_WEIGHT_PER_20_ITEMS;

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
    /** Set once the budget was taken: only then is there anything to refund. */
    admission?: { admitted: boolean },
  ): Promise<T> {
    const caller = currentRequestSignal();
    // Time in the budget queue doesn't count against the request timeout:
    // a heavy background load (home warm-up, trade analytics) may wait
    // longer than that for its turn, and still has to run. A page load is
    // bounded by its own request's deadline (`caller`) instead.
    const queued = AbortSignal.any([this.jobs.signal, ...(caller ? [caller] : [])]);
    await this.budgeter.acquire(weight, priority, rank, { known, signal: queued });
    if (admission) admission.admitted = true;
    queued.throwIfAborted();
    // Shared per-IP window: page work may use all of it and waits briefly
    // when it is full; background work is capped below it so pages keep room.
    // A trade-analytics job (PAGE_RANK.analytics) goes to the background
    // lane and waits there: it is not the page's own request, and its many
    // list calls must not take the pages' room.
    const consumer = currentBudgetConsumer() ?? "";
    const page = priority === "background" && rank !== undefined && rank <= PAGE_WORK_MAX_RANK;
    // Its own reads (a shared page read it joins stays the page's).
    const analytics = consumer === ANALYTICS_CONSUMER && !page;
    // Snapshots and sweeps of watched leaders wait for room in the
    // background lane rather than fail at once (see fetchEssentialInfo).
    const essential = priority === "background" && !page && ESSENTIAL_LANE_CONSUMERS.has(consumer);
    const waitMs = priority === "live" || page ? 0 : analytics ? ANALYTICS_CAPACITY_WAIT_MS : essential ? ESSENTIAL_CAPACITY_WAIT_MS : 0;
    const signal = AbortSignal.any([queued, AbortSignal.timeout(REQUEST_TIMEOUT_MS + waitMs)]);

    const url = apiUrl ?? this.config.value.hyperliquid.apiUrl;
    if (!(this.globalTransport instanceof HyperliquidGlobalTransport)) throw new LiveBoundaryError('hyperliquid_quota_egress_unconfigured');
    const send = priority === "live" ? this.globalTransport.fetchInfo : page ? this.globalTransport.fetchPageInfo
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
  ): Promise<T> {
    const worst = surcharge(maxItems);
    const page = isPageWork(priority, rank);
    let result: T;
    const admission = { admitted: false };
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
    const extra = (n: number) => Math.ceil(Math.min(n, MAX_CANDLES) / CANDLES_PER_EXTRA_WEIGHT);
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

  /**
   * Fills for one address across every dex, used by A5 backfill, the
   * trade-triggered live sync and the hourly sweep (W2/W3). Hyperliquid only returns a bounded
   * window / row count — see §5 known constraints (2000 rows/call, most
   * recent 10,000 fills retained). Time-ascending order, confirmed live.
   * TWAP slice fills are not included; see `userTwapSliceFillsByTime`.
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

  /** Mid prices for every main-dex perp and spot pair ("@107", "#123"
   * outcomes), used for alert scoring (N3) and outcome-token values. */
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
