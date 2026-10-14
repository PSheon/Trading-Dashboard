import { Injectable } from "@nestjs/common";
import type {
  BoardQuery,
  BoardResponse,
  BoardSort,
  BoardTrader,
  CoinBoardResponse,
  CoinIndexResponse,
  CopyScoreResponse,
  HomeBoardsResponse,
  TraderCardsResponse,
  DiscoverSearchQuery,
  DiscoverSearchResponse,
} from "@trading-dashboard/shared/contracts";

import { HOME_TILE_CRYPTO, HOME_TILE_STOCKS } from "@trading-dashboard/shared/contracts";
import { MarketCatalogService } from "../hyperliquid/market-catalog.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { TradersService } from "../traders/traders.service.js";
import { TtlCache } from "../traders/ttl-cache.js";
import { boardFreshness, buildBoard, candidateScores, coinBoard, coinIndex, toCandidate, traderCard, type Candidate, type PoolScores } from "./boards.js";
import { isStockCoin, portfolioNumbers } from "./discovery-figures.js";
import { DiscoveryRepository } from "./discovery.repository.js";
import { BOARDS_TTL_MS, SEARCH_TTL_MS } from '../config/constants/cache-ttls.js';

/** Addresses per GET /discover/cards. */
const CARDS_MAX = 200;
/** Cards per home row (CopyDog scrolls 7 on desktop, more on swipe). */
const HOME_ROW_SIZE = 12;
/** Matches read per source (KOL registry, leaderboard) before ranking. */
const SEARCH_PER_SOURCE = 25;

interface Snapshot {
  candidates: Candidate[];
  scores: PoolScores;
  pool: { ready: number; total: number; tradesReady: number };
}

/**
 * The explore boards and home rows (Stage 3 §0.5, §1): filters and sorts over
 * an in-memory snapshot of `discovery_traders`, cached `BOARDS_TTL_MS`.
 */
@Injectable()
export class DiscoveryService {
  private readonly cache = new TtlCache<Snapshot>(BOARDS_TTL_MS, 1);
  private readonly searches = new TtlCache<DiscoverSearchResponse>(SEARCH_TTL_MS, 500);

  constructor(
    private readonly repository: DiscoveryRepository,
    private readonly settings: SettingsService,
    private readonly traders: TradersService,
    private readonly markets: MarketCatalogService,
  ) {}

  private snapshot(): Promise<Snapshot> {
    return this.cache.get("pool", async () => {
      const rows = await this.repository.boardRows();
      // Derive counts from the same read as the cards, avoiding a pool rebuild
      // between separate coverage and data queries.
      const pool = { total: rows.length, ready: rows.filter(r => r.portfolioAt !== null).length,
        tradesReady: rows.filter(r => r.tradesAt !== null).length };
      const candidates = rows.map(toCandidate);
      return { candidates, scores: candidateScores(candidates), pool };
    });
  }

  /** Every pool trader's copy score in the current snapshot: the figure the
   * trader page, the boards and the insights wallet table share. */
  async copyScoreMap(): Promise<ReadonlyMap<string, number>> {
    return (await this.snapshot()).scores.values;
  }

  async board(query: BoardQuery): Promise<BoardResponse> {
    const { candidates, scores, pool } = await this.snapshot();
    return buildBoard(candidates, query, pool, undefined, scores);
  }

  /**
   * CopyDog's 市場 index: every coin some pool trader made money on, from
   * the pool snapshot (no Hyperliquid calls). See {@link coinIndex}.
   */
  async coins(): Promise<CoinIndexResponse> {
    const { candidates, pool } = await this.snapshot();
    const dates = candidates.map((c) => c.row.tradesAt).filter((d): d is Date => d !== null);
    const updatedAt = dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
    return { items: coinIndex(candidates), pool, updatedAt };
  }

  /** One coin's board from the pool snapshot (empty, not an error, when nobody
   * made money on it). `listed` lets the page tell an empty real market (200)
   * from no such market (404); null means the catalog does not know yet. */
  async coin(coin: string): Promise<CoinBoardResponse> {
    const { candidates, pool } = await this.snapshot();
    const board = coinBoard(candidates, coin);
    const listed = board.items.length > 0 ? true : await this.markets.isListed(coin);
    return { ...board, listed, pool };
  }

