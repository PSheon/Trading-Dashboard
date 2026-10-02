import { Injectable, Logger } from "@nestjs/common";

import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import type { HlAllMidsResponse, HlClearinghouseStateResponse } from "../hyperliquid/types.js";
import { buildSpotPriceBook, hypePrice, stakedHype, toAccountMode, totalAccountValue, valueSpotBalances, type SpotPriceBook } from "../traders/spot-prices.js";
import { activePerpDexes, portfolioSeries, summarizeAccount } from "../traders/traders.mappers.js";
import { TtlCache } from "../traders/ttl-cache.js";
import { CopyRepository } from "./copy.repository.js";

/** Mid prices are shared by every caller for this long (allMids, weight 2). */
export const MIDS_TTL_MS = 3_000;
/** A mids read that fails may fall back to one this recent. */
const MIDS_STALE_OK_MS = 60_000;
/** Universe and funding (metaAndAssetCtxs, weight 20): hourly. */
export const ASSETS_TTL_MS = 3_600_000;
/** Leader account value for ratio sizing (see `leaderEquity` for the reads). */
export const LEADER_EQUITY_TTL_MS = 60_000;
/** Parts of a leader's account value that change slowly or are shared, kept
 * as long as the trader profile keeps them: the account mode and staked
 * HYPE (20 weight each), the spot price book (22) and the dex list. */
const ACCOUNT_MODE_TTL_MS = 10 * 60_000;
const STAKING_TTL_MS = 10 * 60_000;
const SPOT_BOOK_TTL_MS = 30_000;
const DEX_LIST_TTL_MS = 60 * 60_000;

export interface AssetInfo {
  szDecimals: number;
  maxLeverage: number;
  /** Current hourly funding rate. */
  funding: number;
  markPx: number;
}

export interface Mids {
  at: Date;
  px: Map<string, number>;
}

/** A leader's capital for ratio sizing. `none` is a fact (the account was
 * read and holds nothing); `failed` is a read that did not complete (a
 * Hyperliquid timeout, a starved budget): a transient gap, retried by the
 * caller like missing mids, never a reason to reject. */
export type LeaderEquity = { state: "known"; value: number } | { state: "none" } | { state: "failed" };

/**
 * Copy trading mirrors a leader's fills, so its reads are time-critical:
 * they use the budgeter's `live` lane, ahead of every background job (pool,
 * cohort and fill backfills). As plain background calls they starved behind
 * those jobs: the worker's tick hung on `allMids` and approved orders were
 * never filled. The volume is small and bounded by the caches below.
 */
const LANE = "live" as const;

/**
 * Hyperliquid reads for copy trading, through the shared budgeter, each
 * behind a TTL cache with in-flight dedupe. Failures return null, or
 * `failed` for a leader's equity (the caller decides; nothing is priced at
 * 0 and a failed read is never cached).
 */
@Injectable()
export class CopyMarketService {
  private readonly logger = new Logger(CopyMarketService.name);
  private mids: Mids | null = null;
  private midsInflight: Promise<Mids | null> | null = null;
  private assets: { at: number; byCoin: Map<string, AssetInfo> } | null = null;
  private assetsInflight: Promise<Map<string, AssetInfo> | null> | null = null;
  readonly equityCache = new Map<string, { at: number; value: number | null }>();
  private readonly equityInflight = new Map<string, Promise<LeaderEquity>>();
  private readonly abstractionCache = new TtlCache<string>(ACCOUNT_MODE_TTL_MS);
  private readonly stakingCache = new TtlCache<number>(STAKING_TTL_MS);
  private readonly spotBookCache = new TtlCache<SpotPriceBook>(SPOT_BOOK_TTL_MS, 1);
  private readonly dexCache = new TtlCache<string[]>(DEX_LIST_TTL_MS, 1);

  constructor(private readonly info: HyperliquidInfoClient, private readonly repository: CopyRepository) {}

