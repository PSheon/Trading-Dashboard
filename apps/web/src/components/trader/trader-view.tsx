"use client";

import type { TraderWindow } from "@/lib/contracts";
import { notFound } from "next/navigation";
import { useState } from "react";

import { Skeleton } from "@/components/page";
import { useI18n } from "@/i18n/provider";
import {
  isComputing,
  useCopyScore,
  usePortfolio,
  useTraderActivity,
  useTraderAnalytics,
  useTraderProfile,
} from "@/lib/queries";
import { traderIsUnknown } from "@/lib/trader-presence";
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

/** Trader page: profile | KPIs + chart + tabs | copy panel (Stage 2 §6). */
export function TraderView({ address }: { address: string }) {
  return <TraderLoaded address={address.toLowerCase()} />;
}

function TraderLoading() {
  return (
    <>
      <div className="md:hidden"><Skeleton className="h-[640px] rounded-2xl" /></div>
      <div className="trader-grid -mx-1 md:mx-0">
        <div data-area="profile"><Skeleton className="h-[640px] rounded-2xl" /></div>
        <div data-area="main"><Skeleton className="h-[640px] rounded-2xl" /></div>
        <div data-area="copy"><Skeleton className="h-64 rounded-2xl" /></div>
      </div>
    </>
  );
}

function TraderLoaded({ address }: { address: string }) {
  const { t } = useI18n();
  const [window, setWindow] = useState<TraderWindow>("allTime");
  const [mode, setMode] = useState<ChartMode>("pnl");
  const [unit, setUnit] = useState<ChartUnit>("usd");
  const [market, setMarket] = useState<Market>("perp");
  // CopyDog's 即時動態: the pulse in the tab bar swaps the copy panel for it.
  const [feedOpen, setFeedOpen] = useState(false);

  // The profile is the cheap first paint; activity (sample size, which
  // mutes the KPI tiles) costs the api fill lists and loads alongside it.
  const profile = useTraderProfile(address);
  const activity = useTraderActivity(address);
  const portfolio = usePortfolio(address, window, market);
  const allTime = usePortfolio(address, "allTime", market);
  // Round trips for any address, all-time (the rail, the tabs and the
  // win-rate tile). A cold address computes on the api for a while (503
  // busy, retried).
  const tradesAll = useTraderAnalytics(address, "all");
  // The KPI tiles, as CopyDog's: 表現 / ROI follow their own All / 30D / 7D
  // period (perp), Sharpe, drawdown and win rate are all-time.
  const [kpiPeriod, setKpiPeriod] = useState<KpiPeriod>("allTime");
  const kpiPortfolio = usePortfolio(address, kpiPeriod, "perp");
  const allTimePerp = usePortfolio(address, "allTime", "perp");
  // Positions, account value, fills and marks straight from Hyperliquid's
  // WebSocket, over the REST profile (initial state and fallback).
  const live = useLiveTrader(address, profile.data);
  const lowSample = activity.data?.sample.lowSample ?? false;

  // Owner's rule: no data for the address is the 404 page (CopyDog draws
  // its trader page with every figure empty). Until the fill history has
  // answered for a blank profile, the page keeps its loading look.
  const unknown = traderIsUnknown(profile.data, activity.data);
  if (unknown) notFound();

  const copyScore = useCopyScore(address);
  const rail = live.profile ? (
    <ProfileCard
      profile={live.profile}
      allTimeVolume={allTime.data?.volume ?? null}
      trades={tradesAll.data}
      tradesComputing={isComputing(tradesAll)}
      copyScore={copyScore.data?.copyScore ?? null}
    />
  ) : null;

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

  return (
    <>
    {/* Phones: CopyDog's app layout (chart first, 2×2 card, segmented tabs). */}
    <div className="md:hidden">
      {live.profile ? (
        <MobileTrader
          profile={live.profile}
          marks={live.mids}
          portfolio={portfolio.data}
          allTime={allTimePerp.data}
          window={window}
          onWindow={setWindow}
          loading={portfolio.isPending}
          copyScore={copyScore.data?.copyScore ?? null}
        />
      ) : (
        <Skeleton className="h-[640px] rounded-2xl" />
      )}
    </div>
    <div className="trader-grid -mx-1 md:mx-0">
      <div data-area="profile">
        {live.profile ? (
          rail
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
          window={window}
          onWindow={setWindow}
          mode={mode}
          onMode={setMode}
          unit={unit}
          onUnit={setUnit}
          market={market}
          onMarket={setMarket}
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
        {feedOpen ? <LiveFeed address={address} liveFills={live.fills} onCopy={() => setFeedOpen(false)} /> : <CopyPanel address={address} />}
      </div>
    </div>
    </>
  );
}
