"use client";

import { useMemo, useState } from "react";
import { cn } from "cn";

import { AreaChart } from "@/components/charts/area-chart";
import { Seg } from "@/components/copy/portfolio-parts";
import { SkelBar, Skeleton } from "@/components/page";
import { RoiPill } from "@/components/traders/bits";
import { useI18n } from "@/i18n/provider";
import type { CopyStrategyView } from "@/lib/contracts";
import { performanceIsStale } from "@/components/copy/copy-performance";
import { useCopyPerformance } from "@/lib/copy";
import { PORTFOLIO_WINDOWS, periodRoi, windowStart } from "@/lib/copy-portfolio";
import { usdCompact } from "@/lib/format";
import { usePortfolio } from "@/lib/queries";
import type { CopyPerformanceWindow } from "@trading-dashboard/shared/contracts";

const tone = (v: number | null | undefined) => (v === null || v === undefined ? "" : v >= 0 ? "text-positive" : "text-negative");

/**
 * One copy's performance next to its trader's (CopyDog's account view, its
 * 你的跟單 / 交易員 switch). Both views share the window, and under the
 * chart both are measured over the same period: from the later of the
 * window's start and the copy's start, PnL change ÷ the period's highest
 * net deposits (the trader page's ROI definition; the trader's perp
 * account).
 */
