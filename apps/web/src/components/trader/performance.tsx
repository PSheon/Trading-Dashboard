"use client";

import type { PortfolioResponse, TradeWindow, TraderAnalyticsResponse, TraderProfileResponse, TraderWindow } from "@/lib/contracts";
import { useMemo } from "react";
import { cn } from "cn";

import { OrbieMark, Wordmark } from "@/components/brand/logo";
import { AreaChart } from "@/components/charts/area-chart";
import { Skeleton } from "@/components/page";
import { RoiPill } from "@/components/traders/bits";
import { Segmented } from "@/components/ui/segmented";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/provider";
import { useNow } from "@/lib/use-now";
import { pct1, winRateTone } from "@/lib/trade-format";

const WIN_TEXT = { positive: "text-positive", warning: "text-warning", negative: "text-negative" } as const;
const WIN_BAR = { positive: "bg-positive", warning: "bg-warning", negative: "bg-negative" } as const;

export type ChartMode = "pnl" | "value";
export type ChartUnit = "usd" | "pct";
export type Market = "perp" | "all";

export const WINDOWS: TraderWindow[] = ["day", "week", "month", "allTime"];

/** The trade analytics window matching a chart window. */
export const TRADE_WINDOW: Record<TraderWindow, TradeWindow> = { day: "1d", week: "7d", month: "30d", allTime: "all" };

function Tile({
  label,
  value,
  valueClass,
  fill,
  barClass,
  sub,
  loading,
}: {
  label: string;
  value: React.ReactNode;
  valueClass?: string;
  fill: number;
  barClass: string;
  sub: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-2xl border border-border bg-card">
      <div className="border-b border-border px-4 py-2.5 text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex flex-1 flex-col gap-2.5 px-4 pt-3 pb-3.5">
        {loading ? (
          <Skeleton className="h-6 w-24" />
        ) : (
          <div className={cn("num truncate text-lg font-bold tracking-tight md:text-xl", valueClass)}>{value}</div>
        )}
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
          <div
            className={cn("h-full rounded-full transition-[width] duration-500", barClass)}
            style={{ width: `${Math.max(0, Math.min(100, fill * 100))}%` }}
          />
        </div>
        <div className="num truncate text-[11px] text-subtle-foreground">{sub}</div>
      </div>
    </div>
  );
}

const signText = (n: number | null | undefined, muted: boolean) =>
  muted || n === null || n === undefined || n === 0 ? (muted ? "text-subtle-foreground" : "") : n > 0 ? "text-positive" : "text-negative";
const signBar = (n: number | null | undefined, muted: boolean) =>
  muted ? "bg-subtle-foreground" : (n ?? 0) >= 0 ? "bg-positive" : "bg-negative";

/** The window's ROI: the api's flow-neutral, time-weighted return over the
 * same `portfolio` series as its PnL (deposits and withdrawals don't count,
 * so it exists even when more was withdrawn than deposited). The trader
 * page never mixes in the leaderboard's ROI: that one adds up subaccounts
 * and is up to 15 minutes old. Shared by the ROI tile and the chart's pill. */
export function windowRoi(portfolio: PortfolioResponse | undefined): number | null {
  return portfolio?.roi ?? null;
}

/** The leaderboard's figure differs enough from the portfolio's to explain. */
const LEADERBOARD_DIFF = 0.2;

/** Four KPI tiles tied to the window toggle: PnL, ROI, Sharpe (with max
 * drawdown) from Hyperliquid's `portfolio`, and win rate with its trade
 * count from the round trips the api reconstructs for any address (closed
 * in the window, CopyDog's definition). Low-sample traders get their
 * returns greyed. */
