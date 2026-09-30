"use client";

import { ArrowDownRight, ArrowUpRight, Clock3 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "cn";

import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/provider";
import { agoShort, boardPnl, boardRoi, roiPillShort, roiPillWhole } from "@/lib/board-format";
import type { BoardTrader } from "@/lib/contracts";
import { BoardSparkline, boardName, CoinStack, CopyScoreBar, signTone, TraderAvatar, VerifiedTick } from "./board-bits";

const traderHref = (address: string) => `/trader/${address}`;

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
  const { t, format } = useI18n();
  const router = useRouter();
  const ago = agoShort(trader.lastTradeAt, now);
  return (
    <Link
      href={traderHref(trader.address)}
      className="ui-lift group flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card p-4 outline-none transition-colors hover:border-border-strong hover:bg-raised/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <TraderAvatar trader={trader} size={40} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1">
            <span className={cn("truncate text-[0.875rem] font-semibold", !trader.displayName && "font-mono")}>{boardName(trader)}</span>
            {trader.verified ? <VerifiedTick /> : null}
          </span>
          <CoinStack coins={trader.topCoins} />
          {tags}
        </div>
        {ago ? (
          <span
            className="num flex shrink-0 items-center gap-1 text-[0.6875rem] font-medium tracking-wide text-subtle-foreground uppercase"
            title={`${t("discover.lastTrade")} · ${trader.lastTradeAt ? format.dateTime(trader.lastTradeAt) : ""}`}
          >
            <Clock3 className="size-3" aria-hidden />
            {ago}
          </span>
        ) : null}
        {accessory}
      </div>
      <div className="flex min-w-0 items-end gap-3">
        <div className="flex min-w-0 shrink-0 flex-col gap-3">
          <div>
            <div className={cn("num text-lg leading-tight font-bold", signTone(trader.pnl))}>{boardPnl(trader.pnl)}</div>
            <div className="text-[0.6875rem] text-subtle-foreground">{pnlLabel}</div>
          </div>
          <div>
            <div className={cn("num text-base leading-tight font-bold", signTone(trader.roi))}>{boardRoi(trader.roi)}</div>
            {roiHint ? (
              <Tooltip content={roiHint}>
                <span tabIndex={0} className="cursor-help text-[0.6875rem] text-subtle-foreground underline decoration-dotted underline-offset-2 outline-none">
                  {roiLabel}
                </span>
              </Tooltip>
            ) : (
              <div className="text-[0.6875rem] text-subtle-foreground">{roiLabel}</div>
            )}
          </div>
        </div>
        <BoardSparkline values={trader.sparkline} height={82} className="min-w-0 flex-1" />
      </div>
      <div className="flex items-center justify-between gap-2">
        <CopyScoreBar score={trader.copyScore} />
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            router.push(`${traderHref(trader.address)}#copy-amount`);
          }}
          className="h-8 rounded-full bg-primary px-3.5 text-[0.8125rem] font-bold text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("discover.copy")}
        </button>
      </div>
    </Link>
  );
}

