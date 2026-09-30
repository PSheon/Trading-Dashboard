"use client";

import type { PortfolioResponse, TradeWindow, TraderAnalyticsResponse, TraderWindow } from "@/lib/contracts";
import { ArrowDownRight, ArrowUpRight, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "cn";

import { OrbieMark, Wordmark } from "@/components/brand/logo";
import { AreaChart } from "@/components/charts/area-chart";
import { Skeleton } from "@/components/page";
import { RoiPill } from "@/components/traders/bits";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Segmented } from "@/components/ui/segmented";
import { useI18n } from "@/i18n/provider";
import { usdCompact } from "@/lib/format";
import { pct1, signedUsd2, winRateTone } from "@/lib/trade-format";
import { useNow } from "@/lib/use-now";
import { PnlCalendarView, type CalendarUnit } from "./pnl-calendar";

export type ChartMode = "pnl" | "value";
export type ChartUnit = "usd" | "pct";
export type Market = "perp" | "all";

export const WINDOWS: TraderWindow[] = ["day", "week", "month", "allTime"];

/** The trade analytics window matching a chart window. */
export const TRADE_WINDOW: Record<TraderWindow, TradeWindow> = { day: "1d", week: "7d", month: "30d", allTime: "all" };

/** The 表現 tile's periods, CopyDog's All / 30D / 7D. */
export type KpiPeriod = "allTime" | "month" | "week";
export const KPI_PERIODS: Array<[KpiPeriod, string]> = [["allTime", "All"], ["month", "30D"], ["week", "7D"]];
const PERIOD_DAYS: Record<KpiPeriod, number | null> = { allTime: null, month: 30, week: 7 };

type Tone = "positive" | "negative" | "warning";
const TEXT: Record<Tone, string> = { positive: "text-positive", negative: "text-negative", warning: "text-warning" };
const BAR: Record<Tone, string> = { positive: "bg-positive", negative: "bg-negative", warning: "bg-warning" };

/** CopyDog's sign tone: up green, down red, ~0 amber. */
const signTone = (v: number | null | undefined): Tone | null =>
  v == null || Number.isNaN(v) ? null : Math.abs(v) < 0.005 ? "warning" : v > 0 ? "positive" : "negative";
/** CopyDog's Sharpe tone: ≥ 1.5 green, ≥ 0 amber, below red. */
const sharpeTone = (v: number | null | undefined): Tone | null => (v == null ? null : v >= 1.5 ? "positive" : v >= 0 ? "warning" : "negative");
/** Position of `v` on a min–max bar, 0–100. */
const along = (v: number | null | undefined, min: number, max: number) =>
  v == null ? 0 : Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));

/** CopyDog's percent format: sign, no decimals from 100% up, one below, with
 * thousands separators ("+47,374%", "+384%", "−22.7%"). */