export function CopyCompare({ strategy: s, traderName }: { strategy: CopyStrategyView; traderName: string }) {
  const { t, format } = useI18n();
  const [view, setView] = useState<"yours" | "trader">("yours");
  const [window, setWindow] = useState<CopyPerformanceWindow>("7d");
  const [metric, setMetric] = useState<"pnl" | "roi">("pnl");
  const traderWindow = PORTFOLIO_WINDOWS.find(([w]) => w === window)![1];
  const mine = useCopyPerformance(s.id, window);
  const leader = usePortfolio(s.leaderAddress, traderWindow, "perp");

  const mineSeries = useMemo(() => {
    const pts = (mine.data?.points ?? []).filter((p) => p.totalPnl !== null && p.equity !== null);
    return {
      pnl: pts.map((p) => [Date.parse(p.time), p.totalPnl!] as const),
      roi: pts.filter((p) => p.netDeposits > 0).map((p) => [Date.parse(p.time), p.totalPnl! / p.netDeposits] as const),
      value: pts.map((p) => [Date.parse(p.time), p.equity!] as const),
    };
  }, [mine.data]);
  const traderSeries = useMemo(() => ({
    pnl: (leader.data?.pnl ?? []).map(([x, v]) => [x, v] as const),
    roi: (leader.data?.cumulativeReturn ?? []).map(([x, v]) => [x, v] as const),
    value: (leader.data?.accountValue ?? []).map(([x, v]) => [x, v] as const),
  }), [leader.data]);

  // The period ends at the copy's latest read (the server's clock).
  const started = Date.parse(String(s.createdAt));
  const now = mine.data ? Date.parse(mine.data.to) : traderSeries.pnl.at(-1)?.[0] ?? started;
  const from = windowStart(window, now, started);
  const yours = periodRoi(mineSeries.pnl, mineSeries.value, from);
  const theirs = periodRoi(traderSeries.pnl, traderSeries.value, from);

  const active = view === "yours" ? mineSeries : traderSeries;
  const series = metric === "roi" ? active.roi : active.pnl;
  const query = view === "yours" ? mine : leader;
  const last = series.at(-1);
  const pnlLast = active.pnl.at(-1);
  const roiLast = active.roi.at(-1);
  const span = series.length > 1 ? (series.at(-1)![0] - series[0]![0] > 60 * 86_400_000 ? "months" : series.at(-1)![0] - series[0]![0] > 2 * 86_400_000 ? "days" : "hours") : "days";
  const today = mine.data?.todayPnl;

  return (
    <section className="orbit-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-dotted border-border p-3">
        <div role="radiogroup" aria-label={t("pf.detail.switchAria")} className="grid grid-cols-2 rounded-full border border-border bg-raised p-0.5">
          {(["yours", "trader"] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setView(v)} className={cn("h-8 rounded-full px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring", view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>
              {v === "yours" ? t("pf.detail.yourCopy") : t("pf.detail.trader")}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Seg label={t("pf.chart.metric")} value={metric} onChange={setMetric} options={[["pnl", t("pf.chart.pnl")], ["roi", t("pf.chart.roi")]]} />
          <Seg label={t("copyUpdates.historyWindow")} value={window} onChange={setWindow} options={PORTFOLIO_WINDOWS.map(([w, key]) => [w, t(`windows.${key}`)])} />
        </div>
      </div>
      <div className="flex items-start justify-between gap-3 px-3 pt-3">
        <div className="flex flex-col items-start gap-2">
          <p className="text-xs text-muted-foreground">{view === "yours" ? t("pf.detail.yourCopy") : traderName}</p>
          {query.isPending && !query.data ? (
            <>
              <SkelBar line="h-[28.6px]" className="ui-skeleton h-6 w-40 bg-raised" />
              {metric === "pnl" ? <SkelBar className="ui-skeleton h-[26px] w-20 bg-raised" /> : null}
            </>
          ) : (
            <p className={cn("num text-[26px] leading-[1.1] font-bold", last ? tone(last[1]) : "text-muted-foreground")}>
              {!last ? "—" : metric === "roi" ? format.pct(last[1], { sign: true, digits: 2 }) : format.usd(last[1], { sign: true, digits: 2 })}
            </p>
          )}
          {metric === "pnl" && roiLast ? <RoiPill value={roiLast[1]} label={`${Math.abs(roiLast[1] * 100).toFixed(2)}%`} className="h-[26px] px-3 text-sm" /> : null}
          {metric === "roi" && pnlLast ? <span className={cn("num inline-flex h-[26px] items-center rounded-full px-3 text-sm font-semibold", pnlLast[1] >= 0 ? "bg-tag-profit text-tag-profit-foreground" : "bg-tag-loss text-tag-loss-foreground")}>{usdCompact(pnlLast[1], { sign: true, digits: 2 })}</span> : null}
        </div>
        <div className="flex flex-col items-end gap-1 text-right">
          {last ? <p className="num font-mono text-[11px] text-muted-foreground">{format.stamp(last[0])}</p> : null}
          {view === "yours" ? <p className="text-xs text-muted-foreground">{t("copyUpdates.todayPnl")} <strong className={cn("num ml-1", tone(today))}>{today === null || today === undefined ? "—" : format.usd(today, { sign: true, digits: 2 })}</strong></p> : null}
        </div>
      </div>
      <div className="px-1.5 pt-1.5 pb-2">
        {series.length > 1 ? (
          <AreaChart
            data={series}
            animateKey={`${view}:${window}:${metric}`}
            height={200}
            axes
            interactive
            zeroBaseline
            formatValue={(v) => (metric === "roi" ? format.pct(v, { sign: true, digits: 2 }) : format.usd(v, { sign: true, digits: 2 }))}
            formatTick={(v) => (metric === "roi" ? format.pct(v, { digits: 1 }) : usdCompact(v))}
            formatTime={(ts) => format.dateTime(ts)}
            formatAxisTime={(ts) => format.axisDate(ts, span)}
            ariaLabel={view === "yours" ? t("pf.detail.yourChart") : t("pf.detail.traderChart")}
          />
        ) : query.isPending ? <Skeleton className="h-[200px]" /> : (
          <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">{query.isError ? t("copyUpdates.historyError") : t("pf.chart.noData")}</div>
        )}
        {view === "yours" && mine.data ? (
          <p className="flex flex-wrap justify-between gap-2 px-2 pt-1 text-[11px] text-muted-foreground" data-testid="copy-coverage">
            <span>{t("copyUpdates.equityHint")}</span>
            <span>{performanceIsStale(mine.data) ? t("copyUpdates.snapshotStale") : !mine.data.coverage.complete ? t("copyUpdates.partialHistory") : t("copyUpdates.snapshotHistory")}{mine.data.coverage.lastSnapshotAt ? ` · ${format.dateTime(mine.data.coverage.lastSnapshotAt)}` : ""}</span>
          </p>
        ) : null}
      </div>
      <div className="border-t-2 border-dotted border-border p-3" data-testid="copy-compare">
        <p className="text-xs font-semibold">{t("pf.detail.sameWindow", { date: format.dateTime(from) })}</p>
        <dl className="mt-2 grid grid-cols-2 gap-2">
          {([["yours", t("pf.detail.yourCopy"), yours], ["trader", traderName, theirs]] as const).map(([key, label, v]) => (
            <div key={key} className="rounded-xl bg-raised/50 p-3">
              <dt className="truncate text-[11px] text-muted-foreground">{label}</dt>
              <dd className={cn("num mt-1 text-base font-bold", tone(v?.roi ?? null))}>{v?.roi === null || v?.roi === undefined ? "—" : format.pct(v.roi, { sign: true, digits: 2 })}</dd>
              <dd className={cn("num text-xs", tone(v?.pnl ?? null))}>{v ? format.usd(v.pnl, { sign: true, digits: 2 }) : "—"}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-[11px] text-muted-foreground">{t("pf.detail.note")}</p>
      </div>
    </section>
  );
}