export function BoardCardSkeleton() {
  return (
    <div aria-hidden="true" className="ui-skeleton flex h-[226px] flex-col gap-4 rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-2.5"><div className="size-10 rounded-full bg-raised" /><div className="h-3 w-24 rounded bg-raised" /></div>
      <div className="flex flex-1 items-end gap-4"><div className="h-16 w-16 rounded-lg bg-raised" /><div className="h-20 flex-1 rounded-lg bg-raised/60" /></div>
      <div className="flex justify-between"><div className="h-5 w-20 rounded bg-raised" /><div className="h-8 w-16 rounded-full bg-raised" /></div>
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
    <span title={t("home.cardRoi")} aria-label={`${t("home.cardRoi")}: ${roiPillShort(trader.roi)}`} className={cn("num inline-flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-[0.6875rem] font-bold", up ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative")}>
      <Arrow className="size-3" strokeWidth={2.5} aria-hidden />
      {roiPillShort(trader.roi)}
    </span>
  );
  return (
    <Link
      href={traderHref(trader.address)}
      className="ui-lift flex w-[148px] shrink-0 snap-start flex-col gap-2 rounded-2xl border border-border bg-card p-2.5 outline-none transition-colors hover:border-border-strong hover:bg-raised/60 focus-visible:ring-2 focus-visible:ring-ring md:w-[190px] md:gap-3 md:p-3.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        <TraderAvatar trader={trader} size={32} />
        <span className="ml-auto md:hidden">{pill}</span>
        <span className="hidden min-w-0 items-center gap-1 md:flex">
          <span className={cn("truncate text-[0.8125rem] font-semibold", !trader.displayName && "font-mono")}>{boardName(trader)}</span>
          {trader.verified ? <VerifiedTick className="size-3.5" /> : null}
        </span>
      </div>
      <span className="flex min-w-0 items-center gap-1 md:hidden">
        <span className={cn("truncate text-[0.8125rem] font-semibold", !trader.displayName && "font-mono")}>{boardName(trader)}</span>
        {trader.verified ? <VerifiedTick className="size-3.5" /> : null}
      </span>
      <BoardSparkline values={trader.sparkline} height={64} className="md:hidden" />
      <BoardSparkline values={trader.sparkline} height={78} className="hidden md:block" />
      <div className="flex items-end justify-between gap-1.5">
        <div className="min-w-0">
          <span className="mb-0.5 block text-[0.6875rem] text-muted-foreground">{t("home.cardPnl")}</span>
        <span className={cn("num block truncate text-[0.9375rem] font-bold md:text-base", signTone(trader.pnl))}>
          {format.usd(trader.pnl, { compact: true, sign: true })}
        </span>
        </div>
        <span className="hidden flex-col items-end gap-0.5 md:inline-flex"><span className="text-[0.6875rem] text-muted-foreground">{t("home.cardRoi")}</span>{pill}</span>
      </div>
    </Link>
  );
}

export function HomeCardSkeleton() {
  return (
    <div aria-hidden="true" className="ui-skeleton flex w-[148px] shrink-0 flex-col gap-2 rounded-2xl border border-border bg-card p-2.5 md:w-[190px] md:gap-3 md:p-3.5">
      <div className="flex h-8 items-center gap-2"><div className="size-8 shrink-0 rounded-full bg-raised" /><div className="h-3 flex-1 rounded bg-raised" /></div>
      <div className="h-[19.5px] w-24 rounded bg-raised md:hidden" />
      <div className="h-16 rounded-lg bg-raised/60 md:h-[78px]" />
      <div className="flex h-[42px] items-end justify-between gap-2"><div className="flex flex-col gap-2"><div className="h-2.5 w-8 rounded bg-raised" /><div className="h-5 w-20 rounded bg-raised" /></div><div className="hidden h-6 w-12 rounded bg-raised md:block" /></div>
    </div>
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
      <Link href={traderHref(trader.address)} className="flex items-center gap-3 rounded-xl py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <TraderAvatar trader={trader} size={44} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="flex min-w-0 items-center gap-1">
            <span className={cn("truncate text-[0.9375rem] font-semibold", !trader.displayName && "font-mono")}>{boardName(trader)}</span>
            {trader.verified ? <VerifiedTick className="size-3.5" /> : null}
          </span>
          <span className="flex items-center gap-2">
            <CoinStack coins={trader.topCoins.slice(0, 3)} size={14} />
            <CopyScoreBar score={trader.copyScore} layout="bar-first" barClassName="w-11" />
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span className={cn("num text-[0.9375rem] font-bold", signTone(trader.pnl))}>{format.usd(trader.pnl, { compact: true, sign: true })}</span>
          <span className={cn("num inline-flex h-6 items-center gap-0.5 rounded-md px-1.5 text-[0.6875rem] font-bold", up ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative")}>
            <Arrow className="size-3" strokeWidth={2.5} aria-hidden />
            {roiPillWhole(trader.roi)}
          </span>
        </div>
      </Link>
    </li>
  );
}

