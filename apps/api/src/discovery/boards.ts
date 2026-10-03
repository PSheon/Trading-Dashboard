import type {
  BoardMarket,
  BoardQuery,
  BoardResponse,
  BoardSort,
  BoardTrader,
  BoardWindow,
  CoinBoardResponse,
  CoinIndexRow,
  CoinTrader,
  TraderCard,
  TradingStyle,
} from "@trading-dashboard/shared/contracts";
import { tradingStyleSchema } from "@trading-dashboard/shared/contracts";
import { copyScores } from "../analytics/copy-score.js";

import { isStockCoin, realized } from "./discovery-figures.js";
import type { BoardSourceRow, CardIdentityRow } from "./discovery.repository.js";
import { kolAvatarPath } from "./kol-avatar.js";

/** CopyDog shows a fixed top 100 per board, no paging. */
export const BOARD_SIZE = 100;

const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A pool row as a card, before the board picks its PnL / ROI. */
export interface Candidate {
  row: BoardSourceRow;
  card: Omit<BoardTrader, "pnl" | "roi" | "sparkline">;
}

export function toCandidate(row: BoardSourceRow): Candidate {
  const kol = row.kolVerified !== null;
  const style = tradingStyleSchema.safeParse(row.style);
  return {
    row,
    card: {
      address: row.address,
      metricsUpdatedAt: row.portfolioAt,
      displayName: (kol ? row.kolName : null) ?? row.leaderboardName ?? null,
      avatarUrl: kol ? kolAvatarPath(row.address, row.kolAvatarEtag) : null,
      xHandle: kol ? row.kolXHandle : null,
      verified: kol ? Boolean(row.kolVerified) : false,
      kol,
      accountValue: num(row.leaderboardAccountValue) ?? num(row.accountValue),
      // Old stored fitted scores are never a population percentile.
      copyScore: null,
      style: style.success ? style.data : null,
      topCoins: row.topCoins,
      lastTradeAt: row.lastTradeAt,
      tradesFrom: row.tradesFrom,
    },
  };
}

export interface PoolScores {
  values: Map<string, number>;
  eligibleCount: number;
}

/**
 * One universe for every board, card and detail in a snapshot. $10 dust,
 * 30-day activity and archive high-fill-rate exclusion are local inferred
 * eligibility rules, not Copydog's unpublished thresholds/classification.
 * Unknown activity is unscored. Recent imported positive monthly volume
 * provides evidence while the fill ledger is still warming up.
 */
export function candidateScores(candidates: Candidate[], now = Date.now()): PoolScores {
  const since = now - 30 * 86_400_000;
  const recent = (date: Date | null | undefined) => date != null && date.getTime() >= since && date.getTime() <= now;
  const eligible = candidates.filter(({ row, card }) => row.inPool && row.portfolioAt !== null
    && card.accountValue !== null && card.accountValue >= 10 && !row.archiveExcluded
    && (recent(row.lastTradeAt) || (recent(row.leaderboardUpdatedAt) && (num(row.leaderboardVolumeMonth) ?? 0) > 0)));
  const values = copyScores(eligible.map(({ row }) => ({ address: row.address, inputs: {
    roi: num(row.roiAll), pnl: num(row.pnlAll), sharpe: num(row.sharpe),
    spanDays: num(row.spanDays), returnSamples: row.returnSamples,
  } })));
  return { values, eligibleCount: values.size };
}

/** Which board a query names. */
export function boardKind(board: string): "top100" | "kol" | "coin" {
  return board === "top100" || board === "kol" ? board : "coin";
}

/**
 * CopyDog's sort rules (its `boardSorts` chunk): coin boards and the stocks
 * top 100 sort by copy score, PnL or ROI; the 30-day window by PnL or ROI.
 * Anything else falls back to PnL.
 */
export function effectiveSort(query: Pick<BoardQuery, "market" | "board" | "sort">, window: BoardWindow): BoardSort {
  const kind = boardKind(query.board);
  const windowed = kind !== "coin" && !(query.market === "stocks" && kind === "top100");
  let allowed: BoardSort[] = windowed ? ["copyScore", "pnl", "roi", "accountValue"] : ["copyScore", "pnl", "roi"];
  if (window === "30d") allowed = allowed.filter((s) => s === "pnl" || s === "roi");
  return allowed.includes(query.sort) ? query.sort : "pnl";
}

/** The window a board uses: coin boards and the stocks top 100 are
 * all-time (CopyDog hides the 30 天 toggle there). */
export function effectiveWindow(query: Pick<BoardQuery, "market" | "board" | "window">): BoardWindow {
  const kind = boardKind(query.board);
  return kind === "coin" || (query.market === "stocks" && kind === "top100") ? "all" : query.window;
}

