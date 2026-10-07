"use client";

import type { TraderActivityResponse, TraderProfileResponse, TraderWindow } from "@/lib/contracts";
import { traderWindowEnum } from "@trading-dashboard/shared/contracts";
import { notFound } from "next/navigation";
import { useState } from "react";
import { useUrlState } from "@/lib/url-state";

import { useI18n } from "@/i18n/provider";
import {
  type InitialRead,
  isComputing,
  isUnavailable,
  useCopyScore,
  usePortfolio,
  useTraderActivity,
  useTraderAnalytics,
  useTraderProfile,
} from "@/lib/queries";
import { shareName } from "@/lib/share-card";
import { traderIsUnknown } from "@/lib/trader-presence";
import { useIsDesktop } from "@/lib/use-is-desktop";
import { useLiveTrader } from "@/lib/use-live-trader";
import { ActivityTabs, ActivityTabsSkeleton } from "./activity-tabs";
import { SectionBoundary } from "@/components/section-boundary";
import { CopyPanel } from "./copy-panel";
import { LiveFeed } from "./live-feed";
import { MobileTrader, MobileTraderSkeleton } from "./mobile-trader";
import {
  KpiTiles,
  PerformanceChart,
  windowRoi,
  type ChartMode,
  type KpiPeriod,
  type ChartUnit,
  type Market,
} from "./performance";
import { ProfileCard, ProfileCardSkeleton } from "./profile-card";
import { TextButton } from "@/components/ui/text-button";

/** What the page read on the server (`prefetchTrader`); either is null when
 * the api did not answer in time, and the browser reads it as before. */
export interface TraderInitial {
  profile: InitialRead<TraderProfileResponse> | null;
  activity: InitialRead<TraderActivityResponse> | null;
}

/** Trader page: profile | KPIs + chart + tabs | copy panel (Stage 2 §6). */
export function TraderView({ address, initial }: { address: string; initial?: TraderInitial }) {
  return <TraderLoaded address={address.toLowerCase()} initial={initial} />;
}

/** Before the width is known (the server's HTML and hydration). With the
 * profile at hand the desktop outline already carries the profile card
 * (its h1, name and figures; no reads of its own), so the first HTML has
 * them; the phone outline stays a skeleton until its own layout mounts. */
function TraderLoading({ address, profile }: { address: string; profile?: TraderProfileResponse }) {
  return (
    <>
      {/* Both outlines, one shown by CSS: the width is not known yet. */}
      <div className="md:hidden"><MobileTraderSkeleton /></div>
      <div className="trader-grid -mx-1 md:mx-0">
        <div data-area="profile">
          {profile ? <ProfileCard profile={profile} allTimeVolume={null} trades={undefined} tradesComputing /> : <ProfileCardSkeleton />}
        </div>
        <div data-area="main" className="flex min-w-0 flex-col gap-4"><TraderMainSkeleton address={address} /></div>
        <div data-area="copy"><CopyPanel address={address} /></div>
      </div>
    </>
  );
}

const noop = () => {};

/** The middle column before its reads are in: the KPI tiles, the chart card
 * and the tabs, each in its own loading state (same sizes as loaded). */
function TraderMainSkeleton({ address }: { address: string }) {
  return (
    <>
      <KpiTiles period="allTime" onPeriod={noop} periodPortfolio={undefined} allTime={undefined} trades={undefined} tradesComputing lowSample={false} />
      <PerformanceChart address={address} portfolio={undefined} loading window="allTime" onWindow={noop} mode="pnl" onMode={noop} unit="usd" onUnit={noop} market="perp" onMarket={noop} muted={false} roi={null} onRetry={noop} />
      <ActivityTabsSkeleton />
    </>
  );
}

