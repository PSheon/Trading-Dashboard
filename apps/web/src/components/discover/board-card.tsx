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
import { BoardSparkline, boardName, CoinStack, CopyScoreBar, signTone, TraderAvatar, VerifiedTick } from "./board-bits";

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
      className="group flex min-w-0 flex-col gap-3 rounded-xl border border-raised bg-tile px-4 py-3 outline-none transition-colors hover:border-border-strong hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex min-h-10 min-w-0 items-start gap-2.5">
        <TraderAvatar trader={trader} size={40} />
        {/* CopyDog's .hl-card__id: the name (14/21), 2px, the 14px coins. */}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate text-[0.875rem] leading-[21px] font-bold tracking-[-0.14px]">{boardName(trader)}</span>
            {trader.verified ? <VerifiedTick /> : null}
          </span>
          <CoinStack coins={trader.topCoins} />
          {tags}
        </div>
        {ago ? (
          <Tooltip variant="chip" side="top" content={`${t("discover.lastTrade")} · ${trader.lastTradeAt ? lastTradeStamp(trader.lastTradeAt) : ""}`}>
            <span className="num flex shrink-0 items-center gap-1 text-[0.6875rem] leading-[16.5px] tracking-[0.3px] text-subtle-foreground uppercase">
              <Clock3 className="size-[11px]" strokeWidth={2.2} aria-hidden />
              {ago}
            </span>
          </Tooltip>
        ) : null}
        {accessory}
      </div>
      <div className="flex min-w-0 items-center gap-3.5">
        <div className="flex w-[130px] min-w-0 shrink-0 flex-col gap-3.5">
          <div>
            {/* CopyDog prints the card's PnL in white and colours only the ROI. */}
            <div className="num text-[1.0625rem] leading-[1.1] font-extrabold text-foreground">{boardPnl(trader.pnl)}</div>
            <div className="mt-0.5 text-[0.6875rem] leading-[16.5px] tracking-[0.4px] text-subtle-foreground">{pnlLabel}</div>
          </div>
          <div>
            <div className={cn("num text-[1.0625rem] leading-[1.1] font-bold", signTone(trader.roi))}>{boardRoi(trader.roi)}</div>
            {roiHint ? (
              <Tooltip content={roiHint}>
                <span tabIndex={0} className="mt-0.5 block cursor-help text-[0.6875rem] leading-[16.5px] tracking-[0.4px] text-subtle-foreground underline decoration-dotted underline-offset-2 outline-none">
                  {roiLabel}
                </span>
              </Tooltip>
            ) : (
              <div className="mt-0.5 text-[0.6875rem] leading-[16.5px] tracking-[0.4px] text-subtle-foreground">{roiLabel}</div>
            )}
          </div>
        </div>
        <BoardSparkline values={trader.sparkline} height={90} className="min-w-0 flex-1" />
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
          className="h-[34px] rounded-full bg-primary px-[11px] text-[0.8125rem] font-semibold text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("discover.copy")}
        </button>
      </div>
    </Link>
  );
}

export function BoardCardSkeleton() {
  return (
    <div aria-hidden="true" className="ui-skeleton flex h-[214px] flex-col gap-4 rounded-xl border border-raised bg-tile px-4 py-3">
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
    <span title={t("home.cardRoi")} aria-label={`${t("home.cardRoi")}: ${roiPillShort(trader.roi)}`} className={cn("num inline-flex h-[26px] shrink-0 items-center gap-0.5 rounded-md px-1 text-xs font-semibold md:h-6 md:px-1.5", up ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative")}>
      <Arrow className="size-[9px] md:size-[11px]" strokeWidth={2.5} aria-hidden />
      {roiPillShort(trader.roi)}
    </span>
  );
  return (
    <Link
      href={traderHref(trader.address)}
      className="flex w-[116px] shrink-0 snap-start flex-col gap-2 rounded-xl border border-transparent bg-tile p-[7px] outline-none transition-colors hover:border-border-strong hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring md:w-[190px] md:gap-[11px] md:p-[13px]"
    >
      <div className="flex min-w-0 items-center gap-2">
        <TraderAvatar trader={trader} size={32} />
        <span className="ml-auto md:hidden">{pill}</span>
        <span className="hidden min-w-0 items-center gap-1 md:flex">
          <span className="truncate text-sm font-semibold">{boardName(trader)}</span>
          {trader.verified ? <VerifiedTick className="size-[13px]" /> : null}
        </span>
      </div>
      <span className="flex min-w-0 items-center gap-1 md:hidden">
        {/* A phone card is 116px wide: a short address does not fit, and
            cutting it again read "0x9871…0…". TraderName cuts an address
            once, in the middle, and always shows its end. */}
        <TraderName trader={trader} className="text-base font-semibold" />
        {trader.verified ? <VerifiedTick className="size-[11px]" /> : null}
      </span>
      <BoardSparkline values={trader.sparkline} height={26} className="md:hidden" plain />
      <BoardSparkline values={trader.sparkline} height={74} className="hidden md:block" />
      <div className="flex items-center justify-between gap-1.5">
        <span className={cn("num block truncate text-base leading-[26px] font-bold md:leading-6", signTone(trader.pnl))} title={t("home.cardPnl")}>
          {format.usd(trader.pnl, { compact: true, sign: true })}
        </span>
        <span className="hidden md:inline-flex">{pill}</span>
      </div>
    </Link>
  );
}

/** CopyDog's hl-fcard--skel: one shimmering block the size of the card. */
export function HomeCardSkeleton() {
  return <div aria-hidden="true" className="ui-skeleton h-[148px] w-[116px] shrink-0 rounded-xl bg-tile md:h-[180px] md:w-[190px]" />;
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
            <span className="truncate text-[0.9375rem] font-semibold">{boardName(trader)}</span>
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

