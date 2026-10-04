import { AppConfig } from "../config/app-config.js";
import { Optional } from "@nestjs/common";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { Injectable, Logger } from "@nestjs/common";
import {
  type PortfolioQuery,
  type PortfolioResponse,
  type SparklinesResponse,
  type TraderActivityResponse,
  type TraderFill,
  type TraderOrdersResponse,
  type TraderProfileResponse,
  type TradersQuery,
  type TradersResponse,
  type TraderTransfersResponse,
  type TraderTwapsResponse,
  type TraderWindowInput,
} from "@trading-dashboard/shared/contracts";

import { FILL_PAGE, readForward } from "../analytics/fill-history.js";
import { RoundTripService } from "../analytics/round-trip.service.js";
import { AnalysisHistoryService } from "./analysis-history.service.js";
import { TradersRepository } from "./traders.repository.js";
import { HyperliquidInfoClient, LEDGER_MAX_ITEMS, twapSliceToFill } from "../hyperliquid/hyperliquid-info.client.js";
import { PAGE_RANK } from "../hyperliquid/request-budgeter.service.js";
import type { HlLedgerUpdate, HlPortfolioResponse, HlUserFill } from "../hyperliquid/types.js";
import { TraderOrdersReader } from './trader-orders-reader.js';
import { TraderTwapReader } from './trader-twap-reader.js';
import { TraderAccountReader } from './trader-account-reader.js';
import { LiveBoundaryError } from '../copy/live/wallet-authorization.js';
import { activeTwaps, mergeOrders, toTraderTransfer } from "./trader-tabs.mappers.js";
import { SettingsService } from "../settings/settings.service.js";
import { LeaderboardIngestService } from "./leaderboard-ingest.service.js";
import { SPOT_PRICE_TTL_MS, SpotPriceService } from "./spot-price.service.js";
import { hypePrice, stakedHype, toAccountMode, totalAccountValue } from "./spot-prices.js";
import {
  activePerpDexes,
  dbFillToTraderFill,
  downsample,
  hlFillToTraderFill,
  portfolioSeries,
  sampleFromLists,
  type FillSample,
  summarizeAccount,
  summarizeRoundTrips,
  toPortfolioResponse,
  toTraderStats,
} from "./traders.mappers.js";
import { TtlCache } from "./ttl-cache.js";
import { kolAvatarPath } from "../discovery/kol-avatar.js";
import { KolAvatarRepository } from "../discovery/kol-avatar.repository.js";

/**
 * Page loads go ahead of backfill and sweeps (lower rank first within the
 * background lane) but never ahead of live detection (the live lane). Within
 * a page, the first paint (profile: account value, positions) goes first,
 * then the chart, then the fill lists.
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
/** 訂單 / TWAP / 轉帳 tabs: loaded when opened, kept this long. */
export const ORDERS_TTL_MS = 30_000;
export const TWAP_TTL_MS = 60_000;
export const TRANSFERS_TTL_MS = 5 * 60_000;
/** The 轉帳 tab reads the last 90 days … */
export const TRANSFERS_WINDOW_MS = 90 * 24 * 3_600_000;
/** … at most this many rows, the newest … */
export const TRANSFERS_MAX_ROWS = 500;
/** … in at most this many calls. */
export const TRANSFERS_MAX_PAGES = 3;
export const SPARKLINE_MAX_POINTS = 40;
/** A sparkline batch answers with what is ready by then (see `sparklines`). */
export const SPARKLINE_DEADLINE_MS = 8_000;
/** A discovery-pool sparkline older than this is fetched instead. */
export const POOL_SPARKLINE_MAX_AGE_MS = 24 * 3_600_000;
const DAY_MS = 86_400_000;
type SeriesPoint = [number, number];
const THIRTY_DAYS_MS = 30 * 24 * 3_600_000;

/** Stored sparkline values as a series ending at `endMs`, spread evenly
 * over `spanMs`, at most `SPARKLINE_MAX_POINTS`. */
export function poolSeries(values: number[], endMs: number, spanMs: number): SeriesPoint[] {
  if (values.length === 1) return [[endMs, values[0]]];
  const step = spanMs / (values.length - 1);
  return downsample(values.map((v, i): SeriesPoint => [Math.round(endMs - spanMs + i * step), v]), SPARKLINE_MAX_POINTS);
}