function TraderLoaded({ address, initial }: { address: string; initial?: TraderInitial }) {
  const { t } = useI18n();
  // Only the layout on screen is mounted: the desktop page's rail, KPI
  // tiles and tables have their own reads (fills ×2000 every 30 s, a second
  // and third portfolio), which a phone used to make from a hidden copy.
  const desktop = useIsDesktop();
  // The chart window is in the URL (?window=), so a shared link opens it.
  const [window, setWindow] = useUrlState<TraderWindow>("window", traderWindowEnum, "allTime");
  const [market, setMarket] = useState<Market>("perp");

  // The profile and the chart are the first paint. Activity (sample size,
  // which mutes the KPI tiles) and the fills tab cost the api Hyperliquid's
  // fill lists (≈ 240 weight), so they are asked for once the first paint
  // is in: asked for alongside it, they spent the page budget the profile
  // and chart were waiting on (Stage, 2026-10-05). A blank profile asks for
  // the activity at once: only its fills tell a 404 from a quiet account.
  const profile = useTraderProfile(address, initial?.profile);
  const portfolio = usePortfolio(address, window, market);
  const firstPaint = Boolean(profile.data) && (Boolean(portfolio.data) || portfolio.errorUpdateCount > 0);
  const blank = Boolean(profile.data) && traderIsUnknown(profile.data, undefined) === null;
  const activity = useTraderActivity(address, initial?.activity, { enabled: firstPaint || blank || profile.errorUpdateCount > 0 });
  const allTimePerp = usePortfolio(address, "allTime", "perp");
  // Positions, account value, fills and marks straight from Hyperliquid's
  // WebSocket, over the REST profile (initial state and fallback).
  const live = useLiveTrader(address, profile.data);
  const copyScore = useCopyScore(address);
  // A failed read with nothing to show. The poll puts such a query back to
  // "pending" each time it asks again, so `isError` alone would alternate
  // between a placeholder and "no data"; the count stays until data arrives.
  const portfolioFailed = portfolio.errorUpdateCount > 0 && !portfolio.data;

  // Owner's rule: no data for the address is the 404 page (CopyDog draws
  // its trader page with every figure empty). Until the fill history has
  // answered for a blank profile, the page keeps its loading look.
  const unknown = traderIsUnknown(profile.data, activity.data);
  if (unknown) notFound();

  if (unknown === null && profile.data && !activity.isError) return <TraderLoading address={address} />;
  // CopyDog: the profile's retries are silent; once they run out the page
  // is this one line and its retry. The poll keeps asking meanwhile, which
  // puts a query without data back to pending: `errorUpdateCount` keeps the
  // line up until data arrives, instead of flashing back to placeholders.
  if (profile.errorUpdateCount > 0 && !live.profile) {
    return (
      <div className="pt-8 text-center">
        <p className="text-muted-foreground">{t("trader.loadFailed")}</p>
        <TextButton busy={profile.isFetching} className="mt-2 rounded text-primary-text" onClick={() => void profile.refetch()}>
          {t("common.retry")}
        </TextButton>
      </div>
    );
  }

  // The width is known once the page has hydrated; until then only what
  // the server read (the profile) is drawn.
  if (desktop === undefined) return <TraderLoading address={address} profile={live.profile} />;
  if (!desktop) {
    // Phones: CopyDog's app layout (chart first, 2×2 card, segmented tabs).
    return live.profile ? (
      <MobileTrader
        profile={live.profile}
        marks={live.mids}
        portfolio={portfolio.data}
        allTime={allTimePerp.data}
        window={window}
        onWindow={setWindow}
        loading={portfolio.isPending}
        failed={portfolioFailed}
        onRetry={() => void portfolio.refetch()}
        copyScore={copyScore.data?.copyScore ?? null}
      />
    ) : (
      <MobileTraderSkeleton />
    );
  }
  return (
    <DesktopTrader
      address={address}
      profile={profile}
      live={live}
      lowSample={activity.data?.sample.lowSample ?? false}
      firstPaint={firstPaint}
      portfolio={portfolio}
      allTimePerp={allTimePerp}
      copyScore={copyScore.data?.copyScore ?? null}
      window={window}
      onWindow={setWindow}
      market={market}
      onMarket={setMarket}
    />
  );
}

/** The desktop page: profile rail | KPIs + chart + tabs | copy panel. Its
 * own reads live here, so they start only when this layout is shown. */
