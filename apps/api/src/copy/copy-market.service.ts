import { Injectable, Logger } from "@nestjs/common";

import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import type { HlAllMidsResponse, HlClearinghouseStateResponse } from "../hyperliquid/types.js";
import { buildSpotPriceBook, hypePrice, stakedHype, toAccountMode, totalAccountValue, valueSpotBalances, type SpotPriceBook } from "../traders/spot-prices.js";
import { activePerpDexes, portfolioSeries, summarizeAccount } from "../traders/traders.mappers.js";
import { TtlCache } from "../traders/ttl-cache.js";
import { coinDex } from "@trading-dashboard/shared/contracts";

import { Dec } from "../common/decimal/dec.js";
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
  funding: Dec;
  markPx: Dec;
}

/** The universe that was read: the main dex, plus each HIP-3 dex a caller
 * asked for. `missingDexes` are dexes that were asked for and could not be
 * read (a transient gap for their coins, not "the coin does not exist"). */
export class AssetMap extends Map<string, AssetInfo> {
  readonly missingDexes = new Set<string>();
}

export interface Mids {
  at: Date;
  /** Mid by coin, exactly as Hyperliquid sent it. */
  px: Map<string, Dec>;
  /** HIP-3 dexes whose mids were asked for and could not be read. */
  missingDexes: Set<string>;
}

/** The HIP-3 dexes among `coins` ("xyz" for "xyz:TSLA"); never the main dex. */
export function hip3DexesOf(coins: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const coin of coins) {
    const dex = coinDex(coin);
    if (dex) out.add(dex);
  }
  return [...out].sort();
}

/** Hyperliquid's maintenance margin for a position: half the initial margin
 * at the coin's maximum leverage, i.e. notional ÷ (2 × maxLeverage). The
 * larger-position margin tiers (the lowest starts at $3M notional) are not
 * modelled: the paper caps (order, coin and user exposure) stay far below. */
export function maintenanceMargin(notional: Dec, maxLeverage: number): Dec {
  return notional.abs().div(2 * Math.max(1, maxLeverage));
}

/** A leader's capital for ratio sizing. `none` is a fact (the account was
 * read and holds nothing); `failed` is a read that did not complete (a
 * Hyperliquid timeout, a starved budget): a transient gap, retried by the
 * caller like missing mids, never a reason to reject. */
