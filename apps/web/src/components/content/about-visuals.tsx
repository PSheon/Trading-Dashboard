"use client";

import Link from "next/link";
import { cn } from "cn";

import { boardName, TraderAvatar } from "@/components/discover/board-bits";
import { CoinIcon } from "@/components/traders/coin-icon";
import type { BoardTrader } from "@/lib/contracts";
import { usdCompact } from "@/lib/format";
import { useHomeBoards } from "@/lib/queries";

/**
 * CopyDog's about-page pictures: a two-row marquee of the featured traders
 * under the hero, and small product mock-ups (its `about-mock` cards) in the
 * three steps and the feature rows. Names and avatars come from the home
 * page's featured traders; the figures inside the mock-ups are illustrative.
 */

function useFeatured(): BoardTrader[] {
  const home = useHomeBoards();
  return (home.data?.featured ?? []).filter((t) => t.avatarUrl);
}

/** One marquee row: the list twice over, scrolled endlessly (80s a lap). */
function MarqueeRow({ traders, reverse }: { traders: BoardTrader[]; reverse?: boolean }) {
  const row = (
    <div className="flex shrink-0 gap-10 pr-10">
      {traders.map((t) => (
        <Link key={t.address} href={`/trader/${t.address}`} className="flex items-center gap-4 outline-none focus-visible:ring-2 focus-visible:ring-ring" tabIndex={-1}>
          <TraderAvatar trader={t} size={64} className="rounded-2xl" />
          <span className="text-[26px] font-[650] tracking-[-0.2px] whitespace-nowrap">{boardName(t)}</span>
        </Link>
      ))}
    </div>
  );
  return (
    <div className="flex w-full overflow-hidden" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className={cn("about-marquee flex shrink-0", reverse && "[animation-direction:reverse]")}>
          {row}
        </div>
      ))}
    </div>
  );
}

export function KolMarquee() {
  const featured = useFeatured();
  if (featured.length < 4) return <div className="h-[148px]" aria-hidden />;
  const half = Math.ceil(featured.length / 2);
  return (
    <div className="flex w-full flex-col gap-5 overflow-hidden pb-[120px]">
      <MarqueeRow traders={featured.slice(0, half)} />
      <MarqueeRow traders={featured.slice(half)} reverse />
    </div>
  );
}

function Mock({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div aria-hidden className={cn("flex flex-col gap-0.5 rounded-[12px] bg-card p-3.5 text-left shadow-[inset_0_0_0_1px_var(--border-strong)] select-none", className)}>
      {children}
    </div>
  );
}

const K = "font-mono text-[10px] tracking-[0.6px] text-muted-foreground uppercase";

function Spark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={cn("block h-[62px] w-full", className)}>
      <path d="M0 27 L12 25 L22 26 L34 20 L46 21 L58 15 L70 16 L82 9 L92 8 L100 3 L100 30 L0 30 Z" className="fill-positive/15" />
      <path d="M0 27 L12 25 L22 26 L34 20 L46 21 L58 15 L70 16 L82 9 L92 8 L100 3" fill="none" className="stroke-positive" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const sample = (featured: BoardTrader[], i: number) => featured[i % Math.max(1, featured.length)];

/** 瀏覽排行榜: a coin's top traders. */
export function BoardMock() {
  const featured = useFeatured();
  return (
    <Mock>
      <div className="flex items-center gap-2.5 pb-3">
        <CoinIcon coin="BTC" size={26} />
        <span className="text-[17px] font-[650] tracking-[-0.2px]">BTC</span>
        <span className={cn(K, "ml-auto")}>Top traders</span>
      </div>
      {[0, 1, 2].map((i) => {
        const t = sample(featured, i);
        return (
          <div key={i} className="flex items-center gap-2.5 border-t border-border py-2.5">
            {t ? <TraderAvatar trader={t} size={32} /> : <span className="size-8 rounded-full bg-raised" />}
            <span className="min-w-0 truncate text-sm font-semibold">{t ? boardName(t) : "—"}</span>
            <span className="ml-auto shrink-0 text-sm font-[650] text-positive">{t && t.pnl !== null ? usdCompact(t.pnl, { sign: true }) : ["+$9.9M", "+$2.7M", "+$1.0M"][i]}</span>
          </div>
        );
      })}
    </Mock>
  );
}