function DesktopTrader({ address, profile, live, lowSample, firstPaint, portfolio, allTimePerp, copyScore, window, onWindow, market, onMarket }: {
  address: string;
  profile: ReturnType<typeof useTraderProfile>;
  live: ReturnType<typeof useLiveTrader>;
  lowSample: boolean;
  firstPaint: boolean;
  portfolio: ReturnType<typeof usePortfolio>;
  allTimePerp: ReturnType<typeof usePortfolio>;
  copyScore: number | null;
  window: TraderWindow;
  onWindow: (window: TraderWindow) => void;
  market: Market;
  onMarket: (market: Market) => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<ChartMode>("pnl");
  const [unit, setUnit] = useState<ChartUnit>("usd");
  // CopyDog's 即時動態: the pulse in the tab bar swaps the copy panel for it.
  const [feedOpen, setFeedOpen] = useState(false);
  // The rail's all-time volume follows the chart's market.
  const allTime = usePortfolio(address, "allTime", market);
  // Round trips for any address, all-time (the rail, the tabs and the
  // win-rate tile). A cold address computes on the api for a while (503
  // busy, retried).
  const tradesAll = useTraderAnalytics(address, "all");
  // The KPI tiles, as CopyDog's: 表現 / ROI follow their own All / 30D / 7D
  // period (perp), Sharpe, drawdown and win rate are all-time.
  const [kpiPeriod, setKpiPeriod] = useState<KpiPeriod>("allTime");
  const kpiPortfolio = usePortfolio(address, kpiPeriod, "perp");

  return (
    <div className="trader-grid -mx-1 md:mx-0">
      <div data-area="profile">
        {live.profile ? (
          <ProfileCard
            profile={live.profile}
            allTimeVolume={allTime.data?.volume ?? null}
            trades={tradesAll.data}
            tradesComputing={isComputing(tradesAll)}
            copyScore={copyScore}
          />
        ) : (
          <ProfileCardSkeleton />
        )}
      </div>
      <div data-area="main" className="flex min-w-0 flex-col gap-4">
        {profile.data?.dataQuality?.partial ? (
          <p role="status" className="text-sm text-warning">{t("trader.partialProfile")} <TextButton busy={profile.isFetching} onClick={() => void profile.refetch()}>{t("common.retry")}</TextButton></p>
        ) : null}
        {profile.data ? (
          <KpiTiles
            period={kpiPeriod}
            onPeriod={setKpiPeriod}
            periodPortfolio={kpiPortfolio.data?.window === kpiPeriod ? kpiPortfolio.data : undefined}
            allTime={allTimePerp.data}
            portfolioFailed={kpiPortfolio.isError || allTimePerp.isError}
            lowSample={lowSample}
            trades={tradesAll.data}
            tradesComputing={isComputing(tradesAll)}
            tradesUnavailable={isUnavailable(tradesAll)}
            onRetryTrades={() => void tradesAll.refetch()}
          />
        ) : (
          <KpiTiles period={kpiPeriod} onPeriod={setKpiPeriod} periodPortfolio={undefined} allTime={undefined} trades={undefined} tradesComputing lowSample={false} />
        )}
        <PerformanceChart
          address={address}
          portfolio={portfolio.data}
          loading={portfolio.isPending}
          failed={portfolio.errorUpdateCount > 0 && !portfolio.data}
          onRetry={() => void portfolio.refetch()}
          window={window}
          onWindow={onWindow}
          mode={mode}
          onMode={setMode}
          unit={unit}
          onUnit={setUnit}
          market={market}
          onMarket={onMarket}
          muted={lowSample}
          roi={windowRoi(portfolio.data)}
        />
        {live.profile ? (
          <ActivityTabs
            profile={live.profile}
            liveFills={live.fills}
            marks={live.mids}
            feedOpen={feedOpen}
            onToggleFeed={() => setFeedOpen((open) => !open)}
            fillsReady={firstPaint}
          />
        ) : (
          <ActivityTabsSkeleton />
        )}
      </div>

      <div data-area="copy">
        <SectionBoundary key={feedOpen ? "feed" : "copy"}>
          {feedOpen ? <LiveFeed address={address} liveFills={live.fills} onCopy={() => setFeedOpen(false)} /> : <CopyPanel address={address} leaderPositions={live.profile?.positions} traderName={live.profile ? shareName(live.profile) : undefined} />}
        </SectionBoundary>
      </div>
    </div>
  );
}
