import { Optional } from "@nestjs/common";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { and, asc, count, desc, eq, gt, gte, ilike, inArray, like, max, notLike, or, sql, type SQL } from "drizzle-orm";
import {
  CHAIN_DEFAULT,
  fills,
  type ActiveWithin,
  leaders,
  traderStats,
  userFavorites,
  type PortfolioQuery,
  type PortfolioResponse,
  type SparklinesResponse,
  type TraderActivityResponse,
  type TraderFill,
  type TraderProfileResponse,
  type TradersQuery,
  type TradersResponse,
  type TraderWindowInput,
} from "@trading-dashboard/shared";

import { RoundTripService } from "../analytics/round-trip.service.js";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { HyperliquidInfoClient, twapSliceToFill } from "../hyperliquid/hyperliquid-info.client.js";
import { PAGE_RANK } from "../hyperliquid/request-budgeter.service.js";
import type { HlPortfolioResponse, HlUserFill } from "../hyperliquid/types.js";
import { SettingsService } from "../settings/settings.service.js";
import { LeaderboardIngestService } from "./leaderboard-ingest.service.js";
import { SpotPriceService } from "./spot-price.service.js";
import { hypePrice, stakedHype, toAccountMode, totalAccountValue } from "./spot-prices.js";
import {
  dbFillToTraderFill,
  downsample,
  hlFillToTraderFill,
  isPerpCoin,
  portfolioSeries,
  sampleFromLists,
  type FillSample,
  summarizeAccount,
  summarizeRoundTrips,
  toPortfolioResponse,
  toTraderStats,
} from "./traders.mappers.js";
import { TtlCache } from "./ttl-cache.js";

/**
 * Page loads go ahead of backfill and sweeps (lower rank first within the
 * background lane) but never ahead of live detection (the live lane). Within
 * a page, the first paint (profile: account value, positions) goes first,
 * then the chart, then the fill lists; home warming after all of them.
 */
const LANE = "background" as const;

/** Positions and account value: live data. */
export const PROFILE_TTL_MS = 60_000;
export const PORTFOLIO_TTL_MS = 60_000;
/** Hyperliquid's latest fill and TWAP slice lists, for addresses we don't
 * store fills for (a tracked address's fills tab reads our table). They
 * cost up to 120 weight each, 3–6× a whole profile, so they are kept
 * longer: the fills tab and activity of an untracked trader are up to 5 min
 * old. */
export const FILLS_TTL_MS = 5 * 60_000;
export const SPARKLINE_TTL_MS = 10 * 60_000;
export const DEX_LIST_TTL_MS = 60 * 60_000;
/** Account mode (unified / portfolio margin / standard) and staked HYPE:
 * both change rarely and cost 20 weight each, so they are kept longer than
 * the profile. Staking is revalued at the current HYPE price every time. */
export const ACCOUNT_MODE_TTL_MS = 10 * 60_000;
export const STAKING_TTL_MS = 10 * 60_000;
export const SPARKLINE_MAX_POINTS = 40;
/** Warmed every 10 min and kept 15, so a card never falls out of cache
 * between two warm runs (a run takes ~0.5 min at the default budget). */
export const WARM_TTL_MS = 15 * 60_000;
export const WARM_TOP_COUNT = 24;
const THIRTY_DAYS_MS = 30 * 24 * 3_600_000;

/** The profile without the per-request `favorite`, so one cached copy
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

/** Volume column per activity filter: "traded within the window" means that
 * window's leaderboard volume is above zero (Stage 2 §12). */
const ACTIVE_VOLUME_COLUMNS = {
  day: traderStats.volumeDay,
  week: traderStats.volumeWeek,
  month: traderStats.volumeMonth,
} as const;

