"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "cn";

import { ErrorState, SkelBar } from "@/components/page";
import { Tabs } from "@/components/ui/tabs";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";

import { useI18n } from "@/i18n/provider";
import { cohortHeadlineReady } from "@trading-dashboard/shared/contracts";
import type { CohortDetail, CohortTier, CohortWindow } from "@/lib/contracts";
import { usdCompact } from "@/lib/format";
import { useCohort, useCohortHistory } from "@/lib/queries";
import { MarketsTable, WalletsTable, WalletsTableSkeleton } from "./cohort-tables";
import { MarketTreemap } from "./market-treemap";
import { PositioningChart } from "./positioning-chart";
import { SplitBar } from "./sentiment";
import { TextButton } from "@/components/ui/text-button";

export const TIERS: CohortTier[] = ["extremely_profitable", "very_profitable", "profitable", "break_even", "unprofitable", "very_unprofitable", "rekt"];
const FILTERS = ["all", "crypto", "tradfi"] as const;

/**
 * 洞察 (CopyDog's /hyperliquid/cohorts): a PnL tier's positioning — the
 * banner with the tier picker, unrealized PnL and notional split cards, the
 * 倉位傾向 chart against BTC, the 各市場持倉方向 treemap, and the 錢包 /
 * 市場 tables. CopyDog serves 極度盈利 only, so that is the page; the tier
 * picker (`tierPicker`, `?tier=`) is for the /dev lab, the other tiers'
 * data stays in the api.
 */
/** A tier's snapshot older than half an hour shows its age. */
const stale = (updatedAt: string | Date | null | undefined) => updatedAt != null && Date.now() - new Date(updatedAt).getTime() > 30 * 60_000;

