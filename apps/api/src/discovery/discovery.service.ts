import { Injectable } from "@nestjs/common";
import type {
  BoardQuery,
  BoardResponse,
  BoardTrader,
  CoinBoardResponse,
  CoinIndexResponse,
  CopyScoreResponse,
  HomeBoardsResponse,
  TraderCardsResponse,
  DiscoverSearchQuery,
  DiscoverSearchResponse,
} from "@trading-dashboard/shared/contracts";

import { SettingsService } from "../settings/settings.service.js";
import { TradersService } from "../traders/traders.service.js";
import { TtlCache } from "../traders/ttl-cache.js";
import { boardFreshness, buildBoard, coinBoard, coinIndex, toCandidate, traderCard, type Candidate } from "./boards.js";
import { isStockCoin, portfolioNumbers, scoreOf } from "./discovery-figures.js";
import { DiscoveryRepository } from "./discovery.repository.js";

/** Boards read the pool table at most this often (it changes a row at a
 * time, a few times a minute). */
export const BOARDS_TTL_MS = 30_000;
/** Addresses per GET /discover/cards. */
export const CARDS_MAX = 200;
/** Cards per home row (CopyDog scrolls 7 on desktop, more on swipe). */
export const HOME_ROW_SIZE = 12;
/** Header search answers stay this long per query (names change rarely). */
export const SEARCH_TTL_MS = 30_000;
/** Matches read per source (KOL registry, leaderboard) before ranking. */
export const SEARCH_PER_SOURCE = 25;

interface Snapshot {
  candidates: Candidate[];
  pool: { ready: number; total: number; tradesReady: number };
}

/**
 * The explore page's boards and the home page's rows (Stage 3 §0.5, §1),
 * built in memory from the discovery pool (`discovery_traders`, ≈1,200
 * rows) with no Hyperliquid calls. The pool snapshot is cached
 * `BOARDS_TTL_MS`; each board is a filter and sort over it.
 */
@Injectable()
export class DiscoveryService {
  private readonly cache = new TtlCache<Snapshot>(BOARDS_TTL_MS, 1);
  private readonly searches = new TtlCache<DiscoverSearchResponse>(SEARCH_TTL_MS, 500);

  constructor(
    private readonly repository: DiscoveryRepository,
    private readonly settings: SettingsService,
    private readonly traders: TradersService,
  ) {}

  private snapshot(): Promise<Snapshot> {
    return this.cache.get("pool", async () => {
      const rows = await this.repository.boardRows();
      // Derive counts from the same read as the cards, avoiding a pool rebuild
      // between separate coverage and data queries.
      const pool = { total: rows.length, ready: rows.filter(r => r.portfolioAt !== null).length,
        tradesReady: rows.filter(r => r.tradesAt !== null).length };
      return { candidates: rows.map(toCandidate), pool };
    });
  }

