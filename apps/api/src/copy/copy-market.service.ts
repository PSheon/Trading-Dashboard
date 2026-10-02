import { Injectable, Logger } from "@nestjs/common";

import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import type { HlClearinghouseStateResponse } from "../hyperliquid/types.js";

/** Mid prices are shared by every caller for this long (allMids, weight 2). */
export const MIDS_TTL_MS = 3_000;
/** A mids read that fails may fall back to one this recent. */
const MIDS_STALE_OK_MS = 60_000;
/** Universe and funding (metaAndAssetCtxs, weight 20): hourly. */
export const ASSETS_TTL_MS = 3_600_000;
/** Leader account value for ratio sizing (clearinghouseState, weight 2). */
export const LEADER_EQUITY_TTL_MS = 60_000;

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

  constructor(private readonly info: HyperliquidInfoClient) {}

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
  }

  /** The leader's perp account value, cached {@link LEADER_EQUITY_TTL_MS}.
   * Only a completed read is cached, so a failure is asked again next pass. */
  async leaderEquity(address: string): Promise<LeaderEquity> {
    const hit = this.equityCache.get(address);
    if (hit && Date.now() - hit.at < LEADER_EQUITY_TTL_MS) return toLeaderEquity(hit.value);
    let flight = this.equityInflight.get(address);
    if (!flight) {
      flight = (async (): Promise<LeaderEquity> => {
        try {
          const state = await this.info.clearinghouseState(address, undefined, LANE);
          const value = Number(state.marginSummary.accountValue);
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

  /** A fresh snapshot of the leader (adoption at activation). Throws on failure. */
  async leaderSnapshot(address: string): Promise<HlClearinghouseStateResponse> {
    const state = await this.info.clearinghouseState(address, undefined, LANE);
    const value = Number(state.marginSummary.accountValue);
    if (Number.isFinite(value) && value > 0) this.equityCache.set(address, { at: Date.now(), value });
    return state;
  }
}

function toLeaderEquity(value: number | null): LeaderEquity {
  return value === null ? { state: "none" } : { state: "known", value };
}