function figures(c: Candidate, market: BoardMarket, kind: "top100" | "kol" | "coin", coin: string | null, window: BoardWindow): BoardTrader | null {
  const { row } = c;
  if (row.portfolioAt === null) return null;
  const sparkline = (window === "30d" ? row.sparkline30d : row.sparkline) ?? [];
  if (kind === "coin") {
    const stat = row.coinStats[coin!];
    if (!stat || (stat.trades === 0 && stat.volume === 0)) return null;
    return { ...c.card, metricsUpdatedAt: row.tradesAt, pnl: stat.pnl, roi: stat.volume > 0 ? stat.pnl / stat.volume : null, sparkline };
  }
  if (market === "stocks" && kind === "top100") {
    const r = realized(row.coinStats, isStockCoin);
    if (!r) return null;
    return { ...c.card, metricsUpdatedAt: row.tradesAt, pnl: r.pnl, roi: r.roi, sparkline };
  }
  const pnl = window === "30d" ? num(row.pnl30d) : num(row.pnlAll);
  const roi = window === "30d" ? num(row.roi30d) : num(row.roiAll);
  return { ...c.card, pnl, roi, sparkline };
}

const sortValue = (t: BoardTrader, sort: BoardSort): number | null =>
  sort === "copyScore" ? t.copyScore : sort === "pnl" ? t.pnl : sort === "roi" ? t.roi : t.accountValue;

/** Descending, nulls last, then address (stable across refreshes). */
function compare(sort: BoardSort) {
  return (a: BoardTrader, b: BoardTrader) => {
    const x = sortValue(a, sort);
    const y = sortValue(b, sort);
    if (x === null || y === null) return x === y ? a.address.localeCompare(b.address) : x === null ? 1 : -1;
    return y - x || (b.pnl ?? 0) - (a.pnl ?? 0) || a.address.localeCompare(b.address);
  };
}

/**
 * One board from the pool: crypto top 100 (perp figures of the window),
 * KOL (the registry's traders), a coin (that coin's realized PnL and PnL ÷
 * volume, all-time), or the stocks top 100 (realized figures over every
 * stock market). Only traders with an account value above 0, and matching
 * `style` when given; at most `limit`.
 */
export function buildBoard(
  candidates: Candidate[],
  query: BoardQuery,
  pool: { ready: number; total: number; tradesReady?: number },
  limit = BOARD_SIZE,
  scores = candidateScores(candidates),
): BoardResponse {
  const kind = boardKind(query.board);
  const window = effectiveWindow(query);
  const sort = effectiveSort(query, window);
  const coin = kind === "coin" ? query.board : null;
  const style: TradingStyle | null = query.style ?? null;
  const items: BoardTrader[] = [];
  let updatedAt: Date | null = null;
  for (const c of candidates) {
    if (kind === "kol" && !c.card.kol) continue;
    if ((c.card.accountValue ?? 0) <= 0) continue;
    if (style && c.card.style !== style) continue;
    const t = figures(c, query.market, kind, coin, window);
    if (!t) continue;
    items.push({ ...t, copyScore: scores.values.get(t.address) ?? null });
    const at = c.row.portfolioAt;
    if (at && (!updatedAt || at > updatedAt)) updatedAt = at;
  }
  items.sort(compare(sort));
  const displayed = items.slice(0, limit);
  return { market: query.market, board: query.board, coin, sort, window, style, items: displayed, pool, updatedAt,
    rankingScope: "candidate_pool", eligibleCount: items.length, scoreEligibleCount: scores.eligibleCount, freshness: boardFreshness(displayed) };
}

export function boardFreshness(items: BoardTrader[]) {
  const times = items.map(t => t.metricsUpdatedAt?.getTime()).filter((t): t is number => t !== undefined && Number.isFinite(t));
  return {
    oldestUpdatedAt: times.length ? new Date(Math.min(...times)) : null,
    newestUpdatedAt: times.length ? new Date(Math.max(...times)) : null,
    missingTimestamps: items.length - times.length,
  };
}

/**
 * Any trader as a watchlist card: the pool's all-time figures when it has
 * them, else the leaderboard's (no copy score, sparkline, win rate or
 * risk figures), else identity only. KOL name, handle, badge and cached
 * avatar come from the registry either way.
 */
