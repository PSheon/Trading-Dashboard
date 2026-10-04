"use client";

import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronRight, Trophy, UserRound } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { cn } from "cn";

import { AreaChart } from "@/components/charts/area-chart";
import { boardName, HScroll, TraderAvatar, VerifiedTick } from "@/components/discover/board-bits";
import { HomeCard, HomeCardSkeleton } from "@/components/discover/board-card";
import { ErrorState, Skeleton } from "@/components/page";
import { SiteFooter } from "@/components/shell/site-footer";
import { CoinIcon } from "@/components/traders/coin-icon";
import { useI18n } from "@/i18n/provider";
import { boardCoinLabel, homeTiles, roiPillShort } from "@/lib/board-format";
import { HOME_TILE_CRYPTO, HOME_TILE_STOCKS, type BoardTrader, type HomeBoardsResponse } from "@/lib/contracts";
import { useHomeBoards, type InitialRead } from "@/lib/queries";
import { historicalSimulation } from "@/lib/historical-simulation";


const exploreHref = (board: string, sort: string, market?: "stocks") =>
  `/explore?${new URLSearchParams({ ...(market ? { market } : {}), ...(board !== "top100" ? { board } : {}), ...(sort !== "copyScore" ? { sort } : {}) })}`;

/**
 * Home (Stage 3 §0.5, CopyDog's /hyperliquid): hero and the $1,000
 * calculator (all-time ROI), 依市場瀏覽 tiles, carousel rows (精選 KOLs, top
 * crypto, top stocks, one per market) and the footer. Every row comes from
 * one GET /discover/home, read while the page renders on the server when
 * the api answers in time (`initial`) so the rows are in the first HTML.
 * Phones: compact title, two tile rows, no calculator, three compact cards
 * per screen.
 */
export function HomeView({ initial }: { initial?: { home: InitialRead<HomeBoardsResponse> | null } } = {}) {
  const home = useHomeBoards(initial?.home);
  return <HomeContent home={{ data: home.data, isError: home.isError, refetch: () => void home.refetch() }} />;
}

/** The page's Suspense fallback while the server reads the rows: the same
 * layout with skeleton rows and no query of its own. A fallback that read
 * the rows itself would create the query first on a client navigation to
 * the home, and TanStack ignores the server's `initialData` for a query
 * that already exists (a second /discover/home request). */
export function HomeSkeleton() {
  return <HomeContent home={{ data: undefined, isError: false, refetch: () => {} }} />;
}

