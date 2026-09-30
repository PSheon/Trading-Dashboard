/** Deterministic discovery fixtures. Only loaded with NEXT_PUBLIC_API_FIXTURES=1. */
import type { BoardQuery, BoardTrader } from "@trading-dashboard/shared/contracts";
import { publicSettings } from "./admin";
import { leaderboardUpdatedAt, sparklineFor, traderStats } from "./data";

const CRYPTO = ["BTC", "ETH", "SOL", "DOGE", "HYPE", "ZEC", "NEAR"];
const STOCKS = ["xyz:SP500", "xyz:GOLD", "xyz:CL", "xyz:NVDA", "xyz:TSLA", "xyz:BRENTOIL", "xyz:SILVER"];

export function fixtureBoard(query: BoardQuery) {
  const coins = query.market === "stocks" ? (publicSettings().stockBoards ?? STOCKS) : (publicSettings().cryptoBoards ?? CRYPTO);
  const window = query.window === "30d" ? "month" : "allTime";
  const coin = query.board === "top100" || query.board === "kol" ? null : query.board;
  const rows: BoardTrader[] = traderStats.filter((trader) => !trader.isVault).map((trader, index) => ({
    address: trader.address,
    metricsUpdatedAt: trader.updatedAt,
    displayName: trader.displayName,
    avatarUrl: null,
    xHandle: null,
    verified: false,
    kol: index % 4 === 0,
    accountValue: trader.accountValue,
    pnl: trader.pnl[window],
    roi: trader.roi[window],
    copyScore: 98 - index % 70,
    style: (["scalp", "intraday", "swing", "position"] as const)[index % 4],
    topCoins: coins.length ? [coins[index % coins.length], coins[(index + 1) % coins.length]] : [],
    lastTradeAt: trader.updatedAt,
    sparkline: sparklineFor(trader.address, window).map((point) => point[1]),
  }));
  const items = rows.filter((trader) => (!coin || trader.topCoins.includes(coin)) && (query.board !== "kol" || trader.kol) && (!query.style || trader.style === query.style))
    .sort((a, b) => (b[query.sort] ?? -Infinity) - (a[query.sort] ?? -Infinity)).slice(0, 100);
  return { ...query, coin, style: query.style ?? null, items, pool: { ready: rows.length, total: rows.length, tradesReady: rows.length }, rankingScope: "candidate_pool" as const,
    freshness: { oldestUpdatedAt: leaderboardUpdatedAt, newestUpdatedAt: leaderboardUpdatedAt, missingTimestamps: 0 }, updatedAt: leaderboardUpdatedAt };
}

export function fixtureHome() {
  const board = (market: "crypto" | "stocks", board = "top100", sort: BoardQuery["sort"] = "copyScore") => fixtureBoard({ market, board, sort, window: "all" }).items.slice(0, 7);
  const settings = publicSettings();
  return {
    featured: board("crypto", "kol"), crypto: board("crypto"), stocks: board("stocks"),
    markets: (["crypto", "stocks"] as const).flatMap((market) => (market === "crypto" ? (settings.cryptoBoards ?? CRYPTO) : (settings.stockBoards ?? STOCKS)).map((coin) => ({ coin, market, items: board(market, coin, "pnl") }))),
    calculator: board("crypto").slice(0, 6), updatedAt: leaderboardUpdatedAt,
    pool: fixtureBoard({ market: "crypto", board: "top100", sort: "copyScore", window: "all" }).pool,
    rankingScope: "candidate_pool" as const,
    freshness: { oldestUpdatedAt: leaderboardUpdatedAt, newestUpdatedAt: leaderboardUpdatedAt, missingTimestamps: 0 },
  };
}