export type LeaderEquity = { state: "known"; value: Dec } | { state: "none" } | { state: "failed" };

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
  /** Mids per dex ("" is the main dex), each with its own age. */
  private readonly midsByDex = new Map<string, { at: number; px: Map<string, Dec> }>();
  private readonly midsInflight = new Map<string, Promise<boolean>>();
  private readonly assetsByDex = new Map<string, { at: number; byCoin: Map<string, AssetInfo> }>();
  private readonly assetsInflight = new Map<string, Promise<boolean>>();
  readonly equityCache = new Map<string, { at: number; value: number | null }>();
  private readonly equityInflight = new Map<string, Promise<LeaderEquity>>();
  private readonly abstractionCache = new TtlCache<string>(ACCOUNT_MODE_TTL_MS);
  private readonly stakingCache = new TtlCache<number>(STAKING_TTL_MS);
  private readonly spotBookCache = new TtlCache<SpotPriceBook>(SPOT_BOOK_TTL_MS, 1);
  private readonly dexCache = new TtlCache<string[]>(DEX_LIST_TTL_MS, 1);

  constructor(private readonly info: HyperliquidInfoClient, private readonly repository: CopyRepository) {}

  /** One dex's mids, at most one request per {@link MIDS_TTL_MS}. True when
   * usable mids are held afterwards (fresh, or a failed read with a copy no
   * older than {@link MIDS_STALE_OK_MS}). */
  private loadMids(dex: string): Promise<boolean> {
    const held = this.midsByDex.get(dex);
    if (held && Date.now() - held.at < MIDS_TTL_MS) return Promise.resolve(true);
    let flight = this.midsInflight.get(dex);
    if (!flight) {
      flight = (async () => {
        try {
          const raw = await this.info.allMids(LANE, undefined, dex || undefined);
          const px = new Map<string, Dec>();
          for (const [coin, v] of Object.entries(raw)) {
            const mid = Dec.parse(v);
            if (mid?.isPositive) px.set(coin, mid);
          }
          this.midsByDex.set(dex, { at: Date.now(), px });
          return true;
        } catch (error) {
          this.logger.warn(`allMids${dex ? ` (${dex})` : ""} failed: ${(error as Error).message}`);
          const stale = this.midsByDex.get(dex);
          return stale !== undefined && Date.now() - stale.at < MIDS_STALE_OK_MS;
        } finally {
          this.midsInflight.delete(dex);
        }
      })();
      this.midsInflight.set(dex, flight);
    }
    return flight;
  }

  /**
   * Mid prices: the main dex always, plus the HIP-3 dex of every coin in
   * `coins` ("xyz:TSLA" reads the `xyz` dex; weight 2 each, cached like the
   * main one). Null when the main dex can't be read; a HIP-3 dex that can't
   * be read is listed in `missingDexes` and its coins have no price.
   */
  async midPrices(coins: Iterable<string> = []): Promise<Mids | null> {
    const dexes = hip3DexesOf(coins);
    const [main, ...rest] = await Promise.all(["", ...dexes].map((dex) => this.loadMids(dex)));
    if (!main) return null;
    const mainMids = this.midsByDex.get("")!;
    if (dexes.length === 0) return { at: new Date(mainMids.at), px: mainMids.px, missingDexes: new Set() };
    const px = new Map(mainMids.px);
    const missingDexes = new Set<string>();
    let at = mainMids.at;
    dexes.forEach((dex, i) => {
      const held = this.midsByDex.get(dex);
      if (!rest[i] || !held) { missingDexes.add(dex); return; }
      at = Math.min(at, held.at);
      for (const [coin, value] of held.px) px.set(coin, value);
    });
    return { at: new Date(at), px, missingDexes };
  }

  /** One dex's universe with funding, at most hourly; a failed read keeps the last one. */
  private loadAssets(dex: string): Promise<boolean> {
    const held = this.assetsByDex.get(dex);
    if (held && Date.now() - held.at < ASSETS_TTL_MS) return Promise.resolve(true);
    let flight = this.assetsInflight.get(dex);
    if (!flight) {
      flight = (async () => {
        try {
          const [meta, ctxs] = await this.info.metaAndAssetCtxs(LANE, undefined, dex || undefined);
          const byCoin = new Map<string, AssetInfo>();
          meta.universe.forEach((a, i) => {
            const ctx = ctxs[i];
            byCoin.set(a.name, { szDecimals: a.szDecimals, maxLeverage: a.maxLeverage, funding: Dec.parse(ctx?.funding) ?? Dec.ZERO, markPx: Dec.parse(ctx?.markPx) ?? Dec.ZERO });
          });
          this.assetsByDex.set(dex, { at: Date.now(), byCoin });
          return true;
        } catch (error) {
          this.logger.warn(`metaAndAssetCtxs${dex ? ` (${dex})` : ""} failed: ${(error as Error).message}`);
          return this.assetsByDex.has(dex);
        } finally {
          this.assetsInflight.delete(dex);
        }
      })();
      this.assetsInflight.set(dex, flight);
    }
    return flight;
  }

  /**
   * The universe (size decimals, max leverage, funding, mark): the main dex
   * always, plus the HIP-3 dex of every coin in `coins` (weight 20 each, at
   * most hourly). Null when the main dex was never read; a HIP-3 dex that
   * was never read is listed in `missingDexes`.
   */
  async assetInfo(coins: Iterable<string> = []): Promise<AssetMap | null> {
    const dexes = hip3DexesOf(coins);
    const [main, ...rest] = await Promise.all(["", ...dexes].map((dex) => this.loadAssets(dex)));
    if (!main) return null;
    const out = new AssetMap(this.assetsByDex.get("")!.byCoin);
    dexes.forEach((dex, i) => {
      const held = this.assetsByDex.get(dex);
      if (!rest[i] || !held) { out.missingDexes.add(dex); return; }
      for (const [coin, value] of held.byCoin) out.set(coin, value);
    });
    return out;
  }

  /** Drops every cache (tests, and a new listing). */
  resetCaches(): void {
    this.midsByDex.clear();
    this.assetsByDex.clear();
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

  /**
   * A fresh snapshot of the leader's open positions (adoption at
   * activation) on the main dex and every builder dex (one
   * `clearinghouseState` each, weight 2; HIP-3 positions are not in the
   * main dex's answer). Builder dexes are read whether or not the policy
   * copies them, so the start of a copy can say which positions were left
   * out. `time` is the earliest of the reads, so a fill between two of
   * them is still after the activation cursor. Its margin summary is not the
   * leader's capital; see {@link leaderEquity}. Throws when any read fails:
   * a partial list is never adopted as the whole.
   */
  async leaderSnapshot(address: string): Promise<{ time: number; assetPositions: HlClearinghouseStateResponse["assetPositions"] }> {
    const dexes = await this.dexCache.get("dexes", async () => activePerpDexes(await this.info.perpDexs(LANE)));
    const states = await Promise.all(dexes.map((dex) => this.info.clearinghouseState(address, dex || undefined, LANE)));
    return { time: Math.min(...states.map((s) => s.time)), assetPositions: states.flatMap((s) => s.assetPositions) };
  }
}

/** The account value comes from the trader profile's valuation (spot
 * balances × prices, in floats): it is a ratio's denominator, not a ledger
 * amount, and enters the decimal arithmetic here at its printed value. */
function toLeaderEquity(value: number | null): LeaderEquity {
  return value === null ? { state: "none" } : { state: "known", value: Dec.from(value) };
}