function HomeContent({ home }: { home: { data: HomeBoardsResponse | undefined; isError: boolean; refetch: () => void } }) {
  const { t } = useI18n();
  // CopyDog's tiles: five fixed per kind, then the two trending markets.
  const crypto = homeTiles(HOME_TILE_CRYPTO, home.data?.trending?.coins);
  const stocks = homeTiles(HOME_TILE_STOCKS, home.data?.trending?.stocks);
  const label = (coin: string) => boardCoinLabel(coin, t, "home");

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
    <div className="flex flex-col gap-6 md:gap-[34px]">
      {/* Phones: the compact two-line title (登入 is in the phone header). The
          page's one <h1> is the desktop hero's; this is the same level-1
          heading where that one is not displayed. */}
      <div className="md:hidden">
        <p role="heading" aria-level={1} className="font-display text-[1.75rem] leading-[1.15] whitespace-pre-line">{t("home.heroTitleMobile")}</p>
      </div>

      <section className="hidden items-center gap-10 md:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,500px)]">
        <div>
          <h1 className="max-w-[11.5em] text-[clamp(2.25rem,3.25vw,3.5rem)] leading-[1.05] font-extrabold tracking-tight">{t("home.heroTitle")}</h1>
          <Link
            href="/explore"
            className="mt-[26px] inline-flex h-[47px] items-center rounded-full bg-raised px-5 text-sm font-bold outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("home.heroBrowse")}
          </Link>
        </div>
        <div className="hidden lg:block">
          {home.data ? <Calculator traders={home.data.calculator} /> : !home.isError ? <CalculatorSkeleton /> : null}
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-[1.375rem] font-bold tracking-tight md:mb-3.5 md:text-lg md:leading-[27px] md:tracking-normal">{t("home.byMarket")}</h2>
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
        <div className="flex flex-col gap-4 md:hidden">
          <div className="grid grid-cols-2 gap-3">
            <WideTile href={exploreHref("top100", "copyScore")} label={t("home.markets.top100")} icon={<Trophy className="size-5 text-primary" />} />
            <WideTile href={exploreHref("kol", "copyScore")} label={t("home.kols")} icon={<UserRound className="size-5 text-primary" />} />
          </div>
          {/* Two rows that scroll sideways, the fifth tile peeking in. */}
          <div className="-mx-5 flex snap-x scroll-px-5 gap-3 overflow-x-auto px-5 no-scrollbar" data-testid="phone-crypto-tiles">
            {crypto.map((c) => <Tile key={c} href={exploreHref(c, "pnl")} label={label(c)} icon={<CoinIcon coin={c} size={30} />} small />)}
          </div>
          <div className="-mx-5 flex snap-x scroll-px-5 gap-3 overflow-x-auto px-5 no-scrollbar" data-testid="phone-stock-tiles">
            {stocks.map((c) => <Tile key={c} href={exploreHref(c, "pnl", "stocks")} label={label(c)} icon={<CoinIcon coin={c} size={30} />} small />)}
          </div>
        </div>
      </section>

      {home.isError && !home.data ? <ErrorState message={t("discover.error")} onRetry={() => home.refetch()} /> : null}

      {rows
        ? rows
            .filter((row) => row.items.length > 0)
            .map((row) => (
              <section key={row.key}>
                <RowHeader title={row.title} coin={"coin" in row ? row.coin : undefined} href={row.href} />
                <HScroll label={row.title}>
                  {row.items.map((trader) => <HomeCard key={trader.address} trader={trader} />)}
                </HScroll>
              </section>
            ))
        : !home.isError
          ? Array.from({ length: 3 }, (_, i) => (
              <section key={i}>
                <Skeleton className="mb-3 h-[33px] w-40 md:mb-3.5 md:h-[30px]" />
                <div className="-mx-5 flex gap-3 overflow-hidden px-5 md:mx-0 md:px-0 md:pb-0.5">
                  {Array.from({ length: 7 }, (_, j) => <HomeCardSkeleton key={j} />)}
                </div>
              </section>
            ))
          : null}

      {/* CopyDog's phone home ends with the last row (no footer). */}
      <SiteFooter className="hidden md:block" />
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
        "flex shrink-0 snap-start flex-col items-center justify-center gap-2 rounded-[12px] border border-border bg-card font-semibold outline-none transition-colors hover:border-border-strong hover:bg-raised/60 focus-visible:ring-2 focus-visible:ring-ring",
        small ? "size-[78px] text-xs" : "size-[104px] text-[0.8125rem]",
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
      className="flex h-[52px] items-center gap-2.5 rounded-[12px] border border-border bg-card px-4 text-[0.9375rem] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {icon}
      {label}
    </Link>
  );
}

function RowHeader({ title, coin, href }: { title: string; coin?: string; href: string }) {
  const { t } = useI18n();
  return (
    <div className="mb-3 flex items-center justify-between gap-3 md:mb-3.5">
      <h2 className="flex items-center gap-2 text-[1.375rem] font-bold tracking-tight md:text-lg md:leading-[27px] md:tracking-normal">
        {coin ? <CoinIcon coin={coin} size={24} /> : null}
        {title}
      </h2>
      <Link
        href={href}
        aria-label={`${t("home.seeAll")} · ${title}`}
        className="flex items-center justify-center rounded-full bg-raised text-[0.8125rem] font-semibold outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring max-md:size-8 md:h-[30px] md:px-4"
      >
        <span className="hidden md:inline">{t("home.seeAll")}</span>
        <ArrowRight className="size-4 md:hidden" />
      </Link>
    </div>
  );
}

