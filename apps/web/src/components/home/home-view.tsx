"use client";

import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronRight, Info, Trophy, UserRound } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { cn } from "cn";

import { AreaChart } from "@/components/charts/area-chart";
import { boardName, HScroll, TraderAvatar, VerifiedTick } from "@/components/discover/board-bits";
import { DiscoveryCoverage } from "@/components/discover/discovery-coverage";
import { HomeCard, HomeCardSkeleton } from "@/components/discover/board-card";
import { ErrorState, Skeleton } from "@/components/page";
import { SiteFooter } from "@/components/shell/site-footer";
import { CoinIcon } from "@/components/traders/coin-icon";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/provider";
import { boardCoinLabel, roiPillShort } from "@/lib/board-format";
import type { BoardTrader } from "@/lib/contracts";
import { useHomeBoards, useSiteSettings } from "@/lib/queries";
import { historicalSimulation } from "@/lib/historical-simulation";
import styles from "./home-view.module.css";

const DEFAULT_CRYPTO = ["BTC", "ETH", "SOL", "DOGE", "HYPE", "ZEC", "NEAR"];
const DEFAULT_STOCKS = ["xyz:SP500", "xyz:GOLD", "xyz:CL", "xyz:NVDA", "xyz:TSLA", "xyz:BRENTOIL", "xyz:SILVER"];

const exploreHref = (board: string, sort: string, market?: "stocks") =>
  `/explore?${new URLSearchParams({ ...(market ? { market } : {}), ...(board !== "top100" ? { board } : {}), ...(sort !== "copyScore" ? { sort } : {}) })}`;

/**
 * Home (Stage 3 §0.5, CopyDog's /hyperliquid): hero and the $1,000
 * calculator (all-time ROI), 依市場瀏覽 tiles, carousel rows (精選 KOLs, top
 * crypto, top stocks, one per market) and the footer. Every row comes from
 * one GET /discover/home. Phones: compact title, two tile rows, no
 * calculator, three compact cards per screen.
 */