export function InsightsView({ tierPicker = false }: { tierPicker?: boolean }) {
  const { t, format } = useI18n();
  const params = useSearchParams();
  const fromUrl = params.get("tier");
  const [tier, setTier] = useState<CohortTier>(tierPicker && fromUrl && (TIERS as string[]).includes(fromUrl) ? (fromUrl as CohortTier) : "extremely_profitable");
  const [window, setWindow] = useState<CohortWindow>("all");
  const [tab, setTab] = useState<"wallets" | "markets">("wallets");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const detail = useCohort(tier);
  const history = useCohortHistory(tier, window);
  const data = detail.data;
  // Current summaries require fresh coverage; history remains explicitly historical.
  const ready = data ? (data.headlineReady ?? cohortHeadlineReady(data.walletCount, data.memberCount)) : false;
  const tierName = t(`trader.pnlTiers.${tier}`);

  useEffect(() => {
    if (!tierPicker) return;
    const qs = new URLSearchParams(globalThis.location.search);
    if (tier === "extremely_profitable") qs.delete("tier");
    else qs.set("tier", tier);
    const next = `${globalThis.location.pathname}${qs.size ? `?${qs}` : ""}`;
    if (next !== `${globalThis.location.pathname}${globalThis.location.search}`) globalThis.history.replaceState(null, "", next);
  }, [tier, tierPicker]);

  return (
    <div className="flex flex-col gap-4">
      <header className="relative flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <HyperliquidWordmark className="flex h-[41px] md:hidden" />
        <h1 className="type-h1 text-balance">{t("insights.cohort.bannerTitle")}</h1>
        <div className="flex items-center gap-4 max-md:absolute max-md:top-[18px] max-md:right-[18px] md:order-3">
          {tierPicker ? <TierPicker value={tier} onChange={setTier} /> : null}
          <HyperliquidWordmark className="hidden md:flex" />
        </div>
      </header>

      {detail.isError && !data ? (
        <div className="orbit-card py-10 text-center text-sm text-muted-foreground">
          {t("insights.cohort.loadError")}{" "}
          <TextButton busy={detail.isFetching} className="text-primary-text" onClick={() => void detail.refetch()}>{t("insights.cohort.retry")}</TextButton>
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-[1fr_1.04fr]">
            <HeroCards data={ready ? data : undefined} />
          </div>
          {data && ready && stale(data.updatedAt) ? (
            <p role="status" className="text-xs font-bold text-muted-foreground" data-testid="cohort-age">{t("insights.cohort.updated", { time: format.relative(data.updatedAt!) })}</p>
          ) : null}
          {data && !ready ? (
            <div role="status" className="rounded-xl bg-raised px-4 py-3 text-xs font-bold text-muted-foreground">
              <p>{t("insights.cohort.building")}</p>
              <p className="mt-1">{t("copyUpdates.coverage", { count: data.walletCount, total: data.memberCount })}</p>
              {data.updatedAt ? <p className="mt-1" data-testid="cohort-age">{t("insights.cohort.updated", { time: format.relative(data.updatedAt) })}</p> : null}
              <TextButton busy={detail.isFetching} className="mt-2 text-primary-text" onClick={() => void detail.refetch()}>{t("insights.cohort.retry")}</TextButton>
            </div>
          ) : null}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.04fr)]">
            {history.errorUpdateCount > 0 && !history.data ? (
              // Not a placeholder without end: the history could not be read.
              <section className="flex min-h-[300px] items-center justify-center orbit-card">
                <ErrorState onRetry={() => void history.refetch()} />
              </section>
            ) : (
            <PositioningChart
              title={t("insights.cohort.positioning", { name: tierName })}
              series={history.data?.series ?? []}
              btc={history.data?.btc ?? []}
              window={window}
              onWindow={setWindow}
              loading={!history.data}
              latest={ready ? (data?.hero.longPct ?? null) : null}
              emptyHint={t("insights.cohort.chartEmpty", { minutes: 15 })}
            />
            )}
            {/* Not an empty box while the tier is being built: it says so. */}
            <MarketTreemap title={t("insights.cohort.byMarket")} markets={ready ? data?.markets : undefined} loading={!data} emptyText={data && !ready ? t("insights.cohort.building") : undefined} />
          </div>
          <section>
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <Tabs label={`${t("insights.cohort.wallets")} / ${t("insights.cohort.markets")}`} value={tab} onChange={setTab} idPrefix="cohort-tab" controls="cohort-table-panel"
                className="rounded-full bg-raised p-1" items={(["wallets", "markets"] as const).map((value) => ({ value, label: t(`insights.cohort.${value}`) }))} />
              {tab === "markets" ? (
                <Segmented label={t("insights.cohort.markets")} variant="pill" value={filter} onChange={setFilter}
                  options={FILTERS.map((value) => ({ value, label: t(`insights.cohort.filter.${value}`) }))} />
              ) : null}
            </div>
            <div id="cohort-table-panel" role="tabpanel" aria-labelledby={`cohort-tab-${tab}`}>
              {!data ? (
                <WalletsTableSkeleton />
              ) : tab === "wallets" ? (
                <WalletsTable rows={data.wallets} />
              ) : (
                <MarketsTable rows={data.markets} filter={filter} />
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function TierPicker({ value, onChange }: { value: CohortTier; onChange: (tier: CohortTier) => void }) {
  const { t } = useI18n();
  return (
    <Select
      size="sm"
      align="end"
      label={t("insights.cohort.tierLabel")}
      value={value}
      onValueChange={(v) => onChange(v as CohortTier)}
      contentClassName="min-w-72"
      options={TIERS.map((tier) => ({ value: tier, label: t(`trader.pnlTiers.${tier}`), hint: t(`trader.pnlTierHints.${tier}`) }))}
    />
  );
}

/** Hyperliquid's name set like its wordmark ("Hyper" upright, "liquid"
 * italic); text, not their logo file. */
function HyperliquidWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("items-center gap-2 text-[1.75rem] leading-none text-foreground select-none", className)} aria-hidden>
      <svg viewBox="0 0 32 20" className="h-5 w-8" fill="currentColor">
        <path d="M6 0C2.7 0 0 3.6 0 10s2.7 10 6 10c2.4 0 3.9-1.9 5.6-4.2C13 13.9 14.5 12 16 12s3 1.9 4.4 3.8C22.1 18.1 23.6 20 26 20c3.3 0 6-3.6 6-10S29.3 0 26 0c-2.4 0-3.9 1.9-5.6 4.2C19 6.1 17.5 8 16 8s-3-1.9-4.4-3.8C9.9 1.9 8.4 0 6 0Z" />
      </svg>
      <span className="font-light">Hyper<span className="font-serif italic">liquid</span></span>
    </span>
  );
}

function HeroCards({ data }: { data: CohortDetail | undefined }) {
  const { t } = useI18n();
  if (!data) {
    // HeroCard's own card, title and split bar, with bars for the legend.
    return (
      <>
        {([t("insights.cohort.unrealizedPnl"), t("insights.cohort.notional")]).map((title) => (
          <section key={title} aria-hidden="true" className="orbit-card card-pad ui-skeleton overflow-hidden">
            <h2 className="type-h2">{title}</h2>
            <div className="mt-2.5 flex flex-col gap-3">
              <div className="cd-bar h-3 rounded-full" />
              <div className="flex items-center justify-between gap-1.5">
                <SkelBar line="h-[18px]" className="h-2.5 w-32" />
                <SkelBar line="h-[18px]" className="h-2.5 w-32" />
              </div>
            </div>
          </section>
        ))}
      </>
    );
  }
  const h = data.hero;
  const wallets = h.walletsInProfit + h.walletsInLoss;
  const inProfit = wallets > 0 ? Math.round((100 * h.walletsInProfit) / wallets) : null;
  const pct = (v: number | null, digits = 1) => (v === null ? "—" : `${v.toFixed(digits)}%`);
  const dot = <span className="text-subtle-foreground">▪</span>;
  return (
    <>
      <HeroCard
        title={t("insights.cohort.unrealizedPnl")}
        pos={h.upnlProfitPct}
        left={<><span className="num font-semibold text-positive">{pct(h.upnlProfitPct)}</span> {dot} <span>{inProfit === null ? "—" : `${100 - inProfit}% ${t("insights.cohort.inLoss")}`}</span></>}
        right={<><span>{inProfit === null ? "—" : `${inProfit}% ${t("insights.cohort.inProfit")}`}</span> {dot} <span className="num font-semibold text-negative">{h.upnlProfitPct === null ? "—" : pct(100 - h.upnlProfitPct)}</span></>}
      />
      <HeroCard
        title={t("insights.cohort.notional")}
        pos={h.longPct}
        left={<><span className="num font-semibold text-positive">{usdCompact(h.notionalLong, { digits: 2 })}</span> {dot} <span>{h.longPct === null ? "—" : `${Math.round(h.longPct)}% ${t("insights.cohort.long")}`}</span></>}
        right={<><span>{h.longPct === null ? "—" : `${Math.round(100 - h.longPct)}% ${t("insights.cohort.short")}`}</span> {dot} <span className="num font-semibold text-negative">{usdCompact(h.notionalShort, { digits: 2 })}</span></>}
      />
    </>
  );
}

function HeroCard({ title, pos, left, right }: { title: string; pos: number | null; left: React.ReactNode; right: React.ReactNode }) {
  return (
    <section className="orbit-card card-pad overflow-hidden">
      <h2 className="type-h2">{title}</h2>
      <div className="mt-2.5 flex flex-col gap-3">
        <SplitBar pos={pos} className="cd-bar h-3 rounded-full [&>*]:rounded-full" />
        <div className="flex items-center justify-between gap-1.5 text-xs leading-[18px] font-bold whitespace-nowrap text-muted-foreground [&_.font-semibold]:font-display [&_.font-semibold]:text-[15px]">
          <span className="flex items-center gap-1">{left}</span>
          <span className="flex items-center gap-1">{right}</span>
        </div>
      </div>
    </section>
  );
}
