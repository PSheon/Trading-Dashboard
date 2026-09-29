import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, ilike, inArray, like, notLike, or, type SQL } from "drizzle-orm";
import {
  CHAIN_DEFAULT,
  fills,
  leaders,
  traderStats,
  userFavorites,
  type PortfolioQuery,
  type PortfolioResponse,
  type SparklinesResponse,
  type TraderFill,
  type TraderProfileResponse,
  type TradersQuery,
  type TradersResponse,
  type TraderWindowInput,
} from "@trading-dashboard/shared";

import { RoundTripService } from "../analytics/round-trip.service.js";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import type { HlPortfolioResponse, HlUserFill } from "../hyperliquid/types.js";
import { LeaderboardIngestService } from "./leaderboard-ingest.service.js";
import {
  dbFillToTraderFill,
  downsample,
  hlFillToTraderFill,
  isPerpCoin,
  summarizeAccount,
  summarizeRoundTrips,
  toPortfolioResponse,
  toTraderStats,
} from "./traders.mappers.js";
import { TtlCache } from "./ttl-cache.js";

/** Page loads go ahead of backfill and sweeps (lower rank first within the
 * background lane) but never ahead of live detection (the live lane). */
const LANE = "background" as const;
const RANK = 0;

export const PROFILE_TTL_MS = 60_000;
export const PORTFOLIO_TTL_MS = 60_000;
export const FILLS_TTL_MS = 60_000;
export const SPARKLINE_TTL_MS = 10 * 60_000;
export const DEX_LIST_TTL_MS = 60 * 60_000;
export const SPARKLINE_MAX_POINTS = 40;
const ANALYTICS_WINDOW_MS = 30 * 24 * 3_600_000;

/** The profile without the per-caller `favorite` flag, so one cached copy
 * serves everyone. */
type SharedProfile = Omit<TraderProfileResponse, "favorite">;

const SORT_COLUMNS = {
  pnl: { day: traderStats.pnlDay, week: traderStats.pnlWeek, month: traderStats.pnlMonth, allTime: traderStats.pnlAllTime },
  roi: { day: traderStats.roiDay, week: traderStats.roiWeek, month: traderStats.roiMonth, allTime: traderStats.roiAllTime },
  volume: {
    day: traderStats.volumeDay,
    week: traderStats.volumeWeek,
    month: traderStats.volumeMonth,
    allTime: traderStats.volumeAllTime,
  },
} as const;

/** Escapes LIKE/ILIKE wildcards in user input. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Discovery (Stage 2 §4): the leaderboard table, and trader pages for any
 * address — live positions across dexes, portfolio history, recent fills.
 * Every Hyperliquid call goes through the budgeter and an in-process cache
 * with in-flight de-duplication.
 */
@Injectable()
export class TradersService {
  private readonly logger = new Logger(TradersService.name);