export function HomeView() {
  const { t } = useI18n();
  const home = useHomeBoards();
  const settings = useSiteSettings();
  const crypto = settings.data?.cryptoBoards ?? DEFAULT_CRYPTO;
  const stocks = settings.data?.stockBoards ?? DEFAULT_STOCKS;
  const label = (coin: string) => boardCoinLabel(coin, t);

  const rows = home.data
    ? [
        { key: "featured", title: t("home.featured"), href: exploreHref("kol", "copyScore"), items: home.data.featured },
        { key: "crypto", title: t("home.topCrypto"), href: exploreHref("top100", "copyScore"), items: home.data.crypto },
        { key: "stocks", title: t("home.topStock"), href: exploreHref("top100", "pnl", "stocks"), items: home.data.stocks },
        ...home.data.markets.map((m) => ({
          key: m.coin,
          title: label(m.coin),
          coin: m.coin,
          href: exploreHref(m.coin, "pnl", m.market === "stocks" ? "stocks" : undefined),
          items: m.items,
        })),
      ]
    : null;

  return (
    <div className={cn(styles.home, "flex flex-col gap-9 md:gap-11")}>
      {/* Phones: CopyDog's compact two-line title (登入 is in Orbie's top bar,
          which phones keep; CopyDog puts it here instead). */}
      <h1 className={cn(styles.mobileTitle, "text-[2rem] leading-[1.15] font-black tracking-tight whitespace-pre-line md:hidden")}>{t("home.heroTitleMobile")}</h1>

      <section className={cn(styles.hero, "hidden items-center gap-10 md:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,500px)]")}>
        <svg className={styles.orbit} viewBox="0 0 220 220" fill="none" aria-hidden="true">
          <circle cx="110" cy="110" r="66" stroke="currentColor" />
          <ellipse cx="110" cy="110" rx="106" ry="34" transform="rotate(-32 110 110)" stroke="currentColor" />
          <circle cx="194" cy="57" r="3" fill="currentColor" />
        </svg>
        <div>
          <h1 className="max-w-[8.2em] text-[3.5rem] leading-[1.08] font-black tracking-tight">{t("home.heroTitle")}</h1>
          <Link
            href="/explore"
            className="mt-8 inline-flex h-12 items-center gap-2 rounded-full bg-raised px-7 text-base font-bold outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("home.heroBrowse")}
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
        <div className="hidden lg:block">
          {home.data ? <Calculator traders={home.data.calculator} /> : !home.isError ? <CalculatorSkeleton /> : null}
        </div>
      </section>

      <section className={styles.markets}>
        <h2 className="mb-3.5 text-lg font-bold tracking-tight md:text-xl">{t("home.byMarket")}</h2>
        {/* Desktop: one scrolling row of square tiles. */}
        <div className="hidden md:block">
          <HScroll label={t("home.byMarket")}>
            <Tile href={exploreHref("top100", "copyScore")} label={t("home.markets.top100")} icon={<BoardIcon kind="top100" />} />
            <Tile href={exploreHref("kol", "copyScore")} label={t("home.kols")} icon={<BoardIcon kind="kol" />} />
            {crypto.map((c) => <Tile key={c} href={exploreHref(c, "pnl")} label={label(c)} icon={<CoinIcon coin={c} size={34} />} />)}
            {stocks.map((c) => <Tile key={c} href={exploreHref(c, "pnl", "stocks")} label={label(c)} icon={<CoinIcon coin={c} size={34} />} />)}
          </HScroll>
        </div>
        {/* Phones: Top 100 and KOL pills, then a crypto and a stock row. */}
        <div className="flex flex-col gap-3 md:hidden">
          <div className="grid grid-cols-2 gap-3">
            <WideTile href={exploreHref("top100", "copyScore")} label={t("home.markets.top100")} icon={<Trophy className="size-5 text-primary" />} />
            <WideTile href={exploreHref("kol", "copyScore")} label={t("home.kols")} icon={<UserRound className="size-5 text-primary" />} />
          </div>
          <div className="-mx-4 flex gap-3 overflow-x-auto px-4 no-scrollbar">
            {crypto.map((c) => <Tile key={c} href={exploreHref(c, "pnl")} label={label(c)} icon={<CoinIcon coin={c} size={30} />} small />)}
          </div>
          <div className="-mx-4 flex gap-3 overflow-x-auto px-4 no-scrollbar">
            {stocks.map((c) => <Tile key={c} href={exploreHref(c, "pnl", "stocks")} label={label(c)} icon={<CoinIcon coin={c} size={30} />} small />)}
          </div>
        </div>
      </section>

      {home.data ? <DiscoveryCoverage data={home.data} /> : null}

      {home.isError && !home.data ? <ErrorState message={t("discover.error")} onRetry={() => home.refetch()} /> : null}

      {rows
        ? rows
            .filter((row) => row.items.length > 0)
            .map((row) => (
              <section key={row.key} className={styles.row}>
                <RowHeader title={row.title} coin={"coin" in row ? row.coin : undefined} href={row.href} />
                <HScroll label={row.title}>
                  {row.items.map((trader) => <HomeCard key={trader.address} trader={trader} />)}
                </HScroll>
              </section>
            ))
        : !home.isError
          ? Array.from({ length: 3 }, (_, i) => (
              <section key={i}>
                <Skeleton className="my-2 mb-5.5 h-7 w-40" />
                <div className="-mx-4 flex gap-3 overflow-hidden px-4 py-1 md:mx-0 md:px-0">
                  {Array.from({ length: 7 }, (_, j) => <HomeCardSkeleton key={j} />)}
                </div>
              </section>
            ))
          : null}

      <SiteFooter />
    </div>
  );
}

function BoardIcon({ kind }: { kind: "top100" | "kol" }) {
  const Icon = kind === "top100" ? Trophy : UserRound;
  return (
    <span className="flex size-[34px] items-center justify-center rounded-full bg-primary-soft text-primary">
      <Icon className="size-[18px]" />
    </span>
  );
}

