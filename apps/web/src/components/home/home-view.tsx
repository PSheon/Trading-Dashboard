"use client";

import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronRight, Trophy, UserRound } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { cn } from "cn";

import { AreaChart } from "@/components/charts/area-chart";
import { boardName, HScroll, TraderAvatar, VerifiedTick } from "@/components/discover/board-bits";
import { HomeCard, HomeCardSkeleton } from "@/components/discover/board-card";
import { ErrorState, SkelBar, SkelCircle, Skeleton } from "@/components/page";
import { buttonVariants } from "@/components/ui/button";
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
    <div className="flex flex-col gap-7 md:gap-8">
      {/* Phones: the compact two-line title (登入 is in the phone header). The
          page's one <h1> is the desktop hero's; this is the same level-1
          heading where that one is not displayed. */}
      <div className="md:hidden">
        <p role="heading" aria-level={1} className="type-hero whitespace-pre-line">
          <Accented text={t("home.heroTitleMobile")} />
        </p>
      </div>

      <section className="hidden items-center gap-8 pt-4 md:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,520px)]">
        <div>
          <h1 className="type-hero max-w-[12em] text-balance whitespace-pre-line">
            <Accented text={t("home.heroTitle")} />
          </h1>
          <Link
            href="/explore"
            className={buttonVariants({ size: "cta", className: "mt-6 gap-2.5" })}
          >
            {t("home.heroBrowse")}
            <ArrowRight className="size-5" strokeWidth={2.6} aria-hidden />
          </Link>
        </div>
        <div className="md:max-lg:mt-2">
          {home.data ? <Calculator traders={home.data.calculator} /> : !home.isError ? <CalculatorSkeleton /> : null}
        </div>
      </section>

      <section>
        <h2 className="type-h2 mb-3.5">{t("home.byMarket")}</h2>
        {/* Desktop: one scrolling row of square tiles. */}
        <div className="hidden md:block">
          <HScroll label={t("home.byMarket")}>
            <Tile href={exploreHref("top100", "copyScore")} label={t("home.markets.top100")} icon={<BoardIcon kind="top100" />} featured />
            <Tile href={exploreHref("kol", "copyScore")} label={t("home.kols")} icon={<BoardIcon kind="kol" />} />
            {crypto.map((c) => <Tile key={c} href={exploreHref(c, "pnl")} label={label(c)} icon={<CoinIcon coin={c} size={34} />} />)}
            {stocks.map((c) => <Tile key={c} href={exploreHref(c, "pnl", "stocks")} label={label(c)} icon={<CoinIcon coin={c} size={34} />} />)}
          </HScroll>
        </div>
        {/* Phones: Top 100 and KOL pills, then a crypto and a stock row. */}
        <div className="flex flex-col gap-4 md:hidden">
          <div className="grid grid-cols-2 gap-3">
            <WideTile href={exploreHref("top100", "copyScore")} label={t("home.markets.top100")} icon={<Trophy className="size-5" strokeWidth={2.4} />} featured />
            <WideTile href={exploreHref("kol", "copyScore")} label={t("home.kols")} icon={<UserRound className="size-5" strokeWidth={2.4} />} />
          </div>
          {/* Two rows that scroll sideways, the fifth tile peeking in. */}
          <div className="-mx-4 flex snap-x scroll-px-4 gap-2.5 overflow-x-auto px-4 no-scrollbar" data-testid="phone-crypto-tiles">
            {crypto.map((c) => <Tile key={c} href={exploreHref(c, "pnl")} label={label(c)} icon={<CoinIcon coin={c} size={30} />} small />)}
          </div>
          <div className="-mx-4 flex snap-x scroll-px-4 gap-2.5 overflow-x-auto px-4 no-scrollbar" data-testid="phone-stock-tiles">
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
              <section key={i} aria-hidden="true">
                {/* RowHeader: the title's line and 查看全部. */}
                <div className="mb-3.5 flex items-center justify-between gap-3">
                  <Skeleton className="h-[27.5px] w-32 rounded-full" />
                  <Skeleton className="h-11 w-[84px] rounded-full" />
                </div>
                <div className="-mx-4 flex gap-3 overflow-hidden px-4 py-1 md:mx-0 md:px-0.5">
                  {Array.from({ length: 7 }, (_, j) => <HomeCardSkeleton key={j} />)}
                </div>
              </section>
            ))
          : null}

      {/* The phone home ends with the last row (M-Home: no footer). */}
      <SiteFooter className="hidden md:flex" />
    </div>
  );
}

