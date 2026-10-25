import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { outsideRequest } from "../runtime/request-context.js";
import { HyperliquidInfoClient } from "./hyperliquid-info.client.js";
import { budgetConsumer } from "./request-budgeter.service.js";
import { safeErrorText } from "../runtime/safe-error-text.js";
import { MARKET_CATALOG_TTL_MS, MARKET_VOLUME_STALE_MS, MARKET_VOLUME_TTL_MS } from '../config/constants/cache-ttls.js';
import { MARKET_CATALOG_RETRY_MS, MARKET_CATALOG_WAIT_MS } from '../config/constants/hyperliquid.js';

/** The catalog's budget consumer: essential (HyperliquidInfoClient waits for
 * room in the shared background lane for it instead of failing at once). */
export const CATALOG_CONSUMER = "catalog";

/**
 * Every perp market Hyperliquid has listed: the main dex and each HIP-3
 * builder dex (`xyz:TSLA`), delisted ones included (they are real markets
 * with trade history), and each active market's 24h volume. One read gives
 * both: `perpDexs` and one `metaAndAssetCtxs` per dex (its universe is
 * `meta`'s, delisted entries included), outside any request (so a caller
 * that stops waiting does not cancel it). A failed re-read keeps the last
 * good list and ranking.
 *
 * Until 2026-10-25 the list came from a sweep of its own (`meta` per dex),
 * retried only when `markets()` was called: on Stage the copy meter's
 * background lane refused it (`hyperliquid_quota_exhausted`) at start and on
 * each rare retry, each one beside the volume sweep the same request
 * started, and the list stayed null for ten hours while the volume sweep,
 * retried on every home load, succeeded. Every coin icon was a 404 (D19).
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
  private trendingList: { coins: string[]; volumes: ReadonlyMap<string, number>; at: number } | null = null;
  private loading: Promise<void> | null = null;
  private attemptedAt = -Infinity;
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
    if (this.list && this.now() - this.list.at < MARKET_CATALOG_TTL_MS) return this.list.coins;
    const load = this.refresh();
    // A stale list is still Hyperliquid's own; markets are not unlisted from it.
    if (this.list || !load) return this.list?.coins ?? null;
    await this.within(load, waitMs);
    return this.listed();
  }

  private listed(): ReadonlySet<string> | null {
    return this.list?.coins ?? null;
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
    if (this.trendingList && this.now() - this.trendingList.at < MARKET_VOLUME_TTL_MS) return this.trendingList.coins;
    const load = this.refresh();
    if (!this.usableRanking() && load) await this.within(load, waitMs);
    return this.usableRanking() ?? [];
  }

  /** Each active market's exchange 24h notional volume (USD) from the last
   * trending read still fresh (15 min); null when there is none. Starts a
   * read when due, never waits for it. */
  async dayVolumes(): Promise<ReadonlyMap<string, number> | null> {
    await this.trending(0);
    return this.usableRanking() ? this.trendingList!.volumes : null;
  }

  private usableRanking(): string[] | null {
    return this.trendingList && this.now() - this.trendingList.at < MARKET_VOLUME_STALE_MS ? this.trendingList.coins : null;
  }

  /** Waits for `load`, at most `waitMs`. */
  private async within(load: Promise<void>, waitMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([load, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]);
    } finally { clearTimeout(timer); }
  }

  /** The read in flight; a new one when the last attempt is at least
   * `MARKET_CATALOG_RETRY_MS` old; else null. Never rejects. */
  private refresh(): Promise<void> | null {
    if (this.loading) return this.loading;
    if (this.now() - this.attemptedAt < MARKET_CATALOG_RETRY_MS) return null;
    this.attemptedAt = this.now();
    this.loading = outsideRequest(() => this.read())
      .catch((error: unknown) => { this.logger.warn(`Market catalog read failed: ${safeErrorText(error)}`); })
      .finally(() => { this.loading = null; });
    return this.loading;
  }

  private async read(): Promise<void> {
    // A dozen small calls every few minutes that serve display and the
    // feed's rules, not an order: an essential background consumer on the
    // shared meter (it waits for room instead of failing at once), never
    // the live lane (H-R11).
    const { coins, volumes } = await budgetConsumer(CATALOG_CONSUMER, () => this.readCatalog());
    if (coins.size === 0) throw new Error("Hyperliquid returned no markets");
    const at = this.now();
    this.list = { coins, at };
    if (volumes.size === 0) throw new Error("No market volume available");
    const ranked = [...volumes].sort(([a, av], [b, bv]) => bv - av || a.localeCompare(b)).map(([coin]) => coin);
    this.trendingList = { coins: ranked, volumes, at };
  }

  /** Every dex's universe and active volumes; any failed dex fails the read. */
  private async readCatalog(): Promise<{ coins: Set<string>; volumes: Map<string, number> }> {
    const dexes = await this.info.perpDexs("background");
    const coins = new Set<string>();
    const volumes = new Map<string, number>();
    for (const dex of dexes) {
      const [meta, contexts] = await this.info.metaAndAssetCtxs("background", undefined, dex?.name || undefined);
      meta.universe.forEach((asset, index) => {
        coins.add(asset.name);
        const volume = Number(contexts[index]?.dayNtlVlm);
        if (!asset.isDelisted && Number.isFinite(volume) && volume > 0) volumes.set(asset.name, volume);
      });
      for (const [name] of dex?.assetToStreamingOiCap ?? []) coins.add(name);
    }
    return { coins, volumes };
  }
}
