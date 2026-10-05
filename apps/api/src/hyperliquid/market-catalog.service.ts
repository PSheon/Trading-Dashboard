import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

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
export class MarketCatalogService implements OnModuleInit {
  private readonly logger = new Logger(MarketCatalogService.name);
  private list: { coins: ReadonlySet<string>; at: number } | null = null;
  private loading: Promise<ReadonlySet<string> | null> | null = null;
  private failedAt = 0;
  private trendingList: { coins: string[]; volumes: ReadonlyMap<string, number>; at: number } | null = null;
  private trendingLoading: Promise<string[]> | null = null;
  private trendingAttemptedAt = -Infinity;
  /** Settable for tests. */
  now: () => number = () => Date.now();

  constructor(private readonly info: HyperliquidInfoClient) {}

  /** The first read starts with the process, not with the first visitor of
   * a coin page (who would get "cannot tell yet" and no 404). */
  onModuleInit(): void {
    void this.markets(0);
  }

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

  /** Exchange 24h notional volume across active perp markets, refreshed every
   * five minutes. Stale data expires after fifteen minutes; callers then use
   * their configured fallback. A failed/partial dex read never replaces a
   * complete ranking. Cold requests wait at most the catalog wait budget. */
  async trending(waitMs = MARKET_CATALOG_WAIT_MS): Promise<string[]> {
    const now = this.now();
    if (this.trendingList && now - this.trendingList.at < 5 * 60_000) return this.trendingList.coins;
    if (!this.trendingLoading && now - this.trendingAttemptedAt >= MARKET_CATALOG_RETRY_MS) {
      this.trendingAttemptedAt = now;
      this.trendingLoading = outsideRequest(async () => {
        const dexes = await this.info.perpDexs("live");
        const volumes = new Map<string, number>();
        for (const dex of dexes) {
          const [meta, contexts] = await this.info.metaAndAssetCtxs("live", undefined, dex?.name || undefined);
          meta.universe.forEach((asset, index) => {
            const volume = Number(contexts[index]?.dayNtlVlm);
            if (!asset.isDelisted && Number.isFinite(volume) && volume > 0) volumes.set(asset.name, volume);
          });
        }
        if (volumes.size === 0) throw new Error("No market volume available");
        const coins = [...volumes].sort(([a, av], [b, bv]) => bv - av || a.localeCompare(b)).map(([coin]) => coin);
        this.trendingList = { coins, volumes, at: this.now() };
        return coins;
      }).catch((error: unknown) => {
        this.logger.warn(`Trending market read failed: ${(error as Error).message}`);
        return [];
      }).finally(() => { this.trendingLoading = null; });
    }
    if (this.trendingList && now - this.trendingList.at < 15 * 60_000) return this.trendingList.coins;
    if (!this.trendingLoading) return [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.trendingLoading, new Promise<string[]>(resolve => { timer = setTimeout(() => resolve([]), waitMs); })]);
    } finally { clearTimeout(timer); }
  }

  /** Each active market's exchange 24h notional volume (USD) from the last
   * trending read still fresh (15 min); null when there is none. Starts a
   * read when due, never waits for it. */
  async dayVolumes(): Promise<ReadonlyMap<string, number> | null> {
    await this.trending(0);
    return this.trendingList && this.now() - this.trendingList.at < 15 * 60_000 ? this.trendingList.volumes : null;
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
    // The live lane: a dozen small calls an hour, and behind the background
    // queue they did not finish for minutes after a start.
    const dexes = await this.info.perpDexs("live");
    const coins = new Set<string>();
    for (const dex of dexes) {
      const meta = await this.info.meta(dex?.name || undefined, "live");
      for (const asset of meta.universe) coins.add(asset.name);
      for (const [name] of dex?.assetToStreamingOiCap ?? []) coins.add(name);
    }
    if (coins.size === 0) throw new Error("Hyperliquid returned no markets");
    return coins;
  }
}