export function traderCard(address: string, row: BoardSourceRow | undefined, identity: CardIdentityRow | undefined, score: number | null = null): TraderCard {
  if (row && row.portfolioAt !== null) {
    const { card } = toCandidate(row);
    let trades = 0;
    let wins = 0;
    for (const stat of Object.values(row.coinStats)) {
      trades += stat.trades;
      wins += stat.wins;
    }
    return {
      ...card,
      copyScore: score,
      pnl: num(row.pnlAll),
      roi: num(row.roiAll),
      sparkline: row.sparkline ?? [],
      pnl30d: num(row.pnl30d),
      winRate: trades > 0 ? wins / trades : null,
      sharpe: num(row.sharpe),
      maxDrawdown: num(row.maxDrawdown),
      source: "pool",
    };
  }
  const kol = identity?.kolVerified !== null && identity?.kolVerified !== undefined;
  return {
    address,
    // The leaderboard's figures are as old as its import.
    metricsUpdatedAt: identity?.pnlAllTime != null ? identity.statsUpdatedAt : null,
    displayName: (kol ? identity!.kolName : null) ?? identity?.displayName ?? row?.leaderboardName ?? null,
    avatarUrl: kol ? kolAvatarPath(address, identity!.kolAvatarEtag) : null,
    xHandle: kol ? identity!.kolXHandle : null,
    verified: kol ? Boolean(identity!.kolVerified) : false,
    kol,
    accountValue: num(identity?.accountValue),
    pnl: num(identity?.pnlAllTime),
    roi: num(identity?.roiAllTime),
    copyScore: null,
    style: null,
    topCoins: row?.topCoins ?? [],
    lastTradeAt: row?.lastTradeAt ?? null,
    tradesFrom: row?.tradesFrom ?? null,
    sparkline: [],
    pnl30d: num(identity?.pnlMonth),
    winRate: null,
    sharpe: null,
    maxDrawdown: null,
    source: identity?.pnlAllTime != null ? "leaderboard" : "none",
  };
}

/** CopyDog lists 40 traders on a coin page. */
export const COIN_BOARD_SIZE = 40;

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * CopyDog's 市場 index (`/hyperliquid/coins`): every coin on which at least
 * one pool trader has a positive realized PnL, with how many did and their
 * summed PnL, highest total first. Account size is not considered.
 */
export function coinIndex(candidates: Candidate[]): CoinIndexRow[] {
  const byCoin = new Map<string, { traders: number; profit: number }>();
  for (const { row } of candidates) {
    for (const [coin, stat] of Object.entries(row.coinStats)) {
      if (!(stat.pnl > 0)) continue;
      const entry = byCoin.get(coin) ?? { traders: 0, profit: 0 };
      entry.traders += 1;
      entry.profit += stat.pnl;
      byCoin.set(coin, entry);
    }
  }
  return [...byCoin.entries()]
    .map(([coin, e]) => ({ coin, market: isStockCoin(coin) ? ("stocks" as const) : ("crypto" as const), traders: e.traders, profit: round2(e.profit) }))
    .sort((a, b) => b.profit - a.profit || a.coin.localeCompare(b.coin));
}

/**
 * One coin's page (「Hyperliquid 上最強的 BTC 交易者」): the pool traders who
 * made money on `coin`, by its realized PnL (then address), at most `limit`;
 * win rate is winning ÷ closed round trips. `stats` sums the listed rows,
 * as CopyDog's 列出的交易者 / 獲利總額 / 交易量 / 交易數 do.
 */
export function coinBoard(candidates: Candidate[], coin: string, limit = COIN_BOARD_SIZE): Pick<CoinBoardResponse, "coin" | "market" | "stats" | "items"> & { updatedAt: Date | null } {
  const rows: Array<{ trader: CoinTrader; at: Date | null }> = [];
  for (const c of candidates) {
    const stat = c.row.coinStats[coin];
    if (!stat || !(stat.pnl > 0)) continue;
    const { address, displayName, avatarUrl, xHandle, verified, kol } = c.card;
    rows.push({
      trader: { address, displayName, avatarUrl, xHandle, verified, kol, pnl: stat.pnl, winRate: stat.trades > 0 ? stat.wins / stat.trades : null, trades: stat.trades, volume: stat.volume },
      at: c.row.tradesAt,
    });
  }
  rows.sort((a, b) => b.trader.pnl - a.trader.pnl || a.trader.address.localeCompare(b.trader.address));
  const listed = rows.slice(0, limit);
  const stats = { traders: listed.length, profit: 0, volume: 0, trades: 0 };
  let updatedAt: Date | null = null;
  for (const { trader, at } of listed) {
    stats.profit += trader.pnl;
    stats.volume += trader.volume;
    stats.trades += trader.trades;
    if (at && (!updatedAt || at > updatedAt)) updatedAt = at;
  }
  stats.profit = round2(stats.profit);
  stats.volume = round2(stats.volume);
  return { coin, market: isStockCoin(coin) ? "stocks" : "crypto", stats, items: listed.map((r) => r.trader), updatedAt };
}
