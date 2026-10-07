"use client";

import type { PortfolioResponse, TraderAnalyticsResponse, TraderProfileResponse, TraderWindow } from "@/lib/contracts";
import { ArrowLeft, X } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useEffect, useMemo, useState } from "react";
import { useUrlState } from "@/lib/url-state";
import { cn } from "cn";

import { AlertBell } from "@/components/alerts/alert-bell";
import { OrbieMark } from "@/components/brand/logo";
import { AreaChart } from "@/components/charts/area-chart";
import { ErrorState, SkelBar, SkelCircle, Skeleton } from "@/components/page";
import { useModalFocus } from "@/lib/use-modal-focus";
import { FavoriteButton, RoiPill } from "@/components/traders/bits";
import { roiPillShort } from "@/lib/board-format";
import { useI18n } from "@/i18n/provider";
import { isComputing, isUnavailable, useChartSnapshots, useTraderAnalytics } from "@/lib/queries";
import { ChartSnapshotStrip } from "./chart-snapshot-strip";
import { CopyScoreBar, TraderAvatar } from "@/components/discover/board-bits";
import { truncateAddress, usdCompact, signedUsdShort, usd2 } from "@/lib/format";
import { partialSampleSince, pct1, winRateTone } from "@/lib/trade-format";
import { shareName } from "@/lib/share-card";
import { SectionBoundary } from "@/components/section-boundary";
import { CopyPanel } from "./copy-panel";
import { ShareButton } from "./share-dialog";
import { MobileInsights } from "./mobile-insights";
import { useAuth } from "@/lib/auth";
import { useCopyOf } from "@/lib/copy";
import { signedPctCd, WINDOWS } from "./performance";
import { PerformanceTab, TradesTab, type PerfView } from "./trade-analytics";
import { PositionsTab } from "./trader-tabs";
import { unavailableNote } from "./profile-card";
import { SwitchPanel } from "@/components/ui/switch-panel";
import { useSlidingIndicator } from "@/lib/use-sliding-indicator";

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
  // The orange pill slides to the chosen option, as every segmented control's does.
  const [trackRef, pill] = useSlidingIndicator<HTMLDivElement>(value);
  return (
    <div ref={trackRef} role="radiogroup" aria-label={label} className={cn("relative flex items-center gap-0.5 rounded-full bg-raised p-1", className)}>
      {pill ? <span aria-hidden className="absolute rounded-full bg-primary transition-[left,top,width] duration-300 ease-(--ease-orbit) motion-reduce:transition-none" style={{ left: pill.left, top: pill.top, width: pill.width, height: pill.height }} /> : null}
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          data-active={value === v}
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn(
            "relative min-h-11 rounded-full px-3.5 py-2 text-sm leading-5 whitespace-nowrap outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring",
            stretch && "min-w-0 flex-1",
            value === v ? cn("font-extrabold text-primary-foreground", !pill && "bg-primary") : "font-bold text-muted-foreground",
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
    <div className="sticky top-[env(safe-area-inset-top,0px)] z-30 -mx-4 -mt-4 flex items-center gap-2 bg-background/95 px-4 pt-4 pb-2 backdrop-blur-[10px]">
      <Link
        href="/explore"
        aria-label={t("common.back")}
        className="orbit-press relative inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-raised outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft className="size-5" strokeWidth={2.4} />
      </Link>
      {/* CopyDog centres the title across the bar, between 116px gutters. */}
      <h1 className="pointer-events-none absolute inset-x-0 truncate px-[150px] text-center font-display text-xl leading-6 max-[374px]:px-[128px] max-[374px]:text-base" title={profile.address}>
        {profile.kol ? profile.displayName?.trim() || truncateAddress(profile.address) : truncateAddress(profile.address)}
      </h1>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 max-[374px]:gap-1 max-[374px]:[&_button]:size-9 [&_button]:size-10 [&_button]:rounded-full [&_button]:bg-raised [&_button]:text-foreground [&_svg]:size-[18px]">
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
const MOBILE_TABS: readonly MobileTab[] = ["positions", "insights", "performance", "trades"];

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
  const [tab, setTab] = useUrlState<MobileTab>("tab", MOBILE_TABS, "positions");
  const [perfView, setPerfView] = useState<PerfView>("best");
  const [sheet, setSheet] = useState(false);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const snapshots = useChartSnapshots(profile.address, window);
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
  const accountGap = unavailableNote(profile, t, format.locale);

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

      <section aria-label={t("trader.chart.pnlLabel")} className="flex flex-col gap-5 rounded-2xl bg-raised p-4 [--skel-bar:var(--border)]">
        <div className="flex items-stretch justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
            <Pills
              value={mode}
              onChange={setMode}
              label={t("trader.chart.pnlLabel")}
              options={[["pnl", t("trader.mobile.pnl")], ["roi", t("trader.mobile.roi")]]}
            />
            {loading && !portfolio && !failed ? (
              <>
                <SkelBar line="h-[36px]" className="h-8 w-44" />
                {mode === "pnl" ? <SkelBar className="h-8 w-20 rounded-md" /> : null}
              </>
            ) : (
              <div className={cn("num font-display text-[2.125rem] leading-[1.05]", headline === null ? "" : headline >= 0 ? "text-positive" : "text-negative")}>
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
              <span className="inline-flex size-[52px] items-center justify-center rounded-full bg-card text-foreground" aria-hidden>
                <OrbieMark size={28} />
              </span>
            )}
            {copyScore != null ? (
              // CopyDog leaves the score out of the hero while there is none.
              // CopyDog: the dotted 複製評分 label over the bar and the score.
              <span className="flex flex-col items-end gap-1 text-xs text-muted-foreground" data-testid="hero-copy-score">
                <span className="bg-[linear-gradient(90deg,currentColor_1.5px,transparent_1.5px)] bg-[length:3.5px_1px] bg-bottom bg-repeat-x pb-[3px]">{t("discover.copyScore")}</span>
                <CopyScoreBar score={copyScore} layout="bar-first" barClassName="w-[54px] bg-card" className="text-foreground [&>span:last-child]:text-xs" />
              </span>
            ) : null}
          </span>
        </div>
        {portfolio && series.length > 1 ? (
          <AreaChart
            data={series}
            animateKey={`${window}:${mode}`}
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
            onHoverChange={setHoverTime}
          />
        ) : failed ? (
          <div className="flex h-[180px] items-center justify-center"><ErrorState onRetry={onRetry} /></div>
        ) : loading ? (
          <Skeleton className="h-[180px] rounded-2xl bg-background/60" />
        ) : (
          <div className="flex h-[180px] items-center justify-center text-sm text-muted-foreground">{t("trader.chart.noData")}</div>
        )}
        {series.length > 1 ? (
          <ChartSnapshotStrip data={snapshots.data} time={hoverTime} className="pt-3" />
        ) : loading && !failed && snapshots.data?.coverageStart && snapshots.data.snapshots.length > 0 ? (
          <div className="min-h-9" aria-hidden />
        ) : null}
        <div role="radiogroup" aria-label={t("trader.kpi.period")} className="flex items-center gap-0.5 rounded-full bg-card p-1">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              role="radio"
              aria-checked={window === w}
              onClick={() => onWindow(w)}
              className={cn("group inline-flex min-h-11 flex-1 items-center justify-center rounded-full outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring", window === w && "bg-primary")}
            >
              <span className={cn("inline-flex text-sm leading-5", window === w ? "font-extrabold text-primary-foreground" : "font-bold text-muted-foreground")}>
                {t(`windows.${w}`)}
              </span>
            </button>
          ))}
        </div>
      </section>

      <dl className="orbit-card card-pad grid grid-cols-2 gap-x-4 gap-y-5">
        <div className="flex min-w-0 flex-col gap-[5px]">
          <dt className="text-xs leading-4 font-bold text-muted-foreground">{t("trader.accountValue")}</dt>
          <dd className="num font-display text-xl leading-[30px]" data-testid="account-value">{profile.accountValue === null ? "—" : usd2(profile.accountValue)}</dd>
          {accountGap ? <dd role="status" className="text-[11px] leading-[14px] font-bold text-warning">{accountGap}</dd> : null}
        </div>
        <div className="flex min-w-0 flex-col gap-[5px]">
          <dt className="text-xs leading-4 font-bold text-muted-foreground">{t("trader.kpi.sharpe")}</dt>
          <dd className={cn("num font-display text-xl leading-[30px]", sharpe === null ? "" : sharpe >= 1.5 ? "text-positive" : sharpe >= 0 ? "text-warning" : "text-negative")}>
            {sharpe === null ? "—" : sharpe.toFixed(2)}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-[5px]">
          <dt className="text-xs leading-4 font-bold text-muted-foreground">{t("trader.kpi.winRate")}</dt>
          <dd className={cn("num flex items-center gap-2 font-display text-xl leading-[30px]", winTone ? TONE[winTone] : "")}>
            {winRate === null ? (isComputing(trades) ? <SkelBar className="ui-skeleton h-5 w-16" /> : "—") : pct1(winRate)}
            {winRate !== null ? <Ring value={winRate} /> : null}
          </dd>
          {analytics && sampleSince !== null ? (
            <dd className="num text-[11px] leading-[14px] font-bold text-muted-foreground" title={t("trader.kpi.tradesSinceHint")}>
              {t("trader.kpi.tradesSince", { count: analytics.summary.trades, date: format.shortDate(sampleSince) })}
            </dd>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-[5px]">
          <dt className="text-xs leading-4 font-bold text-muted-foreground">{t("trader.mobile.drawdown")}</dt>
          <dd className="num font-display text-xl leading-[30px] text-negative">{mdd === null ? "—" : pct1(mdd)}</dd>
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

      <SwitchPanel value={tab} order={MOBILE_TABS} className="-mt-2">
        {tab === "positions" ? <PositionsTab profile={profile} marks={marks} /> : null}
        {tab === "insights" ? <MobileInsights profile={profile} trades={trades.data} computing={isComputing(trades)} /> : null}
        {tab === "performance" ? (
          <div>
            <PerformanceTab
              analytics={trades.data}
              computing={isComputing(trades)}
              unavailable={isUnavailable(trades)}
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
      </SwitchPanel>

      <div className="fixed inset-x-0 bottom-0 z-40 bg-background/92 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur-xl md:hidden">
        <button
          type="button"
          onClick={() => (authStatus === "signedOut" ? login() : setSheet(true))}
          className="orbit-press h-14 w-full rounded-full bg-primary px-8 font-display text-lg text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {copying ? t("trader.copy.manage") : t("trader.copyTrade")}
        </button>
      </div>

      {sheet ? (
        <div ref={sheetRef} className="fixed inset-0 z-50 flex items-end bg-overlay animate-in fade-in-0 motion-reduce:animate-none md:hidden" role="dialog" aria-modal="true" aria-label={t("trader.copyTrade")} onClick={() => setSheet(false)}>
          <div className="relative max-h-[85dvh] w-full overflow-y-auto rounded-t-[32px] bg-card p-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] [--seg-track:var(--inset)] animate-in slide-in-from-bottom duration-300 motion-reduce:animate-none" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setSheet(false)}
              aria-label={t("common.close")}
              className="absolute top-3 right-3 z-10 inline-flex size-11 items-center justify-center rounded-full bg-inset outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-5" strokeWidth={2.4} />
            </button>
            <SectionBoundary className="flex flex-col items-center gap-2 px-1 pt-9 text-center text-sm">
              <CopyPanel address={profile.address} sheet leaderPositions={profile.positions} traderName={shareName(profile)} />
            </SectionBoundary>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The phone trader page before the profile is in: the same top bar,
 * chart card, 2×2 figures, tabs and position cards, with bars for what is
 * still to come. */
export function MobileTraderSkeleton() {
  const { t } = useI18n();
  const figures = ["trader.accountValue", "trader.kpi.sharpe", "trader.kpi.winRate", "trader.mobile.drawdown"] as const;
  return (
    <div aria-hidden="true" className="flex flex-col gap-6 pb-6">
      <div className="-mx-4 -mt-4 flex items-center gap-2 bg-background/95 px-4 pt-4 pb-2">
        <SkelCircle className="size-11 bg-raised" />
        <SkelBar line="mx-auto h-6" className="h-4 w-28 bg-raised" />
        <span className="flex shrink-0 items-center gap-1.5">
          <SkelCircle className="size-10 bg-raised" />
          <SkelCircle className="size-10 bg-raised" />
          <SkelCircle className="size-10 bg-raised" />
        </span>
      </div>
      <section className="ui-skeleton flex flex-col gap-5 rounded-2xl bg-raised p-4 [--skel-bar:var(--border)]">
        <div className="flex items-stretch justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
            <span className="flex h-[52px] w-36 rounded-full bg-background/60" />
            <SkelBar line="h-[36px]" className="h-8 w-44" />
            <SkelBar className="h-8 w-20 rounded-md" />
          </div>
          <SkelCircle className="size-[52px] bg-card" />
        </div>
        <div className="h-[180px] rounded-2xl bg-background/60" />
        <div className="flex h-[52px] rounded-full bg-card" />
      </section>
      <dl className="orbit-card card-pad ui-skeleton grid grid-cols-2 gap-x-4 gap-y-5">
        {figures.map((key) => (
          <div key={key} className="flex min-w-0 flex-col gap-[5px]">
            <dt className="text-xs leading-4 font-bold text-muted-foreground">{t(key)}</dt>
            <SkelBar line="h-[30px]" className="h-5 w-24" />
          </div>
        ))}
      </dl>
      <div className="flex h-[52px] rounded-full bg-raised" />
      <div className="-mt-2 flex flex-col gap-3">
        {[0, 1].map((i) => (
          <div key={i} className="ui-skeleton h-[148px] rounded-[24px] bg-raised" />
        ))}
      </div>
      {/* The sticky 跟單 bar's place. */}
      <div className="fixed inset-x-0 bottom-0 z-40 bg-background/92 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:hidden">
        <div className="h-14 rounded-full bg-raised" />
      </div>
    </div>
  );
}