  async board(query: BoardQuery): Promise<BoardResponse> {
    const { candidates, pool } = await this.snapshot();
    return buildBoard(candidates, query, pool);
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

  /** One coin's leaderboard from the pool snapshot. An unknown coin is an
   * empty board, not an error (the pool may not have reached it yet). */
  async coin(coin: string): Promise<CoinBoardResponse> {
    const { candidates, pool } = await this.snapshot();
    return { ...coinBoard(candidates, coin), pool };
  }

  /**
   * The header search (CopyDog's `/traders/search`): traders whose KOL
   * name, 𝕏 handle or leaderboard name contains `q`, or whose address
   * starts with it, as cards, by all-time PnL (unknown counts as 0, as
   * CopyDog orders them). Two indexed-or-bounded reads plus the card reads;
   * each answer is cached `SEARCH_TTL_MS`; no Hyperliquid calls.
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

  /**
   * Every home row in one read, as CopyDog's home builds them: 精選 (KOLs by
   * copy score), top crypto (copy score), top stocks (stock PnL), one row per
   * `discovery.homeMarkets` coin (that coin's PnL); only traders whose
   * sparkline moves. The calculator takes six from 精選 then named top-ROI
   * traders: ROI > 5%, sparkline ending ≥ 0, preferring PnL ≥ $100K,
   * highest ROI first.
   */
  async home(): Promise<HomeBoardsResponse> {
    const [{ candidates, pool }, discovery] = await Promise.all([this.snapshot(), this.settings.get("discovery")]);
    const moves = (t: BoardTrader) => t.sparkline.length > 1 && Math.max(...t.sparkline) > Math.min(...t.sparkline);
    const row = (query: Partial<BoardQuery>, size = HOME_ROW_SIZE) =>
      buildBoard(candidates, { market: "crypto", board: "top100", sort: "copyScore", window: "all", ...query }, pool).items.filter(moves).slice(0, size);
    const featured = row({ board: "kol" });
    const crypto = row({});
    // PnL-ranked rows list only traders who made money in that market, as
    // CopyDog's do; a row still filling in stays short (or hidden) instead.
    const profitable = (items: BoardTrader[]) => items.filter((t) => (t.pnl ?? 0) > 0);
    const stocks = profitable(row({ market: "stocks", sort: "pnl" }));
    const markets = discovery.homeMarkets.map((coin) => {
      const market = isStockCoin(coin) ? ("stocks" as const) : ("crypto" as const);
      return { coin, market, items: profitable(row({ market, board: coin, sort: "pnl" })) };
    });
    const seen = new Set(featured.map((t) => t.address));
    const named = row({ sort: "roi" }, 100).filter((t) => t.displayName && !seen.has(t.address));
    const eligible = [...featured, ...named].filter((t) => (t.roi ?? 0) > 0.05 && t.sparkline.length > 3 && t.sparkline[t.sparkline.length - 1] >= 0);
    const large = eligible.filter((t) => (t.pnl ?? 0) >= 100_000);
    const calculator = (large.length > 0 ? large : eligible).sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0)).slice(0, 6);
    const dates = candidates.map((c) => c.row.portfolioAt).filter((d): d is Date => d !== null);
    const updatedAt = dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
    return { featured, crypto, stocks, markets, calculator, updatedAt, pool, rankingScope: "candidate_pool",
      freshness: boardFreshness([...featured, ...crypto, ...stocks, ...markets.flatMap(m => m.items), ...calculator]) };
  }

  /**
   * Watchlist cards for these addresses, in the order given (duplicates
   * dropped, at most `CARDS_MAX`): two indexed reads, no cache (a user's
   * own list, small), no Hyperliquid calls. See {@link traderCard}.
   */
  async cards(addresses: string[]): Promise<TraderCardsResponse> {
    const unique = [...new Set(addresses.map((a) => a.toLowerCase()))].slice(0, CARDS_MAX);
    const [rows, identities] = await Promise.all([this.repository.poolRowsOf(unique), this.repository.identitiesOf(unique)]);
    const byRow = new Map(rows.map((r) => [r.address, r]));
    const byIdentity = new Map(identities.map((r) => [r.address, r]));
    return { items: unique.map((address) => traderCard(address, byRow.get(address), byIdentity.get(address))) };
  }

  /**
   * Any trader's copy score and its inputs, from the all-time portfolio
   * (the trader page's own 60 s portfolio cache, so the chart and the rail
   * share one read) and the leaderboard account value.
   */
  async copyScore(address: string): Promise<CopyScoreResponse> {
    const [raw, accountValue] = await Promise.all([this.traders.rawPortfolio(address), this.repository.leaderboardAccountValue(address)]);
    const n = portfolioNumbers(raw);
    return {
      address,
      copyScore: scoreOf(n, accountValue),
      components: {
        roi: n.roiAll,
        pnl: n.pnlAll,
        sharpe: n.sharpe,
        maxDrawdown: n.maxDrawdown,
        returnSamples: n.returnSamples,
        spanDays: Math.round(n.spanDays * 10) / 10,
        accountValue,
      },
      version: "copydog-v5-fit",
    };
  }
}