function Tile({ href, label, icon, small = false }: { href: string; label: string; icon: React.ReactNode; small?: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        "ui-lift flex shrink-0 snap-start flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-card text-[0.8125rem] font-semibold outline-none transition-colors hover:border-border-strong hover:bg-raised/60 focus-visible:ring-2 focus-visible:ring-ring",
        small ? "size-[82px]" : "size-[104px]",
      )}
    >
      {icon}
      <span className="max-w-[90%] truncate">{label}</span>
    </Link>
  );
}

function WideTile({ href, label, icon }: { href: string; label: string; icon: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="flex h-[52px] items-center gap-2.5 rounded-2xl border border-border bg-card px-4 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {icon}
      {label}
    </Link>
  );
}

function RowHeader({ title, coin, href }: { title: string; coin?: string; href: string }) {
  const { t } = useI18n();
  return (
    <div className="mb-3.5 flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight md:text-xl">
        {coin ? <CoinIcon coin={coin} size={24} /> : null}
        {title}
      </h2>
      <Link
        href={href}
        aria-label={`${t("home.seeAll")} · ${title}`}
        className="flex h-11 items-center justify-center rounded-full bg-raised text-sm font-semibold outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring max-md:w-11 md:px-4"
      >
        <span className="hidden md:inline">{t("home.seeAll")}</span>
        <ArrowRight className="size-4 md:hidden" />
      </Link>
    </div>
  );
}

function CalculatorSkeleton() {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t("common.loading")} className="ui-skeleton overflow-hidden rounded-3xl border border-border bg-card">
      <div aria-hidden="true" className="flex items-center gap-3 border-b border-border px-5 py-3.5">
        <div className="size-10 rounded-full bg-raised" />
        <div className="h-3 w-28 rounded-full bg-raised" />
        <div className="ml-auto h-2 w-24 rounded-full bg-raised" />
      </div>
      <div aria-hidden="true" className="grid grid-cols-[170px_minmax(0,1fr)] gap-5 p-5">
        <div className="flex flex-col gap-2">
          <div className="h-4 w-20 rounded bg-raised" />
          <div className="h-12 rounded-2xl bg-raised" />
          <div className="mt-2 h-4 w-24 rounded bg-raised" />
          <div className="h-12 rounded-2xl bg-raised" />
        </div>
        <div className="h-[170px] rounded-xl bg-raised/60" />
      </div>
    </div>
  );
}

