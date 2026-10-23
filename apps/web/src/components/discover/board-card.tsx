"use client";

import { ArrowDownRight, ArrowUpRight, Clock3, TriangleAlert } from "lucide-react";
import { Link, useRouter } from "@/i18n/navigation";
import { cn } from "cn";

import { SkelBar, SkelCircle } from "@/components/page";
import { InfoTip } from "@/components/ui/info-tip";
import { Tooltip } from "@/components/ui/tooltip";
import { TIME_ZONE } from "@/i18n/config";
import { TraderName } from "@/components/traders/trader-name";
import { useI18n } from "@/i18n/provider";
import { boardPnl, boardRoi, roiPillShort, roiPillWhole } from "@/lib/board-format";
import type { BoardTrader } from "@/lib/contracts";
import { BoardSparkline, boardName, CoinStack, ScoreRing, signTone, TraderAvatar, VerifiedTick } from "./board-bits";
import { timeAgo } from "@/lib/format";
import { useNow } from "@/lib/use-now";

const traderHref = (address: string) => `/trader/${address}`;

/** CopyDog's last-trade chip reads "Oct 1, 01:44" in every language. */
function lastTradeStamp(at: string): string {
  return new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: TIME_ZONE });
}

/** Explore grid card (CopyDog's hl-card): identity and coins, last trade,
 * PnL and ROI beside the sparkline, copy score and 跟單. */