export function signedPctCd(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  const n = Math.abs(v * 100);
  const digits = n >= 100 ? 0 : 1;
  return `${v >= 0 ? "+" : "-"}${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

/** CopyDog's track record: "<1d", "12d", "1mo", "2.8y" since the first trade. */
export function trackRecord(firstMs: number, now: number): string {
  const days = (now - firstMs) / 86_400_000;
  if (days < 1) return "<1d";
  if (days < 30) return `${Math.floor(days)}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

/** CopyDog's annualised return: (1 + ROI)^(365.25 ÷ days) − 1, days being
 * the period (30 / 7) or, for All, the history's span. */
export function annualized(roi: number | null | undefined, days: number | null): number | null {
  if (roi == null || !(days != null && days > 0)) return null;
  const v = Math.max(1 + roi, 1e-9) ** (1 / (days / 365.25)) - 1;
  return Number.isFinite(v) ? v : null;
}

/** CopyDog shows the young-record warning under this many days. */
export const YOUNG_RECORD_DAYS = 90;

/** The window's ROI: CopyDog's PnL ÷ peak net deposits (the api's `roi`),
 * shared by the ROI tile and the chart's pill. */
export function windowRoi(portfolio: PortfolioResponse | undefined): number | null {
  return portfolio?.roi ?? null;
}

function Tile({
  label,
  action,
  value,
  tone,
  fill,
  sub,
  loading,
  muted,
}: {
  label: string;
  action?: React.ReactNode;
  value: React.ReactNode;
  tone: Tone | null;
  fill: number;
  sub: React.ReactNode;
  loading?: boolean;
  muted?: boolean;
}) {
  const t = muted ? null : tone;
  return (
    <div className="flex min-w-0 flex-col rounded-[12px] border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs font-medium text-muted-foreground">
        <span>{label}</span>
        {action}
      </div>
      <div className="flex flex-1 flex-col gap-2 px-4 pt-3 pb-3">
        {loading ? (
          <Skeleton className="h-6 w-24" />
        ) : (
          <div className={cn("num truncate text-lg font-bold tracking-tight md:text-xl", muted ? "text-subtle-foreground" : t ? TEXT[t] : "")}>{value}</div>
        )}
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
          <div
            className={cn("h-full rounded-full transition-[width] duration-500", muted ? "bg-subtle-foreground" : t ? BAR[t] : "bg-border-strong")}
            style={{ width: `${fill}%` }}
          />
        </div>
        <div className="num truncate text-[11px] text-subtle-foreground">{sub}</div>
      </div>
    </div>
  );
}

/**
 * The four KPI tiles as CopyDog lays them out (its "hd-metrics"):
 *
 * - 表現: perp PnL of the tile's own All / 30D / 7D period, a ±$1M bar, and
 *   the track record ("1mo 交易資歷") since the first point of the history;
 * - ROI: the same period's ROI (PnL ÷ peak net deposits), a ±100% bar, and
 *   the annualised return, whose title warns when the record is younger
 *   than 90 days;
 * - 夏普: all-time Sharpe of the whole account (a −3…3 bar) and all-time max
 *   drawdown;
 * - 勝率: all-time win rate of closed round trips and their count.
 *
 * Only 表現 and ROI follow the period; the chart's window is separate.
 */
export function KpiTiles({
  period,
  onPeriod,
  periodPortfolio,
  allTime,
  trades,
  tradesComputing,
  lowSample,
  now: nowProp,
}: {
  period: KpiPeriod;
  onPeriod: (p: KpiPeriod) => void;
  /** The perp portfolio of `period`. */
  periodPortfolio: PortfolioResponse | undefined;
  /** The all-time portfolio (Sharpe, drawdown and the track record). */
  allTime: PortfolioResponse | undefined;
  /** GET /traders/:address/analytics?window=all. */
  trades: TraderAnalyticsResponse | undefined;
  /** The api is still reconstructing a cold address's trades. */
  tradesComputing: boolean;
  /** From the activity request; greys the returns of a low sample. */
  lowSample: boolean;
  /** Fixed time for tests; the shared ticking clock otherwise. */
  now?: number;
}) {
  const { t } = useI18n();
  const ticking = useNow();
  const now = nowProp ?? ticking;
  const pnl = periodPortfolio?.pnl.at(-1)?.[1] ?? null;
  const roi = windowRoi(periodPortfolio);
  const first = allTime?.pnl[0]?.[0] ?? null;
  const spanDays = allTime && allTime.pnl.length > 1 ? (allTime.pnl.at(-1)![0] - allTime.pnl[0][0]) / 86_400_000 : null;
  const annual = annualized(roi, PERIOD_DAYS[period] ?? spanDays);
  const recordDays = first === null ? null : Math.round((now - first) / 86_400_000);
  const annualTitle =
    period === "allTime" && annual !== null && recordDays !== null && recordDays < YOUNG_RECORD_DAYS
      ? t("trader.kpi.annualizedYoung", { days: recordDays })
      : t("trader.kpi.annualized");
  const sharpe = allTime?.sharpe ?? null;
  const mdd = allTime?.maxDrawdownPct ?? null;
  const winRate = trades?.summary.winRate ?? null;
  const winTone = winRateTone(winRate);

  const periodMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("trader.kpi.period")}
        className="group inline-flex items-center gap-0.5 rounded-md bg-raised px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-raised-hover data-[state=open]:text-foreground"
      >
        {KPI_PERIODS.find(([p]) => p === period)![1]}
        <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
      </DropdownMenuTrigger>
      {/* CopyDog's period list: as narrow as the pill, dropping from it. */}
      <DropdownMenuContent sideOffset={4} className="min-w-[var(--radix-dropdown-menu-trigger-width)] rounded-lg p-1">
        <DropdownMenuRadioGroup value={period} onValueChange={(v) => onPeriod(v as KpiPeriod)}>
          {KPI_PERIODS.map(([p, label]) => (
            <DropdownMenuRadioItem key={p} value={p} className="rounded-md px-2 py-1.5 text-[11px] font-semibold">
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Tile
        label={t("trader.kpi.pnl")}
        action={periodMenu}
        loading={!periodPortfolio}
        value={pnl === null ? "—" : signedUsd2(pnl)}
        tone={signTone(pnl)}
        muted={lowSample}
        fill={along(pnl, -1e6, 1e6)}
        sub={first === null ? "—" : t("trader.kpi.history", { value: trackRecord(first, now) })}
      />
      <Tile
        label={t("trader.kpi.roi")}
        loading={!periodPortfolio}
        value={signedPctCd(roi)}
        tone={signTone(roi)}
        muted={lowSample}
        fill={along(roi, -1, 1)}
        sub={
          annual === null ? (
            "—"
          ) : (
            <span title={annualTitle}>
              <span className={lowSample ? "" : TEXT[signTone(annual) ?? "warning"]}>{signedPctCd(annual)}</span>{" "}
              {t("trader.kpi.annualized")}
            </span>
          )
        }
      />
      <Tile
        label={t("trader.kpi.sharpe")}
        loading={!allTime}
        value={sharpe === null ? "—" : sharpe.toFixed(2)}
        tone={sharpeTone(sharpe)}
        muted={lowSample}
        fill={along(sharpe, -3, 3)}
        sub={
          mdd === null ? (
            "—"
          ) : (
            <>
              <span className="text-negative">{pct1(mdd)}</span> {t("trader.kpi.maxDrawdown")}
            </>
          )
        }
      />
      <Tile
        label={t("trader.kpi.winRate")}
        loading={!trades && tradesComputing}
        value={winRate === null ? "—" : pct1(winRate)}
        tone={winTone}
        fill={(winRate ?? 0) * 100}
        sub={trades ? t("trader.kpi.trades", { count: trades.summary.trades }) : tradesComputing ? t("trader.kpi.computing") : t("trader.kpi.noTrades")}
      />
    </div>
  );
}

/** PnL / value chart with market, mode, window and unit toggles, and
 * CopyDog's third tab, 日曆 (monthly PnL calendar, its own $ / % toggle,
 * % first). */
export function PerformanceChart({
  address,
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
  /** The trader, for the calendar's all-time perp + spot series. */
  address: string;
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
  const [calendar, setCalendar] = useState(false);
  const [calendarUnit, setCalendarUnit] = useState<CalendarUnit>("pct");

  const series = useMemo(() => {
    if (!portfolio) return [];
    const raw = mode === "pnl" ? portfolio.pnl : portfolio.accountValue;
    if (unit === "usd") return raw;
    // PnL in % is PnL ÷ peak net deposits (CopyDog's), ending at the ROI.
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
  // CopyDog's % PnL headline: an arrow and the unsigned percentage, with
  // the dollar PnL in the pill under it.
  const pctPnl = unit === "pct" && mode === "pnl";
  const PctArrow = last && last[1] < 0 ? ArrowDownRight : ArrowUpRight;
  const usdPnl = pctPnl ? portfolio?.pnl.at(-1)?.[1] ?? null : null;
  const headline = last
    ? pctPnl
      ? <span className="inline-flex items-center gap-1"><PctArrow className="size-[0.8em]" strokeWidth={2.5} aria-hidden />{format.pct(Math.abs(last[1]), { digits: 2 })}</span>
      : unit === "pct"
        ? format.pct(last[1], { sign: true, digits: 2 })
        : format.usd(last[1], { sign: mode === "pnl", digits: 2 })
    : "—";

  return (
    <section className="rounded-[12px] border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-3 py-2">
        <div className="flex items-center">
          {(["perp", "all", "calendar"] as const).map((m) => {
            const active = m === "calendar" ? calendar : !calendar && market === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => {
                  if (m === "calendar") return setCalendar(true);
                  setCalendar(false);
                  onMarket(m);
                }}
                aria-pressed={active}
                className={cn(
                  "relative px-2.5 py-2 text-[0.8125rem] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "text-foreground" : "text-subtle-foreground hover:text-muted-foreground",
                )}
              >
                {t(m === "perp" ? "trader.chart.perp" : m === "all" ? "trader.chart.all" : "trader.chart.calendar")}
                {active ? <span className="absolute inset-x-2.5 -bottom-2 h-0.5 rounded-full bg-primary" /> : null}
              </button>
            );
          })}
        </div>
        {calendar ? (
          <Segmented
            value={calendarUnit}
            onChange={setCalendarUnit}
            options={[
              { value: "usd", label: t("trader.chart.usd") },
              { value: "pct", label: t("trader.chart.pct") },
            ]}
          />
        ) : (
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
        )}
      </div>

      {calendar ? (
        <div className="px-2 pb-2 md:px-3">
          <PnlCalendarView address={address} unit={calendarUnit} />
        </div>
      ) : (
        <>
          <div className="px-4 pt-4 md:px-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div
                  className={cn(
                    "num text-[1.75rem] leading-none font-bold tracking-tight md:text-[1.625rem]",
                    muted
                      ? "text-subtle-foreground"
                      : mode === "pnl" && last
                        ? last[1] >= 0
                          ? "text-positive"
                          : "text-negative"
                        : "text-primary",
                  )}
                >
                  {loading && !portfolio ? <Skeleton className="h-8 w-48" /> : headline}
                </div>
                {pnlPct !== null && unit === "usd" ? <RoiPill value={pnlPct} digits={2} className="mt-2.5" muted={muted} /> : null}
                {usdPnl !== null ? (
                  <span className={cn("num mt-2.5 inline-flex h-6 items-center rounded-full px-2 text-xs font-semibold", muted ? "bg-raised text-subtle-foreground" : usdPnl >= 0 ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative")}>
                    {usdCompact(usdPnl, { sign: true, digits: 2 })}
                  </span>
                ) : null}
              </div>
              {last ? <p className="num font-mono text-xs text-subtle-foreground">{format.stamp(last[0])}</p> : null}
            </div>
          </div>

          <div className="px-2 pt-2 pb-2 md:px-3">
            {portfolio && series.length > 1 ? (
              <AreaChart
                data={series}
                height={296}
                axes
                interactive
                zeroBaseline={mode === "pnl"}
                formatValue={fmt}
                formatTick={(v) => (unit === "pct" ? format.pct(v, { digits: 1 }) : usdCompact(v))}
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
              <Skeleton className="m-2 h-[280px]" />
            ) : (
              <div className="flex h-[296px] items-center justify-center text-sm text-muted-foreground">
                {t("trader.chart.noData")}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
