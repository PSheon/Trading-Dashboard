"use client";

import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronRight, Globe, Info, Trophy, UserRound } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { cn } from "cn";

import { Wordmark, OrbieMark } from "@/components/brand/logo";
import { AreaChart } from "@/components/charts/area-chart";
import { boardName, HScroll, TraderAvatar, VerifiedTick } from "@/components/discover/board-bits";
import { HomeCard, HomeCardSkeleton } from "@/components/discover/board-card";
import { ErrorState, Skeleton } from "@/components/page";
import { CoinIcon } from "@/components/traders/coin-icon";
import { Tooltip } from "@/components/ui/tooltip";
import { LOCALES } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";
import { boardCoinLabel, roiPillShort } from "@/lib/board-format";
import type { BoardTrader } from "@/lib/contracts";
import { useHomeBoards, useSiteSettings } from "@/lib/queries";
import { useChangeLocale } from "@/lib/use-change-locale";

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
  const { status, login } = useAuth();
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
    <div className="flex flex-col gap-9 md:gap-11">
      {/* Phones: CopyDog's compact title with the sign-in button. */}
      <section className="flex items-start justify-between gap-4 md:hidden">
        <h1 className="max-w-[9ch] text-[2rem] leading-[1.15] font-black tracking-tight">{t("home.heroTitleMobile")}</h1>
        {status === "signedOut" || status === "disabled" ? (
          <button
            type="button"
            onClick={login}
            disabled={status === "disabled"}
            title={status === "disabled" ? t("topbar.loginUnavailable") : undefined}
            className="mt-1 h-11 shrink-0 rounded-full bg-primary px-5 font-bold text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            {t("topbar.login")}
          </button>
        ) : null}
      </section>

      <section className="hidden items-center gap-10 md:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,500px)]">
        <div>
          <h1 className="max-w-[10ch] text-[3.6rem] leading-[1.08] font-black tracking-tight text-balance">{t("home.heroTitle")}</h1>
          <Link
            href="/explore"
            className="mt-8 inline-flex h-14 items-center rounded-full bg-raised px-7 text-base font-bold outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("home.heroBrowse")}
          </Link>
        </div>
        <div className="hidden lg:block">
          {home.data ? <Calculator traders={home.data.calculator} /> : <Skeleton className="h-[266px] rounded-3xl" />}
        </div>
      </section>

      <section>
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
                <Skeleton className="mb-3.5 h-7 w-40" />
                <div className="flex gap-3 overflow-hidden">
                  {Array.from({ length: 7 }, (_, j) => <HomeCardSkeleton key={j} />)}
                </div>
              </section>
            ))
          : null}

      <Footer />
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
        "flex shrink-0 snap-start flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-card text-[0.8125rem] font-semibold outline-none transition-colors hover:border-border-strong hover:bg-raised/60 focus-visible:ring-2 focus-visible:ring-ring",
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
        className="flex h-9 items-center justify-center rounded-full bg-raised text-sm font-semibold outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring max-md:w-9 md:px-4"
      >
        <span className="hidden md:inline">{t("home.seeAll")}</span>
        <ArrowRight className="size-4 md:hidden" />
      </Link>
    </div>
  );
}

/** CopyDog's calculator series: the sparkline rescaled from the amount to
 * the result (never below half the amount). */
function scaled(amount: number, roi: number, sparkline: number[]): Array<readonly [number, number]> {
  const result = amount * (1 + roi);
  if (sparkline.length < 3) return [];
  const first = sparkline[0];
  const span = sparkline[sparkline.length - 1] - first || 1;
  return sparkline.map((v, i) => [i, Math.max(amount * 0.5, amount + ((v - first) / span) * (result - amount))] as const);
}