  /** allMids, at most one request per {@link MIDS_TTL_MS}. */
  async midPrices(): Promise<Mids | null> {
    if (this.mids && Date.now() - this.mids.at.getTime() < MIDS_TTL_MS) return this.mids;
    this.midsInflight ??= (async () => {
      try {
        const raw = await this.info.allMids(LANE);
        const px = new Map<string, number>();
        for (const [coin, v] of Object.entries(raw)) {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) px.set(coin, n);
        }
        this.mids = { at: new Date(), px };
        return this.mids;
      } catch (error) {
        this.logger.warn(`allMids failed: ${(error as Error).message}`);
        return this.mids && Date.now() - this.mids.at.getTime() < MIDS_STALE_OK_MS ? this.mids : null;
      } finally {
        this.midsInflight = null;
      }
    })();
    return this.midsInflight;
  }

  /** Main-dex universe with funding, at most hourly. */
  async assetInfo(): Promise<Map<string, AssetInfo> | null> {
    if (this.assets && Date.now() - this.assets.at < ASSETS_TTL_MS) return this.assets.byCoin;
    this.assetsInflight ??= (async () => {
      try {
        const [meta, ctxs] = await this.info.metaAndAssetCtxs(LANE);
        const byCoin = new Map<string, AssetInfo>();
        meta.universe.forEach((a, i) => {
          const ctx = ctxs[i];
          byCoin.set(a.name, { szDecimals: a.szDecimals, maxLeverage: a.maxLeverage, funding: Number(ctx?.funding ?? 0), markPx: Number(ctx?.markPx ?? 0) });
        });
        this.assets = { at: Date.now(), byCoin };
        return byCoin;
      } catch (error) {
        this.logger.warn(`metaAndAssetCtxs failed: ${(error as Error).message}`);
        return this.assets?.byCoin ?? null;
      } finally {
        this.assetsInflight = null;
      }
    })();
    return this.assetsInflight;
  }

  /** Drops every cache (tests, and a new listing). */
  resetCaches(): void {
    this.mids = null;
    this.assets = null;
    this.equityCache.clear();
    for (const cache of [this.abstractionCache, this.stakingCache, this.spotBookCache, this.dexCache]) cache.clear();
  }

  /**
   * The leader's capital, the denominator of ratio sizing ("if they use 5%
   * of their balance, you use 5% of yours"), cached
   * {@link LEADER_EQUITY_TTL_MS}. Only a completed read is cached, so a
   * failure is asked again next pass.
   *
   * It is the account value the trader profile shows (`totalAccountValue`),
   * not the main dex's `marginSummary.accountValue`: for a unified or
   * portfolio-margin account that figure is only the margin its perps hold
   * (read live 2026-10-02: 11.2M on a 22M unified account, 1.78M on a 6.8M
   * portfolio-margin one; ~0 with no position open), so sizing against it
   * made every open several times too large or rejected it.
   */
  async leaderEquity(address: string): Promise<LeaderEquity> {
    const hit = this.equityCache.get(address);
    if (hit && Date.now() - hit.at < LEADER_EQUITY_TTL_MS) return toLeaderEquity(hit.value);
    let flight = this.equityInflight.get(address);
    if (!flight) {
      flight = (async (): Promise<LeaderEquity> => {
        try {
          const value = await this.readAccountValue(address);
          const ok = Number.isFinite(value) && value > 0 ? value : null;
          this.equityCache.set(address, { at: Date.now(), value: ok });
          return toLeaderEquity(ok);
        } catch (error) {
          this.logger.warn(`Leader equity for ${address} failed: ${(error as Error).message}`);
          return { state: "failed" };
        } finally {
          this.equityInflight.delete(address);
        }
      })();
      this.equityInflight.set(address, flight);
    }
    return flight;
  }

  /**
   * The whole account, by the trader profile's rule: a standard account is
   * its perp equity on every dex + spot + staked HYPE; a unified or
   * portfolio-margin account is spot + staked HYPE (its spot balance
   * already holds the perp collateral and PnL); a vault is its TVL, the
   * latest whole-account value of `portfolio`. Throws when any read it
   * needs fails: a partial sum is never used as the capital.
   */
  private async readAccountValue(address: string): Promise<number> {
    if (await this.repository.isVault(address)) {
      const tvl = portfolioSeries(await this.info.portfolio(address, LANE), "allTime", "all").accountValue.at(-1)?.[1];
      if (tvl === undefined) throw new Error("vault portfolio has no account value");
      return tvl;
    }
    const [spot, abstraction, staked, book] = await Promise.all([
      this.info.spotClearinghouseState(address, LANE),
      this.abstractionCache.get(address, () => this.info.userAbstraction(address, LANE)),
      this.stakingCache.get(address, async () => stakedHype(await this.info.delegatorSummary(address, LANE))),
      this.spotBookCache.get("book", async () => buildSpotPriceBook(
        await this.info.spotMetaAndAssetCtxs(LANE),
        // Only outcome tokens need it; without it they count as 0.
        await this.info.allMids(LANE).catch((): HlAllMidsResponse => ({})),
      )),
    ]);
    const mode = toAccountMode(abstraction, spot.portfolioMarginEnabled ?? false);
    let perpEquity = 0;
    if (mode === "standard") {
      const dexes = await this.dexCache.get("dexes", async () => activePerpDexes(await this.info.perpDexs(LANE)));
      perpEquity = summarizeAccount(await Promise.all(dexes.map((dex) => this.info.clearinghouseState(address, dex || undefined, LANE)))).perpEquity;
    }
    return totalAccountValue(mode, perpEquity, valueSpotBalances(spot.balances ?? [], book).spotValue, staked * hypePrice(book));
  }

  /** A fresh snapshot of the leader's main-dex positions (adoption at
   * activation). Its margin summary is not the leader's capital; see
   * {@link leaderEquity}. Throws on failure. */
  leaderSnapshot(address: string): Promise<HlClearinghouseStateResponse> {
    return this.info.clearinghouseState(address, undefined, LANE);
  }
}

function toLeaderEquity(value: number | null): LeaderEquity {
  return value === null ? { state: "none" } : { state: "known", value };
}
