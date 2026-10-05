"use client";

import { ChevronDown, ChartPie, Share2, UserPlus, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { cn } from "cn";

import { AreaChart } from "@/components/charts/area-chart";
import { PaperBadge } from "@/components/copy/paper-badge";
import { TraderAvatar, boardName } from "@/components/discover/board-bits";
import { ListRowsSkeleton, SkelBar, Skeleton } from "@/components/page";
import { CoinIcon } from "@/components/traders/coin-icon";
import { RoiPill } from "@/components/traders/bits";
import { Button } from "@/components/ui/button";
import { TradeShareDialog, copyCardSource, type TradeCardSource } from "@/components/trader/trade-share-dialog";
import { useI18n } from "@/i18n/provider";
import type { CopyOverview, CopyStrategyView } from "@/lib/contracts";
import { useCopyPortfolio, useCopyTrades, type CopyClosedTradeView } from "@/lib/copy";
import { PORTFOLIO_WINDOWS, exposure, insightsOverview, netInvested, paperLegend, sharePct, todayChange } from "@/lib/copy-portfolio";
import { coinLabel, usdCompact } from "@/lib/format";
import type { CopyPerformanceWindow } from "@trading-dashboard/shared/contracts";

type Leader = { address: string; displayName: string | null; avatarUrl: string | null };
const leaderOf = (leaders: Map<string, Leader>, address: string): Leader => leaders.get(address) ?? { address, displayName: null, avatarUrl: null };
const tone = (v: number | null | undefined) => (v === null || v === undefined ? "" : v >= 0 ? "text-positive" : "text-negative");

/** CopyDog's text segments (mono, uppercase, no pill). */
export function Seg<T extends string>({ value, onChange, options, label }: { value: T; onChange: (value: T) => void; options: Array<[T, React.ReactNode]>; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-0.5 rounded-full bg-(--seg-track,var(--raised)) p-1">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={v === value}
          onClick={() => onChange(v)}
          className={cn(
            "h-9 rounded-full px-3 text-[13px] whitespace-nowrap outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring",
            v === value ? "bg-primary font-extrabold text-primary-foreground" : "font-bold text-muted-foreground hover:text-foreground",
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** A copy's PnL since it started (CopyDog's equity-curve column): green
 * when it ends up, red when down; gaps are left out. */
export function CopySparkline({ points, width = 72, height = 28, className }: { points: ReadonlyArray<number | null> | undefined; width?: number; height?: number; className?: string }) {
  const known = (points ?? []).map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null && Number.isFinite(p[1]));
  if (known.length < 2) return <span className={cn("text-muted-foreground", className)}>—</span>;
  const n = Math.max(1, (points?.length ?? 1) - 1);
  const values = known.map(([, v]) => v);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pad = 3;
  const xy = known.map(([i, v]) => [pad + (i / n) * (width - 2 * pad), height - pad - ((v - lo) / span) * (height - 2 * pad)] as const);
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const up = values.at(-1)! >= 0;
  const [ex, ey] = xy.at(-1)!;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-hidden className={cn("chart-draw inline-block", up ? "text-positive" : "text-negative", className)}>
      <path d={`${d}L${ex.toFixed(1)},${height}L${xy[0]![0].toFixed(1)},${height}Z`} fill="currentColor" fillOpacity={0.12} />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={ex} cy={ey} r={2.4} fill="currentColor" />
    </svg>
  );
}

/**
 * The whole paper portfolio's PnL (CopyDog's portfolio chart): 盈虧 / ROI,
 * 24H / 7D / 30D / ALL. ROI is each point's PnL ÷ the live copies' current
 * net deposits, as CopyDog divides; it is offered only when that is above 0.
 */
export function PortfolioChart({ overview, height = 240, className }: { overview: CopyOverview; height?: number; className?: string }) {
  const { t, format } = useI18n();
  const [window, setWindow] = useState<CopyPerformanceWindow>("all");
  const [metric, setMetric] = useState<"pnl" | "roi">("pnl");
  const query = useCopyPortfolio(window);
  const invested = netInvested(overview.strategies);
  const roiOk = invested > 0;
  const roi = metric === "roi" && roiOk;
  const known = useMemo(() => (query.data?.points ?? []).filter((p) => p.pnl !== null).map((p) => [Date.parse(p.time), p.pnl!] as const), [query.data]);
  const series = useMemo(() => (roi ? known.map(([x, v]) => [x, v / invested] as const) : known), [known, roi, invested]);
  const last = known.at(-1);
  const lastRoi = last && roiOk ? last[1] / invested : null;
  const span = known.length > 1 ? (known.at(-1)![0] - known[0]![0] > 60 * 86_400_000 ? "months" : known.at(-1)![0] - known[0]![0] > 2 * 86_400_000 ? "days" : "hours") : "days";
  const fmtUsd = (v: number) => format.usd(v, { sign: true, digits: 2 });
  return (
    <section className={cn("flex min-w-0 flex-col rounded-2xl bg-raised p-3 [--seg-track:var(--background)] md:p-[18px]", className)} aria-label={t("pf.chart.aria")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Seg label={t("pf.chart.metric")} value={roi ? "roi" : "pnl"} onChange={setMetric} options={roiOk ? [["pnl", t("pf.chart.pnl")], ["roi", t("pf.chart.roi")]] : [["pnl", t("pf.chart.pnl")]]} />
          <PaperBadge />
        </div>
        <Seg label={t("copyUpdates.historyWindow")} value={window} onChange={setWindow} options={PORTFOLIO_WINDOWS.map(([w, key]) => [w, t(`windows.${key}`)])} />
      </div>
      <div className="flex items-start justify-between gap-3 pt-3">
        <div className="flex min-w-0 flex-col items-start gap-2">
          {query.isPending && !query.data ? (
            <>
              <SkelBar line="h-[30.8px]" className="ui-skeleton h-6 w-40 bg-border" />
              {/* The ROI pill's place. */}
              {roiOk ? <SkelBar className="ui-skeleton h-[26px] w-20 bg-border" /> : null}
            </>
          ) : (
            <p className={cn("num font-display text-[1.75rem] leading-[1.1]", last ? tone(last[1]) : "text-muted-foreground")}>
              {!last ? "—" : roi ? format.pct(lastRoi!, { sign: true, digits: 2 }) : fmtUsd(last[1])}
            </p>
          )}
          {last && roiOk ? (
            roi ? (
              <span className={cn("num inline-flex h-[26px] items-center rounded-full px-3 text-sm font-semibold", last[1] >= 0 ? "bg-tag-profit text-tag-profit-foreground" : "bg-tag-loss text-tag-loss-foreground")}>{usdCompact(last[1], { sign: true, digits: 2 })}</span>
            ) : (
              <RoiPill value={lastRoi} label={`${Math.abs(lastRoi! * 100).toFixed(2)}%`} className="h-[26px] gap-[3px] px-3 text-sm leading-none [&>svg]:size-2.5" />
            )
          ) : null}
        </div>
        {last ? <p className="num mt-1 shrink-0 font-mono text-[11px] font-medium whitespace-nowrap text-muted-foreground">{format.stamp(last[0])}</p> : null}
      </div>
      <div className="flex-1 px-1.5 pt-1.5 pb-2">
        {series.length > 1 ? (
          <AreaChart
            data={series}
            animateKey={`${window}:${roi}`}
            height={height}
            axes
            interactive
            zeroBaseline
            formatValue={roi ? (v) => format.pct(v, { sign: true, digits: 2 }) : fmtUsd}
            formatTick={(v) => (roi ? format.pct(v, { digits: 1 }) : usdCompact(v))}
            formatTime={(ts) => format.dateTime(ts)}
            formatAxisTime={(ts) => format.axisDate(ts, span)}
            ariaLabel={t("pf.chart.aria")}
          />
        ) : query.isPending ? (
          <div style={{ height }}><Skeleton className="h-full rounded-2xl bg-background/60" /></div>
        ) : (
          <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>
            {query.isError ? t("copyUpdates.historyError") : t("pf.chart.noData")}
          </div>
        )}
        {query.data?.partial && series.length > 1 ? <p className="px-2 pt-1 text-[11px] text-muted-foreground">{t("pf.chart.partial")}</p> : null}
      </div>
    </section>
  );
}

/** The paper account as CopyDog's hero: total value, today's change (UTC
 * day) and the Available / Copied / Unrealized legend. */
export function PaperSummary({ overview, className, collapsible = false }: { overview: CopyOverview; className?: string; collapsible?: boolean }) {
  const { t, format } = useI18n();
  const portfolio = useCopyPortfolio("1d", overview.strategies.length > 0);
  const today = todayChange(overview, portfolio.data?.todayPnl);
  const legend = paperLegend(overview);
  const [open, setOpen] = useState(!collapsible);
  const p = overview.paper;
  const rows: Array<[string, number | null, boolean]> = [
    [t("pf.legend.available"), legend.available, false],
    [t("pf.legend.copied"), legend.copied, false],
    [t("pf.legend.unrealized"), legend.unrealized, true],
    [t("pf.legend.totalPnl"), p.totalPnl, true],
  ];
  return (
    <section className={cn("flex flex-col rounded-2xl bg-raised p-6", className)} aria-label={t("portfolio.copy.paperAccount")}>
      <div className="flex items-center justify-between gap-2">
        <p className="font-display text-xl">{t("portfolio.copy.paperAccount")}</p>
        <PaperBadge />
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="num font-display text-[2.5rem] leading-tight">{p.totalValue === null ? "—" : format.usd(p.totalValue, { digits: 2 })}</p>
        {collapsible ? (
          <button type="button" aria-expanded={open} aria-label={t("portfolio.breakdown")} onClick={() => setOpen((v) => !v)} className="inline-flex size-8 items-center justify-center rounded-full bg-raised outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
          </button>
        ) : null}
      </div>
      {today ? (
        <p className="num mt-1 flex items-center gap-1.5 text-sm font-semibold" data-testid="paper-today">
          <span className={tone(today.pnl)}>{format.usd(today.pnl, { sign: true, digits: 2 })}</span>
          {today.pct !== null ? <span className={tone(today.pct)}>({format.pct(today.pct, { sign: true, digits: 2 })})</span> : null}
          <span className="text-xs font-normal text-muted-foreground">{t("pf.today")}</span>
        </p>
      ) : overview.strategies.length > 0 && !portfolio.isPending ? (
        <p className="num mt-1 text-sm text-muted-foreground" data-testid="paper-today">— <span className="text-xs">{t("pf.today")}</span></p>
      ) : null}
      {open ? (
        <dl className="mt-5 grid grid-cols-1 gap-2 text-[0.9375rem] xl:grid-cols-2">
          {rows.map(([label, value, signed]) => (
            <div key={label} className="flex flex-col gap-0.5 rounded-xl bg-card px-4 py-3">
              <dt className="text-xs font-bold text-muted-foreground">{label}</dt>
              <dd className={cn("num font-display text-xl", signed ? tone(value) : "")}>{value === null ? "—" : format.usd(value, { sign: signed, digits: 2 })}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p className="mt-auto pt-4 text-xs font-bold text-muted-foreground">{t("portfolio.copy.paperHint")}</p>
    </section>
  );
}

function SecHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex min-h-8 items-center justify-between gap-3">
      <h3 className="type-h2">{title}</h3>
      {children}
    </div>
  );
}

function Pills<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<[T, string]>; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5 rounded-full bg-(--seg-track,var(--raised)) p-1">
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={v === value} onClick={() => onChange(v)} className={cn("h-8 rounded-full px-3 text-xs outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring", v === value ? "bg-primary font-extrabold text-primary-foreground" : "font-bold text-muted-foreground")}>
          {text}
        </button>
      ))}
    </div>
  );
}

function EmptyBlock({ icon: Icon, title, body, cta }: { icon: typeof ChartPie; title: string; body: string; cta?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <Icon className="size-9 text-muted-foreground" strokeWidth={1.5} aria-hidden />
      <p className="mt-3 text-[0.9375rem] font-bold">{title}</p>
      <p className="mt-2 max-w-sm text-[0.8125rem] text-muted-foreground">{body}</p>
      {cta ? <Button asChild className="mt-5"><Link href="/explore">{t("portfolio.cta")}</Link></Button> : null}
    </div>
  );
}

function TradeRow({ trade, leaders }: { trade: CopyClosedTradeView; leaders: Map<string, Leader> }) {
  const { t, format } = useI18n();
  const [card, setCard] = useState<TradeCardSource | null>(null);
  return (
    <li className="flex items-center gap-3 py-2.5">
      {card ? <TradeShareDialog source={card} onClose={() => setCard(null)} /> : null}
      <CoinIcon coin={trade.coin} size={32} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold">{coinLabel(trade.coin)}</span>
        <span className="truncate text-xs text-muted-foreground">{boardName(leaderOf(leaders, trade.leaderAddress))} · {format.date(trade.closedAt)}</span>
      </div>
      <div className="flex flex-col items-end">
        <span className={cn("num text-sm font-semibold", tone(trade.pnl))}>{format.usd(trade.pnl, { sign: true, digits: 2 })}</span>
        {trade.roiPct !== null ? <span className={cn("num text-xs", tone(trade.roiPct))}>{format.pct(trade.roiPct / 100, { sign: true, digits: 1 })}</span> : null}
      </div>
      <button type="button" aria-haspopup="dialog" onClick={() => setCard(copyCardSource("trade", { id: trade.id }, coinLabel(trade.coin)))} aria-label={t("trader.shareTrade")} title={t("trader.shareTrade")}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <Share2 className="size-3.5" />
      </button>
    </li>
  );
}

/** CopyDog's Best / Worst trades: the five largest closed gains or losses
 * (after fees), with the trader and the close date. Hidden with none. */
function BestWorst({ leaders }: { leaders: Map<string, Leader> }) {
  const { t } = useI18n();
  const [which, setWhich] = useState<"best" | "worst">("best");
  const best = useCopyTrades("best", 5);
  const worst = useCopyTrades("worst", 5);
  const list = which === "best" ? best : worst;
  if (best.data && worst.data && best.data.items.length === 0 && worst.data.items.length === 0) return null;
  return (
    <section>
      <SecHead title={which === "best" ? t("pf.insights.bestTrades") : t("pf.insights.worstTrades")}>
        <Pills label={t("pf.insights.bestTrades")} value={which} onChange={setWhich} options={[["best", t("pf.insights.best")], ["worst", t("pf.insights.worst")]]} />
      </SecHead>
      {list.data ? (
        list.data.items.length ? (
          <ul className="divide-y-2 divide-dotted divide-border">{list.data.items.map((trade) => <TradeRow key={trade.id} trade={trade} leaders={leaders} />)}</ul>
        ) : (
          <p className="py-4 text-sm text-muted-foreground">{which === "best" ? t("pf.insights.noWins") : t("pf.insights.noLosses")}</p>
        )
      ) : list.isError ? (
        <p className="py-4 text-sm text-muted-foreground">{t("copyUpdates.historyError")}</p>
      ) : (
        <ListRowsSkeleton rowClassName="py-2.5" />
      )}
    </section>
  );
}

/** CopyDog's Traders list: P&L or ROI, and each copy's share of the copied equity. */
function TraderLeague({ strategies, leaders, onSelect }: { strategies: CopyStrategyView[]; leaders: Map<string, Leader>; onSelect: (id: number) => void }) {
  const { t, format } = useI18n();
  const [by, setBy] = useState<"pnl" | "roi">("pnl");
  const live = strategies.filter((s) => s.status !== "stopped");
  const deployed = Math.max(live.reduce((a, s) => a + (s.equity ?? 0), 0), 1e-4);
  const sorted = [...live].sort((a, b) => (by === "roi" ? (b.roiPct ?? -Infinity) - (a.roiPct ?? -Infinity) : (b.totalPnl ?? 0) - (a.totalPnl ?? 0)));
  return (
    <section>
      <SecHead title={t("pf.insights.traders")}>
        <Pills label={t("pf.insights.traders")} value={by} onChange={setBy} options={[["pnl", "PnL"], ["roi", "ROI"]]} />
      </SecHead>
      <ul className="flex flex-col">
        {sorted.map((s) => {
          const leader = leaderOf(leaders, s.leaderAddress);
          const share = (s.equity ?? 0) / deployed;
          return (
            <li key={s.id}>
              <button type="button" onClick={() => onSelect(s.id)} className="flex w-full items-center gap-3 rounded-lg py-2.5 text-left outline-none hover:bg-raised/40 focus-visible:ring-2 focus-visible:ring-ring">
                <TraderAvatar trader={leader} size={34} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-sm font-semibold">{boardName(leader)}</span>
                  <span className="flex items-center gap-2">
                    <span className="relative h-1.5 w-14 rounded-full bg-raised"><span className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${Math.min(100, Math.max(0, share * 100))}%` }} /></span>
                    <span className="num text-xs text-muted-foreground">{sharePct(share)}</span>
                  </span>
                </span>
                <span className="flex flex-col items-end">
                  {by === "pnl" ? (
                    <span className={cn("num text-sm font-semibold", tone(s.totalPnl))}>{s.totalPnl === null ? "—" : format.usd(s.totalPnl, { sign: true, digits: 2 })}</span>
                  ) : (
                    <span className={cn("num text-sm font-semibold", tone(s.roiPct))}>{s.roiPct === null ? "—" : format.pct(s.roiPct / 100, { sign: true, digits: 1 })}</span>
                  )}
                  <span className="num text-xs text-muted-foreground">{t("pf.insights.equity", { value: s.equity === null ? "—" : format.usd(s.equity, { digits: 2 }) })}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Insights: Overview, Best / Worst trades and Traders (CopyDog), in three
 * columns on desktop and stacked (with the chart first) on phones. */
export function InsightsPanel({ overview, leaders, onSelect, desktop }: { overview: CopyOverview; leaders: Map<string, Leader>; onSelect: (id: number) => void; desktop: boolean }) {
  const { t, format } = useI18n();
  if (overview.strategies.length === 0) return <EmptyBlock icon={ChartPie} title={t("pf.insights.noPerfTitle")} body={t("pf.insights.noPerfDesc")} cta />;
  const o = insightsOverview(overview.strategies);
  const kpis: Array<[string, string, string]> = [
    [t("pf.insights.invested"), format.usd(o.invested, { digits: 2 }), ""],
    [t("pf.insights.value"), o.value === null ? "—" : format.usd(o.value, { digits: 2 }), ""],
    [t("pf.insights.totalPnl"), o.totalPnl === null ? "—" : format.usd(o.totalPnl, { sign: true, digits: 2 }), tone(o.totalPnl)],
    [t("pf.insights.roi"), o.roiPct === null ? "—" : format.pct(o.roiPct / 100, { sign: true, digits: 1 }), tone(o.roiPct)],
  ];
  const overviewBlock = (
    <section>
      <SecHead title={t("pf.insights.overview")} />
      <dl className="divide-y-2 divide-dotted divide-border">
        {kpis.map(([k, v, c]) => (
          <div key={k} className="flex items-center justify-between gap-3 py-2.5 text-sm">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className={cn("num font-semibold", c)}>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
  return desktop ? (
    <div className="grid grid-cols-1 lg:grid-cols-3 lg:divide-x lg:divide-border">
      <div className="p-4">{overviewBlock}</div>
      <div className="p-4"><BestWorst leaders={leaders} /></div>
      <div className="p-4"><TraderLeague strategies={overview.strategies} leaders={leaders} onSelect={onSelect} /></div>
    </div>
  ) : (
    <div className="flex flex-col gap-6">
      <PortfolioChart overview={overview} height={196} />
      {overviewBlock}
      <BestWorst leaders={leaders} />
      <TraderLeague strategies={overview.strategies} leaders={leaders} onSelect={onSelect} />
    </div>
  );
}

function Bar({ parts }: { parts: Array<[number, string]> }) {
  return (
    <div className="flex h-2.5 overflow-hidden rounded-full bg-raised">
      {parts.map(([w, cls], i) => <span key={i} className={cls} style={{ width: `${Math.max(0, Math.min(100, w))}%` }} />)}
    </div>
  );
}

/** Exposure: Direction, Leverage and By Asset (CopyDog), with the hedged
 * coins marked and each coin's copies listed when opened. */
export function ExposurePanel({ overview, leaders, desktop }: { overview: CopyOverview; leaders: Map<string, Leader>; desktop: boolean }) {
  const { t, format } = useI18n();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const e = exposure(overview.strategies);
  if (!e) return <p role="status" className="py-8 text-center text-sm text-muted-foreground">{t("copyUpdates.exposureUnknown")}</p>;
  if (e.assets.length === 0) return <EmptyBlock icon={UserPlus} title={t("pf.exposure.noOpenTitle")} body={t("pf.exposure.noOpenDesc")} />;
  const net = e.long - e.short;
  const direction = (
    <section>
      <SecHead title={t("pf.exposure.direction")}><PaperBadge /></SecHead>
      <p className="num text-2xl font-bold">{format.usd(e.gross, { digits: 2 })}</p>
      {e.assets.some((a) => a.hedged) ? <p className="mt-1 text-xs text-warning">{t("copyUpdates.hedgeHint")}</p> : null}
      <div className="mt-3"><Bar parts={[[e.longPct, "bg-positive"], [e.shortPct, "bg-negative"]]} /></div>
      <dl className="mt-3 grid gap-2 text-sm">
        <div className="flex justify-between gap-3"><dt className="flex items-center gap-2 text-muted-foreground"><span className="size-2 rounded-full bg-positive" />{t("pf.exposure.long")} {Math.round(e.longPct)}%</dt><dd className="num font-semibold">{format.usd(e.long, { digits: 2 })}</dd></div>
        <div className="flex justify-between gap-3"><dt className="flex items-center gap-2 text-muted-foreground"><span className="size-2 rounded-full bg-negative" />{t("pf.exposure.short")} {Math.round(e.shortPct)}%</dt><dd className="num font-semibold">{format.usd(e.short, { digits: 2 })}</dd></div>
        <div className="flex justify-between gap-3 border-t-2 border-dotted border-border pt-2"><dt className="text-muted-foreground">{t("copyUpdates.exposureLabels.netExposure")}</dt><dd className="num font-semibold">{format.usd(Math.abs(net), { digits: 2 })}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("copyUpdates.exposureLabels.signedNet")}</dt><dd className="num font-semibold">{format.usd(net, { sign: true, digits: 2 })}</dd></div>
      </dl>
      <p className="mt-3 text-[11px] text-muted-foreground">{t("copyUpdates.exposureLabels.exposureFormula")}</p>
    </section>
  );
  const leverage = (
    <section>
      <SecHead title={t("pf.exposure.leverage")} />
      <p className="num text-2xl font-bold">{e.leverage === null ? "—" : `${e.leverage.toFixed(1)}×`}</p>
      <div className="mt-3"><Bar parts={[[e.leverage === null ? 0 : (e.leverage / 10) * 100, "bg-primary"]]} /></div>
      <dl className="mt-3 grid gap-2 text-sm">
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("pf.exposure.notional")}</dt><dd className="num font-semibold">{format.usd(e.gross, { digits: 2 })}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("pf.exposure.equity")}</dt><dd className="num font-semibold">{format.usd(e.equity, { digits: 2 })}</dd></div>
      </dl>
      <p className="mt-3 text-[11px] text-warning">{t("copyUpdates.exposureLabels.accountRisk")}</p>
    </section>
  );
  const byAsset = (
    <section>
      <SecHead title={t("pf.exposure.byAsset")} />
      <ul className="divide-y-2 divide-dotted divide-border">
        {e.assets.map((a) => {
          const share = e.gross > 0 ? a.grossNotional / e.gross : 0;
          const expanded = open.has(a.coin);
          return (
            <li key={a.coin}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen((cur) => { const next = new Set(cur); if (next.has(a.coin)) next.delete(a.coin); else next.add(a.coin); return next; })}
                className="flex w-full items-center gap-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CoinIcon coin={a.coin} size={30} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold">{coinLabel(a.coin)}</span>
                    {a.hedged ? (
                      <span className="rounded px-1.5 py-0.5 text-[10px] font-bold text-warning bg-warning/15">{t("pf.exposure.hedged")}</span>
                    ) : (
                      <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", a.isLong ? "bg-tag-profit text-tag-profit-foreground" : "bg-tag-loss text-tag-loss-foreground")}>{a.isLong ? t("pf.exposure.long") : t("pf.exposure.short")}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="relative h-1.5 w-14 rounded-full bg-raised"><span className={cn("absolute inset-y-0 left-0 rounded-full", a.hedged ? "bg-warning" : a.isLong ? "bg-positive" : "bg-negative")} style={{ width: `${Math.min(100, share * 100)}%` }} /></span>
                    <span className="text-xs text-muted-foreground">{t(a.copyCount === 1 ? "pf.exposure.shareOne" : "pf.exposure.shareMany", { pct: sharePct(share), count: a.copyCount })}</span>
                  </span>
                </span>
                <span className="flex flex-col items-end">
                  <span className="num text-sm font-semibold">{format.usd(a.grossNotional, { digits: 2 })}</span>
                  <span className={cn("num text-xs", tone(a.pnl))}>{format.usd(a.pnl, { sign: true, digits: 2 })}</span>
                </span>
                <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} />
              </button>
              {expanded ? (
                <ul className="mb-2 rounded-xl bg-raised/40 px-3">
                  {a.lines.map((l) => {
                    const leader = leaderOf(leaders, l.leaderAddress);
                    return (
                      <li key={`${l.strategyId}-${a.coin}`} className="flex items-center gap-2.5 py-2">
                        <TraderAvatar trader={leader} size={22} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="flex items-center gap-1.5 text-xs font-semibold">
                            <span className="truncate">{boardName(leader)}</span>
                            <span className={cn("rounded px-1 py-px text-[10px]", l.size > 0 ? "bg-tag-profit text-tag-profit-foreground" : "bg-tag-loss text-tag-loss-foreground")}>{l.size > 0 ? t("pf.exposure.long") : t("pf.exposure.short")}</span>
                          </span>
                          <span className="num text-[11px] text-muted-foreground">{format.usd(l.notional, { digits: 2 })}</span>
                        </span>
                        <span className="flex flex-col items-end">
                          <span className={cn("num text-xs font-semibold", tone(l.unrealizedPnl))}>{format.usd(l.unrealizedPnl, { sign: true, digits: 2 })}</span>
                          {l.roiPct !== null ? <span className={cn("num text-[11px]", tone(l.roiPct))}>{format.pct(l.roiPct / 100, { sign: true, digits: 2 })}</span> : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
  return desktop ? (
    <div className="grid grid-cols-1 lg:grid-cols-3 lg:divide-x lg:divide-border">
      <div className="p-4">{direction}</div>
      <div className="p-4">{leverage}</div>
      <div className="p-4">{byAsset}</div>
    </div>
  ) : (
    <div className="flex flex-col gap-6">{direction}{leverage}{byAsset}</div>
  );
}

/** CopyDog's 反向持倉提示 after a copy starts, worded for Orbie's separate
 * copy wallets: the opposite positions both stay open. */
export function HedgeNotice({ trader, coins, onDismiss }: { trader: string; coins: string[]; onDismiss: () => void }) {
  const { t } = useI18n();
  return (
    <div role="status" className="rounded-xl border border-warning/40 bg-warning/10 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold text-warning">{t("pf.hedge.title")}</p>
        <button type="button" onClick={onDismiss} aria-label={t("pf.hedge.dismiss")} className="inline-flex size-6 items-center justify-center rounded-full outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring">
          <X className="size-3.5" />
        </button>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{t("pf.hedge.body", { trader, coins: coins.map(coinLabel).join(", ") })}</p>
    </div>
  );
}

/** The 模擬帳戶 card while /me/copy loads: same card, title, value line and
 * the four figure wells (`compact`: the phone's collapsed card). */
export function PaperSummarySkeleton({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { t } = useI18n();
  return (
    <section aria-hidden="true" className={cn("ui-skeleton flex flex-col rounded-2xl bg-raised p-6 [--skel-bar:var(--border)]", className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="font-display text-xl">{t("portfolio.copy.paperAccount")}</p>
        <SkelBar className="h-6 w-14" />
      </div>
      <SkelBar line="h-[50px]" className="h-8 w-40" />
      <SkelBar line="mt-1 h-5" className="h-3 w-28" />
      {compact ? (
        <SkelBar line="pt-4 h-8" className="h-2.5 w-40" />
      ) : (
        <>
          <div className="mt-5 grid grid-cols-1 gap-2 xl:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex flex-col gap-0.5 rounded-xl bg-card px-4 py-3">
                <SkelBar line="h-4" className="h-2.5 w-14" />
                <SkelBar line="h-7" className="h-4 w-20" />
              </div>
            ))}
          </div>
          <SkelBar line="mt-auto pt-4 h-8" className="h-2.5 w-40" />
        </>
      )}
    </section>
  );
}

/** PortfolioChart while /me/copy loads: its header controls, the headline
 * and the chart area, at the loaded sizes. */
export function PortfolioChartSkeleton({ height = 240, className }: { height?: number; className?: string }) {
  return (
    <section aria-hidden="true" className={cn("ui-skeleton flex min-w-0 flex-col rounded-2xl bg-raised p-3 [--skel-bar:var(--border)] md:p-[18px]", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="h-10 w-28 rounded-full bg-background" />
          <SkelBar className="h-6 w-14" />
        </div>
        <span className="h-10 w-56 rounded-full bg-background" />
      </div>
      <div className="flex flex-col items-start gap-2 pt-3">
        <SkelBar line="h-[30.8px]" className="h-6 w-40" />
        <SkelBar className="h-[26px] w-20" />
      </div>
      <div className="flex-1 px-1.5 pt-1.5 pb-2">
        <div className="rounded-2xl bg-background/60" style={{ height }} />
      </div>
    </section>
  );
}
