"use client";

import type { TraderWindow } from "@/lib/contracts";
import { SearchX } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { EmptyState, ErrorState, Skeleton } from "@/components/page";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { usePortfolio, useSiteSettings, useTraderProfile } from "@/lib/queries";
import { ActivityTabs } from "./activity-tabs";
import { CopyPanel } from "./copy-panel";
import {
  KpiTiles,
  PerformanceChart,
  windowRoi,
  type ChartMode,
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

  const profile = useTraderProfile(address);
  const portfolio = usePortfolio(address, window, market);
  const allTime = usePortfolio(address, "allTime", market);
  const settings = useSiteSettings();

  if (profile.isError) {
    return (
      <div className="rounded-2xl border border-border bg-card">
        <ErrorState message={`${t("trader.loadFailed")} · ${profile.error.message}`} onRetry={() => profile.refetch()} />
      </div>
    );
  }

  return (
    <div className="trader-grid -mx-1 md:-mx-3">
      <div data-area="profile">
        {profile.data ? (
          <ProfileCard profile={profile.data} lowSampleThreshold={settings.data?.lowSampleThreshold ?? 20} />
        ) : (
          <Skeleton className="h-[640px] rounded-2xl" />
        )}
      </div>

      <div data-area="main" className="flex min-w-0 flex-col gap-3">
        {profile.data ? (
          <KpiTiles
            profile={profile.data}
            portfolio={portfolio.data}
            allTime={allTime.data}
            window={window}
          />
        ) : (
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
          muted={profile.data?.sample.lowSample ?? false}
          roi={profile.data ? windowRoi(profile.data, portfolio.data, window) : null}
        />
        {profile.data ? <ActivityTabs profile={profile.data} /> : <Skeleton className="h-64 rounded-2xl" />}
      </div>

      <div data-area="copy">
        <CopyPanel />
      </div>
    </div>
  );
}
