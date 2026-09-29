import { Injectable, Logger } from "@nestjs/common";

import { env } from "../config/env.js";
import { RequestBudgeterService, type RequestPriority } from "./request-budgeter.service.js";
import type {
  HlAllMidsResponse,
  HlClearinghouseStateResponse,
  HlInfoRequestBody,
  HlMetaResponse,
  HlPerpDexsResponse,
  HlPortfolioResponse,
  HlTwapSliceFill,
  HlUserFill,
  HlReferralResponse,
  HlUserFillsByTimeResponse,
} from "./types.js";

/** Hyperliquid `info` request weights (verified live against the docs —
 * see `request-budgeter.service.ts` for the full citation/reasoning). */
const WEIGHT_CLEARINGHOUSE_STATE = 2;
const WEIGHT_USER_FILLS_BY_TIME_BASE = 20;
const WEIGHT_META = 20;
const WEIGHT_PERP_DEXS = 20;
/** In the docs' weight-2 list with clearinghouseState (rate-limits-and-user-limits). */
const WEIGHT_ALL_MIDS = 2;
const WEIGHT_PORTFOLIO = 20;
const WEIGHT_USER_FILLS_BASE = 20;
/** `userTwapSliceFills` and `userTwapSliceFillsByTime` are both in the
 * docs' list of requests with "additional weight per 20 items returned"
 * (rate-limits-and-user-limits, checked 2026-09-29); base 20 like every
 * other request not in the weight-2 list. */
const WEIGHT_TWAP_SLICE_FILLS_BASE = 20;
/** Not in the weight-2 list, so "all other documented info requests" = 20
 * (rate-limits-and-user-limits, checked 2026-09-29). */
const WEIGHT_REFERRAL = 20;
/** Assumed per-docs multiplier for the "additional weight per 20 items
 * returned" surcharge on userFillsByTime — see the budgeter's doc comment
 * for why this is 1 and not something else. */
const EXTRA_WEIGHT_PER_20_ITEMS = 1;
/** Every list endpoint returns at most 2,000 items per call. */
export const MAX_LIST_ITEMS = 2000;
/** The worst-case surcharge of one list call, acquired up front. */
export const MAX_LIST_SURCHARGE = Math.ceil(MAX_LIST_ITEMS / 20) * EXTRA_WEIGHT_PER_20_ITEMS;
/** A dead connection must not hold a caller (and its per-address sync
 * chain) forever. */
const REQUEST_TIMEOUT_MS = 20_000;

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

  constructor(private readonly budgeter: RequestBudgeterService) {}

  private async post<T>(
    body: HlInfoRequestBody,
    weight: number,
    priority: RequestPriority = "background",
    rank?: number,
    /** The part of `weight` that is certain (list calls: the base). */
    known?: number,
  ): Promise<T> {
    if (known === undefined) await this.budgeter.acquire(weight, priority, rank);
    else await this.budgeter.acquire(weight, priority, rank, known);

    const url = env.hyperliquidApiUrl();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

    this.budgeter.onSuccess();
    return (await res.json()) as T;
  }

  /**
   * A list request (1 more weight per 20 items returned): acquires the base
   * plus the worst-case surcharge up front, then gives back what the
   * response didn't use. On failure the surcharge goes back and the base
   * stays spent (a failed call may still have been counted), except after a
   * 429, where the budgeter has just backed off and handing tokens back
   * would undo that.
   */
  private async postList<T extends unknown[]>(
    body: HlInfoRequestBody,
    base: number,
    priority: RequestPriority,
    rank: number | undefined,
  ): Promise<T> {
    let result: T;
    try {
      result = await this.post<T>(body, base + MAX_LIST_SURCHARGE, priority, rank, base);
    } catch (error) {
      if (!(error as Error).message.endsWith(": 429")) this.budgeter.adjust(-MAX_LIST_SURCHARGE);
      throw error;
    }
    this.budgeter.adjust(surcharge(result.length) - MAX_LIST_SURCHARGE);
    return result;
  }

  /** Coin universe metadata: szDecimals, max leverage (§5). `dex` selects a
   * HIP-3 dex; omitted means the main dex. */
  meta(dex?: string): Promise<HlMetaResponse> {
    return this.post<HlMetaResponse>(dex ? { type: "meta", dex } : { type: "meta" }, WEIGHT_META);
  }

  /** All perp dexes: `[null, {name: "xyz"}, …]`, main dex first. */
  perpDexs(priority: RequestPriority = "background", rank?: number): Promise<HlPerpDexsResponse> {
    return this.post<HlPerpDexsResponse>({ type: "perpDexs" }, WEIGHT_PERP_DEXS, priority, rank);
  }

  /** Positions + equity for one address on ONE dex. Without `dex` only the
   * main dex is returned — HIP-3 positions ("xyz:TSLA") need their own call
   * (verified live 2026-09-29). */
  clearinghouseState(
    address: string,
    dex?: string,
    priority: RequestPriority = "background",
    rank?: number,
  ): Promise<HlClearinghouseStateResponse> {
    return this.post<HlClearinghouseStateResponse>(
      dex ? { type: "clearinghouseState", user: address, dex } : { type: "clearinghouseState", user: address },
      WEIGHT_CLEARINGHOUSE_STATE,
      priority,
      rank,
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

  /** Mid prices for every coin, used for alert scoring (N3). */
  allMids(): Promise<HlAllMidsResponse> {
    return this.post<HlAllMidsResponse>({ type: "allMids" }, WEIGHT_ALL_MIDS);
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