/** The WHERE condition for an activity filter; none for "any". */
export function activeCondition(active: ActiveWithin): SQL | undefined {
  return active === "any" ? undefined : gt(ACTIVE_VOLUME_COLUMNS[active], "0");
}

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
  readonly twapFillsCache = new TtlCache<HlUserFill[]>(FILLS_TTL_MS);
  readonly dexCache = new TtlCache<string[]>(DEX_LIST_TTL_MS, 1);
  /** Hyperliquid's `userAbstraction` per address (rarely changes). */
  readonly abstractionCache = new TtlCache<string>(ACCOUNT_MODE_TTL_MS);
  /** Staked HYPE per address, in HYPE; valued with the live price book. */
  readonly stakingCache = new TtlCache<number>(STAKING_TTL_MS);
  readonly spotPrices: SpotPriceService;

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly info: HyperliquidInfoClient,
    private readonly roundTrips: RoundTripService,
    private readonly ingest: LeaderboardIngestService,
    private readonly settings: SettingsService,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
    @Optional() spotPrices?: SpotPriceService,
  ) {
    this.spotPrices = spotPrices ?? new SpotPriceService(info);
  }

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return;
    // The first trader page after a deploy then needs one request, not two.
    this.perpDexes().catch(() => undefined);
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
    const discovery = await this.settings.get("discovery");
    const hideVaults = query.hideVaults ?? discovery.hideVaults;
    if (hideVaults) conditions.push(eq(traderStats.isVault, false));
    const active = activeCondition(query.active ?? discovery.defaultActiveWithin);
    if (active) conditions.push(active);
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

  /**
   * The first paint: identity, account value, positions across dexes, the
   * leaderboard stats and (tracked) our own analytics. No fill lists: those
   * are `activity()`. `address` must already be validated and lowercased.
   */
  async profile(address: string, userId: number | null): Promise<TraderProfileResponse> {
    const [shared, favorites] = await Promise.all([
      this.profileCache.get(address, () => this.loadProfile(address)),
      this.favoritesAmong(userId, [address]),
    ]);
    return { ...shared, favorite: favorites.has(address) };
  }

  /**
   * Account value = perp (every dex) + spot + staked HYPE, except that a
   * unified or portfolio-margin account's spot balance already holds its
   * perp collateral (`totalAccountValue`). Costs, per cold profile: 2 per
   * dex and 2 for spot; the account mode and staking (20 each) are kept 10
   * min, the spot price book (22) 30 s app-wide.
   */
  private async loadProfile(address: string): Promise<SharedProfile> {
    const since = new Date(Date.now() - THIRTY_DAYS_MS);
    const [dexes, tracked] = await Promise.all([this.perpDexes(), this.isTracked(address)]);
    const [states, spot, abstraction, staked, book, statsRows, analytics] = await Promise.all([
      Promise.all(
        dexes.map((dex) => this.info.clearinghouseState(address, dex || undefined, LANE, PAGE_RANK.profile)),
      ),
      this.info.spotClearinghouseState(address, LANE, PAGE_RANK.profile),
      this.abstractionCache.get(address, () => this.info.userAbstraction(address, LANE, PAGE_RANK.profile)),
      this.stakingCache.get(address, async () =>
        stakedHype(await this.info.delegatorSummary(address, LANE, PAGE_RANK.profile)),
      ),
      this.spotPrices.book(LANE, PAGE_RANK.profile),
      this.db
        .select()
        .from(traderStats)
        .where(and(eq(traderStats.chain, CHAIN_DEFAULT), eq(traderStats.address, address)))
        .limit(1),
      tracked
        ? this.roundTrips.reconstructRoundTrips(address).then((trips) => summarizeRoundTrips(trips, since))
        : null,
    ]);
    const stats = statsRows[0] ? toTraderStats(statsRows[0]) : null;
    const perp = summarizeAccount(states);
    const { spotValue, balances } = this.spotPrices.value(spot.balances ?? [], book);
    const stakedValue = staked * hypePrice(book);
    const accountMode = toAccountMode(abstraction, spot.portfolioMarginEnabled ?? false);
    return {
      address,
      displayName: stats?.displayName ?? null,
      stats,
      ...perp,
      accountValue: totalAccountValue(accountMode, perp.perpEquity, spotValue, stakedValue),
      spotValue,
      stakedValue,
      accountMode,
      spotBalances: balances,
      perpDexes: dexes,
      tracked,
      isVault: stats?.isVault ?? this.ingest.isVault(address),
      analytics,
      fetchedAt: new Date(),
    };
  }

  // --- GET /traders/:address/activity ---------------------------------------

  /** Sample size and last trade, from fills (TWAP slices included). Apart
   * from the profile because the fill lists cost far more weight. */
  async activity(address: string): Promise<TraderActivityResponse> {
    const since = new Date(Date.now() - THIRTY_DAYS_MS);
    const [tracked, discovery] = await Promise.all([this.isTracked(address), this.settings.get("discovery")]);
    const sample = tracked ? await this.trackedSample(address, since) : await this.untrackedSample(address, since);
    return {
      address,
      lastTradeAt: sample.lastTradeAt === null ? null : new Date(sample.lastTradeAt),
      sample: {
        fills30d: sample.fills30d,
        capped: sample.capped,
        lowSample: sample.fills30d < discovery.lowSampleThreshold,
      },
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

  /** From Hyperliquid's latest fills and TWAP slices, through the same
   * caches the fills tab reads, so opening the page pays for each once. */
  private async untrackedSample(address: string, since: Date): Promise<FillSample> {
    return sampleFromLists(await this.latestFills(address), since.getTime());
  }

  /** `userFills` and the latest TWAP slices (which it doesn't include). */
  private latestFills(address: string): Promise<[HlUserFill[], HlUserFill[]]> {
    return Promise.all([
      this.userFillsCache.get(address, () => this.info.userFills(address, LANE, PAGE_RANK.fills)),
      this.twapFillsCache.get(address, async () =>
        (await this.info.userTwapSliceFills(address, LANE, PAGE_RANK.fills)).map(twapSliceToFill),
      ),
    ]);
  }

  /**
   * Dexes to query for an address we know nothing about: the main dex ("")
   * plus every HIP-3 dex with at least one listed market. Cached for an
   * hour.
   */
  perpDexes(): Promise<string[]> {
    return this.dexCache.get("dexes", async () => {
      const list = await this.info.perpDexs(LANE, PAGE_RANK.profile);
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
    const raw = await this.portfolioCache.get(address, () =>
      this.info.portfolio(address, LANE, PAGE_RANK.portfolio),
    );
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
            this.portfolioCache.get(address, () => this.info.portfolio(address, LANE, PAGE_RANK.fills)),
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

  /** The home page's trader cards: the admin's featured list (always kept,
   * active or not), else the top 24 by month PnL among what the home list
   * shows: no vaults while `hideVaults` is on, and only accounts that traded
   * within `defaultActiveWithin`, so 30-day holders aren't warmed (§12). */
  async homeAddresses(): Promise<string[]> {
    const discovery = await this.settings.get("discovery");
    if (discovery.featuredAddresses.length > 0) {
      return [...new Set(discovery.featuredAddresses.map((a) => a.toLowerCase()))];
    }
    const conditions: SQL[] = [eq(traderStats.chain, CHAIN_DEFAULT)];
    if (discovery.hideVaults) conditions.push(eq(traderStats.isVault, false));
    const active = activeCondition(discovery.defaultActiveWithin);
    if (active) conditions.push(active);
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
    if (this.jobs.stopping) return Promise.resolve(0);
    this.warming ??= this.jobs.run(() => this.runWarm()).finally(() => {
      this.warming = undefined;
    });
    return this.warming;
  }

  private async runWarm(): Promise<number> {
    const addresses = await this.homeAddresses();
    const results = await Promise.allSettled(
      addresses.map((address) =>
        this.sparklineCache.refresh(address, () => this.info.portfolio(address, LANE, PAGE_RANK.warm), WARM_TTL_MS),
      ),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) this.logger.warn(`Home warm-up: ${failed}/${addresses.length} portfolios failed`);
    else this.logger.log(`Home warm-up: ${addresses.length} portfolios cached`);
    return addresses.length - failed;
  }

  // --- GET /traders/:address/fills -----------------------------------------

  /** Recent perp fills, newest first, TWAP slices included (with their
   * `twapId`): ours when the address is tracked, otherwise Hyperliquid's
   * latest fills and TWAP slices merged. */
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
          twapId: sql<string | null>`${fills.raw}->>'twapId'`,
        })
        .from(fills)
        .where(and(eq(fills.chain, CHAIN_DEFAULT), eq(fills.address, address), ...perpFillsOnly))
        .orderBy(desc(fills.ts), desc(fills.tid))
        .limit(limit);
      return rows.map(dbFillToTraderFill);
    }
    const [regular, twap] = await this.latestFills(address);
    return [...regular, ...twap]
      .filter((f) => isPerpCoin(f.coin))
      .sort((a, b) => b.time - a.time || b.tid - a.tid)
      .slice(0, limit)
      .map(hlFillToTraderFill);
  }
}
