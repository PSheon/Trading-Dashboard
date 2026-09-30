"use client";

import type { TraderWindow } from "@/lib/contracts";
import { SearchX } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { EmptyState, ErrorState, Skeleton } from "@/components/page";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { isBusy } from "@/lib/api";
import {
  isComputing,
  usePortfolio,
  useSiteSettings,
  useTraderActivity,
  useTraderAnalytics,
  useTraderProfile,
} from "@/lib/queries";
import { useLiveTrader } from "@/lib/use-live-trader";
import { ActivityTabs } from "./activity-tabs";
import { CopyPanel } from "./copy-panel";
import { LiveFeed } from "./live-feed";
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

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Trader page: profile | KPIs + chart + tabs | copy panel (Stage 2 §6). */
export function TraderView({ address: rawAddress }: { address: string }) {
  const { t } = useI18n();
  const valid = ADDRESS.test(rawAddress);
  const address = rawAddress.toLowerCase();

  if (!valid) {
    return (
      <EmptyState
        icon={SearchX}
        title={t("trader.invalidAddress")}
        body={rawAddress}
        action={
          <Button asChild variant="secondary">
            <Link href="/explore">{t("home.browse")}</Link>
          </Button>
        }
      />
    );
  }
  return <TraderLoaded address={address} />;
}

function TraderLoaded({ address }: { address: string }) {
  const { t } = useI18n();
  const [window, setWindow] = useState<TraderWindow>("allTime");
  const [mode, setMode] = useState<ChartMode>("pnl");
  const [unit, setUnit] = useState<ChartUnit>("usd");
  const [market, setMarket] = useState<Market>("perp");
  // CopyDog's 即時動態: the pulse in the tab bar swaps the copy panel for it.
  const [feedOpen, setFeedOpen] = useState(false);

  // The profile is the cheap first paint; activity (sample size, last
  // trade) costs the api fill lists and loads alongside it.
  const profile = useTraderProfile(address);
  const activity = useTraderActivity(address);
  const portfolio = usePortfolio(address, window, market);
  const allTime = usePortfolio(address, "allTime", market);
  const settings = useSiteSettings();
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
  const busy = [profile, activity, portfolio].some((q) => !q.data && isBusy(q.failureReason));

  return (
    <div className="trader-grid -mx-1 md:-mx-3">
      <div data-area="profile">
        {profile.isError && !live.profile ? (
          <ErrorState message={`${t("trader.loadFailed")} · ${profile.error.message}`} onRetry={() => profile.refetch()} />
        ) : live.profile ? (
          <ProfileCard
            profile={live.profile}
            activity={activity.isError ? null : activity.data}
            lowSampleThreshold={settings.data?.lowSampleThreshold ?? 20}
            liveStatus={live.profile.dataQuality?.partial ? "polling" : live.status}
            allTimeVolume={allTime.data?.volume ?? null}
            trades={tradesAll.data}
            tradesComputing={isComputing(tradesAll)}
          />
        ) : (
          <Skeleton className="h-[640px] rounded-2xl" />
        )}
      </div>

      <div data-area="main" className="flex min-w-0 flex-col gap-3">
        {profile.data?.dataQuality?.partial ? (
          <p role="status" className="text-sm text-warning">{t("trader.partialProfile")} <button type="button" className="underline" onClick={() => profile.refetch()}>{t("common.retry")}</button></p>
        ) : null}
        {busy ? (
          <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-warning" />
            {t("trader.busyRetrying")}
          </p>
        ) : null}
        {profile.data ? (
          <KpiTiles
            period={kpiPeriod}
            onPeriod={setKpiPeriod}
            periodPortfolio={kpiPortfolio.data?.window === kpiPeriod ? kpiPortfolio.data : undefined}
            allTime={allTimePerp.data}
            lowSample={lowSample}
            trades={tradesAll.data}
            tradesComputing={isComputing(tradesAll)}
          />
        ) : profile.isError ? null : (
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-[116px] rounded-2xl" />
            ))}
          </div>
        )}
        <PerformanceChart
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
        ) : profile.isError ? (
          <p className="text-sm text-muted-foreground">{t("trader.positionsUnavailable")}</p>
        ) : (
          <Skeleton className="h-64 rounded-2xl" />
        )}
      </div>

      <div data-area="copy">
        {feedOpen ? <LiveFeed address={address} liveFills={live.fills} onCopy={() => setFeedOpen(false)} /> : <CopyPanel />}
      </div>
    </div>
  );
}