/** CopyDog's hero placeholder: one shimmering block the size of the card. */
function CalculatorSkeleton() {
  const { t } = useI18n();
  return <div role="status" aria-label={t("common.loading")} className="ui-skeleton h-[267px] rounded-xl bg-card" />;
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
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex h-[70px] items-center gap-3 border-b border-border px-[23px]">
        <Link href={`/trader/${trader.address}`} className="flex min-w-0 items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <TraderAvatar trader={trader} size={32} />
          <span className="truncate font-semibold">{boardName(trader)}</span>
          {trader.verified ? <VerifiedTick /> : null}
        </Link>
        <div className="ml-auto flex items-center gap-1.5" role="group" aria-label={t("home.nextTrader")}>
          {traders.map((c, i) => (
            <button
              key={c.address}
              type="button"
              aria-label={t("home.traderN", { n: String(i + 1) })}
              aria-current={i === index % traders.length}
              onClick={() => { setIndex(i); setHover(null); }}
              className={cn(
                "relative h-1.5 rounded-full outline-none transition-[width,background-color] before:absolute before:-inset-x-[3px] before:-inset-y-3 focus-visible:ring-2 focus-visible:ring-ring",
                i === index % traders.length ? "w-[18px] bg-muted-foreground" : "w-1.5 bg-muted-foreground/35",
              )}
            />
          ))}
        </div>
        <button
          type="button"
          aria-label={t("home.nextTrader")}
          onClick={() => { setIndex((i) => (i + 1) % traders.length); setHover(null); }}
          className="-ml-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-raised outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight className="size-[19px]" />
        </button>
      </div>
      <div className="grid grid-cols-[163px_minmax(0,1fr)] gap-5 px-[23px] py-[19px]">
        <div className="flex flex-col gap-2">
          <label htmlFor="calc-amount" className="text-xs text-muted-foreground">{t("home.ifInvested")}</label>
          <div className="flex h-[46px] items-center rounded-2xl bg-raised px-4 focus-within:ring-2 focus-within:ring-ring">
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
          </span>
          <div className={cn("flex h-[46px] items-center rounded-2xl px-4", shown === null ? "bg-raised" : up ? "bg-positive-soft" : "bg-negative-soft")} aria-live="polite">
            <span className={cn("num truncate text-xl font-bold", shown === null ? "text-muted-foreground" : up ? "text-positive" : "text-negative")}>{shown === null ? "—" : `$${Math.round(shown).toLocaleString("en-US")}`}</span>
          </div>
        </div>
        <div className="relative min-h-[150px]" onMouseLeave={() => setHover(null)}>
          {change !== null ? <span className={cn("num absolute top-0 left-0 z-10 inline-flex h-6 items-center gap-0.5 rounded-md px-1.5 text-xs font-bold", up ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative")}>
            <Arrow className="size-3" strokeWidth={2.5} aria-hidden />
            {roiPillShort(change)}
          </span> : null}
          <HoverChartOrEmpty series={series} hover={hover} onHover={setHover} missingRoi={simulation === null} />
        </div>
      </div>
    </section>
  );
}

function HoverChartOrEmpty({ series, hover, onHover, missingRoi }: { series: Array<readonly [number, number]>; hover: number | null; onHover: (i: number | null) => void; missingRoi: boolean }) {
  const { t } = useI18n();
  return series.length > 0 ? <HoverChart series={series} hover={hover} onHover={onHover} /> : (
    <p className="flex h-[157px] items-center justify-center px-3 text-center text-xs text-muted-foreground" role="status">
      {t(missingRoi ? "home.calculatorMissingRoi" : "home.calculatorMissingCurve")}
    </p>
  );
}

function HoverChart({ series, hover, onHover }: { series: Array<readonly [number, number]>; hover: number | null; onHover: (i: number | null) => void }) {
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
      {/* CopyDog's crosshair: a dashed line and a dot on the hovered point. */}
      <AreaChart data={series} height={157} strokeWidth={2} zeroBaseline={false} grid={4} marker={hover} formatValue={(v) => format.usd(v, { compact: true })} />
    </div>
  );
}
