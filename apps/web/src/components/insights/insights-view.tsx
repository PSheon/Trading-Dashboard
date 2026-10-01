"use client";

import { ChevronDown } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "cn";

import { Skeleton } from "@/components/page";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useI18n } from "@/i18n/provider";
import type { CohortDetail, CohortTier, CohortWindow } from "@/lib/contracts";
import { usdCompact } from "@/lib/format";
import { useCohort, useCohortHistory } from "@/lib/queries";
import { MarketsTable, WalletsTable } from "./cohort-tables";
import { MarketTreemap } from "./market-treemap";
import { PositioningChart } from "./positioning-chart";
import { SplitBar } from "./sentiment";

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
export function InsightsView({ tierPicker = false }: { tierPicker?: boolean }) {
  const { t } = useI18n();
  const params = useSearchParams();
  const fromUrl = params.get("tier");
  const [tier, setTier] = useState<CohortTier>(tierPicker && fromUrl && (TIERS as string[]).includes(fromUrl) ? (fromUrl as CohortTier) : "extremely_profitable");
  const [window, setWindow] = useState<CohortWindow>("all");
  const [tab, setTab] = useState<"wallets" | "markets">("wallets");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const detail = useCohort(tier);
  const history = useCohortHistory(tier, window);
  const data = detail.data;
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
    <div className="flex flex-col gap-2 max-md:-mx-1 max-md:mt-3">
      <header className="relative mb-2.5 flex flex-col gap-3.5 rounded-[12px] border border-border bg-card p-[18px] md:flex-row md:items-center md:justify-between md:px-6 md:pt-[18px] md:pb-[17px]">
        <HyperliquidWordmark className="flex h-[41px] md:hidden" />
        <h1 className="text-[21px] leading-[1.2] font-bold tracking-[-0.6px] md:text-[26px]">{t("insights.cohort.bannerTitle")}</h1>
        <div className="flex items-center gap-4 max-md:absolute max-md:top-[18px] max-md:right-[18px] md:order-3">
          {tierPicker ? <TierPicker value={tier} onChange={setTier} /> : null}
          <HyperliquidWordmark className="hidden md:flex" />
        </div>
      </header>

      {detail.isError && !data ? (
        <div className="rounded-2xl border border-border bg-card py-10 text-center text-sm text-muted-foreground">
          {t("insights.cohort.loadError")}{" "}
          <button type="button" className="text-primary underline" onClick={() => detail.refetch()}>{t("insights.cohort.retry")}</button>
        </div>
      ) : (
        <>
          <div className="grid gap-2 md:grid-cols-[1fr_1.04fr]">
            <HeroCards data={data} />
          </div>
          {data && data.walletCount === 0 ? (
            <p className="rounded-xl bg-raised/60 px-4 py-2.5 text-xs text-muted-foreground">{t("insights.cohort.building")}</p>
          ) : null}
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.04fr)]">
            <PositioningChart
              title={t("insights.cohort.positioning", { name: tierName })}
              series={history.data?.series ?? []}
              btc={history.data?.btc ?? []}
              window={window}
              onWindow={setWindow}
              loading={!history.data}
              latest={data?.hero.longPct ?? null}
              emptyHint={t("insights.cohort.chartEmpty", { minutes: 15 })}
            />
            <MarketTreemap title={t("insights.cohort.byMarket")} markets={data?.markets} loading={!data} />
          </div>
          <section className="overflow-hidden rounded-[12px] border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3.5">
              <div className="flex" role="tablist">
                {(["wallets", "markets"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={tab === key}
                    onClick={() => setTab(key)}
                    className={cn(
                      "-mb-px mr-[22px] border-b-2 px-0.5 py-3 font-mono text-xs leading-[18px] font-semibold tracking-[0.4px] uppercase outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                      tab === key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(`insights.cohort.${key}`)}
                  </button>
                ))}
              </div>
              {tab === "markets" ? (
                <div className="flex gap-3" role="radiogroup" aria-label={t("insights.cohort.markets")}>
                  {FILTERS.map((f) => (
                    <button
                      key={f}
                      type="button"
                      role="radio"
                      aria-checked={filter === f}
                      onClick={() => setFilter(f)}
                      className={cn("rounded font-mono text-[11px] font-medium tracking-[0.2px] uppercase outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", filter === f ? "text-primary" : "text-muted-foreground hover:text-foreground")}
                    >
                      {t(`insights.cohort.filter.${f}`)}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {!data ? (
              <div className="flex flex-col gap-2 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div>
            ) : tab === "wallets" ? (
              <WalletsTable rows={data.wallets} />
            ) : (
              <MarketsTable rows={data.markets} filter={filter} />
            )}
          </section>
        </>
      )}
    </div>
  );
}

function TierPicker({ value, onChange }: { value: CohortTier; onChange: (tier: CohortTier) => void }) {
  const { t } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("insights.cohort.tierLabel")}
        className="flex h-8 items-center gap-1.5 rounded-full bg-raised px-3.5 text-[13px] font-semibold outline-none transition-colors hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t(`trader.pnlTiers.${value}`)}
        <ChevronDown className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as CohortTier)}>
          {TIERS.map((tier) => (
            <DropdownMenuRadioItem key={tier} value={tier} className="flex flex-col items-start gap-0">
              <span className="font-semibold">{t(`trader.pnlTiers.${tier}`)}</span>
              <span className="text-[0.6875rem] text-subtle-foreground">{t(`trader.pnlTierHints.${tier}`)}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Hyperliquid's name set like its wordmark ("Hyper" upright, "liquid"
 * italic); text, not their logo file. */
function HyperliquidWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("items-center gap-2 text-[1.75rem] leading-none tracking-tight text-foreground select-none", className)} aria-hidden>
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
    return (
      <>
        {[0, 1].map((i) => (
          <div key={i} className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-4">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-1.5 w-full" />
            <div className="flex justify-between"><Skeleton className="h-4 w-32" /><Skeleton className="h-4 w-32" /></div>
          </div>
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
    <section className="overflow-hidden rounded-[12px] border border-border bg-card">
      <h2 className="flex h-8 items-center border-b border-border px-3 text-xs leading-4 font-medium tracking-[-0.12px] text-muted-foreground">{title}</h2>
      <div className="flex flex-col gap-3 p-3.5">
        <SplitBar pos={pos} className="cd-bar h-2 rounded-[2px] [&>*]:rounded-none" />
        <div className="flex items-center justify-between gap-1.5 text-[11px] leading-[17px] font-medium tracking-[-0.2px] whitespace-nowrap text-muted-foreground [&_.font-semibold]:font-medium">
          <span className="flex items-center gap-1">{left}</span>
          <span className="flex items-center gap-1">{right}</span>
        </div>
      </div>
    </section>
  );
}
