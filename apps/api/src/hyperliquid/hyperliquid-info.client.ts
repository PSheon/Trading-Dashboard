import { Injectable, Logger } from "@nestjs/common";

import { env } from "../config/env.js";
import { RequestBudgeterService } from "./request-budgeter.service.js";
import type {
  HlAllMidsResponse,
  HlClearinghouseStateResponse,
  HlInfoRequestBody,
  HlMetaResponse,
  HlUserFillsByTimeResponse,
} from "./types.js";

/** Hyperliquid `info` request weights (verified live against the docs —
 * see `request-budgeter.service.ts` for the full citation/reasoning). */
const WEIGHT_CLEARINGHOUSE_STATE = 2;
const WEIGHT_USER_FILLS_BY_TIME_BASE = 20;
const WEIGHT_META = 20;
const WEIGHT_ALL_MIDS = 20;
/** Assumed per-docs multiplier for the "additional weight per 20 items
 * returned" surcharge on userFillsByTime — see the budgeter's doc comment
 * for why this is 1 and not something else. */
const EXTRA_WEIGHT_PER_20_ITEMS = 1;

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

  private async post<T>(body: HlInfoRequestBody, weight: number): Promise<T> {
    await this.budgeter.acquire(weight);

    const url = env.hyperliquidApiUrl();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

  /** Coin universe metadata: szDecimals, max leverage (§5). */
  meta(): Promise<HlMetaResponse> {
    return this.post<HlMetaResponse>({ type: "meta" }, WEIGHT_META);
  }

  /** Positions + equity for one address (§4.2 W4, polled every N seconds). */
  clearinghouseState(address: string): Promise<HlClearinghouseStateResponse> {
    return this.post<HlClearinghouseStateResponse>(
      { type: "clearinghouseState", user: address },
      WEIGHT_CLEARINGHOUSE_STATE,
    );
  }

  /**
   * Historical fills for one address, used at import time (A5) and for
   * delta-triggered fetches (W2/W3). Hyperliquid only returns a bounded
   * window / row count — see §5 known constraints (2000 rows/call, most
   * recent 10,000 fills retained). Time-ascending order, confirmed live.
   *
   * The base weight (20) is acquired up-front by `post()`; the per-20-items
   * surcharge is only knowable after the response lands, so it is reported
   * to the budgeter here, right after parsing.
   */
  async userFillsByTime(
    address: string,
    startTime: number,
    endTime?: number,
  ): Promise<HlUserFillsByTimeResponse> {
    const result = await this.post<HlUserFillsByTimeResponse>(
      { type: "userFillsByTime", user: address, startTime, endTime },
      WEIGHT_USER_FILLS_BY_TIME_BASE,
    );
    const extraWeight = Math.ceil(result.length / 20) * EXTRA_WEIGHT_PER_20_ITEMS;
    this.budgeter.recordAdditionalWeight(extraWeight);
    return result;
  }

  /** Mid prices for every coin, used for alert scoring (N3). */
  allMids(): Promise<HlAllMidsResponse> {
    return this.post<HlAllMidsResponse>({ type: "allMids" }, WEIGHT_ALL_MIDS);
  }
}
