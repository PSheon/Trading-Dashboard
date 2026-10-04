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
    pnl: trader.accountPnl[window],
    roi: trader.accountRoi[window],
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

/** GET /insights/cohorts/:tier. 極度盈利 is fully read (150 of 150 members);
 * `rekt` is a tier the worker has only started on (33 of 150): its headline
 * is not the tier's yet, and the page withholds it. */
export function fixtureCohort(tier: string) {
  const members = 150;
  const fresh = tier === "rekt" ? 33 : 150;
  const traders = traderStats.filter((t) => !t.isVault).slice(0, Math.min(fresh, 40));
  const wallets = traders.map((trader, i) => {
    const long = i % 4 !== 0;
    const positionValue = Math.round(trader.accountValue * (1.5 + (i % 5) / 2));
    return {
      address: trader.address, displayName: trader.displayName, avatarUrl: null, verified: i % 9 === 0, topAssets: [["BTC", "ETH", "HYPE"][i % 3]!, "SOL"],
      totalPnl: trader.accountPnl.allTime, roi: trader.accountRoi.allTime, perpEquity: trader.accountValue, copyScore: 95 - (i % 50),
      positionValue, leverage: Number((positionValue / Math.max(1, trader.accountValue)).toFixed(2)), sumUpnl: Math.round((long ? 1 : -1) * positionValue * 0.04), biasPct: long ? 100 : 0,
    };
  });
  const coins = ["BTC", "ETH", "HYPE", "SOL", "xyz:SP500"];
  const markets = coins.map((coin, i) => {
    const notionalLong = 900_000_000 / (i + 1);
    const notionalShort = 340_000_000 / (i + 1);
    return { coin, notionalLong, notionalShort, biasPct: Number(((100 * notionalLong) / (notionalLong + notionalShort)).toFixed(1)), upnl: 12_000_000 / (i + 1), tradersLong: 60 - i * 7, tradersShort: 22 - i * 3, tradersProfit: 50 - i * 6, tradersLoss: 30 - i * 4 };
  });
  const notionalLong = markets.reduce((a, m) => a + m.notionalLong, 0);
  const notionalShort = markets.reduce((a, m) => a + m.notionalShort, 0);
  return {
    tier, memberCount: members, walletCount: fresh, headlineReady: fresh / members >= 0.8,
    hero: {
      upnlProfit: 68_900_000, upnlLoss: 31_100_000, upnlProfitPct: 68.9, walletsInProfit: Math.round(fresh * 0.6), walletsInLoss: Math.round(fresh * 0.4),
      // What a fifth of the tier would have said: almost nobody long.
      notionalLong: tier === "rekt" ? 69_000 : notionalLong, notionalShort: tier === "rekt" ? 931_000 : notionalShort,
      longPct: tier === "rekt" ? 6.9 : Number(((100 * notionalLong) / (notionalLong + notionalShort)).toFixed(1)),
    },
    markets, wallets, updatedAt: leaderboardUpdatedAt,
  };
}

/** GET /insights/cohorts/:tier/history: a point every six hours; none for a tier that was never fully read. */
export function fixtureCohortHistory(tier: string, window: string) {
  const days = window === "7d" ? 7 : window === "30d" ? 30 : 90;
  const end = Date.UTC(2026, 9, 2, 12);
  const points = tier === "rekt" ? 0 : days * 4;
  return {
    tier, window,
    series: Array.from({ length: points }, (_, i) => ({ t: new Date(end - (points - 1 - i) * 6 * 3_600_000), pctLong: Number((62 + 11 * Math.sin(i / 9) + (i / points) * 4).toFixed(1)) })),
    btc: Array.from({ length: points }, (_, i) => [end - (points - 1 - i) * 6 * 3_600_000, Math.round(84_000 + 6_000 * Math.sin(i / 14))] as [number, number]),
  };
}
