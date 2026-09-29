import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { and, asc, count, desc, eq, gte, ilike, inArray, like, max, notLike, or, type SQL } from "drizzle-orm";
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
import { SettingsService } from "../settings/settings.service.js";
import { LeaderboardIngestService } from "./leaderboard-ingest.service.js";
import {
  dbFillToTraderFill,
  downsample,
  hlFillToTraderFill,
  isPerpCoin,
  portfolioSeries,
  sampleFromUserFills,
  type FillSample,
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
/** Home-page warming: behind page loads, still ahead of backfill/sweeps
 * (whose rank is their arrival sequence). */
const WARM_RANK = 1;

export const PROFILE_TTL_MS = 60_000;
export const PORTFOLIO_TTL_MS = 60_000;
export const FILLS_TTL_MS = 60_000;
export const SPARKLINE_TTL_MS = 10 * 60_000;
export const DEX_LIST_TTL_MS = 60 * 60_000;
export const SPARKLINE_MAX_POINTS = 40;
/** Warmed every 10 min and kept 15, so a card never falls out of cache
 * between two warm runs (a run takes ~0.5 min at the default budget). */
export const WARM_TTL_MS = 15 * 60_000;
export const WARM_TOP_COUNT = 24;
const THIRTY_DAYS_MS = 30 * 24 * 3_600_000;

/** The profile without per-request fields (`favorite`, and `lowSample`,
 * which follows the admin's threshold), so one cached copy serves everyone. */
type SharedProfile = Omit<TraderProfileResponse, "favorite" | "sample"> & {
  sample: { fills30d: number; capped: boolean };
};

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

/** Perp coins only: spot is "@107" or "PURR/USDC". */
const perpFillsOnly = [notLike(fills.coin, "@%"), notLike(fills.coin, "%/%")];

/**
 * Discovery (Stage 2 §4, §10): the leaderboard table, and trader pages for
 * any address — live positions across dexes, sample size, portfolio history
 * with drawdown and Sharpe, recent fills. Every Hyperliquid call goes
 * through the budgeter and an in-process cache with in-flight
 * de-duplication; the home page's cards are pre-warmed.
 */
@Injectable()
export class TradersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TradersService.name);
  private warming: Promise<number> | undefined;

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
    private readonly settings: SettingsService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return;
    // After the startup import, so "top by month PnL" has data.
    this.ingest.startup.then(() => this.onWarmSchedule()).catch(() => undefined);
  }

  // --- GET /traders ---------------------------------------------------------

  async list(query: TradersQuery, userId: number | null): Promise<TradersResponse> {
    const conditions: SQL[] = [eq(traderStats.chain, CHAIN_DEFAULT)];
    const q = query.q?.trim();
    if (q) {
      conditions.push(
        or(
          like(traderStats.address, `${likeEscape(q.toLowerCase())}%`),
          ilike(traderStats.displayName, `%${likeEscape(q)}%`),
        )!,
      );
    }
    if (query.minAccountValue !== undefined) {
      conditions.push(gte(traderStats.accountValue, String(query.minAccountValue)));
    }
    const hideVaults = query.hideVaults ?? (await this.settings.get("discovery")).hideVaults;
    if (hideVaults) conditions.push(eq(traderStats.isVault, false));
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
    const [shared, favorites, discovery] = await Promise.all([
      this.profileCache.get(address, () => this.loadProfile(address)),
      this.favoritesAmong(userId, [address]),
      this.settings.get("discovery"),
    ]);
    return {
      ...shared,
      sample: { ...shared.sample, lowSample: shared.sample.fills30d < discovery.lowSampleThreshold },
      favorite: favorites.has(address),
    };
  }

  private async loadProfile(address: string): Promise<SharedProfile> {
    const since = new Date(Date.now() - THIRTY_DAYS_MS);
    const [dexes, tracked] = await Promise.all([this.perpDexes(), this.isTracked(address)]);
    const [states, statsRows, sample, analytics] = await Promise.all([
      Promise.all(dexes.map((dex) => this.info.clearinghouseState(address, dex || undefined, LANE, RANK))),
      this.db
        .select()
        .from(traderStats)
        .where(and(eq(traderStats.chain, CHAIN_DEFAULT), eq(traderStats.address, address)))
        .limit(1),
      tracked ? this.trackedSample(address, since) : this.untrackedSample(address, since),
      tracked
        ? this.roundTrips.reconstructRoundTrips(address).then((trips) => summarizeRoundTrips(trips, since))
        : null,
    ]);
    const stats = statsRows[0] ? toTraderStats(statsRows[0]) : null;
    return {
      address,
      displayName: stats?.displayName ?? null,
      stats,
      ...summarizeAccount(states),
      tracked,
      isVault: stats?.isVault ?? this.ingest.isVault(address),
      lastTradeAt: sample.lastTradeAt === null ? null : new Date(sample.lastTradeAt),
      sample: { fills30d: sample.fills30d, capped: sample.capped },
      analytics,
      fetchedAt: new Date(),
    };
  }

  /** The larger of our own perp fills in the window and Hyperliquid's latest
   * fills. Ours can have holes (an address imported less than 30 days ago,
   * backfill limits, downtime), and a hole must not make an active trader
   * look like a low sample; Hyperliquid's list stops at 2,000. */
  private async trackedSample(address: string, since: Date): Promise<FillSample> {
    const mine = and(eq(fills.chain, CHAIN_DEFAULT), eq(fills.address, address), ...perpFillsOnly);
    const [[{ n }], [{ last }], upstream] = await Promise.all([
      this.db.select({ n: count() }).from(fills).where(and(mine, gte(fills.ts, since))),
      this.db.select({ last: max(fills.ts) }).from(fills).where(mine),
      // Our count alone is still an answer if Hyperliquid is unavailable.
      this.untrackedSample(address, since).catch((): FillSample => ({ fills30d: 0, capped: false, lastTradeAt: null })),
    ]);
    const ours = last ? new Date(last).getTime() : null;
    const lastTradeAt = Math.max(ours ?? -1, upstream.lastTradeAt ?? -1);
    const count30d = n >= upstream.fills30d ? { fills30d: n, capped: false } : upstream;
    return { fills30d: count30d.fills30d, capped: count30d.capped, lastTradeAt: lastTradeAt < 0 ? null : lastTradeAt };
  }

  /** From Hyperliquid's latest fills, through the same cache the fills tab
   * reads, so opening the page pays for `userFills` once. */
  private async untrackedSample(address: string, since: Date): Promise<FillSample> {
    return sampleFromUserFills(await this.userFills(address), since.getTime());
  }

  private userFills(address: string): Promise<HlUserFill[]> {
    return this.userFillsCache.get(address, () => this.info.userFills(address, LANE, RANK));
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
          return [address, downsample(portfolioSeries(raw, window, "all").pnl, SPARKLINE_MAX_POINTS)] as const;
        } catch (error) {
          this.logger.warn(`Sparkline for ${address} failed: ${(error as Error).message}`);
          return [address, []] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  // --- home-page warming ------------------------------------------------------

  @Cron("0 */10 * * * *")
  async onWarmSchedule(): Promise<void> {
    try {
      await this.warmHome();
    } catch (error) {
      this.logger.error(`Home warm-up failed: ${(error as Error).message}`);
    }
  }

  /** The home page's trader cards: the admin's featured list, else the top
   * 24 by month PnL (vaults left out when `hideVaults` is on). */
  async homeAddresses(): Promise<string[]> {
    const discovery = await this.settings.get("discovery");
    if (discovery.featuredAddresses.length > 0) {
      return [...new Set(discovery.featuredAddresses.map((a) => a.toLowerCase()))];
    }
    const conditions: SQL[] = [eq(traderStats.chain, CHAIN_DEFAULT)];
    if (discovery.hideVaults) conditions.push(eq(traderStats.isVault, false));
    const rows = await this.db
      .select({ address: traderStats.address })
      .from(traderStats)
      .where(and(...conditions))
      .orderBy(desc(traderStats.pnlMonth), asc(traderStats.address))
      .limit(WARM_TOP_COUNT);
    return rows.map((r) => r.address);
  }

  /**
   * Re-fetches the home cards' portfolios into the sparkline cache (kept 15
   * min, re-warmed every 10), so the home page never waits on Hyperliquid.
   * Returns how many addresses were warmed. Overlapping runs share one.
   */
  warmHome(): Promise<number> {
    this.warming ??= this.runWarm().finally(() => {
      this.warming = undefined;
    });
    return this.warming;
  }

  private async runWarm(): Promise<number> {
    const addresses = await this.homeAddresses();
    const results = await Promise.allSettled(
      addresses.map((address) =>
        this.sparklineCache.refresh(address, () => this.info.portfolio(address, LANE, WARM_RANK), WARM_TTL_MS),
      ),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) this.logger.warn(`Home warm-up: ${failed}/${addresses.length} portfolios failed`);
    else this.logger.log(`Home warm-up: ${addresses.length} portfolios cached`);
    return addresses.length - failed;
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
        .where(and(eq(fills.chain, CHAIN_DEFAULT), eq(fills.address, address), ...perpFillsOnly))
        .orderBy(desc(fills.ts), desc(fills.tid))
        .limit(limit);
      return rows.map(dbFillToTraderFill);
    }
    const raw = await this.userFills(address);
    return raw
      .filter((f) => isPerpCoin(f.coin))
      .sort((a, b) => b.time - a.time || b.tid - a.tid)
      .slice(0, limit)
      .map(hlFillToTraderFill);
  }
}
