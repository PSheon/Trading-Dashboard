"use client";

import type { PortfolioResponse, TraderAnalyticsResponse, TraderProfileResponse, TraderWindow } from "@/lib/contracts";
import { ArrowLeft, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { cn } from "cn";

import { AlertBell } from "@/components/alerts/alert-bell";
import { OrbieMark } from "@/components/brand/logo";
import { AreaChart } from "@/components/charts/area-chart";
import { ErrorState, Skeleton } from "@/components/page";
import { useModalFocus } from "@/lib/use-modal-focus";
import { FavoriteButton, RoiPill } from "@/components/traders/bits";
import { roiPillShort } from "@/lib/board-format";
import { useI18n } from "@/i18n/provider";
import { isComputing, useTraderAnalytics } from "@/lib/queries";
import { CopyScoreBar, TraderAvatar } from "@/components/discover/board-bits";
import { truncateAddress, usdCompact } from "@/lib/format";
import { partialSampleSince, pct1, signedUsdShort, usd2, winRateTone } from "@/lib/trade-format";
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
    <div role="radiogroup" aria-label={label} className={cn("flex items-center gap-0.5 rounded-full bg-card p-[3px]", className)}>
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn(
            "min-h-8 rounded-full px-3 py-[7px] text-xs leading-[18px] font-semibold whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            stretch && "min-w-0 flex-1",
            value === v ? "bg-primary text-primary-foreground" : stretch ? "text-muted-foreground" : "text-foreground",
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
    <div className="sticky top-[env(safe-area-inset-top,0px)] z-30 -mx-5 -mt-5 flex items-center gap-2 bg-background/95 px-5 pt-4 pb-2 backdrop-blur-[10px]">
      <Link
        href="/explore"
        aria-label={t("common.back")}
        className="relative inline-flex size-8 shrink-0 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft className="size-[19px]" />
      </Link>
      {/* CopyDog centres the title across the bar, between 116px gutters. */}
      <h1 className="pointer-events-none absolute inset-x-0 truncate px-[116px] text-center text-base leading-6 font-semibold" title={profile.address}>
        {profile.kol ? profile.displayName?.trim() || truncateAddress(profile.address) : truncateAddress(profile.address)}
      </h1>
      <span className="ml-auto flex shrink-0 items-center gap-1 [&_button]:size-8 [&_button]:rounded-lg [&_button]:text-foreground [&_svg]:size-[19px]">
        <FavoriteButton address={profile.address} favorite={profile.favorite} size="sm" />
        <AlertBell address={profile.address} history />
        <ShareButton
          address={profile.address}
          name={shareName({ address: profile.address, displayName: profile.displayName, kol: profile.kol })}
          icon="external"
        />
      </span>
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
  failed = false,
  onRetry,
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
  /** The portfolio could not be read: a line and a retry in the chart's place. */
  failed?: boolean;
  onRetry?: () => void;
  /** CopyDog's hero shows the copy score under the chart header. */
  copyScore: number | null;
}) {
  const { t, format } = useI18n();
  const [mode, setMode] = useState<"pnl" | "roi">("pnl");
  const [tab, setTab] = useState<MobileTab>("positions");
  const [perfView, setPerfView] = useState<PerfView>("best");
  const [sheet, setSheet] = useState(false);
  const sheetRef = useModalFocus<HTMLDivElement>(sheet, () => setSheet(false));
  const { status: authStatus, login } = useAuth();
  const copying = useCopyOf(profile.address) !== undefined;
  const trades = useTraderAnalytics(profile.address, "all");
  const analytics = trades.data as TraderAnalyticsResponse | undefined;
  const winRate = analytics?.summary.winRate ?? null;
  const winTone = winRateTone(winRate);
  // Not all-time when the history read does not reach the account's start.
  const sampleSince = partialSampleSince(analytics?.coverage, allTime?.pnl);
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
    <div className="flex flex-col gap-6 pb-6">
      <TopBar profile={profile} />

      <section aria-label={t("trader.chart.pnlLabel")} className="flex flex-col gap-6">
        <div className="flex items-stretch justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
            <Pills
              value={mode}
              onChange={setMode}
              label={t("trader.chart.pnlLabel")}
              options={[["pnl", t("trader.mobile.pnl")], ["roi", t("trader.mobile.roi")]]}
            />
            {loading && !portfolio && !failed ? (
              <Skeleton className="h-9 w-44" />
            ) : (
              <div className={cn("num text-[34px] leading-[1.05] font-bold tracking-[-1px]", headline === null ? "" : headline >= 0 ? "text-positive" : "text-negative")}>
                {headline === null ? "—" : mode === "pnl" ? signedUsdShort(headline) : signedPctCd(headline)}
              </div>
            )}
            {mode === "pnl" && roi !== null ? <RoiPill value={roi} label={roiPillShort(roi)} className="h-auto gap-1 px-2.5 py-[5px] text-[15px] leading-[22px] [&>svg]:size-3.5" /> : null}
          </div>
          <span className="flex shrink-0 flex-col items-end justify-between gap-2">
            {profile.kol?.avatarUrl ? (
              // A KOL's picture takes the brand mark's place (CopyDog's).
              <TraderAvatar trader={{ address: profile.address, avatarUrl: profile.kol.avatarUrl }} size={52} />
            ) : (
              <span className="inline-flex size-[52px] items-center justify-center rounded-full bg-raised text-foreground" aria-hidden>
                <OrbieMark size={28} />
              </span>
            )}
            {copyScore != null ? (
              // CopyDog leaves the score out of the hero while there is none.
              // CopyDog: the dotted 複製評分 label over the bar and the score.
              <span className="flex flex-col items-end gap-1 text-xs text-muted-foreground" data-testid="hero-copy-score">
                <span className="bg-[linear-gradient(90deg,currentColor_1.5px,transparent_1.5px)] bg-[length:3.5px_1px] bg-bottom bg-repeat-x pb-[3px]">{t("discover.copyScore")}</span>
                <CopyScoreBar score={copyScore} layout="bar-first" barClassName="w-[54px] bg-white/10" className="text-foreground [&>span:last-child]:text-xs" />
              </span>
            ) : null}
          </span>
        </div>
        {portfolio && series.length > 1 ? (
          <AreaChart
            data={series}
            height={180}
            className="-mb-3 px-2"
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
        ) : failed ? (
          <div className="flex h-[180px] items-center justify-center"><ErrorState onRetry={onRetry} /></div>
        ) : loading ? (
          <Skeleton className="h-[180px]" />
        ) : (
          <div className="flex h-[180px] items-center justify-center text-sm text-muted-foreground">{t("trader.chart.noData")}</div>
        )}
        <div role="radiogroup" aria-label={t("trader.kpi.period")} className="flex items-center">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              role="radio"
              aria-checked={window === w}
              onClick={() => onWindow(w)}
              className="group inline-flex min-h-[34px] flex-1 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className={cn("inline-flex rounded-full px-3 py-[5px] text-xs leading-[18px] font-semibold transition-colors", window === w ? "bg-primary-soft text-primary" : "text-muted-foreground")}>
                {t(`windows.${w}`)}
              </span>
            </button>
          ))}
        </div>
      </section>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-5 rounded-2xl bg-card p-5">
        <div className="flex min-w-0 flex-col gap-[5px]">
          <dt className="text-[10px] leading-[15px] font-semibold tracking-[0.5px] text-muted-foreground uppercase">{t("trader.accountValue")}</dt>
          <dd className="num text-xl leading-[30px] font-bold">{profile.accountValue === null ? "—" : usd2(profile.accountValue)}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-[5px]">
          <dt className="text-[10px] leading-[15px] font-semibold tracking-[0.5px] text-muted-foreground uppercase">{t("trader.kpi.sharpe")}</dt>
          <dd className={cn("num text-xl leading-[30px] font-bold", sharpe === null ? "" : sharpe >= 1.5 ? "text-positive" : sharpe >= 0 ? "text-warning" : "text-negative")}>
            {sharpe === null ? "—" : sharpe.toFixed(2)}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-[5px]">
          <dt className="text-[10px] leading-[15px] font-semibold tracking-[0.5px] text-muted-foreground uppercase">{t("trader.kpi.winRate")}</dt>
          <dd className={cn("num flex items-center gap-2 text-xl leading-[30px] font-bold", winTone ? TONE[winTone] : "")}>
            {winRate === null ? (isComputing(trades) ? <Skeleton className="h-6 w-16" /> : "—") : pct1(winRate)}
            {winRate !== null ? <Ring value={winRate} /> : null}
          </dd>
          {analytics && sampleSince !== null ? (
            <p className="num text-[10px] leading-[14px] text-muted-foreground" title={t("trader.kpi.tradesSinceHint")}>
              {t("trader.kpi.tradesSince", { count: analytics.summary.trades, date: format.shortDate(sampleSince) })}
            </p>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-[5px]">
          <dt className="text-[10px] leading-[15px] font-semibold tracking-[0.5px] text-muted-foreground uppercase">{t("trader.mobile.drawdown")}</dt>
          <dd className="num text-xl leading-[30px] font-bold text-negative">{mdd === null ? "—" : pct1(mdd)}</dd>
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

      <div className="-mt-2">
        {tab === "positions" ? <PositionsTab profile={profile} marks={marks} /> : null}
        {tab === "insights" ? <MobileInsights profile={profile} trades={trades.data} computing={isComputing(trades)} /> : null}
        {tab === "performance" ? (
          <div>
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
          <div>
            <TradesTab address={profile.address} />
          </div>
        ) : null}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background px-5 pt-3 pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:hidden">
        <button
          type="button"
          onClick={() => (authStatus === "signedOut" ? login() : setSheet(true))}
          className="h-[52px] w-full rounded-full bg-primary px-6 text-[15px] font-semibold text-primary-foreground outline-none transition-transform focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
        >
          {copying ? t("trader.copy.manage") : t("trader.copyTrade")}
        </button>
      </div>

      {sheet ? (
        <div ref={sheetRef} className="fixed inset-0 z-50 flex items-end bg-black/60 md:hidden" role="dialog" aria-modal="true" aria-label={t("trader.copyTrade")} onClick={() => setSheet(false)}>
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
