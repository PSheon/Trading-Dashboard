import { Injectable, Logger } from "@nestjs/common";

import { env } from "../config/env.js";
import type {
  HlAllMidsResponse,
  HlClearinghouseStateResponse,
  HlInfoRequestBody,
  HlMetaResponse,
  HlUserFillsByTimeResponse,
} from "./types.js";

/**
 * Read-only wrapper around Hyperliquid's `POST /info` endpoint.
 *
 * Only method shapes are implemented here — no retry/backoff and no request
 * budgeting yet. W6 (§4.2) will need a shared weight budgeter across every
 * call this client makes; the TODO below marks where it plugs in.
 */
@Injectable()
export class HyperliquidInfoClient {
  private readonly logger = new Logger(HyperliquidInfoClient.name);

  private async post<T>(body: HlInfoRequestBody): Promise<T> {
    // TODO(W6): route every call through the request-weight budgeter before
    // it goes out, so total info-API weight stays under Hyperliquid's
    // per-minute IP limit (§4.2 W6). No throttling/queueing happens yet.
    const url = env.hyperliquidApiUrl();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      this.logger.error(
        `Hyperliquid info request failed: ${res.status} ${res.statusText}`,
      );
      throw new Error(`Hyperliquid info request failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }

  /** Coin universe metadata: szDecimals, max leverage (§5). */
  meta(): Promise<HlMetaResponse> {
    return this.post<HlMetaResponse>({ type: "meta" });
  }

  /** Positions + equity for one address (§4.2 W4, polled every 5 min). */
  clearinghouseState(address: string): Promise<HlClearinghouseStateResponse> {
    return this.post<HlClearinghouseStateResponse>({
      type: "clearinghouseState",
      user: address,
    });
  }

  /**
   * Historical fills for one address, used at import time (A5) and for
   * reconciliation backfill (W4). Hyperliquid only returns a bounded
   * window / row count — see §5 known constraints.
   */
  userFillsByTime(
    address: string,
    startTime: number,
    endTime?: number,
  ): Promise<HlUserFillsByTimeResponse> {
    return this.post<HlUserFillsByTimeResponse>({
      type: "userFillsByTime",
      user: address,
      startTime,
      endTime,
    });
  }

  /** Mid prices for every coin, used for alert scoring (N3). */
  allMids(): Promise<HlAllMidsResponse> {
    return this.post<HlAllMidsResponse>({ type: "allMids" });
  }
}
