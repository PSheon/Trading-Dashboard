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

/**
 * Hyperliquid reads for copy trading, through the shared budgeter at
 * background priority, each behind a TTL cache with in-flight dedupe.
 * Failures return null (the caller decides; nothing is priced at 0).
 */
@Injectable()
export class CopyMarketService {
  private readonly logger = new Logger(CopyMarketService.name);
  private mids: Mids | null = null;
  private midsInflight: Promise<Mids | null> | null = null;
  private assets: { at: number; byCoin: Map<string, AssetInfo> } | null = null;
  private assetsInflight: Promise<Map<string, AssetInfo> | null> | null = null;
  readonly equityCache = new Map<string, { at: number; value: number | null }>();

  constructor(private readonly info: HyperliquidInfoClient) {}

  /** allMids, at most one request per {@link MIDS_TTL_MS}. */
  async midPrices(): Promise<Mids | null> {
    if (this.mids && Date.now() - this.mids.at.getTime() < MIDS_TTL_MS) return this.mids;
    this.midsInflight ??= (async () => {
      try {
        const raw = await this.info.allMids("background");
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
        const [meta, ctxs] = await this.info.metaAndAssetCtxs("background");
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

  /** Drops the hourly universe cache (tests; a new listing). */
  resetAssets(): void {
    this.assets = null;
  }

  /** The leader's perp account value, cached {@link LEADER_EQUITY_TTL_MS}. */
  async leaderEquity(address: string): Promise<number | null> {
    const hit = this.equityCache.get(address);
    if (hit && Date.now() - hit.at < LEADER_EQUITY_TTL_MS) return hit.value;
    try {
      const state = await this.info.clearinghouseState(address, undefined, "background");
      const value = Number(state.marginSummary.accountValue);
      const ok = Number.isFinite(value) && value > 0 ? value : null;
      this.equityCache.set(address, { at: Date.now(), value: ok });
      return ok;
    } catch (error) {
      this.logger.warn(`Leader equity for ${address} failed: ${(error as Error).message}`);
      return null;
    }
  }

  /** A fresh snapshot of the leader (adoption at activation). Throws on failure. */
  async leaderSnapshot(address: string): Promise<HlClearinghouseStateResponse> {
    const state = await this.info.clearinghouseState(address, undefined, "background");
    const value = Number(state.marginSummary.accountValue);
    if (Number.isFinite(value) && value > 0) this.equityCache.set(address, { at: Date.now(), value });
    return state;
  }
}
