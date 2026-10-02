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

/** GET /discover/search: name or address prefix over the fixture pool. */
export function fixtureSearch(q: string, limit: number) {
  const term = q.replace(/^@/, "").toLowerCase();
  const items = fixtureBoard({ market: "crypto", board: "top100", sort: "pnl", window: "all" }).items
    .filter((trader) => trader.address.startsWith(term) || (trader.displayName ?? "").toLowerCase().includes(term))
    .slice(0, limit)
    .map(({ address, displayName, avatarUrl, xHandle, verified, kol, pnl, roi, accountValue }) => ({ address, displayName, avatarUrl, xHandle, verified, kol, pnl, roi, accountValue }));
  return { items };
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

/** Hyperliquid markets the fixtures know that no fixture trader has traded:
 * a real market with no data yet (the page's 「尚無市場資料」 state). Any other
 * name outside the boards is not a market (the 404). */
export const FIXTURE_UNTRADED_MARKETS = ["MEGA", "xyz:AAPL"];

/** GET /discover/coins: every board coin, by summed profit. */
export function fixtureCoinIndex() {
  const items = [...CRYPTO, ...STOCKS].map((coin) => {
    const board = fixtureCoinBoard(coin);
    return { coin, market: board.market, traders: board.stats.traders, profit: board.stats.profit };
  }).filter((row) => row.traders > 0).sort((a, b) => b.profit - a.profit);
  return { items, pool: fixtureBoard({ market: "crypto", board: "top100", sort: "pnl", window: "all" }).pool, updatedAt: leaderboardUpdatedAt };
}

/** GET /discover/coins/:coin: the traders whose fixture card lists the coin. */
export function fixtureCoinBoard(coin: string) {
  const market = STOCKS.includes(coin) || coin.includes(":") ? ("stocks" as const) : ("crypto" as const);
  const known = CRYPTO.includes(coin) || STOCKS.includes(coin);
  const source = known ? fixtureBoard({ market, board: coin, sort: "pnl", window: "all" }) : null;
  const items = (source?.items ?? []).filter((trader) => (trader.pnl ?? 0) > 0).slice(0, 40).map((trader, index) => ({
    address: trader.address, displayName: trader.displayName, avatarUrl: trader.avatarUrl, xHandle: trader.xHandle, verified: trader.verified, kol: trader.kol,
    pnl: Math.round((trader.pnl ?? 0) / 10), winRate: 0.4 + (index % 6) / 10, trades: 3 + (index % 40), volume: Math.round(Math.abs(trader.pnl ?? 0) * 3),
  }));
  const stats = { traders: items.length, profit: items.reduce((a, t) => a + t.pnl, 0), volume: items.reduce((a, t) => a + t.volume, 0), trades: items.reduce((a, t) => a + t.trades, 0) };
  return {
    coin, market, stats, items, listed: known || FIXTURE_UNTRADED_MARKETS.includes(coin),
    pool: fixtureBoard({ market: "crypto", board: "top100", sort: "pnl", window: "all" }).pool, updatedAt: items.length ? leaderboardUpdatedAt : null,
  };
}
