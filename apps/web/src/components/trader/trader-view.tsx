"use client";

import type { TraderActivityResponse, TraderProfileResponse, TraderWindow } from "@/lib/contracts";
import { notFound } from "next/navigation";
import { useState } from "react";

import { Skeleton } from "@/components/page";
import { useI18n } from "@/i18n/provider";
import {
  type InitialRead,
  isComputing,
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
import { ActivityTabs } from "./activity-tabs";
import { CopyPanel } from "./copy-panel";
import { LiveFeed } from "./live-feed";
import { MobileTrader } from "./mobile-trader";
import {
  KpiTiles,
  PerformanceChart,
  windowRoi,
  type ChartMode,
  type KpiPeriod,
  type ChartUnit,
  type Market,
} from "./performance";
import { ProfileCard } from "./profile-card";

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
function TraderLoading({ profile }: { profile?: TraderProfileResponse }) {
  return (
    <>
      {/* Both outlines, one shown by CSS: the width is not known yet. */}
      <div className="md:hidden"><Skeleton className="h-[640px] rounded-2xl" /></div>
      <div className="trader-grid -mx-1 md:mx-0">
        <div data-area="profile">
          {profile ? <ProfileCard profile={profile} allTimeVolume={null} trades={undefined} tradesComputing /> : <Skeleton className="h-[640px] rounded-2xl" />}
        </div>
        <div data-area="main"><Skeleton className="h-[640px] rounded-2xl" /></div>
        <div data-area="copy"><Skeleton className="h-64 rounded-2xl" /></div>
      </div>
    </>
  );
}

function TraderLoaded({ address, initial }: { address: string; initial?: TraderInitial }) {
  const { t } = useI18n();
  // Only the layout on screen is mounted: the desktop page's rail, KPI
  // tiles and tables have their own reads (fills ×2000 every 30 s, a second
  // and third portfolio), which a phone used to make from a hidden copy.
  const desktop = useIsDesktop();
  const [window, setWindow] = useState<TraderWindow>("allTime");
  const [market, setMarket] = useState<Market>("perp");

  // The profile is the cheap first paint; activity (sample size, which
  // mutes the KPI tiles) costs the api fill lists and loads alongside it.
  const profile = useTraderProfile(address, initial?.profile);
  const activity = useTraderActivity(address, initial?.activity);
  const portfolio = usePortfolio(address, window, market);
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

  if (unknown === null && profile.data && !activity.isError) return <TraderLoading />;
  // CopyDog: the profile's retries are silent; once they run out the page
  // is this one line and its retry. The poll keeps asking meanwhile, which
  // puts a query without data back to pending: `errorUpdateCount` keeps the
  // line up until data arrives, instead of flashing back to placeholders.
  if (profile.errorUpdateCount > 0 && !live.profile) {
    return (
      <div className="pt-8 text-center">
        <p className="text-muted-foreground">{t("trader.loadFailed")}</p>
        <button type="button" className="mt-2 rounded text-primary underline outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => profile.refetch()}>
          {t("common.retry")}
        </button>
      </div>
    );
  }

  // The width is known once the page has hydrated; until then only what
  // the server read (the profile) is drawn.
  if (desktop === undefined) return <TraderLoading profile={live.profile} />;
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
      <Skeleton className="h-[640px] rounded-2xl" />
    );
  }
  return (
    <DesktopTrader
      address={address}
      profile={profile}
      live={live}
      lowSample={activity.data?.sample.lowSample ?? false}
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
function DesktopTrader({ address, profile, live, lowSample, portfolio, allTimePerp, copyScore, window, onWindow, market, onMarket }: {
  address: string;
  profile: ReturnType<typeof useTraderProfile>;
  live: ReturnType<typeof useLiveTrader>;
  lowSample: boolean;
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
          <Skeleton className="h-[640px] rounded-2xl" />
        )}
      </div>
      <div data-area="main" className="flex min-w-0 flex-col gap-1.5">
        {profile.data?.dataQuality?.partial ? (
          <p role="status" className="text-sm text-warning">{t("trader.partialProfile")} <button type="button" className="underline" onClick={() => profile.refetch()}>{t("common.retry")}</button></p>
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
          />
        ) : (
          <div className="grid grid-cols-2 gap-1.5 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-[128px] rounded-[12px]" />
            ))}
          </div>
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
          />
        ) : (
          <Skeleton className="h-64 rounded-2xl" />
        )}
      </div>

      <div data-area="copy">
        {feedOpen ? <LiveFeed address={address} liveFills={live.fills} onCopy={() => setFeedOpen(false)} /> : <CopyPanel address={address} leaderPositions={live.profile?.positions} traderName={live.profile ? shareName(live.profile) : undefined} />}
      </div>
    </div>
  );
}