  readonly profileCache = new TtlCache<SharedProfile>(PROFILE_TTL_MS);
  readonly portfolioCache = new TtlCache<HlPortfolioResponse>(PORTFOLIO_TTL_MS);
  readonly sparklineCache = new TtlCache<HlPortfolioResponse>(SPARKLINE_TTL_MS);
  readonly userFillsCache = new TtlCache<HlUserFill[]>(FILLS_TTL_MS);
  readonly dexCache = new TtlCache<string[]>(DEX_LIST_TTL_MS, 1);

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly info: HyperliquidInfoClient,
    private readonly roundTrips: RoundTripService,
    private readonly ingest: LeaderboardIngestService,
  ) {}

  // --- GET /traders ---------------------------------------------------------

  async list(query: TradersQuery, userId: number | null): Promise<TradersResponse> {
    const conditions: SQL[] = [eq(traderStats.chain, CHAIN_DEFAULT)];
    const q = query.q?.trim();
    if (q) {
      const escaped = likeEscape(q);
      conditions.push(
        or(like(traderStats.address, `${likeEscape(q.toLowerCase())}%`), ilike(traderStats.displayName, `%${escaped}%`))!,
      );
    }
    if (query.minAccountValue !== undefined) {
      conditions.push(gte(traderStats.accountValue, String(query.minAccountValue)));
    }
    const where = and(...conditions);
    const column = query.sort === "accountValue" ? traderStats.accountValue : SORT_COLUMNS[query.sort][query.window];
    const direction = query.order === "asc" ? asc : desc;

    const [rows, [{ total }], updatedAt] = await Promise.all([
      this.db
        .select()
        .from(traderStats)
        .where(where)
        .orderBy(direction(column), asc(traderStats.address))
        .limit(query.limit)
        .offset(query.offset),
      this.db.select({ total: count() }).from(traderStats).where(where),
      this.ingest.lastImportAt(),
    ]);

    const favorites = await this.favoritesAmong(
      userId,
      rows.map((r) => r.address),
    );
    return {
      total,
      updatedAt,
      items: rows.map((row) => ({ ...toTraderStats(row), favorite: favorites.has(row.address) })),
    };
  }

  private async favoritesAmong(userId: number | null, addresses: string[]): Promise<Set<string>> {
    if (userId === null || addresses.length === 0) return new Set();
    const rows = await this.db
      .select({ address: userFavorites.address })
      .from(userFavorites)
      .where(
        and(
          eq(userFavorites.userId, userId),
          eq(userFavorites.chain, CHAIN_DEFAULT),
          inArray(userFavorites.address, addresses),
        ),
      );
    return new Set(rows.map((r) => r.address));
  }

  // --- GET /traders/:address ------------------------------------------------

  /** `address` must already be validated and lowercased. */
  async profile(address: string, userId: number | null): Promise<TraderProfileResponse> {
    const [shared, favorites] = await Promise.all([
      this.profileCache.get(address, () => this.loadProfile(address)),
      this.favoritesAmong(userId, [address]),
    ]);
    return { ...shared, favorite: favorites.has(address) };
  }

  private async loadProfile(address: string): Promise<SharedProfile> {
    const dexes = await this.perpDexes();
    const [states, statsRows, tracked] = await Promise.all([
      Promise.all(dexes.map((dex) => this.info.clearinghouseState(address, dex || undefined, LANE, RANK))),
      this.db
        .select()
        .from(traderStats)
        .where(and(eq(traderStats.chain, CHAIN_DEFAULT), eq(traderStats.address, address)))
        .limit(1),
      this.isTracked(address),
    ]);
    const stats = statsRows[0] ? toTraderStats(statsRows[0]) : null;
    const analytics = tracked
      ? summarizeRoundTrips(
          await this.roundTrips.reconstructRoundTrips(address),
          new Date(Date.now() - ANALYTICS_WINDOW_MS),
        )
      : null;
    return {
      address,
      displayName: stats?.displayName ?? null,
      stats,
      ...summarizeAccount(states),
      tracked,
      analytics,
      fetchedAt: new Date(),
    };
  }

  /**
   * Dexes to query for an address we know nothing about: the main dex ("")
   * plus every HIP-3 dex with at least one listed market. Cached for an
   * hour.
   */
  perpDexes(): Promise<string[]> {
    return this.dexCache.get("dexes", async () => {
      const list = await this.info.perpDexs(LANE, RANK);
      const hip3 = list
        .filter((d): d is NonNullable<typeof d> => d !== null && (d.assetToStreamingOiCap?.length ?? 0) > 0)
        .map((d) => d.name);
      return ["", ...hip3];
    });
  }

  async isTracked(address: string): Promise<boolean> {
    const rows = await this.db
      .select({ address: leaders.address })
      .from(leaders)
      .where(and(eq(leaders.chain, CHAIN_DEFAULT), eq(leaders.address, address), eq(leaders.active, true)))
      .limit(1);
    return rows.length > 0;
  }

  // --- GET /traders/:address/portfolio -------------------------------------

  async portfolio(address: string, query: PortfolioQuery): Promise<PortfolioResponse> {
    const raw = await this.portfolioCache.get(address, () => this.info.portfolio(address, LANE, RANK));
    return toPortfolioResponse(raw, query.window, query.market);
  }

  // --- GET /traders/sparklines ---------------------------------------------

  /** Whole-account PnL series per address (≤ 40 points). An address whose
   * fetch fails gets an empty series rather than failing the whole row of
   * cards. */
  async sparklines(addresses: string[], window: TraderWindowInput): Promise<SparklinesResponse> {
    const entries = await Promise.all(
      addresses.map(async (address) => {
        try {
          // A fresh trader-page copy (60 s) is reused; either way one fetch.
          const raw = await this.sparklineCache.get(address, () =>
            this.portfolioCache.get(address, () => this.info.portfolio(address, LANE, RANK)),
          );
          const series = toPortfolioResponse(raw, window, "all").pnl;
          return [address, downsample(series, SPARKLINE_MAX_POINTS)] as const;
        } catch (error) {
          this.logger.warn(`Sparkline for ${address} failed: ${(error as Error).message}`);
          return [address, []] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  // --- GET /traders/:address/fills -----------------------------------------

  /** Recent perp fills, newest first: ours when the address is tracked,
   * otherwise Hyperliquid's latest. */
  async fills(address: string, limit: number): Promise<TraderFill[]> {
    if (await this.isTracked(address)) {
      const rows = await this.db
        .select({
          tid: fills.tid,
          coin: fills.coin,
          side: fills.side,
          dir: fills.dir,
          px: fills.px,
          sz: fills.sz,
          fee: fills.fee,
          closedPnl: fills.closedPnl,
          ts: fills.ts,
        })
        .from(fills)
        .where(
          and(
            eq(fills.chain, CHAIN_DEFAULT),
            eq(fills.address, address),
            notLike(fills.coin, "@%"),
            notLike(fills.coin, "%/%"),
          ),
        )
        .orderBy(desc(fills.ts), desc(fills.tid))
        .limit(limit);
      return rows.map(dbFillToTraderFill);
    }
    const raw = await this.userFillsCache.get(address, () => this.info.userFills(address, LANE, RANK));
    return raw
      .filter((f) => isPerpCoin(f.coin))
      .sort((a, b) => b.time - a.time || b.tid - a.tid)
      .slice(0, limit)
      .map(hlFillToTraderFill);
  }
}