function BoardIcon({ kind }: { kind: "top100" | "kol" }) {
  const Icon = kind === "top100" ? Trophy : UserRound;
  return (
    <span className="flex size-9 items-center justify-center rounded-full bg-card text-foreground">
      <Icon className="size-[18px]" strokeWidth={2.4} />
    </span>
  );
}

/** A market tile (C-Home): a raised 26px-cornered block, the icon on a
 * card-coloured disc; Top 100 is the orange one. */
function Tile({ href, label, icon, small = false, featured = false }: { href: string; label: string; icon: React.ReactNode; small?: boolean; featured?: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        "orbit-press flex shrink-0 snap-start flex-col items-center justify-center gap-2 rounded-[26px] font-extrabold outline-none focus-visible:ring-2 focus-visible:ring-ring",
        featured ? "bg-primary text-primary-foreground hover:bg-primary-hover" : "bg-raised hover:bg-raised-hover",
        small ? "h-[84px] w-[76px] text-xs" : "h-24 w-[108px] text-[0.8125rem]",
      )}
    >
      <span className="flex size-9 items-center justify-center overflow-hidden rounded-full bg-card">{icon}</span>
      <span className="max-w-[90%] truncate">{label}</span>
    </Link>
  );
}

function WideTile({ href, label, icon, featured = false }: { href: string; label: string; icon: React.ReactNode; featured?: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        "orbit-press flex h-[56px] items-center gap-2.5 rounded-[26px] px-4 text-[0.9375rem] font-extrabold outline-none focus-visible:ring-2 focus-visible:ring-ring",
        featured ? "bg-primary text-primary-foreground" : "bg-raised",
      )}
    >
      <span className={cn("flex size-9 items-center justify-center rounded-full bg-card", featured ? "text-foreground" : "text-primary-text")}>{icon}</span>
      {label}
    </Link>
  );
}

/** Text with `*accented*` words in Orbie orange (the hero's 加密貨幣 / 股票). */
function Accented({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*[^*]+\*)/).map((part, i) =>
        part.startsWith("*") && part.endsWith("*") && part.length > 2 ? (
          <span key={i} className="text-primary-display">{part.slice(1, -1)}</span>
        ) : (
          part
        ),
      )}
    </>
  );
}

function RowHeader({ title, coin, href }: { title: string; coin?: string; href: string }) {
  const { t } = useI18n();
  return (
    <div className="mb-3.5 flex items-center justify-between gap-3">
      <h2 className="type-h2 flex items-center gap-2">
        {coin ? <CoinIcon coin={coin} size={24} /> : null}
        {title}
      </h2>
      <Link
        href={href}
        aria-label={`${t("home.seeAll")} · ${title}`}
        className="orbit-press flex h-11 items-center justify-center rounded-full bg-raised px-4 text-[0.8125rem] font-extrabold outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("home.seeAll")}
      </Link>
    </div>
  );
}

/** The calculator card while the rows load: the same card, its trader row
 * (avatar, name, dots, ›), the two figure wells with their static labels
 * and the chart's place. */