export function BoardCard({ trader, pnlLabel, roiLabel, roiHint, now, accessory, tags }: {
  trader: BoardTrader;
  pnlLabel: string;
  roiLabel: string;
  /** Coin boards explain their ROI (PnL ÷ notional traded). */
  roiHint?: string;
  now: number;
  /** Top-right, after the last-trade time (favorites: the star). */
  accessory?: React.ReactNode;
  /** Under the coins (favorites: group tags). */
  tags?: React.ReactNode;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const ago = timeAgo(trader.lastTradeAt, now, locale);
  // The card is not a link: its name is, stretched over the card by its
  // `::after` (so a click anywhere opens the trader and the link's name is
  // the trader's). Everything that reacts on its own (跟單, the stale tip,
  // the tooltips, an accessory) sits above the stretch on `relative z-10`.
  return (
    <article className="orbit-card orbit-lift group relative flex min-w-0 flex-col gap-3 p-[18px] has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring">
      <div className="flex min-h-[52px] min-w-0 items-center gap-2.5">
        <TraderAvatar trader={trader} size={44} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <Link
              href={traderHref(trader.address)}
              prefetch={false}
              className="truncate text-[0.9375rem] leading-5 font-extrabold outline-none after:absolute after:inset-0 after:z-0 after:content-['']"
            >
              {boardName(trader)}
            </Link>
            {trader.verified ? <VerifiedTick /> : null}
            <MetricsStamp at={trader.metricsUpdatedAt} now={now} className="relative z-10" />
          </span>
          <CoinStack coins={trader.topCoins} size={16} className="relative z-10 w-fit" />
          {tags}
        </div>
        {accessory ? <span className="relative z-10 flex shrink-0">{accessory}</span> : null}
        <ScoreRing score={trader.copyScore} />
      </div>
      <BoardSparkline values={trader.sparkline} height={72} plain />
      <div className="flex min-w-0 items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-bold text-muted-foreground">{pnlLabel}</div>
          <div className={cn("num truncate font-display text-[1.625rem] leading-[1.1]", signTone(trader.pnl))}>{boardPnl(trader.pnl)}</div>
        </div>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className={cn("num chip-md relative z-10 min-w-0 gap-1 truncate", (trader.roi ?? 0) >= 0 ? "bg-tag-profit text-tag-profit-foreground" : "bg-tag-loss text-tag-loss-foreground")}>
          {roiHint ? (
            <Tooltip content={roiHint}>
              <span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-2 outline-none">{roiLabel}</span>
            </Tooltip>
          ) : (
            <span>{roiLabel}</span>
          )}
          {boardRoi(trader.roi)}
        </span>
        {ago ? (
          <Tooltip variant="chip" side="top" content={`${t("discover.lastTrade")} · ${trader.lastTradeAt ? lastTradeStamp(trader.lastTradeAt) : ""}`}>
            <span className="num relative z-10 flex shrink-0 items-center gap-1 text-xs font-bold text-muted-foreground">
              <Clock3 className="size-3" strokeWidth={2.4} aria-hidden />
              {ago}
            </span>
          </Tooltip>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => router.push(`${traderHref(trader.address)}#copy-amount`)}
        className="orbit-press relative z-10 mt-auto h-11 w-full rounded-full bg-primary text-[15px] font-extrabold text-primary-foreground outline-none hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
      >
        {t("discover.copy")}
      </button>
    </article>
  );
}

/** BoardCard while the board loads: the same card, paddings and rows
 * (avatar and name, sparkline, PnL, ROI tag, 跟單), each as a bar or a
 * circle, so the cards swap in without moving. */
export function BoardCardSkeleton() {
  return (
    <div aria-hidden="true" className="orbit-card ui-skeleton flex min-w-0 flex-col gap-3 p-[18px]">
      <div className="flex min-h-[52px] items-center gap-2.5">
        <SkelCircle className="size-11" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <SkelBar line="h-5" className="h-3.5 w-28" />
          <SkelBar className="h-4 w-10" />
        </span>
        <SkelCircle className="size-[52px]" />
      </div>
      <span className="block h-[72px] rounded-2xl bg-inset" />
      <span className="flex flex-col">
        <SkelBar line="h-4" className="h-2.5 w-10" />
        <SkelBar line="h-[1.79rem]" className="h-6 w-40" />
      </span>
      <span className="flex items-center justify-between gap-2">
        <SkelBar className="h-[30px] w-32 rounded-2xl" />
        <SkelBar className="h-2.5 w-12" />
      </span>
      <span className="mt-auto block h-11 rounded-full bg-inset" />
    </div>
  );
}

/** Home carousel card (CopyDog's hl-fcard): avatar, name, sparkline, PnL
 * and ROI pill; compact on phones (ROI pill on top). */
export function HomeCard({ trader }: { trader: BoardTrader }) {
  const { t, format } = useI18n();
  const up = (trader.roi ?? 0) >= 0;
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  const pill = (
    <span title={t("home.cardRoi")} aria-label={`${t("home.cardRoi")}: ${roiPillShort(trader.roi)}`} className={cn("num chip-sm w-fit shrink-0 gap-0.5", up ? "bg-tag-profit text-tag-profit-foreground" : "bg-tag-loss text-tag-loss-foreground")}>
      <Arrow className="size-[11px]" strokeWidth={2.8} aria-hidden />
      {roiPillShort(trader.roi)}
    </span>
  );
  return (
    <Link
      href={traderHref(trader.address)}
      prefetch={false}
      className="orbit-card orbit-lift flex w-[164px] shrink-0 snap-start flex-col gap-2 rounded-[24px]! p-3.5 outline-none focus-visible:ring-2 focus-visible:ring-ring md:w-[190px]"
    >
      <div className="flex min-w-0 items-center gap-2">
        <TraderAvatar trader={trader} size={32} />
        <span className="hidden min-w-0 items-center gap-1 md:flex">
          <span className="truncate text-sm font-extrabold">{boardName(trader)}</span>
          {trader.verified ? <VerifiedTick className="size-[14px]" /> : null}
        </span>
        {/* A phone card is narrow: TraderName cuts an address once, in the
            middle, and always shows its end ("0x9871…0…" never). */}
        <span className="flex min-w-0 items-center gap-1 md:hidden">
          <TraderName trader={trader} className="text-sm font-extrabold" />
          {trader.verified ? <VerifiedTick className="size-[13px]" /> : null}
        </span>
        <MetricsStamp at={trader.metricsUpdatedAt} className="ml-auto" />
      </div>
      <BoardSparkline values={trader.sparkline} height={52} plain />
      <span className={cn("num block truncate font-display text-xl leading-7", signTone(trader.pnl))} title={t("home.cardPnl")}>
        {format.usd(trader.pnl, { compact: true, sign: true })}
      </span>
      {pill}
    </Link>
  );
}

/** HomeCard while the rows load: the same card (avatar and name,
 * sparkline, PnL line, ROI pill) as bars and a circle. */
export function HomeCardSkeleton() {
  return (
    <div aria-hidden="true" className="orbit-card ui-skeleton flex w-[164px] shrink-0 flex-col gap-2 rounded-[24px]! p-3.5 md:w-[190px]">
      <div className="flex items-center gap-2">
        <SkelCircle className="size-8" />
        <SkelBar className="h-3 w-20" />
      </div>
      <span className="block h-[52px] rounded-xl bg-inset" />
      <SkelBar line="h-7" className="h-5 w-24" />
      <SkelBar className="h-[22px] w-14 rounded-xl" />
    </div>
  );
}

/** BoardMobileRow while the board loads. */
export function BoardMobileRowSkeleton() {
  return (
    <li aria-hidden="true" className="orbit-card ui-skeleton flex items-center gap-3 rounded-[24px]! px-3.5 py-3">
      <SkelCircle className="size-11" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <SkelBar line="h-[22px]" className="h-3.5 w-28" />
        <SkelBar className="h-3.5 w-12" />
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <SkelBar line="h-5" className="h-3.5 w-16" />
        <SkelBar line="h-5" className="h-2.5 w-10" />
      </span>
      <SkelCircle className="size-10" />
    </li>
  );
}

/** Mobile list row (CopyDog's dense list): avatar, name, coins and score;
 * PnL and ROI pill on the right. */
export function BoardMobileRow({ trader }: { trader: BoardTrader }) {
  const { format } = useI18n();
  const up = (trader.roi ?? 0) >= 0;
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <li>
      <Link href={traderHref(trader.address)} prefetch={false} className="orbit-card orbit-press flex items-center gap-3 rounded-[24px]! px-3.5 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <TraderAvatar trader={trader} size={44} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate text-[0.9375rem] font-extrabold">{boardName(trader)}</span>
            {trader.verified ? <VerifiedTick className="size-3.5" /> : null}
            <MetricsStamp at={trader.metricsUpdatedAt} />
          </span>
          <CoinStack coins={trader.topCoins.slice(0, 3)} size={14} />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={cn("num font-display text-[1.0625rem] leading-5", signTone(trader.pnl))}>{format.usd(trader.pnl, { compact: true, sign: true })}</span>
          <span className={cn("num inline-flex h-5 items-center gap-0.5 text-xs font-extrabold", up ? "text-positive" : "text-negative")}>
            <Arrow className="size-3" strokeWidth={2.8} aria-hidden />
            {roiPillWhole(trader.roi)}
          </span>
        </div>
        <ScoreRing score={trader.copyScore} size={40} />
      </Link>
    </li>
  );
}


/** Nothing while the metrics are fresh: an update time helps no one choosing
 * a trader, an outdated one does. Past 24 h, a small warning triangle (not a
 * clock: the clock beside "29 天前" is the last trade) whose tip gives
 * the time (UTC). Age refers to the metrics read, never the browser's most
 * recent fetch; nothing until the clock is known (server render, hydration). */
export function MetricsStamp({ at, now, className }: { at?: string | null; now?: number; className?: string }) {
  const { t, format } = useI18n();
  const ticking = useNow(), clock = now ?? ticking;
  if (!at || clock <= 0 || clock - Date.parse(at) < 24 * 60 * 60 * 1000) return null;
  return (
    <InfoTip label={t("discover.metricsStale")} icon={TriangleAlert} className={cn("text-tag-alert-foreground hover:text-tag-alert-foreground data-[state=open]:text-tag-alert-foreground", className)}>
      <span className="block">{t("discover.metricsStale")}</span>
      {t("discover.metricsUpdated")} · <time dateTime={at}>{format.dateTime(at)} (UTC)</time>
    </InfoTip>
  );
}