  /**
   * The header search (CopyDog's `/traders/search`): name/handle contains `q` or
   * address starts with it, by all-time PnL (unknown as 0, as CopyDog). No
   * Hyperliquid calls; cached `SEARCH_TTL_MS`.
   */
  search(query: DiscoverSearchQuery): Promise<DiscoverSearchResponse> {
    const q = query.q.trim();
    return this.searches.get(`${q.toLowerCase()}|${query.limit}`, async () => {
      const addresses = await this.repository.searchAddresses(q, SEARCH_PER_SOURCE);
      const { items } = await this.cards(addresses);
      const ranked = items
        .map(({ address, displayName, avatarUrl, xHandle, verified, kol, pnl, roi, accountValue }) => ({ address, displayName, avatarUrl, xHandle, verified, kol, pnl, roi, accountValue }))
        .sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0) || a.address.localeCompare(b.address));
      return { items: ranked.slice(0, query.limit) };
    });
  }

  /** Every perp market name the catalog lists (no Hyperliquid call per request). */
  async marketNames(): Promise<{ markets: string[] | null; volumes?: Record<string, number> }> {
    const [markets, volumes] = await Promise.all([this.markets.markets(), this.markets.dayVolumes()]);
    return { markets: markets ? [...markets].sort() : null, ...(volumes ? { volumes: Object.fromEntries(volumes) } : {}) };
  }

  /**
   * Every home row, as CopyDog builds them: 精選, top crypto, top stocks, and one
   * row per `discovery.homeMarkets` coin in fixed order (trending markets are
   * tiles only); only traders whose sparkline moves. The calculator follows
   * CopyDog's home hero filter (bundle 2026-10-04, `be()`).
   */
  async home(): Promise<HomeBoardsResponse> {
    const [{ candidates, scores, pool }, discovery] = await Promise.all([this.snapshot(), this.settings.get("discovery")]);
    const moves = (t: BoardTrader) => t.sparkline.length > 1 && Math.max(...t.sparkline) > Math.min(...t.sparkline);
    const row = (query: Partial<BoardQuery>, size = HOME_ROW_SIZE) =>
      buildBoard(candidates, { market: "crypto", board: "top100", sort: "copyScore", window: "all", ...query }, pool, undefined, scores).items.filter(moves).slice(0, size);
    const featured = row({ board: "kol" });
    const crypto = row({});
    // PnL-ranked rows list only traders who made money in that market, as
    // CopyDog's do; a row still filling in stays short (or hidden) instead.
    const profitable = (items: BoardTrader[]) => items.filter((t) => (t.pnl ?? 0) > 0);
    const stocks = profitable(row({ market: "stocks", sort: "pnl" }));
    const trending = await this.markets.trending();
    const markets = [...new Set(discovery.homeMarkets)].map((coin) => {
      const market = isStockCoin(coin) ? ("stocks" as const) : ("crypto" as const);
      return { coin, market, items: profitable(row({ market, board: coin, sort: "pnl" })) };
    });
    const seen = new Set(featured.map((t) => t.address));
    const named = row({ sort: "roi" }, 100).filter((t) => t.displayName && !seen.has(t.address));
    const winRate = new Map(candidates.map((c) => {
      let trades = 0;
      let wins = 0;
      for (const stat of Object.values(c.row.coinStats ?? {})) { trades += stat.trades; wins += stat.wins; }
      return [c.row.address, trades > 0 ? wins / trades : null] as const;
    }));
    const eligible = [...featured, ...named].filter((t) => (t.roi ?? 0) > 0.05 && (winRate.get(t.address) ?? 0) > 0.1 && (t.accountValue ?? 0) > 0
      && t.sparkline.length > 3 && t.sparkline[t.sparkline.length - 1] >= 0);
    const large = eligible.filter((t) => (t.pnl ?? 0) >= 100_000);
    const calculator = (large.length > 0 ? large : eligible).sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0)).slice(0, 6);
    const dates = candidates.map((c) => c.row.portfolioAt).filter((d): d is Date => d !== null);
    const updatedAt = dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
    return { featured, crypto, stocks, markets, calculator, trending: trendingTiles(trending), updatedAt, pool, rankingScope: "candidate_pool",
      freshness: boardFreshness([...featured, ...crypto, ...stocks, ...markets.flatMap(m => m.items), ...calculator]) };
  }

  /** The traders the site shows (every board's top 100 in every sort and
   * window, and the home rows); the pool's performance loop favours these. */
  async visibleAddresses(): Promise<Set<string>> {
    const [{ candidates, scores, pool }, discovery] = await Promise.all([this.snapshot(), this.settings.get("discovery")]);
    const shown = new Set<string>();
    const add = (query: BoardQuery) => {
      for (const t of buildBoard(candidates, query, pool, undefined, scores).items) shown.add(t.address);
    };
    const sorts: BoardSort[] = ["copyScore", "pnl", "roi", "accountValue"];
    for (const board of ["top100", "kol"] as const) for (const sort of sorts) for (const window of ["all", "30d"] as const) add({ market: "crypto", board, sort, window });
    for (const sort of sorts) add({ market: "stocks", board: "top100", sort, window: "all" });
    for (const coin of discovery.cryptoBoards) for (const sort of sorts) add({ market: "crypto", board: coin, sort, window: "all" });
    for (const coin of discovery.stockBoards) for (const sort of sorts) add({ market: "stocks", board: coin, sort, window: "all" });
    const home = await this.home();
    for (const t of [...home.featured, ...home.crypto, ...home.stocks, ...home.calculator, ...home.markets.flatMap((m) => m.items)]) shown.add(t.address);
    return shown;
  }

  /** Watchlist cards in the order given (deduplicated, at most `CARDS_MAX`);
   * no Hyperliquid calls. */
  async cards(addresses: string[]): Promise<TraderCardsResponse> {
    const unique = [...new Set(addresses.map((a) => a.toLowerCase()))].slice(0, CARDS_MAX);
    const [rows, identities, { scores }] = await Promise.all([this.repository.poolRowsOf(unique), this.repository.identitiesOf(unique), this.snapshot()]);
    const byRow = new Map(rows.map((r) => [r.address, r]));
    const byIdentity = new Map(identities.map((r) => [r.address, r]));
    return { items: unique.map((address) => traderCard(address, byRow.get(address), byIdentity.get(address), scores.values.get(address) ?? null)) };
  }

  /** Same percentile and component snapshot as every board. A trader outside
   * its eligible universe receives null; live portfolio inputs remain useful
   * for an untracked trader but never produce a standalone percentile. */
  async copyScore(address: string): Promise<CopyScoreResponse> {
    const normalized = address.toLowerCase();
    const { candidates, scores } = await this.snapshot();
    const candidate = candidates.find(c => c.row.address === normalized);
    const number = (value: string | number | null | undefined): number | null => {
      if (value === null || value === undefined) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    let components: CopyScoreResponse["components"];
    if (candidate?.row.portfolioAt) {
      const { row, card } = candidate;
      components = { roi: number(row.roiAll), pnl: number(row.pnlAll), sharpe: number(row.sharpe),
        maxDrawdown: number(row.maxDrawdown), returnSamples: number(row.returnSamples),
        spanDays: number(row.spanDays), accountValue: card.accountValue };
    } else {
      const [raw, accountValue] = await Promise.all([this.traders.rawPortfolio(normalized), this.repository.leaderboardAccountValue(normalized)]);
      const n = portfolioNumbers(raw);
      components = { roi: n.roiAll, pnl: n.pnlAll, sharpe: n.sharpe, maxDrawdown: n.maxDrawdown,
        returnSamples: n.returnSamples, spanDays: Math.round(n.spanDays * 10) / 10, accountValue };
    }
    return { address: normalized, copyScore: scores.values.get(normalized) ?? null, components,
      version: "candidate-pool-percentile-v1", rankingScope: "candidate_pool", scoreEligibleCount: scores.eligibleCount };
  }
}

/** Trending tiles shown per kind after CopyDog's fixed ones. */
const TRENDING_TILES = 2;

/**
 * 依市場瀏覽's trending tiles, as CopyDog's `leaderboard/trending-coins` picks
 * them: by 24h volume, the first main-dex coins and stock markets that are not
 * already fixed tiles (matched CopyDog on 2026-10-04).
 */
export function trendingTiles(byVolume: readonly string[]): { coins: string[]; stocks: string[] } {
  const fixedCrypto = new Set<string>(HOME_TILE_CRYPTO);
  const fixedStocks = new Set<string>(HOME_TILE_STOCKS);
  return {
    coins: byVolume.filter((coin) => !coin.includes(":") && !fixedCrypto.has(coin)).slice(0, TRENDING_TILES),
    stocks: byVolume.filter((coin) => isStockCoin(coin) && !fixedStocks.has(coin)).slice(0, TRENDING_TILES),
  };
}