export function KpiTiles({
  profile,
  portfolio,
  allTime,
  window,
  market,
  lowSample,
  trades,
  tradesComputing,
}: {
  profile: TraderProfileResponse;
  portfolio: PortfolioResponse | undefined;
  allTime: PortfolioResponse | undefined;
  window: TraderWindow;
  market: Market;
  /** From the activity request; false until it arrives. */
  lowSample: boolean;
  /** GET /traders/:address/analytics for this window. */
  trades: TraderAnalyticsResponse | undefined;
  /** The api is still reconstructing a cold address's trades. */
  tradesComputing: boolean;
}) {
  const { t, format } = useI18n();
  const muted = lowSample;
  const now = useNow();

  const pnl = portfolio?.pnl.at(-1)?.[1] ?? null;
  const roi = windowRoi(portfolio);

  const spanYears = allTime && allTime.pnl.length > 1
    ? (allTime.pnl.at(-1)![0] - allTime.pnl[0][0]) / (365.25 * 86400_000)
    : null;
  const allRoi = allTime?.roi ?? null;
  const annualized =
    spanYears && spanYears > 0.25 && allRoi !== null && allRoi > -1
      ? (1 + allRoi) ** (1 / spanYears) - 1
      : null;
  // The leaderboard's PnL for the same window (perps + spot, like the "all"
  // market) when it tells a different story: it adds up the address's
  // subaccounts.
  const boardPnl = market === "all" && portfolio?.market === "all" ? profile.stats?.pnl[window] : undefined;
  const boardDiffers =
    boardPnl !== undefined &&
    pnl !== null &&
    Math.abs(boardPnl - pnl) > LEADERBOARD_DIFF * Math.max(Math.abs(boardPnl), Math.abs(pnl), 1);
  const history =
    spanYears === null
      ? null
      : spanYears >= 1
        ? `${format.num(spanYears, 1)}y`
        : `${Math.max(1, Math.round(spanYears * 365))}d`;

  const sharpe = portfolio?.sharpe ?? null;
  const winRate = trades?.summary.winRate ?? null;
  // CopyDog: ≥ 50% green, ≥ 35% amber, below red; value, bar and sub alike.
  const winTone = winRateTone(winRate);
  const loading = !portfolio;

  return (
    <div className="flex flex-col gap-1.5">
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Tile
        label={t("trader.kpi.pnl")}
        loading={loading}
        value={format.usd(pnl, { sign: true, compact: Math.abs(pnl ?? 0) >= 1e5, digits: 2 })}
        valueClass={signText(pnl, muted)}
        fill={Math.min(1, Math.abs(roi ?? 0))}
        barClass={signBar(pnl, muted)}
        sub={history ? t("trader.kpi.history", { value: history }) : t(`windows.${window}`)}
      />
      <Tile
        label={t("trader.kpi.roi")}
        loading={loading}
        value={format.pct(roi, { sign: true })}
        valueClass={signText(roi, muted)}
        fill={Math.min(1, Math.abs(roi ?? 0) / 3)}
        barClass={signBar(roi, muted)}
        sub={
          annualized !== null ? (
            <>
              <span className={muted ? "" : annualized >= 0 ? "text-positive" : "text-negative"}>
                {format.pct(annualized, { sign: true })}
              </span>{" "}
              {t("trader.kpi.annualized")}
            </>
          ) : (
            t(`windows.${window}`)
          )
        }
      />
      <Tile
        label={t("trader.kpi.sharpe")}
        loading={loading}
        value={sharpe === null ? "—" : format.num(sharpe, 2)}
        valueClass={muted ? "text-subtle-foreground" : sharpe !== null && sharpe < 0 ? "text-negative" : ""}
        fill={Math.min(1, Math.max(0, (sharpe ?? 0) / 3))}
        barClass={muted ? "bg-subtle-foreground" : "bg-primary"}
        sub={
          portfolio ? (
            <Tooltip content={`${t("trader.kpi.maxDrawdownTitle")} ${format.usd(portfolio.maxDrawdownUsd, { compact: true })}`}>
              <span tabIndex={0} className="outline-none">
                <span className="text-negative">
                  {portfolio.maxDrawdownPct === null ? format.usd(portfolio.maxDrawdownUsd, { compact: true }) : format.pct(portfolio.maxDrawdownPct)}
                </span>{" "}
                {t("trader.kpi.maxDrawdown")}
              </span>
            </Tooltip>
          ) : (
            t("trader.kpi.sharpeNa")
          )
        }
      />
      <Tile
        label={t("trader.kpi.winRate")}
        loading={!trades && tradesComputing}
        value={winRate === null ? "—" : pct1(winRate)}
        valueClass={muted || !winTone ? "text-subtle-foreground" : WIN_TEXT[winTone]}
        fill={winRate ?? 0}
        barClass={muted || !winTone ? "bg-subtle-foreground" : WIN_BAR[winTone]}
        sub={
          trades
            ? t("trader.kpi.trades", { count: trades.summary.trades })
            : tradesComputing
              ? t("trader.kpi.computing")
              : t("trader.kpi.noTrades")
        }
      />
    </div>
      <p className="num px-1 text-[11px] leading-relaxed text-subtle-foreground">
        {t("trader.kpi.source", { market: t(market === "perp" ? "trader.chart.perp" : "trader.chart.all") })}
        {boardDiffers && profile.stats ? (
          <>
            {" · "}
            {t("trader.kpi.leaderboardDiff", {
              value: format.usd(boardPnl, { sign: true, compact: true }),
              time: format.relative(profile.stats.updatedAt, now),
            })}
          </>
        ) : null}
      </p>
    </div>
  );
}

