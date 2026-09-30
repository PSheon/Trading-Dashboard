"use client";

import { useQueries } from "@tanstack/react-query";
import type { TraderProfileResponse } from "@/lib/contracts";
import { ChevronRight, Trophy } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { cn } from "cn";

import { AreaChart } from "@/components/charts/area-chart";
import { ErrorState, Panel, SectionHeader, Skeleton } from "@/components/page";
import { AddressAvatar } from "@/components/traders/address-avatar";
import { RoiPill } from "@/components/traders/bits";
import { CoinIcon } from "@/components/traders/coin-icon";
import { TraderCard, TraderCardSkeleton, type TraderCardData } from "@/components/traders/trader-card";
import { TraderName } from "@/components/traders/trader-name";
import { TradersTable } from "@/components/traders/traders-table";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { traderProfileOptions } from "@/lib/trader-query-options";
import { coinDex, coinLabel, toNumber } from "@/lib/format";
import { useSiteSettings, useSparklines, useTraders } from "@/lib/queries";
import { useLiveMids } from "@/lib/use-live-mids";
import { useNow } from "@/lib/use-now";

export function HomeView() {
  const { t, format } = useI18n();
  const settings = useSiteSettings();
  const top = useTraders({ window: "month", sort: "pnl", order: "desc", limit: 10, offset: 0 });

  // Featured: the admin's list (Stage 2 §6), else the top 10 by 30-day PnL.
  // `active` is left to the api, which applies the admin's
  // discovery.defaultActiveWithin (§12), so 30-day holders stay off home.
  const featuredAddresses = settings.data?.featuredAddresses ?? [];
  const featuredProfiles = useQueries({
    queries: featuredAddresses.map((address) => ({
      ...traderProfileOptions(address.toLowerCase()),
      staleTime: 60_000,
      refetchInterval: false as const,
    })),
  });

  const featured: TraderCardData[] | undefined = useMemo(() => {
    if (!settings.data) return undefined;
    if (featuredAddresses.length > 0) {
      if (featuredProfiles.some((q) => q.isPending)) return undefined;
      return featuredProfiles
        .map((q) => q.data)
        .filter((p): p is TraderProfileResponse => Boolean(p))
        .map((p) => ({
          address: p.address,
          displayName: p.displayName,
          isVault: p.isVault,
          pnl: p.stats?.pnl.month ?? null,
          roi: p.stats?.roi.month ?? null,
          activity: p.stats?.activity ?? null,
        }));
    }
    return top.data?.items.map((s) => ({
      address: s.address,
      displayName: s.displayName,
      isVault: s.isVault,
      pnl: s.pnl.month,
      roi: s.roi.month,
      activity: s.activity,
    }));
  }, [settings.data, featuredAddresses.length, featuredProfiles, top.data]);

  const sparkAddresses = useMemo(() => {
    const set = new Set<string>();
    featured?.forEach((f) => set.add(f.address));
    top.data?.items.forEach((s) => set.add(s.address));
    return [...set].slice(0, 30);
  }, [featured, top.data]);
  const sparklines = useSparklines(sparkAddresses, "month");

  // Live mark prices on the market chips: `allMids` isn't user-specific, so
  // the home page may subscribe to it (one message per dex every few s).
  const homeMarkets = useMemo(() => settings.data?.homeMarkets ?? [], [settings.data]);
  const mids = useLiveMids(useMemo(() => [...new Set(homeMarkets.map((m) => coinDex(m) ?? ""))], [homeMarkets]));
  const now = useNow();
  const boardNote = top.data?.updatedAt ? (
    <span className="num text-xs font-normal tracking-normal text-subtle-foreground">
      {t("home.leaderboardSource", { time: format.relative(top.data.updatedAt, now) })}
    </span>
  ) : null;

  return (
    <div className="flex flex-col gap-10 md:gap-12">
      <section className="grid items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,500px)]">
        <div className="pt-2 lg:pt-6">
          <p className="font-wordmark text-lg font-semibold tracking-[-0.02em] text-primary">
            {t("meta.tagline")}
          </p>
          <h1 className="mt-3 max-w-[15ch] text-[2.35rem] leading-[1.08] font-black tracking-tight text-balance md:text-[3.4rem]">
            {t("home.headline")}
          </h1>
          <p className="mt-4 max-w-lg text-[0.9375rem] leading-relaxed text-muted-foreground">
            {t("home.subhead")}
          </p>
          <Button asChild variant="secondary" size="lg" className="mt-7 h-12 px-6">
            <Link href="/explore">
              {t("home.browse")}
              <ChevronRight />
            </Link>
          </Button>
        </div>
        <HeroCard traders={featured} sparklines={sparklines.data} />
      </section>

      <section>
        <SectionHeader title={t("home.byMarket")} />
        <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 no-scrollbar md:mx-0 md:px-0">
          <MarketChip href="/explore" label={t("home.markets.top100")} hint={t("home.markets.top100")}>
            <span className="flex size-9 items-center justify-center rounded-full bg-primary-soft text-primary">
              <Trophy className="size-[18px]" />
            </span>
          </MarketChip>
          {homeMarkets.map((market) => (
            <MarketChip
              key={market}
              href={`/insights?coin=${encodeURIComponent(market)}`}
              label={coinLabel(market)}
              hint={t("home.marketHint", { market: coinLabel(market) })}
              price={mids[market]}
            >
              <CoinIcon coin={market} size={36} />
            </MarketChip>
          ))}
          {!settings.data
            ? Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="size-[104px] shrink-0 rounded-2xl" />)
            : null}
        </div>
      </section>

      <section>
        <SectionHeader
          title={<SourcedTitle title={t("home.featured")} note={boardNote} />}
          action={
            <Button asChild variant="secondary" size="sm">
              <Link href="/explore">{t("common.viewAll")}</Link>
            </Button>
          }
        />
        <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 no-scrollbar md:mx-0 md:px-0">
          {featured
            ? featured.map((trader) => (
                <TraderCard key={trader.address} trader={trader} series={sparklines.data?.[trader.address]} />
              ))
            : Array.from({ length: 7 }, (_, i) => <TraderCardSkeleton key={i} />)}
        </div>
      </section>

      <section>
        <SectionHeader
          title={<SourcedTitle title={t("home.topTraders")} note={boardNote} />}
          action={
            <Button asChild variant="secondary" size="sm">
              <Link href="/explore">{t("common.viewAll")}</Link>
            </Button>
          }
        />
        <Panel className="overflow-hidden">
          {top.isError ? (
            <ErrorState message={top.error.message} onRetry={() => top.refetch()} />
          ) : top.data ? (
            <TradersTable rows={top.data.items} window="month" sparklines={sparklines.data ?? {}} />
          ) : (
            <div className="flex flex-col gap-2 p-5">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          )}
        </Panel>
      </section>
    </div>
  );
}

