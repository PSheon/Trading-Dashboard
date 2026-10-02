import { Injectable, Logger } from "@nestjs/common";

import { outsideRequest } from "../runtime/request-context.js";
import { HyperliquidInfoClient } from "./hyperliquid-info.client.js";

/** The catalog is re-read this often (listings change a few times a week). */
export const MARKET_CATALOG_TTL_MS = 60 * 60_000;
/** After a failed read the next one waits this long (the last good list
 * keeps answering meanwhile). */
export const MARKET_CATALOG_RETRY_MS = 60_000;
/** How long one answer waits for the first read of a new process. */
export const MARKET_CATALOG_WAIT_MS = 2_000;

/**
 * Every perp market Hyperliquid has listed: the main dex and each HIP-3
 * builder dex (`xyz:TSLA`), delisted ones included (they are real markets
 * with trade history). Read from `perpDexs` and one `meta` per dex, about
 * once an hour, outside any request (so a caller that stops waiting does not
 * cancel it). A failed re-read keeps the last good list.
 *
 * `isListed` answers "is this name a Hyperliquid market at all": the coin
 * page shows an empty board for a real market nobody in the pool has traded
 * and a 404 for a name that is no market. `null` means it cannot be told yet
 * (no list has been read); callers must not treat that as "no".
 */
@Injectable()
export class MarketCatalogService {
  private readonly logger = new Logger(MarketCatalogService.name);
  private list: { coins: ReadonlySet<string>; at: number } | null = null;
  private loading: Promise<ReadonlySet<string> | null> | null = null;
  private failedAt = 0;
  /** Settable for tests. */
  now: () => number = () => Date.now();

  constructor(private readonly info: HyperliquidInfoClient) {}

  /** The listed markets, or null when none has been read yet and the read
   * did not finish within `waitMs`. */
  async markets(waitMs = MARKET_CATALOG_WAIT_MS): Promise<ReadonlySet<string> | null> {
    const now = this.now();
    if (this.list && now - this.list.at < MARKET_CATALOG_TTL_MS) return this.list.coins;
    const load = now - this.failedAt >= MARKET_CATALOG_RETRY_MS || this.loading ? this.refresh() : null;
    // A stale list is still Hyperliquid's own; markets are not unlisted from it.
    if (this.list) return this.list.coins;
    if (!load) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
    try {
      return await Promise.race([load, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Whether `coin` (Hyperliquid's spelling: "BTC", "xyz:TSLA") is a listed
   * perp market; null when the catalog is not known. */
  async isListed(coin: string, waitMs = MARKET_CATALOG_WAIT_MS): Promise<boolean | null> {
    const markets = await this.markets(waitMs);
    return markets ? markets.has(coin) : null;
  }

  private refresh(): Promise<ReadonlySet<string> | null> {
    this.loading ??= outsideRequest(() => this.read())
      .then((coins) => {
        this.list = { coins, at: this.now() };
        return coins as ReadonlySet<string> | null;
      })
      .catch((error: unknown) => {
        this.failedAt = this.now();
        this.logger.warn(`Market catalog read failed: ${(error as Error).message}`);
        return this.list?.coins ?? null;
      })
      .finally(() => { this.loading = null; });
    return this.loading;
  }

  private async read(): Promise<Set<string>> {
    const dexes = await this.info.perpDexs();
    const coins = new Set<string>();
    for (const dex of dexes) {
      const meta = await this.info.meta(dex?.name || undefined);
      for (const asset of meta.universe) coins.add(asset.name);
      for (const [name] of dex?.assetToStreamingOiCap ?? []) coins.add(name);
    }
    if (coins.size === 0) throw new Error("Hyperliquid returned no markets");
    return coins;
  }
}
