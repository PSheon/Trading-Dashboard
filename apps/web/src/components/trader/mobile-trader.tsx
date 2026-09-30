"use client";

import type { PortfolioResponse, TraderAnalyticsResponse, TraderProfileResponse, TraderWindow } from "@/lib/contracts";
import { ArrowLeft, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { cn } from "cn";

import { AlertBell } from "@/components/alerts/alert-bell";
import { OrbieMark } from "@/components/brand/logo";
import { AreaChart } from "@/components/charts/area-chart";
import { Skeleton } from "@/components/page";
import { FavoriteButton, RoiPill } from "@/components/traders/bits";
import { roiPillShort } from "@/lib/board-format";
import { useI18n } from "@/i18n/provider";
import { isComputing, useTraderAnalytics } from "@/lib/queries";
import { CopyScoreBar, TraderAvatar, VerifiedTick } from "@/components/discover/board-bits";
import { truncateAddress, usdCompact } from "@/lib/format";
import { pct1, signedUsdShort, usd2, winRateTone } from "@/lib/trade-format";
import { shareName } from "@/lib/share-card";
import { CopyPanel } from "./copy-panel";
import { ShareButton } from "./share-dialog";
import { MobileInsights } from "./mobile-insights";
import { useAuth } from "@/lib/auth";
import { useCopyOf } from "@/lib/copy";
import { signedPctCd, WINDOWS } from "./performance";
import { PerformanceTab, TradesTab, type PerfView } from "./trade-analytics";
import { PositionsTab } from "./trader-tabs";

/** A row of pills, the active one filled with the brand colour (CopyDog's
 * mobile segmented controls). */
function Pills<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  stretch = false,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<[T, string]>;
  label: string;
  className?: string;
  stretch?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex items-center gap-1 rounded-full bg-raised p-1", className)}>
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn(
            "h-9 rounded-full px-3.5 text-[0.8125rem] font-semibold whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring",
            stretch && "flex-1",
            value === v ? "bg-primary text-primary-foreground" : "text-muted-foreground",
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** The trader page's own top bar on phones (CopyDog's): back, the address
 * (a KOL's name and badge instead), favourite, alert and share. Replaces the app's header there. */
function TopBar({ profile }: { profile: TraderProfileResponse }) {
  const { t } = useI18n();
  return (
    <div className="sticky top-[env(safe-area-inset-top,0px)] z-30 -mx-5 -mt-5 flex h-14 items-center gap-1 bg-background/90 px-2 backdrop-blur-xl">
      <Link
        href="/explore"
        aria-label={t("common.back")}
        className="inline-flex size-10 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft className="size-5" />
      </Link>
      {profile.kol ? (
        <span className="flex min-w-0 flex-1 items-center justify-center gap-1">
          <span className="min-w-0 truncate text-[0.9375rem] font-bold" title={profile.address}>{profile.displayName?.trim() || truncateAddress(profile.address)}</span>
          {profile.kol.verified ? <VerifiedTick className="size-3.5" /> : null}
        </span>
      ) : (
        <span className="num min-w-0 flex-1 truncate text-center text-[0.9375rem] font-bold">{truncateAddress(profile.address)}</span>
      )}
      <FavoriteButton address={profile.address} favorite={profile.favorite} size="sm" />
      <AlertBell address={profile.address} history />
      <ShareButton
        address={profile.address}
        name={shareName({ address: profile.address, displayName: profile.displayName, kol: profile.kol })}
        className="size-10"
        iconClassName="size-5"
      />
    </div>
  );
}

/** Win rate as a ring (CopyDog's mobile KPI card). */
function Ring({ value, className }: { value: number; className?: string }) {
  const r = 8;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 20 20" className={cn("size-5 -rotate-90", className)} aria-hidden>
      <circle cx="10" cy="10" r={r} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth="3" />
      <circle cx="10" cy="10" r={r} fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray={`${c * Math.max(0, Math.min(1, value))} ${c}`} strokeLinecap="round" />
    </svg>
  );
}

const TONE = { positive: "text-positive", warning: "text-warning", negative: "text-negative" } as const;

type MobileTab = "positions" | "insights" | "performance" | "trades";

/**
 * The trader page on phones, laid out as CopyDog's app: its own top bar,
 * the chart first (損益 / ROI), window pills, a 2×2 card (帳戶價值, 夏普,
 * 勝率 with a ring, 回撤), segmented 持倉 / 洞察 / 表現 / 交易 with cards
 * instead of tables, and a sticky 跟單 button in place of the tab bar that
 * opens the copy panel as a sheet. The copy score sits under the avatar
 * when the trader has one.
 */
export function MobileTrader({
  profile,
  marks,
  portfolio,
  allTime,
  window,
  onWindow,
  loading,
  copyScore,
}: {
  profile: TraderProfileResponse;
  marks: Readonly<Record<string, number>>;
  /** The chart's window (perp). */
  portfolio: PortfolioResponse | undefined;
  /** All time (perp): Sharpe and drawdown. */
  allTime: PortfolioResponse | undefined;
  window: TraderWindow;
  onWindow: (w: TraderWindow) => void;
  loading: boolean;
  /** CopyDog's hero shows the copy score under the chart header. */
  copyScore: number | null;
}) {
  const { t, format } = useI18n();
  const [mode, setMode] = useState<"pnl" | "roi">("pnl");
  const [tab, setTab] = useState<MobileTab>("positions");
  const [perfView, setPerfView] = useState<PerfView>("best");
  const [sheet, setSheet] = useState(false);
  const { status: authStatus, login } = useAuth();
  const copying = useCopyOf(profile.address) !== undefined;
  const trades = useTraderAnalytics(profile.address, "all");
  const winRate = (trades.data as TraderAnalyticsResponse | undefined)?.summary.winRate ?? null;
  const winTone = winRateTone(winRate);
  const sharpe = allTime?.sharpe ?? null;
  const mdd = allTime?.maxDrawdownPct ?? null;

  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSheet(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheet]);

  const series = useMemo(() => (portfolio ? (mode === "pnl" ? portfolio.pnl : portfolio.cumulativeReturn) : []), [portfolio, mode]);
  const pnl = portfolio?.pnl.at(-1)?.[1] ?? null;
  const roi = portfolio?.roi ?? null;
  const headline = mode === "pnl" ? pnl : roi;
  const spanMs = series.length > 1 ? series[series.length - 1][0] - series[0][0] : 0;
  const span = spanMs <= 2 * 86400_000 ? "hours" : spanMs <= 150 * 86400_000 ? "days" : "months";
  const fmt = (v: number) => (mode === "roi" ? format.pct(v, { sign: true }) : format.usd(v, { compact: true, sign: true }));

  return (
    <div className="flex flex-col gap-4 pb-6">
      <TopBar profile={profile} />

      <section aria-label={t("trader.chart.pnlLabel")} className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col items-start gap-2.5">
            <Pills
              value={mode}
              onChange={setMode}
              label={t("trader.chart.pnlLabel")}
              options={[["pnl", t("trader.mobile.pnl")], ["roi", t("trader.mobile.roi")]]}
            />
            {loading && !portfolio ? (
              <Skeleton className="h-9 w-44" />
            ) : (
              <div className="num text-[2rem] leading-none font-bold tracking-tight">
                {headline === null ? "—" : mode === "pnl" ? signedUsdShort(headline) : signedPctCd(headline)}
              </div>
            )}
            {mode === "pnl" && roi !== null ? <RoiPill value={roi} label={roiPillShort(roi)} /> : null}
          </div>
          <span className="flex flex-col items-end gap-2">
            {profile.kol?.avatarUrl ? (
              // A KOL's picture takes the brand mark's place (CopyDog's).
              <TraderAvatar trader={{ address: profile.address, avatarUrl: profile.kol.avatarUrl }} size={48} />
            ) : (
              <span className="inline-flex size-12 items-center justify-center rounded-full bg-raised text-foreground" aria-hidden>
                <OrbieMark size={26} />
              </span>
            )}
            {copyScore != null ? (
              // CopyDog leaves the score out of the hero while there is none.
              // CopyDog: the dotted 複製評分 label over the bar and the score.
              <span className="flex flex-col items-end gap-1.5 text-[0.6875rem] text-muted-foreground" data-testid="hero-copy-score">
                <span className="underline decoration-dotted underline-offset-2">{t("discover.copyScore")}</span>
                <CopyScoreBar score={copyScore} layout="bar-first" barClassName="w-[60px]" className="text-foreground" />
              </span>
            ) : null}
          </span>
        </div>
        {portfolio && series.length > 1 ? (
          <AreaChart
            data={series}
            height={200}
            axes
            interactive
            zeroBaseline
            yAxis="left"
            formatValue={fmt}
            formatTick={(v) => (mode === "roi" ? format.pct(v, { digits: 0 }) : usdCompact(v, { digits: 0 }))}
            formatTime={(ts) => format.dateTime(ts)}
            formatAxisTime={(ts) => format.axisDate(ts, span)}
            ariaLabel={t("trader.chart.pnlLabel")}
          />
        ) : loading ? (
          <Skeleton className="h-[200px]" />
        ) : (
          <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">{t("trader.chart.noData")}</div>
        )}
        <div role="radiogroup" aria-label={t("trader.kpi.period")} className="flex items-center justify-between px-2">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              role="radio"
              aria-checked={window === w}
              onClick={() => onWindow(w)}
              className={cn(
                "h-9 rounded-full px-4 text-[0.8125rem] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
                window === w ? "bg-primary-soft text-primary" : "text-muted-foreground",
              )}
            >
              {t(`windows.${w}`)}
            </button>
          ))}
        </div>
      </section>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-5 rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-col gap-1.5">
          <dt className="text-xs text-muted-foreground">{t("trader.accountValue")}</dt>
          <dd className="num text-xl font-bold">{profile.accountValue === null ? "—" : usd2(profile.accountValue)}</dd>
        </div>
        <div className="flex flex-col gap-1.5">
          <dt className="text-xs text-muted-foreground">{t("trader.kpi.sharpe")}</dt>
          <dd className={cn("num text-xl font-bold", sharpe === null ? "" : sharpe >= 1.5 ? "text-positive" : sharpe >= 0 ? "text-warning" : "text-negative")}>
            {sharpe === null ? "—" : sharpe.toFixed(2)}
          </dd>
        </div>
        <div className="flex flex-col gap-1.5">
          <dt className="text-xs text-muted-foreground">{t("trader.kpi.winRate")}</dt>
          <dd className={cn("num flex items-center gap-2 text-xl font-bold", winTone ? TONE[winTone] : "")}>
            {winRate === null ? (isComputing(trades) ? <Skeleton className="h-6 w-16" /> : "—") : pct1(winRate)}
            {winRate !== null ? <Ring value={winRate} /> : null}
          </dd>
        </div>
        <div className="flex flex-col gap-1.5">
          <dt className="text-xs text-muted-foreground">{t("trader.mobile.drawdown")}</dt>
          <dd className="num text-xl font-bold text-negative">{mdd === null ? "—" : pct1(mdd)}</dd>
        </div>
      </dl>

      <Pills
        value={tab}
        onChange={setTab}
        label={t("trader.tabsLabel")}
        stretch
        options={[
          ["positions", t("trader.tabs.positions")],
          ["insights", t("trader.tabs.insights")],
          ["performance", t("trader.tabs.performance")],
          ["trades", t("trader.tabs.trades")],
        ]}
      />

      <div className="-mx-1">
        {tab === "positions" ? <PositionsTab profile={profile} marks={marks} /> : null}
        {tab === "insights" ? <MobileInsights profile={profile} trades={trades.data} computing={isComputing(trades)} /> : null}
        {tab === "performance" ? (
          <div className="rounded-2xl border border-border bg-card">
            <PerformanceTab
              analytics={trades.data}
              computing={isComputing(trades)}
              error={trades.error}
              onRetry={() => trades.refetch()}
              view={perfView}
              onView={setPerfView}
            />
          </div>
        ) : null}
        {tab === "trades" ? (
          <div className="rounded-2xl border border-border bg-card">
            <TradesTab address={profile.address} />
          </div>
        ) : null}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur-xl md:hidden">
        <button
          type="button"
          onClick={() => (authStatus === "signedOut" ? login() : setSheet(true))}
          className="h-13 w-full rounded-full bg-primary py-3.5 text-base font-bold text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {copying ? t("trader.copy.manage") : t("trader.copyTrade")}
        </button>
      </div>

      {sheet ? (
        <div className="fixed inset-0 z-50 flex items-end bg-black/60 md:hidden" role="dialog" aria-modal="true" aria-label={t("trader.copyTrade")} onClick={() => setSheet(false)}>
          <div className="relative max-h-[85dvh] w-full overflow-y-auto rounded-t-3xl bg-background p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setSheet(false)}
              aria-label={t("common.close")}
              className="absolute top-3 right-3 z-10 inline-flex size-8 items-center justify-center rounded-full bg-raised outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" />
            </button>
            <CopyPanel address={profile.address} sheet />
          </div>
        </div>
      ) : null}
    </div>
  );
}