/** PnL / value chart with market, mode, window and unit toggles. */
export function PerformanceChart({
  portfolio,
  loading,
  window,
  onWindow,
  mode,
  onMode,
  unit,
  onUnit,
  market,
  onMarket,
  muted,
  roi,
}: {
  roi: number | null;
  portfolio: PortfolioResponse | undefined;
  loading: boolean;
  window: TraderWindow;
  onWindow: (w: TraderWindow) => void;
  mode: ChartMode;
  onMode: (m: ChartMode) => void;
  unit: ChartUnit;
  onUnit: (u: ChartUnit) => void;
  market: Market;
  onMarket: (m: Market) => void;
  muted: boolean;
}) {
  const { t, format } = useI18n();

  const series = useMemo(() => {
    if (!portfolio) return [];
    const raw = mode === "pnl" ? portfolio.pnl : portfolio.accountValue;
    if (unit === "usd") return raw;
    // PnL in % is the time-weighted return, so the line ends at the ROI.
    if (mode === "pnl") return portfolio.cumulativeReturn;
    const base = raw[0]?.[1] || 1;
    return raw.map(([ts, v]) => [ts, v / base - 1] as [number, number]);
  }, [portfolio, mode, unit]);

  const last = series.at(-1);
  const pnlPct = mode === "pnl" ? roi : null;

  const fmt = (v: number) =>
    unit === "pct" ? format.pct(v, { sign: mode === "pnl" }) : format.usd(v, { compact: true, sign: mode === "pnl" });
  // Axis labels follow the data's actual span (a young account's "all"
  // may cover only weeks).
  const spanMs = series.length > 1 ? series[series.length - 1][0] - series[0][0] : 0;
  const span = spanMs <= 2 * 86400_000 ? "hours" : spanMs <= 150 * 86400_000 ? "days" : "months";
  const headline = last
    ? unit === "pct"
      ? format.pct(last[1], { sign: true, digits: 2 })
      : format.usd(last[1], { sign: mode === "pnl", digits: 2 })
    : "—";

  return (
    <section className="rounded-2xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-3 py-2">
        <div className="flex items-center">
          {(["perp", "all"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onMarket(m)}
              aria-pressed={market === m}
              className={cn(
                "relative px-2.5 py-2 text-[0.8125rem] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
                market === m ? "text-foreground" : "text-subtle-foreground hover:text-muted-foreground",
              )}
            >
              {t(m === "perp" ? "trader.chart.perp" : "trader.chart.all")}
              {market === m ? (
                <span className="absolute inset-x-2.5 -bottom-2 h-0.5 rounded-full bg-primary" />
              ) : null}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Segmented
            value={mode}
            onChange={onMode}
            options={[
              { value: "pnl", label: t("trader.chart.pnl") },
              { value: "value", label: t("trader.chart.value") },
            ]}
          />
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <Segmented
            value={window}
            onChange={onWindow}
            options={WINDOWS.map((w) => ({ value: w, label: t(`windows.${w}`) }))}
          />
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <Segmented
            value={unit}
            onChange={onUnit}
            options={[
              { value: "usd", label: t("trader.chart.usd") },
              { value: "pct", label: t("trader.chart.pct") },
            ]}
          />
        </div>
      </div>

      <div className="px-4 pt-4 md:px-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div
              className={cn(
                "num text-[1.75rem] leading-none font-bold tracking-tight md:text-[2rem]",
                muted
                  ? "text-subtle-foreground"
                  : mode === "pnl" && last
                    ? last[1] >= 0
                      ? "text-positive"
                      : "text-negative"
                    : "text-foreground",
              )}
            >
              {loading && !portfolio ? <Skeleton className="h-8 w-48" /> : headline}
            </div>
            {pnlPct !== null && unit === "usd" ? <RoiPill value={pnlPct} className="mt-2.5" muted={muted} /> : null}
          </div>
          {last ? <p className="num font-mono text-xs text-subtle-foreground">{format.dateTime(last[0])}</p> : null}
        </div>
      </div>

      <div className="px-2 pt-2 pb-2 md:px-3">
        {portfolio && series.length > 1 ? (
          <AreaChart
            data={series}
            height={320}
            axes
            interactive
            zeroBaseline={mode === "pnl"}
            formatValue={fmt}
            formatTime={(ts) => format.dateTime(ts)}
            formatAxisTime={(ts) => format.axisDate(ts, span)}
            ariaLabel={t(mode === "pnl" ? "trader.chart.pnlLabel" : "trader.chart.valueLabel")}
            watermark={
              <span className="flex items-center gap-3 text-foreground">
                <OrbieMark size={56} />
                <Wordmark className="text-6xl" />
              </span>
            }
          />
        ) : loading ? (
          <Skeleton className="m-2 h-[304px]" />
        ) : (
          <div className="flex h-[320px] items-center justify-center text-sm text-muted-foreground">
            {t("trader.chart.noData")}
          </div>
        )}
      </div>
    </section>
  );
}
