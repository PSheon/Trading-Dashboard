import { Injectable, Logger } from "@nestjs/common";

import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import type { RequestPriority } from "../hyperliquid/request-budgeter.service.js";
import type { HlAllMidsResponse, HlSpotBalance } from "../hyperliquid/types.js";
import { buildSpotPriceBook, valueSpotBalances, type SpotPriceBook, type SpotValuation } from "./spot-prices.js";
import { TtlCache } from "./ttl-cache.js";

/** One price book for the whole app, refreshed at most every 30 s. */
export const SPOT_PRICE_TTL_MS = 30_000;

/**
 * Spot prices for valuing balances: `spotMetaAndAssetCtxs` (weight 20) and
 * `allMids` (weight 2, outcome tokens only) at most once per 30 s app-wide,
 * with in-flight de-duplication. A token that can't be priced counts as 0
 * and is logged once per process.
 */
@Injectable()
export class SpotPriceService {
  private readonly logger = new Logger(SpotPriceService.name);
  readonly cache = new TtlCache<SpotPriceBook>(SPOT_PRICE_TTL_MS, 1);
  private readonly unpriced = new Set<string>();

  constructor(private readonly info: HyperliquidInfoClient) {}

  book(priority: RequestPriority = "background", rank?: number): Promise<SpotPriceBook> {
    return this.cache.get("book", async () => {
      const [metaAndCtxs, mids] = await Promise.all([
        this.info.spotMetaAndAssetCtxs(priority, rank),
        // Only outcome tokens need it; without it they count as 0.
        this.info.allMids(priority, rank).catch((error: Error): HlAllMidsResponse => {
          this.logger.warn(`allMids failed, outcome tokens valued at 0: ${error.message}`);
          return {};
        }),
      ]);
      return buildSpotPriceBook(metaAndCtxs, mids);
    });
  }

  value(balances: HlSpotBalance[], book: SpotPriceBook): SpotValuation {
    return valueSpotBalances(balances, book, (coin, token) => {
      const key = `${coin}:${token ?? "-"}`;
      if (this.unpriced.has(key)) return;
      this.unpriced.add(key);
      this.logger.warn(`No price for spot token ${coin} (token ${token ?? "none"}); valued at 0`);
    });
  }
}