/** 分析表現: a trader's headline figures and curve. */
export function ProfileMock() {
  const t = sample(useFeatured(), 0);
  return (
    <Mock>
      <div className="flex items-center gap-2.5 pb-3">
        {t ? <TraderAvatar trader={t} size={38} /> : <span className="size-[38px] rounded-full bg-raised" />}
        <span className="min-w-0 truncate text-[17px] font-[650] tracking-[-0.2px]">{t ? boardName(t) : "—"}</span>
        <span className="ml-auto shrink-0 rounded-full bg-primary/15 px-2 py-[3px] text-xs font-[650] text-primary">{t?.copyScore ?? 98}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-3.5 pt-1 pb-3.5">
        {[
          ["Perp PnL", t && t.pnl !== null ? usdCompact(t.pnl, { sign: true }) : "+$34.4M", true],
          ["ROI", "+246%", true],
          ["Win rate", "80%", false],
          ["Style", "Intraday", false],
        ].map(([k, v, pos]) => (
          <div key={String(k)} className="grid min-w-0 gap-[5px]">
            <span className={K}>{k}</span>
            <span className={cn("text-[17px] font-[650] tracking-[-0.3px] whitespace-nowrap", pos && "text-positive")}>{v}</span>
          </div>
        ))}
      </div>
      <Spark />
    </Mock>
  );
}

/** 一鍵跟單: the amount, quick picks and the button. */
export function CopyMock() {
  return (
    <Mock className="overflow-hidden p-0">
      <div className="flex items-baseline gap-2 px-4 pt-5 pb-3.5 text-[34px] leading-none font-[650] tracking-[-1px]">
        <span>250</span>
        <span className="text-muted-foreground">USDC</span>
      </div>
      <div className="grid grid-cols-4 gap-px border-t border-border bg-border text-center text-[13px] font-semibold">
        {["$100", "$250", "$500", "Max"].map((v) => (
          <span key={v} className={cn("py-2.5", v === "$250" ? "bg-raised text-foreground" : "bg-card text-muted-foreground")}>{v}</span>
        ))}
      </div>
      <div className="bg-primary py-[15px] text-center text-[15px] font-bold tracking-[-0.1px] text-primary-foreground">Copy Trade</div>
    </Mock>
  );
}

/** 投資組合: one copy's live curve and figures. */
export function PortfolioMock() {
  const t = sample(useFeatured(), 0);
  return (
    <Mock>
      <div className="flex items-center gap-2.5 pb-3">
        {t ? <TraderAvatar trader={t} size={26} /> : <span className="size-[26px] rounded-full bg-raised" />}
        <span className="min-w-0 truncate text-[15px] font-[650]">{t ? boardName(t) : "—"}</span>
        <span className={cn(K, "ml-auto inline-flex items-center gap-[5px] text-primary before:size-1.5 before:rounded-full before:bg-primary")}>Live</span>
      </div>
      <Spark className="h-[52px]" />
      <div className="grid grid-cols-3 gap-3 pt-3">
        {[
          ["Allocated", "$500", false],
          ["PnL", "+$182.40", true],
          ["ROI", "+36.5%", true],
        ].map(([k, v, pos]) => (
          <div key={String(k)} className="grid min-w-0 gap-[5px]">
            <span className={K}>{k}</span>
            <span className={cn("text-[15px] font-[650] whitespace-nowrap", pos && "text-positive")}>{v}</span>
          </div>
        ))}
      </div>
    </Mock>
  );
}

/** 提醒: three trade alerts. */
export function AlertsMock() {
  const featured = useFeatured();
  const lines: Array<[string, boolean, string, string]> = [
    ["BTC", true, "$1.2M", "2m"],
    ["HYPE", false, "$418K", "11m"],
    ["ETH", true, "$95K", "28m"],
  ];
  return (
    <Mock className="gap-0 px-3.5 py-1.5">
      {lines.map(([coin, long, size, ago], i) => {
        const t = sample(featured, i);
        return (
          <div key={i} className={cn("flex items-center gap-[11px] py-[13px]", i > 0 && "border-t border-border")}>
            {t ? <TraderAvatar trader={t} size={30} /> : <span className="size-[30px] rounded-full bg-raised" />}
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[13px] font-semibold">{t ? boardName(t) : "—"}</span>
                <span className={cn("shrink-0 font-mono text-[10px] tracking-[0.6px]", long ? "text-positive" : "text-negative")}>{long ? "LONG" : "SHORT"}</span>
                <CoinIcon coin={coin} size={14} />
                <span className="text-[13px] font-semibold">{coin}</span>
              </div>
              <p className="mt-[3px] text-xs text-muted-foreground">{size}</p>
            </div>
            <span className="ml-auto shrink-0 font-mono text-[10px] tracking-[0.4px] text-muted-foreground">{ago}</span>
          </div>
        );
      })}
    </Mock>
  );
}