/** A section title with where its numbers come from beside it. */
function SourcedTitle({ title, note }: { title: string; note: React.ReactNode }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
      {title}
      {note}
    </span>
  );
}

function MarketChip({
  href,
  label,
  hint,
  price,
  children,
}: {
  href: string;
  label: string;
  hint: string;
  /** Live mid from Hyperliquid's WebSocket, when it has arrived. */
  price?: number;
  children: React.ReactNode;
}) {
  const { format } = useI18n();
  return (
    <Link
      href={href}
      title={hint}
      className="flex size-[104px] shrink-0 snap-start flex-col items-center justify-center gap-2 rounded-2xl bg-raised text-[0.8125rem] font-semibold outline-none transition-colors hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
      <span className="flex max-w-[88px] flex-col items-center leading-tight">
        <span className="max-w-full truncate">{label}</span>
        {price !== undefined ? (
          <span className="num max-w-full truncate text-[10.5px] font-medium text-muted-foreground">{format.price(price)}</span>
        ) : null}
      </span>
    </Link>
  );
}

/** "If you had put in $1,000 thirty days ago…" for the featured traders. */
function HeroCard({
  traders,
  sparklines,
}: {
  traders: TraderCardData[] | undefined;
  sparklines: Record<string, [number, number][]> | undefined;
}) {
  const { t, format } = useI18n();
  const [index, setIndex] = useState(0);
  const [amountText, setAmountText] = useState("1000");

  const candidates = (traders ?? []).filter((tr) => (tr.roi ?? 0) > 0).slice(0, 6);
  if (!traders) return <Skeleton className="h-[292px] rounded-3xl" />;
  if (candidates.length === 0) return null;

  const trader = candidates[index % candidates.length];
  const amount = Math.max(0, toNumber(amountText.replace(/[^\d.]/g, "")) ?? 0);
  const result = amount * (1 + (trader.roi ?? 0));

  return (
    <Panel className="overflow-hidden rounded-3xl bg-card/80">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3.5">
        <Link
          href={`/trader/${trader.address}`}
          className="flex min-w-0 items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <AddressAvatar seed={trader.address} size={30} />
          <span className="min-w-0">
            <span className="block text-[11px] text-muted-foreground">{t("home.heroFollowing")}</span>
            <span className="flex min-w-0 text-sm font-semibold">
              <TraderName trader={trader} />
            </span>
          </span>
        </Link>
        <div className="ml-auto flex items-center gap-1.5" aria-hidden>
          {candidates.map((c, i) => (
            <span
              key={c.address}
              className={cn(
                "h-1.5 rounded-full transition-all",
                i === index % candidates.length ? "w-5 bg-foreground" : "w-1.5 bg-border-strong",
              )}
            />
          ))}
        </div>
        <Button
          variant="secondary"
          size="icon-sm"
          aria-label={t("common.next")}
          onClick={() => setIndex((i) => (i + 1) % candidates.length)}
        >
          <ChevronRight />
        </Button>
      </div>
      <div className="grid gap-5 p-5 sm:grid-cols-[190px_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <label htmlFor="hero-amount" className="text-xs text-muted-foreground">
            {t("home.heroInvest")}
          </label>
          <div className="flex h-12 items-center rounded-full bg-raised px-4 focus-within:ring-2 focus-within:ring-ring">
            <span className="text-lg font-semibold text-subtle-foreground">$</span>
            <input
              id="hero-amount"
              inputMode="decimal"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value.replace(/[^\d.]/g, "").slice(0, 12))}
              className="num ml-1.5 w-full bg-transparent text-xl font-bold outline-none"
            />
          </div>
          <span className="mt-2 text-xs text-muted-foreground">{t("home.heroToday")}</span>
          <div className="flex h-12 items-center rounded-full bg-positive-soft px-4">
            <span className="num truncate text-xl font-bold text-positive">
              {format.usd(result, { digits: 0 })}
            </span>
          </div>
        </div>
        <div className="relative min-h-[150px]">
          <RoiPill value={trader.roi} className="absolute top-0 left-0 z-10" />
          <AreaChart
            data={sparklines?.[trader.address] ?? []}
            height={170}
            strokeWidth={2}
            zeroLine
            formatValue={(v) => format.usd(v, { compact: true })}
          />
        </div>
      </div>
      <p className="border-t border-border px-5 py-2.5 text-[11px] text-subtle-foreground">{t("home.heroNote")}</p>
    </Panel>
  );
}