/** "If you invested $1,000 … you would have today": six traders, all-time ROI. */
export function Calculator({ traders }: { traders: BoardTrader[] }) {
  const { t } = useI18n();
  const [index, setIndex] = useState(0);
  const [amount, setAmount] = useState(1000);
  const [hover, setHover] = useState<number | null>(null);
  const trader = traders.length > 0 ? traders[index % traders.length] : null;
  const simulation = useMemo(() => trader ? historicalSimulation(amount, trader.roi, trader.sparkline) : null, [trader, amount]);
  const series = simulation?.series ?? [];
  if (!trader) return null;
  const result = simulation?.total ?? null;
  const shown = hover !== null && series[hover] ? series[hover][1] : result;
  const change = shown === null ? null : amount > 0 ? shown / amount - 1 : 0;
  const up = change !== null && change >= 0;
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <section className={cn(styles.calculator, "overflow-hidden rounded-3xl border border-border bg-card")}>
      <div className="flex items-center gap-3 border-b border-border px-5 py-3.5">
        <Link href={`/trader/${trader.address}`} className="flex min-w-0 items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <TraderAvatar trader={trader} size={32} />
          <span className="truncate font-semibold">{boardName(trader)}</span>
          {trader.verified ? <VerifiedTick /> : null}
        </Link>
        <div className="ml-auto flex items-center" role="group" aria-label={t("home.nextTrader")}>
          {traders.map((c, i) => (
            <button
              key={c.address}
              type="button"
              aria-label={t("home.traderN", { n: String(i + 1) })}
              aria-current={i === index % traders.length}
              onClick={() => { setIndex(i); setHover(null); }}
              className="flex h-8 w-6 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span aria-hidden className={cn("h-1.5 rounded-full transition-colors", i === index % traders.length ? "w-5 bg-foreground" : "w-1.5 bg-border-strong")} />
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label={t("home.nextTrader")}
          onClick={() => { setIndex((i) => (i + 1) % traders.length); setHover(null); }}
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-raised outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
      <div className="grid grid-cols-[170px_minmax(0,1fr)] gap-5 p-5">
        <div className="flex flex-col gap-2">
          <label htmlFor="calc-amount" className="text-xs text-muted-foreground">{t("home.ifInvested")}</label>
          <div className="flex h-12 items-center rounded-2xl bg-raised px-4 focus-within:ring-2 focus-within:ring-ring">
            <span className="text-lg font-semibold text-subtle-foreground">$</span>
            <input
              id="calc-amount"
              inputMode="numeric"
              value={amount.toLocaleString("en-US")}
              onChange={(e) => { setAmount(Math.min(1_000_000, Number(e.target.value.replace(/[^0-9]/g, "")) || 0)); setHover(null); }}
              className="num ml-1.5 w-full bg-transparent text-xl font-bold outline-none"
            />
          </div>
          <span className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
            {hover !== null ? t("home.youWouldHaveHad") : t("home.youWouldHave")}
            <Tooltip content={t("home.calculatorTip")}>
              <span role="img" tabIndex={0} className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("home.calculatorTip")}>
                <Info className="size-3.5" />
              </span>
            </Tooltip>
          </span>
          <div className={cn("flex h-12 items-center rounded-2xl px-4", shown === null ? "bg-raised" : up ? "bg-positive-soft" : "bg-negative-soft")} aria-live="polite">
            <span className={cn("num truncate text-xl font-bold", shown === null ? "text-muted-foreground" : up ? "text-positive" : "text-negative")}>{shown === null ? "—" : `$${Math.round(shown).toLocaleString("en-US")}`}</span>
          </div>
        </div>
        <div className="relative min-h-[150px]" onMouseLeave={() => setHover(null)}>
          {change !== null ? <span className={cn("num absolute top-0 left-0 z-10 inline-flex h-6 items-center gap-0.5 rounded-md px-1.5 text-xs font-bold", up ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative")}>
            <Arrow className="size-3" strokeWidth={2.5} aria-hidden />
            {roiPillShort(change)}
          </span> : null}
          <HoverChartOrEmpty series={series} onHover={setHover} missingRoi={simulation === null} />
        </div>
      </div>
      <p className="px-5 pb-4 text-[11px] leading-relaxed text-muted-foreground">{t("home.calculatorTip")}</p>
    </section>
  );
}

function HoverChartOrEmpty({ series, onHover, missingRoi }: { series: Array<readonly [number, number]>; onHover: (i: number | null) => void; missingRoi: boolean }) {
  const { t } = useI18n();
  return series.length > 0 ? <HoverChart series={series} onHover={onHover} /> : (
    <p className="flex h-[170px] items-center justify-center px-3 text-center text-xs text-muted-foreground" role="status">
      {t(missingRoi ? "home.calculatorMissingRoi" : "home.calculatorMissingCurve")}
    </p>
  );
}

function HoverChart({ series, onHover }: { series: Array<readonly [number, number]>; onHover: (i: number | null) => void }) {
  const { format } = useI18n();
  return (
    <div
      className="h-full"
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        onHover(series.length > 1 ? Math.round(f * (series.length - 1)) : null);
      }}
    >
      <AreaChart data={series} height={170} strokeWidth={2} zeroBaseline={false} formatValue={(v) => format.usd(v, { compact: true })} />
    </div>
  );
}

