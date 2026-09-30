import { Injectable } from "@nestjs/common";
import type { BoardQuery, BoardResponse, BoardTrader, CopyScoreResponse, HomeBoardsResponse } from "@trading-dashboard/shared/contracts";

import { SettingsService } from "../settings/settings.service.js";
import { TradersService } from "../traders/traders.service.js";
import { TtlCache } from "../traders/ttl-cache.js";
import { buildBoard, toCandidate, type Candidate } from "./boards.js";
import { isStockCoin, portfolioNumbers, scoreOf } from "./discovery-figures.js";
import { DiscoveryRepository } from "./discovery.repository.js";

/** Boards read the pool table at most this often (it changes a row at a
 * time, a few times a minute). */
export const BOARDS_TTL_MS = 30_000;
/** Cards per home row (CopyDog scrolls 7 on desktop, more on swipe). */
export const HOME_ROW_SIZE = 12;

interface Snapshot {
  candidates: Candidate[];
  pool: { ready: number; total: number };
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

  constructor(
    private readonly repository: DiscoveryRepository,
    private readonly settings: SettingsService,
    private readonly traders: TradersService,
  ) {}

  private snapshot(): Promise<Snapshot> {
    return this.cache.get("pool", async () => {
      const [rows, pool] = await Promise.all([this.repository.boardRows(), this.repository.coverage()]);
      return { candidates: rows.map(toCandidate), pool };
    });
  }

  async board(query: BoardQuery): Promise<BoardResponse> {
    const { candidates, pool } = await this.snapshot();
    return buildBoard(candidates, query, pool);
  }

  /**
   * Every home row in one read: 精選 (KOLs by copy score), top crypto and
   * stock traders, one row per `discovery.homeMarkets` coin (by that coin's
   * PnL), and the calculator's six traders (精選 first, then top crypto).
   */
  async home(): Promise<HomeBoardsResponse> {
    const [{ candidates, pool }, discovery] = await Promise.all([this.snapshot(), this.settings.get("discovery")]);
    const row = (query: Partial<BoardQuery>) =>
      buildBoard(candidates, { market: "crypto", board: "top100", sort: "copyScore", window: "all", ...query }, pool, HOME_ROW_SIZE).items;
    const featured = row({ board: "kol" });
    const crypto = row({});
    const stocks = row({ market: "stocks" });
    const markets = discovery.homeMarkets.map((coin) => {
      const market = isStockCoin(coin) ? ("stocks" as const) : ("crypto" as const);
      return { coin, market, items: row({ market, board: coin, sort: "pnl" }) };
    });
    const calculator: BoardTrader[] = [];
    for (const t of [...featured, ...crypto]) {
      if (calculator.length >= 6) break;
      if ((t.roi ?? 0) > 0 && t.sparkline.length > 1 && !calculator.some((c) => c.address === t.address)) calculator.push(t);
    }
    const dates = candidates.map((c) => c.row.portfolioAt).filter((d): d is Date => d !== null);
    const updatedAt = dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
    return { featured, crypto, stocks, markets, calculator, updatedAt };
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