/** "If you invested $1,000 … you would have today": six traders, all-time ROI. */
function Calculator({ traders }: { traders: BoardTrader[] }) {
  const { t } = useI18n();
  const [index, setIndex] = useState(0);
  const [amount, setAmount] = useState(1000);
  const [hover, setHover] = useState<number | null>(null);
  const trader = traders.length > 0 ? traders[index % traders.length] : null;
  const series = useMemo(() => (trader ? scaled(amount, trader.roi ?? 0, trader.sparkline) : []), [trader, amount]);
  if (!trader) return null;
  const result = amount * (1 + (trader.roi ?? 0));
  const shown = hover !== null && series[hover] ? series[hover][1] : result;
  const change = amount > 0 ? shown / amount - 1 : 0;
  const up = change >= 0;
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <section className="overflow-hidden rounded-3xl border border-border bg-card">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3.5">
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
              onClick={() => setIndex(i)}
              className={cn("h-1.5 rounded-full transition-all", i === index % traders.length ? "w-5 bg-foreground" : "w-1.5 bg-border-strong")}
            />
          ))}
        </div>
        <button
          type="button"
          aria-label={t("home.nextTrader")}
          onClick={() => setIndex((i) => (i + 1) % traders.length)}
          className="flex size-8 items-center justify-center rounded-full bg-raised outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
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
              onChange={(e) => setAmount(Math.min(1_000_000, Number(e.target.value.replace(/[^0-9]/g, "")) || 0))}
              className="num ml-1.5 w-full bg-transparent text-xl font-bold outline-none"
            />
          </div>
          <span className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
            {hover !== null ? t("home.youWouldHaveHad") : t("home.youWouldHave")}
            <Tooltip content={t("home.calculatorTip")}>
              <span tabIndex={0} className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("home.calculatorTip")}>
                <Info className="size-3.5" />
              </span>
            </Tooltip>
          </span>
          <div className="flex h-12 items-center rounded-2xl bg-positive-soft px-4" aria-live="polite">
            <span className="num truncate text-xl font-bold text-positive">${Math.round(shown).toLocaleString("en-US")}</span>
          </div>
        </div>
        <div className="relative min-h-[150px]" onMouseLeave={() => setHover(null)}>
          <span className={cn("num absolute top-0 left-0 z-10 inline-flex h-6 items-center gap-0.5 rounded-md px-1.5 text-xs font-bold", up ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative")}>
            <Arrow className="size-3" strokeWidth={2.5} aria-hidden />
            {roiPillShort(change)}
          </span>
          <HoverChart series={series} onHover={setHover} />
        </div>
      </div>
    </section>
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

/** CopyDog's footer: brand, tagline, language; 資源 and 社群 columns;
 * copyright and legal links. Pages Orbie doesn't have yet are shown as
 * "coming soon" rather than linking to a 404. */
function Footer() {
  const { t, locale } = useI18n();
  const changeLocale = useChangeLocale();
  const next = LOCALES.find((l) => l !== locale) ?? locale;
  const soon = (label: string) => (
    <span className="cursor-default text-subtle-foreground/70" title={t("home.footer.soon")}>
      {label}
    </span>
  );
  return (
    <footer className="mt-4 border-t border-border pt-8 pb-4 text-sm">
      <div className="grid gap-8 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col items-start gap-3">
          <span className="flex items-center gap-2 text-foreground">
            <OrbieMark size={28} />
            <Wordmark className="text-2xl" />
          </span>
          <p className="text-muted-foreground">{t("home.footer.tagline")}</p>
          <button
            type="button"
            onClick={() => changeLocale(next)}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-raised px-3.5 text-[0.8125rem] font-semibold outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Globe className="size-4" />
            {t(`locales.${locale}`)}
          </button>
        </div>
        <nav aria-label={t("home.footer.resources")} className="flex flex-col gap-2.5">
          <span className="font-semibold">{t("home.footer.resources")}</span>
          <Link href="/methodology" className="text-muted-foreground hover:text-foreground">{t("home.footer.about")}</Link>
          <Link href="/insights" className="text-muted-foreground hover:text-foreground">{t("home.footer.live")}</Link>
          {soon(t("home.footer.faq"))}
        </nav>
        <nav aria-label={t("home.footer.community")} className="flex flex-col gap-2.5">
          <span className="font-semibold">{t("home.footer.community")}</span>
          {soon(t("home.footer.x"))}
          <a href="https://t.me/orbie_fun_bot" target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
            {t("home.footer.telegram")}
          </a>
          {soon(t("home.footer.email"))}
          {soon(t("home.footer.tgIntel"))}
        </nav>
      </div>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-xs text-subtle-foreground">
        <span>{t("home.footer.rights")}</span>
        <span className="flex gap-4">
          {soon(t("home.footer.privacy"))}
          {soon(t("home.footer.terms"))}
        </span>
      </div>
    </footer>
  );
}