function CalculatorSkeleton() {
  const { t } = useI18n();
  return (
    <section role="status" aria-label={t("common.loading")} className="orbit-card card-pad ui-skeleton flex flex-col gap-4 overflow-hidden">
      <div className="flex items-center gap-3">
        <SkelCircle className="size-10" />
        <SkelBar className="h-3.5 w-32" />
        <SkelBar className="ml-auto h-1.5 w-28" />
        <SkelCircle className="ml-1 size-11" />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4" aria-hidden="true">
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-bold text-muted-foreground">{t("home.ifInvested")}</span>
          <div className="flex h-[52px] items-center rounded-[26px] bg-inset px-4" />
          <span className="mt-2.5 text-[13px] font-bold text-muted-foreground">{t("home.youWouldHave")}</span>
          <div className="flex h-[52px] items-center rounded-[26px] bg-inset px-4" />
        </div>
        <div className="relative min-h-[150px] pt-8">
          <SkelBar className="absolute top-0 left-0 h-[30px] w-16 rounded-2xl" />
          <span className="block h-[150px] rounded-2xl bg-inset" />
        </div>
      </div>
    </section>
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
    <section className="orbit-card card-pad flex flex-col gap-4 overflow-hidden">
      <div className="flex items-center gap-3">
        <Link href={`/trader/${trader.address}`} className="flex min-w-0 items-center gap-2.5 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <TraderAvatar trader={trader} size={40} />
          <span className="truncate text-[17px] font-extrabold">{boardName(trader)}</span>
          {trader.verified ? <VerifiedTick /> : null}
        </Link>
        <div className="ml-auto flex items-center" role="group" aria-label={t("home.nextTrader")}>
          {traders.map((c, i) => (
            // A 24px target around each 6px dot (WCAG 2.5.8).
            <button
              key={c.address}
              type="button"
              aria-label={t("home.traderN", { n: String(i + 1) })}
              aria-current={i === index % traders.length}
              onClick={() => { setIndex(i); setHover(null); }}
              className="group flex h-6 min-w-6 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                aria-hidden
                className={cn(
                  "block h-1.5 rounded-full transition-[width,background-color] duration-300 motion-reduce:transition-none",
                  i === index % traders.length ? "w-[18px] bg-foreground" : "w-1.5 bg-border group-hover:bg-muted-foreground",
                )}
              />
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label={t("home.nextTrader")}
          onClick={() => { setIndex((i) => (i + 1) % traders.length); setHover(null); }}
          className="orbit-press ml-1 flex size-11 shrink-0 items-center justify-center rounded-full bg-inset outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight className="size-5" strokeWidth={2.4} />
        </button>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="calc-amount" className="text-[13px] font-bold text-muted-foreground">{t("home.ifInvested")}</label>
          <div className="flex h-[52px] items-center rounded-[26px] border-2 border-transparent bg-inset px-4 transition-colors focus-within:border-primary">
            <span className="font-display text-[22px] text-muted-foreground">$</span>
            <input
              id="calc-amount"
              inputMode="numeric"
              value={amount.toLocaleString("en-US")}
              onChange={(e) => { setAmount(Math.min(1_000_000, Number(e.target.value.replace(/[^0-9]/g, "")) || 0)); setHover(null); }}
              className="num ml-1.5 w-full bg-transparent font-display text-[22px] outline-none"
            />
          </div>
          <span className="mt-2.5 flex items-center gap-1 text-[13px] font-bold text-muted-foreground">
            {hover !== null ? t("home.youWouldHaveHad") : t("home.youWouldHave")}
          </span>
          <div className={cn("flex h-[52px] items-center rounded-[26px] px-4", shown === null ? "bg-inset" : up ? "bg-tag-profit" : "bg-tag-loss")} aria-live="polite">
            <span className={cn("num truncate font-display text-[22px]", shown === null ? "text-muted-foreground" : up ? "text-tag-profit-foreground" : "text-tag-loss-foreground")}>{shown === null ? "—" : `$${Math.round(shown).toLocaleString("en-US")}`}</span>
          </div>
        </div>
        <div className="relative min-h-[150px] pt-8" onMouseLeave={() => setHover(null)}>
          {change !== null ? <span className={cn("num chip-md absolute top-0 left-0 z-10 gap-0.5", up ? "bg-tag-profit text-tag-profit-foreground" : "bg-tag-loss text-tag-loss-foreground")}>
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
    <p className="flex h-[150px] items-center justify-center px-3 text-center text-xs font-bold text-muted-foreground" role="status">
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
      <AreaChart data={series} height={150} strokeWidth={3} zeroBaseline={false} grid={0} marker={hover} formatValue={(v) => format.usd(v, { compact: true })} />
    </div>
  );
}
