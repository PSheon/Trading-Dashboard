"use client";

import { BadgeCheck, ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "cn";

import { AreaChart } from "@/components/charts/area-chart";
import { AddressAvatar } from "@/components/traders/address-avatar";
import { CoinIcon } from "@/components/traders/coin-icon";
import { useI18n } from "@/i18n/provider";
import type { BoardTrader } from "@/lib/contracts";
import { apiAssetUrl } from "@/lib/api";
import { Tooltip } from "@/components/ui/tooltip";
import { coinLabel, truncateAddress } from "@/lib/format";

/** A KOL's picture (the api's cached copy of its 𝕏 avatar), else — and
 * when the image fails — the generated planet avatar. */
export function TraderAvatar({ trader, size, className }: { trader: Pick<BoardTrader, "address" | "avatarUrl">; size: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!trader.avatarUrl || failed) return <AddressAvatar seed={trader.address} size={size} className={className} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- the api serves the bytes with a month-long versioned cache; next/image would re-encode them
    <img
      src={apiAssetUrl(trader.avatarUrl)}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn("shrink-0 rounded-full bg-raised object-cover", className)}
      style={{ width: size, height: size }}
    />
  );
}

/** The card's name: KOL / leaderboard name, else the short address. */
export function boardName(trader: Pick<BoardTrader, "displayName" | "address">): string {
  return trader.displayName?.trim() || truncateAddress(trader.address);
}

export function VerifiedTick({ className }: { className?: string }) {
  const { t } = useI18n();
  return <BadgeCheck aria-label={t("discover.verified")} className={cn("size-4 shrink-0 fill-sky-500 text-background", className)} />;
}

/** A KOL's 𝕏 profile link (CopyDog's small 𝕏 after the name). */
export function XProfileLink({ handle, className }: { handle: string; className?: string }) {
  return (
    <a
      href={`https://x.com/${encodeURIComponent(handle)}`}
      target="_blank"
      rel="noopener noreferrer"
      title={`@${handle}`}
      aria-label={`X @${handle}`}
      className={cn("shrink-0 rounded text-xs leading-none text-subtle-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", className)}
    >
      𝕏
    </a>
  );
}

/** Up to five coin icons, overlapping (CopyDog's asset stack). */
/** `dash`: show "—" when there are no coins (tables); cards show nothing. */
export function CoinStack({ coins, size = 14, className, dash = false }: { coins: string[]; size?: number; className?: string; dash?: boolean }) {
  if (coins.length === 0) return dash ? <span className="text-subtle-foreground">—</span> : null;
  return (
    <span className={cn("inline-flex items-center", className)} aria-label={coins.join(", ")}>
      {coins.slice(0, 5).map((coin, i) => (
        <Tooltip key={coin} content={coinLabel(coin)} side="top" variant="chip">
          <span className="rounded-full ring-2 ring-card" style={{ marginLeft: i === 0 ? 0 : -size * 0.28, zIndex: 5 - i }}>
            <CoinIcon coin={coin} size={size} />
          </span>
        </Tooltip>
      ))}
    </span>
  );
}

/** Green up, red down, plain at zero / unknown. */
export function signTone(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return "text-foreground";
  return value > 0 ? "text-positive" : "text-negative";
}

/** CopyDog's score colours: ≥ 80 high, ≥ 50 middling, below that low. */
export function scoreTone(score: number | null): string {
  if (score === null) return "bg-border-strong";
  return score >= 80 ? "bg-positive" : score >= 50 ? "bg-warning" : "bg-negative";
}

/** "98/100" and a bar (or just the bar with the number after it). */
export function CopyScoreBar({
  score,
  layout = "value-first",
  barClassName,
  className,
}: {
  score: number | null;
  /** "value-first": "85/100 ▬"; "number-first": "85 ▬" (CopyDog's
   * cohort table); "bar-first": "▬ 85"; "bar-only". */
  layout?: "value-first" | "number-first" | "bar-first" | "bar-only";
  barClassName?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const value = score === null ? null : Math.max(0, Math.min(100, Math.round(score)));
  const bar = (
    <span className={cn("relative h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-raised-hover", barClassName)} aria-hidden>
      <span className={cn("absolute inset-y-0 left-0 rounded-full", scoreTone(value))} style={{ width: `${value ?? 0}%` }} />
    </span>
  );
  const label = t("discover.copyScoreOf", { score: value === null ? "—" : String(value) });
  if (layout === "bar-only") return <span className={className} title={label}>{bar}</span>;
  return (
    <span className={cn("inline-flex items-center gap-2", className)} title={label}>
      {layout === "bar-first" ? bar : null}
      <span className="num text-[0.8125rem] font-semibold">
        {value ?? "—"}
        {layout === "value-first" ? <span className="text-subtle-foreground">/100</span> : null}
      </span>
      {layout === "value-first" || layout === "number-first" ? bar : null}
    </span>
  );
}

/** A board sparkline (values only): Orbie's area chart with its end dot. */
export function BoardSparkline({ values, height, className }: { values: number[]; height: number; className?: string }) {
  const { format } = useI18n();
  const data = values.map((v, i) => [i, v] as const);
  if (data.length < 2) return <div className={cn("rounded-xl bg-raised-hover/40", className)} style={{ height }} />;
  return (
    <div className={className} style={{ height }}>
      <AreaChart data={data} height={height} strokeWidth={1.75} grid={4} formatValue={(v) => format.usd(v, { compact: true })} />
    </div>
  );
}

/** A horizontal row that scrolls, with CopyDog's left / right arrows. */
export function HScroll({ children, className, label }: { children: React.ReactNode; className?: string; label: string }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setAtStart(el.scrollLeft <= 1);
    setAtEnd(el.scrollLeft >= el.scrollWidth - el.clientWidth - 1);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [measure]);
  const scroll = (dir: number) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  // CopyDog's arrows sit on the row's edges and show only while the row is
  // hovered or focused (never on touch screens).
  const arrow = "absolute top-1/2 z-10 hidden size-[38px] -translate-y-1/2 items-center justify-center rounded-full border border-border-strong bg-popover text-foreground opacity-0 shadow-lg shadow-black/40 outline-none transition-opacity group-hover/hscroll:opacity-100 group-focus-within/hscroll:opacity-100 hover:bg-raised-hover focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring md:pointer-fine:flex";
  return (
    <div className="group/hscroll relative">
      {!atStart ? (
        <button type="button" aria-label={t("discover.scrollLeft")} className={cn(arrow, "left-0 -translate-x-1/2")} onClick={() => scroll(-1)}>
          <ChevronLeft className="size-[22px]" />
        </button>
      ) : null}
      <div ref={ref} role="group" aria-label={label} className={cn("-mx-5 flex snap-x scroll-px-5 gap-3 overflow-x-auto px-5 py-1 no-scrollbar md:mx-0 md:scroll-px-0 md:px-0", className)}>
        {children}
      </div>
      {!atEnd ? (
        <button type="button" aria-label={t("discover.scrollRight")} className={cn(arrow, "right-0 translate-x-1/2")} onClick={() => scroll(1)}>
          <ChevronRight className="size-[22px]" />
        </button>
      ) : null}
    </div>
  );
}
