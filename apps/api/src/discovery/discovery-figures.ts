import type { DiscoveryCoinStat } from "@trading-dashboard/shared/database";

import { copyScore } from "../analytics/copy-score.js";
import type { HlPortfolioResponse } from "../hyperliquid/types.js";
import { downsample, portfolioSeries, returnMetrics, riskMetrics } from "../traders/traders.mappers.js";
import type { CoinAggregate, DiscoveryFigures } from "./discovery.repository.js";

/** Sparkline points kept per trader (CopyDog sends ~90 all-time, ~48 30D). */
export const SPARKLINE_POINTS = 60;
const DAY_MS = 86_400_000;

/** HIP-3 dexes that list crypto, not stocks or commodities. Every other
 * HIP-3 market (xyz:TSLA, flx:GOLD, km:US500, …) counts as 股票. */
const CRYPTO_DEXES = new Set(["hyna"]);

/** A HIP-3 stock / commodity / index market. */
export function isStockCoin(coin: string): boolean {
  const i = coin.indexOf(":");
  return i > 0 && !CRYPTO_DEXES.has(coin.slice(0, i));
}

const finiteOrNull = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : v);
const dec = (v: number | null) => (v === null ? null : String(v));

/** The copy score's inputs and the pool's PnL / ROI, as numbers, from one
 * `portfolio` response. */
export function portfolioNumbers(raw: HlPortfolioResponse) {
  const perpAll = portfolioSeries(raw, "allTime", "perp");
  const perp30 = portfolioSeries(raw, "month", "perp");
  const wholeAll = portfolioSeries(raw, "allTime", "all");
  const risk = riskMetrics(wholeAll.pnl.length > 0 ? wholeAll : perpAll);
  const series = wholeAll.pnl.length > 0 ? wholeAll.pnl : perpAll.pnl;
  return {
    perpAll,
    perp30,
    pnlAll: finiteOrNull(perpAll.pnl.at(-1)?.[1]),
    roiAll: finiteOrNull(returnMetrics(perpAll).roi),
    pnl30d: finiteOrNull(perp30.pnl.at(-1)?.[1]),
    roi30d: finiteOrNull(returnMetrics(perp30).roi),
    sharpe: finiteOrNull(risk.sharpe),
    maxDrawdown: finiteOrNull(risk.maxDrawdownPct),
    returnSamples: risk.basis.returns,
    spanDays: series.length > 1 ? (series[series.length - 1][0] - series[0][0]) / DAY_MS : 0,
  };
}

/** The copy score of a `portfolio` response and account value. */
export function scoreOf(n: ReturnType<typeof portfolioNumbers>, accountValue: number | null): number | null {
  return copyScore({
    roi: n.roiAll,
    pnl: n.pnlAll,
    sharpe: n.sharpe,
    maxDrawdown: n.maxDrawdown,
    returnSamples: n.returnSamples,
    spanDays: n.spanDays,
    accountValue,
  });
}

/**
 * The pool's portfolio figures from one `portfolio` read (20 weight),
 * stamped `portfolioAt` with `now`: the time of the Hyperliquid read (the
 * boards' `metricsUpdatedAt`).
 * perp all-time and 30-day PnL and ROI (CopyDog's ROI), the whole
 * account's all-time Sharpe, drawdown, sample count and span (the copy
 * score's inputs), and the perp PnL sparklines (CopyDog's `sparkline` ends
 * at `pnlPerp`).
 */
export function portfolioFigures(raw: HlPortfolioResponse, accountValue: number | null, now = Date.now()): DiscoveryFigures {
  const n = portfolioNumbers(raw);
  return {
    accountValue: dec(accountValue),
    pnlAll: dec(n.pnlAll),
    roiAll: dec(n.roiAll),
    pnl30d: dec(n.pnl30d),
    roi30d: dec(n.roi30d),
    sharpe: dec(n.sharpe),
    maxDrawdown: dec(n.maxDrawdown),
    returnSamples: n.returnSamples,
    spanDays: String(Math.round(n.spanDays * 10) / 10),
    copyScore: scoreOf(n, accountValue),
    sparkline: downsample(n.perpAll.pnl, SPARKLINE_POINTS).map(([, v]) => round2(v)),
    sparkline30d: downsample(n.perp30.pnl, SPARKLINE_POINTS).map(([, v]) => round2(v)),
    portfolioAt: new Date(now),
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The pool's trade figures from the stored ledger: per-coin realized PnL,
 * volume, trades and wins; the five most-traded coins by volume; the last
 * fill; the ledger's style (median hold) and coverage start. `now` is the
 * ledger's computation time (the coin boards' `metricsUpdatedAt`).
 */
export function tradeFigures(
  coins: CoinAggregate[],
  style: string | null,
  coverageFrom: Date | null,
  lastFill: Date | null,
  now = Date.now(),
): DiscoveryFigures {
  const coinStats: Record<string, DiscoveryCoinStat> = {};
  for (const c of coins) coinStats[c.coin] = { pnl: round2(c.pnl), volume: round2(c.volume), trades: c.trades, wins: c.wins };
  const topCoins = [...coins]
    .filter((c) => c.volume > 0)
    .sort((a, b) => b.volume - a.volume || a.coin.localeCompare(b.coin))
    .slice(0, 5)
    .map((c) => c.coin);
  return { coinStats, topCoins, style, tradesFrom: coverageFrom, lastTradeAt: lastFill, tradesAt: new Date(now) };
}

/** Realized PnL and ROI (PnL ÷ volume traded, CopyDog's coin ROI) over a
 * set of coins; null when none traded. */
export function realized(stats: Record<string, DiscoveryCoinStat>, pick: (coin: string) => boolean): { pnl: number; roi: number | null } | null {
  let pnl = 0;
  let volume = 0;
  let any = false;
  for (const [coin, s] of Object.entries(stats)) {
    if (!pick(coin)) continue;
    any = true;
    pnl += s.pnl;
    volume += s.volume;
  }
  if (!any) return null;
  return { pnl, roi: volume > 0 ? pnl / volume : null };
}