/** The profile without the per-request `favorite`, so one cached copy
 * serves everyone. */
type SharedProfile = Omit<TraderProfileResponse, "favorite">;

/**
 * Discovery (Stage 2 §4, §10): the leaderboard table, and trader pages for
 * any address — live positions across dexes, sample size, portfolio history
 * with drawdown and Sharpe, recent fills. Every Hyperliquid call goes
 * through the budgeter and an in-process cache with in-flight
 * de-duplication.
 */
@Injectable()
export class TradersService {
  private readonly logger = new Logger(TradersService.name);
  /** Settable for tests. */
  sparklineDeadlineMs = SPARKLINE_DEADLINE_MS;
  profileSourceDeadlineMs = 4_000;

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
  readonly ordersCache = new TtlCache<TraderOrdersResponse>(ORDERS_TTL_MS);
  /** Order coverage includes every named venue, even without streaming OI. */
  readonly ordersDexCache = new TtlCache<string[]>(60_000, 1);
  readonly twapCache = new TtlCache<TraderTwapsResponse>(TWAP_TTL_MS);
  readonly transfersCache = new TtlCache<TraderTransfersResponse>(TRANSFERS_TTL_MS);
  readonly spotPrices: SpotPriceService;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: TradersRepository,
    private readonly info: HyperliquidInfoClient,
    private readonly roundTrips: RoundTripService,
    private readonly ingest: LeaderboardIngestService,
    private readonly settings: SettingsService,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
    @Optional() spotPrices?: SpotPriceService,
    @Optional() private readonly kols?: KolAvatarRepository,
    @Optional() private readonly history?: AnalysisHistoryService,
    @Optional() private readonly orderReader?: TraderOrdersReader,
    @Optional() private readonly twapReader?: TraderTwapReader,
    @Optional() private readonly accountReader?: TraderAccountReader,
  ) {
    this.spotPrices = spotPrices ?? new SpotPriceService(info);
  }

  // --- GET /traders ---------------------------------------------------------

  async list(query: TradersQuery, userId: number | null): Promise<TradersResponse> {
    const discovery = await this.settings.get("discovery");
    const [{ rows, total }, updatedAt] = await Promise.all([this.repository.findPage(query, discovery), this.ingest.lastImportAt()]);

    const favorites = await this.repository.favoritesAmong(
      userId,
      rows.map((r) => r.address),
    );
    return {
      total,
      updatedAt,
      items: rows.map((row) => ({ ...toTraderStats(row), favorite: favorites.has(row.address) })),
    };
  }

  // --- GET /traders/:address ------------------------------------------------

  /**
   * The first paint: identity, account value, positions across dexes, the
   * leaderboard stats and (tracked) our own analytics. No fill lists: those
   * are `activity()`. `address` must already be validated and lowercased.
   */
  async profile(address: string, userId: number | null): Promise<TraderProfileResponse> {
    const [shared, favorites, kol] = await Promise.all([
      this.profileCache.get(address, () => this.loadProfile(address), value => value.dataQuality?.partial ? 5_000 : PROFILE_TTL_MS, PAGE_RANK.profile),
      this.repository.favoritesAmong(userId, [address]),
      this.kols?.card(address),
    ]);
    const dataQuality = shared.dataQuality && { ...shared.dataQuality, sources: Object.fromEntries(
      Object.entries(shared.dataQuality.sources).map(([key, source]) => [key, { ...source,
        stale: source.asOf !== null && Date.now() - Date.parse(source.asOf) > source.maxAgeMs,
      }]),
    ) };
    // The KOL entry is read per request (one indexed row), so an admin's
    // edit or a newly cached avatar shows without waiting for the profile TTL.
    const card = kol ? { displayName: kol.displayName, xHandle: kol.xHandle, verified: kol.verified, avatarUrl: kolAvatarPath(address, kol.avatarEtag) } : null;
    return { ...shared, displayName: kol?.displayName ?? shared.displayName, dataQuality, favorite: favorites.has(address), kol: card };
  }

  /**
   * Account value = perp (every dex) + spot + staked HYPE, except that a
   * unified or portfolio-margin account's spot balance already holds its
   * perp collateral (`totalAccountValue`). A vault's account value is its
   * TVL: the latest whole-account value of Hyperliquid's `portfolio` (the
   * figure Hyperliquid's own vault page, its leaderboard and CopyDog show).
   * A parent vault's clearinghouse state holds only its own perp equity,
   * not what it has in its child vaults (HLP: $43.5M against a $183M TVL,
   * 2026-10-02), so the sum above is wrong for vaults. Costs, per cold
   * profile: one all-venue state subscription and 2 for spot; account mode and staking (20
   * each) are kept 10 min, the spot price book (22) 30 s app-wide; a
   * vault's `portfolio` (20) is the chart's own 60 s copy.
   */
  private async loadProfile(address: string): Promise<SharedProfile> {
    const since = new Date(Date.now() - THIRTY_DAYS_MS);
    const sources: NonNullable<SharedProfile["dataQuality"]>["sources"] = {};
    const read = async <T>(key: string, load: () => Promise<T>, maxAgeMs: number,
      optional = false, observedAt?: () => number | null): Promise<T | null> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const pending = load();
        const value = optional ? await Promise.race([pending, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Source deadline")), this.profileSourceDeadlineMs);
        })]) : await pending;
        const observed = observedAt ? observedAt() : Date.now();
        sources[key] = { status: "available", asOf: observed === null ? null : new Date(observed).toISOString(), stale: false, maxAgeMs };
        return value;
      } catch (error) {
        if (!optional) throw error;
        sources[key] = { status: "unavailable", asOf: null, stale: false, maxAgeMs };
        this.logger.warn(`Profile source unavailable: ${key}`);
        return null;
      } finally { clearTimeout(timer); }
    };
    // Identity/tracking, the dex universe, spot valuation and account mode are
    // required. Without them the accounting scope itself would be a guess.
    const [dexes, tracked, vault] = await Promise.all([this.accountReader ? this.allDexes() : this.perpDexes(), this.isTracked(address), this.isVault(address)]);
    sources.dexes = { status: "available", asOf: new Date((this.accountReader ? this.ordersDexCache : this.dexCache).observedAt("dexes") ?? Date.now()).toISOString(), stale: false,
      maxAgeMs: this.accountReader ? 60000 : DEX_LIST_TTL_MS };
    const statesWork = this.accountReader ? (async () => {
      let receivedAt: number | null = null;
      const snapshot = await read('perps', async () => {
        const result = await this.accountReader!.read(address, dexes);
        receivedAt = result.observedAt;
        return result;
      }, PROFILE_TTL_MS, true, () => receivedAt);
      return dexes.map(dex => {
        const state = snapshot?.states.get(dex) ?? null;
        const at = state ? state.time > 0 ? state.time : snapshot!.observedAt : null;
        sources[`perp:${dex || 'main'}`] = { status: state ? 'available' : 'unavailable', asOf: at === null ? null : new Date(at).toISOString(),
          stale: at !== null && Date.now() - at > PROFILE_TTL_MS, maxAgeMs: PROFILE_TTL_MS };
        return state;
      });
    })() : Promise.all(dexes.map(dex => read(`perp:${dex || 'main'}`,
      () => this.info.clearinghouseState(address, dex || undefined, LANE, PAGE_RANK.profile), PROFILE_TTL_MS, true)));
    let statsMaxAgeMs = PROFILE_TTL_MS;
    const [states, spot, abstraction, staked, book, statsRows, analytics, vaultPortfolio] = await Promise.all([
      statesWork,
      read("spot", () => this.info.spotClearinghouseState(address, LANE, PAGE_RANK.profile), PROFILE_TTL_MS),
      read("accountMode", () => this.abstractionCache.get(address, () => this.info.userAbstraction(address, LANE, PAGE_RANK.profile), ACCOUNT_MODE_TTL_MS, PAGE_RANK.profile),
        ACCOUNT_MODE_TTL_MS, false, () => this.abstractionCache.observedAt(address)),
      read("staking", () => this.stakingCache.get(address, async () => stakedHype(await this.info.delegatorSummary(address, LANE, PAGE_RANK.profile)), STAKING_TTL_MS, PAGE_RANK.profile),
        STAKING_TTL_MS, true, () => this.stakingCache.observedAt(address)),
      read("prices", () => this.spotPrices.book(LANE, PAGE_RANK.profile), SPOT_PRICE_TTL_MS, false, () => this.spotPrices.cache.observedAt("book")),
      read("stats", async () => {
        statsMaxAgeMs = await this.ingest.refreshIntervalMs();
        return this.repository.findStats(address);
      }, PROFILE_TTL_MS, true),
      read("analytics", async () => tracked ? summarizeRoundTrips(await this.roundTrips.reconstructRoundTrips(address), since) : null, PROFILE_TTL_MS, true),
      // A vault's TVL is required: without it the headline figure would be
      // its own perp equity, a fraction of the TVL for a parent vault.
      vault ? read("portfolio", () => this.rawPortfolio(address), PORTFOLIO_TTL_MS, false, () => this.portfolioCache.observedAt(address)) : Promise.resolve(null),
    ]);
    if (spot === null || abstraction === null || book === null) throw new Error("Required profile source unavailable");
    const tvl = vaultPortfolio === null ? null : (portfolioSeries(vaultPortfolio, "allTime", "all").accountValue.at(-1)?.[1] ?? null);
    const stats = statsRows?.[0] ? toTraderStats(statsRows[0]) : null;
    if (statsRows?.[0]) {
      sources.stats.asOf = statsRows[0].updatedAt.toISOString();
      sources.stats.maxAgeMs = statsMaxAgeMs;
    }
    const perp = summarizeAccount(states.filter(state => state !== null));
    const completePerps = states.every(state => state !== null);
    const { spotValue, balances } = this.spotPrices.value(spot.balances ?? [], book);
    const stakedValue = staked === null ? null : staked * hypePrice(book);
    const accountMode = toAccountMode(abstraction, spot.portfolioMarginEnabled ?? false);
    return {
      address, displayName: stats?.displayName ?? null, stats, ...perp,
      perpEquity: completePerps ? perp.perpEquity : null,
      marginUsed: completePerps ? perp.marginUsed : null,
      maintenanceMarginUsed: completePerps ? perp.maintenanceMarginUsed : null,
      withdrawable: completePerps ? perp.withdrawable : null,
      longNotional: completePerps ? perp.longNotional : null,
      shortNotional: completePerps ? perp.shortNotional : null,
      accountValue: vault ? tvl : completePerps && stakedValue !== null ? totalAccountValue(accountMode, perp.perpEquity, spotValue, stakedValue) : null,
      spotValue, stakedValue, accountMode, spotBalances: balances, perpDexes: dexes, tracked,
      isVault: vault, analytics,
      dataQuality: { partial: Object.values(sources).some(source => source.status === "unavailable"), sources },
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
    const [{ n, last }, upstream] = await Promise.all([
      this.repository.fillSample(address, since),
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

  /** `userFills` and the latest TWAP slices (which it doesn't include):
   * the newest 2,000 of each. Where the archive certifies a span that
   * alone holds a full page, the page is the stored fills plus REST's
   * fills after the span (20 weight and up instead of 120). */
  latestFills(address: string): Promise<[HlUserFill[], HlUserFill[]]> {
    return Promise.all([
      this.userFillsCache.get(address, async () =>
        (await this.archivedLatest(address, "regular")) ?? this.info.userFills(address, LANE, PAGE_RANK.fills), FILLS_TTL_MS, PAGE_RANK.fills),
      this.twapFillsCache.get(address, async () =>
        (await this.archivedLatest(address, "twap")) ?? (await this.info.userTwapSliceFills(address, LANE, PAGE_RANK.fills)).map(twapSliceToFill), FILLS_TTL_MS, PAGE_RANK.fills),
    ]);
  }

  /**
   * The newest `FILL_PAGE` fills of one stream from the archive's span and
   * REST's tail after it, newest first as Hyperliquid lists them; null
   * when REST has to answer: the stream is not trusted to the archive
   * (`S3_ARCHIVE_TRUST`), the address has no span, the span holds less
   * than a page (REST's page reaches further back), or the tail does not
   * fit two calls.
   */
  private async archivedLatest(address: string, source: "regular" | "twap"): Promise<HlUserFill[] | null> {
    if (!this.history?.trusts(source)) return null;
    const span = await this.history.archiveSpan(address).catch(() => null);
    if (!span) return null;
    const stored = await this.history.recentFills(address, source, span, FILL_PAGE);
    if (stored.length < FILL_PAGE) return null;
    const now = Date.now();
    // An account that fills a page faster than the archive lags (thousands
    // of fills an hour) has its whole page after the span: REST's one list
    // is the answer, and reading the tail first would cost two more.
    const times = stored.map((fill) => fill.time);
    const pageMs = Math.max(...times) - Math.min(...times);
    if (pageMs <= now - span.through) return null;
    const tail = await readForward(async (since) => source === "twap"
      ? (await this.info.userTwapSliceFillsByTime(address, since, now, LANE, PAGE_RANK.fills)).map(twapSliceToFill)
      : this.info.userFillsByTime(address, since, now, LANE, PAGE_RANK.fills), span.through, 2);
    if (!tail.complete) return null;
    const byTid = new Map([...stored, ...tail.fills].map((fill) => [fill.tid, fill]));
    return [...byTid.values()].sort((a, b) => b.time - a.time || b.tid - a.tid).slice(0, FILL_PAGE);
  }

  /**
   * Dexes to query for an address we know nothing about: the main dex ("")
   * plus every HIP-3 dex with at least one listed market. Cached for an
   * hour.
   */
  perpDexes(): Promise<string[]> {
    return this.dexCache.get("dexes", async () => activePerpDexes(await this.info.perpDexs(LANE, PAGE_RANK.profile)));
  }

  isTracked(address: string) { return this.repository.isTracked(address); }

  /** A vault (parent, child or a user's), from the imported leaderboard row
   * or, for an address not on it, the last vault list fetched. */
  private async isVault(address: string): Promise<boolean> {
    const [row] = await this.repository.findStats(address);
    return row?.isVault ?? this.ingest.isVault(address);
  }

  /** Hyperliquid's leaderboard all-time PnL, as last imported; null for an
   * address not on the leaderboard. */
  async leaderboardAllTimePnl(address: string): Promise<number | null> {
    const [row] = await this.repository.findStats(address);
    return row ? toTraderStats(row).pnl.allTime : null;
  }

  // --- GET /traders/:address/portfolio -------------------------------------

  async portfolio(address: string, query: PortfolioQuery): Promise<PortfolioResponse> {
    return toPortfolioResponse(await this.rawPortfolio(address), query.window, query.market);
  }

  /** Hyperliquid's `portfolio`, through the page's 60 s cache, at the
   * chart's rank: a sparkline batch's read of the same address (rank 2) is
   * not joined, a fresh read goes out ahead of it. */
  rawPortfolio(address: string): Promise<HlPortfolioResponse> {
    return this.portfolioCache.get(address, () => this.info.portfolio(address, LANE, PAGE_RANK.portfolio), PORTFOLIO_TTL_MS, PAGE_RANK.portfolio);
  }

  // --- GET /traders/sparklines ---------------------------------------------

  /**
   * Whole-account PnL series per address (≤ 40 points). An address whose
   * fetch fails gets an empty series rather than failing the whole row of
   * cards. Answers within `sparklineDeadlineMs` with the addresses that are
   * ready and leaves the others out: a cold page of 25 untracked traders
   * costs 500 weight, more than the budget spends inside the 20 s request
   * deadline, and waiting for all of them used to time the whole column out
   * (the explore page's empty 走勢 column). Calls already sent keep loading
   * into the cache, so the client's retry for the missing ones is fast;
   * calls still queued are dropped with the answer. A fetch that
   * times out in the budget queue is left out too (asked for again); only a
   * real failure answers [].
   *
   * Hyperliquid is the last resort. An address not in the in-process caches
   * is served from the discovery pool's stored sparkline when the window
   * is one the pool keeps (month, all-time): its perp PnL series, the
   * points spread evenly over the window (the pool keeps values, not
   * times). An anonymous caller (`known: "listed"`) only makes us fetch
   * addresses the site lists (leaderboard or pool); any other address
   * answers [] without a call. Fetches count as page work: past the
   * budget's page caps they are left out (asked for again), and once the
   * answer is sent those still queued are dropped.
   */
  async sparklines(addresses: string[], window: TraderWindowInput, { fetch = "any" }: { fetch?: "any" | "listed" } = {}): Promise<SparklinesResponse> {
    const ready: SparklinesResponse = {};
    const cold = addresses.filter((a) => this.sparklineCache.peek(a) === undefined && this.portfolioCache.peek(a) === undefined);
    const fromPool = await this.poolSparklines(cold, window);
    for (const [address, series] of fromPool) ready[address] = series;
    let fetchable = addresses.filter((a) => !fromPool.has(a));
    if (fetch === "listed") {
      const unknown = cold.filter((a) => !fromPool.has(a));
      const known = await this.repository.knownAddresses(unknown);
      for (const address of unknown) if (!known.has(address)) ready[address] = [];
      fetchable = fetchable.filter((a) => !(a in ready));
    }
    const all = Promise.all(
      fetchable.map(async (address) => {
        try {
          // A fresh trader-page copy (60 s) is reused; either way one fetch.
          const raw = await this.sparklineCache.get(address, () =>
            this.portfolioCache.get(address, () => this.info.portfolio(address, LANE, PAGE_RANK.fills), PORTFOLIO_TTL_MS, PAGE_RANK.fills),
          SPARKLINE_TTL_MS, PAGE_RANK.fills);
          ready[address] = downsample(portfolioSeries(raw, window, "all").pnl, SPARKLINE_MAX_POINTS);
        } catch (error) {
          // Timed out waiting for the request budget (or shutting down): still
          // loading, not failed. Left out, so the client asks again.
          const name = (error as Error | undefined)?.name;
          if (name === "TimeoutError" || name === "AbortError" || name === "PageBusyError") return;
          this.logger.warn(`Sparkline for ${address} failed: ${(error as Error).message}`);
          ready[address] = [];
        }
      }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.sparklineDeadlineMs);
    });
    try {
      await Promise.race([all, deadline]);
    } finally {
      clearTimeout(timer);
    }
    return { ...ready };
  }

  /** Sparklines from the discovery pool for `window`, where it has them. */
  private async poolSparklines(addresses: string[], window: TraderWindowInput): Promise<Map<string, SeriesPoint[]>> {
    const out = new Map<string, SeriesPoint[]>();
    if (addresses.length === 0 || (window !== "month" && window !== "allTime")) return out;
    const rows = await this.repository.poolSparklines(addresses);
    const now = Date.now();
    for (const row of rows) {
      const at = row.portfolioAt?.getTime();
      if (at === undefined || now - at > POOL_SPARKLINE_MAX_AGE_MS) continue;
      const values = window === "month" ? row.sparkline30d : row.sparkline;
      const spanMs = window === "month" ? 30 * DAY_MS : Number(row.spanDays ?? 0) * DAY_MS;
      if (values.length === 0 || !(spanMs > 0)) continue;
      out.set(row.address, poolSeries(values, at, spanMs));
    }
    return out;
  }

  // --- GET /traders/:address/fills -----------------------------------------

  /**
   * Recent fills, perp and spot, newest first, TWAP slices included (with
   * their `twapId`): Hyperliquid's latest fills and TWAP slices merged, as
   * CopyDog's 成交 tab lists them.
   *
   * A tracked address gets the same list, with our stored fills merged in
   * (by tid). Its tab used to be read from the watcher's table alone, which
   * holds perp fills only and, right after a favourite, only the last hour:
   * tracking a trader made its page emptier and dropped its spot fills
   * (review 43). The stored rows add what the feed has confirmed since
   * Hyperliquid's list was cached, and when Hyperliquid cannot be read
   * (busy, timeout) they are the answer on their own, so a tracked trader's
   * tab still loads where an untracked one's would be 503.
   */
  async fills(address: string, limit: number): Promise<TraderFill[]> {
    const stored = (await this.isTracked(address)) ? (await this.repository.recentFills(address, limit)).map(dbFillToTraderFill) : [];
    let upstream: TraderFill[];
    try {
      const [regular, twap] = await this.latestFills(address);
      upstream = [...regular, ...twap].map(hlFillToTraderFill);
    } catch (error) {
      if (stored.length === 0) throw error;
      this.logger.warn(`Fills of ${address}: Hyperliquid unavailable (${(error as Error).message}); serving ${stored.length} stored fills`);
      return stored;
    }
    // One row per trade: Hyperliquid's copy wins (it is the same fill).
    const byTid = new Map<string, TraderFill>();
    for (const fill of [...stored, ...upstream]) byTid.set(fill.tid, fill);
    return [...byTid.values()]
      .sort((a, b) => b.ts.getTime() - a.ts.getTime() || (BigInt(b.tid) > BigInt(a.tid) ? 1 : BigInt(b.tid) < BigInt(a.tid) ? -1 : 0))
      .slice(0, limit);
  }

  // --- GET /traders/:address/orders ----------------------------------------

  /**
   * Resting and trigger orders across every named venue, sampled through
   * official WebSocket snapshots with complete cleanup acknowledgements.
   * Collateral/account mode cannot prove another venue has no orders.
   */
  orders(address: string): Promise<TraderOrdersResponse> {
    return this.ordersCache.get(address, async () => {
      if (!this.orderReader) throw new LiveBoundaryError('trader_orders_unavailable');
      const dexes = await this.allDexes();
      const snapshot = await this.orderReader.read(address, dexes);
      return { orders: mergeOrders(snapshot.orders), dexes: snapshot.dexes, fetchedAt: new Date(snapshot.observedAt) };
    }, (value) => Math.max(0, value.fetchedAt.getTime() + ORDERS_TTL_MS - Date.now()), PAGE_RANK.fills);
  }
  private allDexes(): Promise<string[]> {
    return this.ordersDexCache.get('dexes', async () => ['', ...(await this.info.perpDexs(LANE, PAGE_RANK.fills)).flatMap(d => d ? [d.name] : [])]);
  }

  // --- GET /traders/:address/twap -------------------------------------------

  /**
   * Running TWAP orders, CopyDog's TWAP tab: the official retained
   * userTwapHistory WebSocket snapshot reduced to those whose latest
   * status is "activated". Their progress comes from the latest TWAP slice
   * fills, the list the fills tab already caches, read only when a TWAP is
   * running. Kept 60 s.
   */
  twaps(address: string): Promise<TraderTwapsResponse> {
    return this.twapCache.get(address, async () => {
      if (!this.twapReader) throw new LiveBoundaryError('trader_twaps_unavailable');
      const snapshot = await this.twapReader.read(address), history = snapshot.history;
      const running = activeTwaps(history, []);
      const slices = running.length === 0 ? [] : (await this.latestFills(address))[1];
      return { twaps: running.length === 0 ? [] : activeTwaps(history, slices), fetchedAt: new Date(snapshot.observedAt) };
    }, (value) => Math.max(0, value.fetchedAt.getTime() + TWAP_TTL_MS - Date.now()), PAGE_RANK.fills);
  }

  // --- GET /traders/:address/transfers ----------------------------------------

  /**
   * Deposits, withdrawals, transfers, vault and staking movements of the
   * last 90 days, newest first, CopyDog's 轉帳 tab. Hyperliquid answers a
   * window with its *oldest* 2,000 updates, so a full page means a busy
   * account (a vault's deposits): the read then skips ahead to the span its
   * density says holds the newest `TRANSFERS_MAX_ROWS`, at most
   * `TRANSFERS_MAX_PAGES` calls, and reports `truncated`. Kept 5 min.
   */
  transfers(address: string): Promise<TraderTransfersResponse> {
    return this.transfersCache.get(address, async () => {
      const now = Date.now();
      let start = now - TRANSFERS_WINDOW_MS;
      let from = start;
      let rows: HlLedgerUpdate[] = [];
      let truncated = false;
      for (let page = 0; page < TRANSFERS_MAX_PAGES; page++) {
        const batch = await this.info.userNonFundingLedgerUpdates(address, start, undefined, LANE, PAGE_RANK.fills);
        rows = batch;
        from = start;
        if (batch.length < LEDGER_MAX_ITEMS) break;
        truncated = true;
        const first = batch[0].time;
        const last = batch[batch.length - 1].time;
        const perMs = batch.length / Math.max(1, last - first);
        start = Math.max(last + 1, Math.floor(now - TRANSFERS_MAX_ROWS / perMs));
      }
      const transfers = rows
        .map((u) => toTraderTransfer(u, address))
        .filter((t): t is NonNullable<typeof t> => t !== null)
        .sort((a, b) => b.time.getTime() - a.time.getTime())
        .slice(0, TRANSFERS_MAX_ROWS);
      return { transfers, from: new Date(from), truncated, fetchedAt: new Date() };
    });
  }
}
