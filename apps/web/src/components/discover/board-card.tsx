"use client";

import { ArrowDownRight, ArrowUpRight, Clock3 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "cn";

import { Tooltip } from "@/components/ui/tooltip";
import { TIME_ZONE } from "@/i18n/config";
import { TraderName } from "@/components/traders/trader-name";
import { useI18n } from "@/i18n/provider";
import { agoShort, boardPnl, boardRoi, roiPillShort, roiPillWhole } from "@/lib/board-format";
import type { BoardTrader } from "@/lib/contracts";
import { BoardSparkline, boardName, CoinStack, ScoreRing, signTone, TraderAvatar, VerifiedTick } from "./board-bits";

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
  const { t } = useI18n();
  const router = useRouter();
  const ago = agoShort(trader.lastTradeAt, now);
  return (
    <Link
      href={traderHref(trader.address)}
      className="orbit-card orbit-lift group flex min-w-0 flex-col gap-3 p-[18px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex min-h-[52px] min-w-0 items-center gap-2.5">
        <TraderAvatar trader={trader} size={44} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[0.9375rem] leading-5 font-extrabold">{boardName(trader)}</span>
            {trader.verified ? <VerifiedTick /> : null}
          </span>
          <CoinStack coins={trader.topCoins} size={16} />
          {tags}
        </div>
        {accessory}
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
        <span className={cn("num inline-flex h-7 min-w-0 items-center gap-1 truncate rounded-md px-2.5 text-[13px] font-extrabold", (trader.roi ?? 0) >= 0 ? "bg-tag-profit text-tag-profit-foreground" : "bg-tag-loss text-tag-loss-foreground")}>
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
            <span className="num flex shrink-0 items-center gap-1 text-xs font-bold text-muted-foreground">
              <Clock3 className="size-3" strokeWidth={2.4} aria-hidden />
              {ago}
            </span>
          </Tooltip>
        ) : null}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          router.push(`${traderHref(trader.address)}#copy-amount`);
        }}
        className="orbit-press mt-auto h-12 w-full rounded-full bg-primary font-display text-base text-primary-foreground outline-none hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
      >
        {t("discover.copy")}
      </button>
    </Link>
  );
}

export function BoardCardSkeleton() {
  return (
    <div aria-hidden="true" className="orbit-card ui-skeleton flex h-[330px] flex-col gap-4 p-[18px]">
      <div className="flex items-center gap-2.5"><div className="size-11 rounded-full bg-inset" /><div className="h-4 w-28 rounded-full bg-inset" /><div className="ml-auto size-[52px] rounded-full bg-inset" /></div>
      <div className="h-[72px] rounded-2xl bg-inset" />
      <div className="h-8 w-40 rounded-full bg-inset" />
      <div className="h-7 w-32 rounded-full bg-inset" />
      <div className="mt-auto h-12 rounded-full bg-inset" />
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
    <span title={t("home.cardRoi")} aria-label={`${t("home.cardRoi")}: ${roiPillShort(trader.roi)}`} className={cn("num inline-flex h-6 w-fit shrink-0 items-center gap-0.5 rounded-md px-2 text-xs font-extrabold", up ? "bg-tag-profit text-tag-profit-foreground" : "bg-tag-loss text-tag-loss-foreground")}>
      <Arrow className="size-[11px]" strokeWidth={2.8} aria-hidden />
      {roiPillShort(trader.roi)}
    </span>
  );
  return (
    <Link
      href={traderHref(trader.address)}
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
      </div>
      <BoardSparkline values={trader.sparkline} height={52} plain />
      <span className={cn("num block truncate font-display text-xl leading-7", signTone(trader.pnl))} title={t("home.cardPnl")}>
        {format.usd(trader.pnl, { compact: true, sign: true })}
      </span>
      {pill}
    </Link>
  );
}

/** CopyDog's hl-fcard--skel: one shimmering block the size of the card. */
export function HomeCardSkeleton() {
  return <div aria-hidden="true" className="ui-skeleton h-[176px] w-[164px] shrink-0 rounded-[24px] bg-raised md:w-[190px]" />;
}

/** Mobile list row (CopyDog's dense list): avatar, name, coins and score;
 * PnL and ROI pill on the right. */
export function BoardMobileRow({ trader }: { trader: BoardTrader }) {
  const { format } = useI18n();
  const up = (trader.roi ?? 0) >= 0;
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <li>
      <Link href={traderHref(trader.address)} className="orbit-card orbit-press flex items-center gap-3 rounded-[24px]! px-3.5 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <TraderAvatar trader={trader} size={44} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate text-[0.9375rem] font-extrabold">{boardName(trader)}</span>
            {trader.verified ? <VerifiedTick className="size-3.5" /> : null}
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

