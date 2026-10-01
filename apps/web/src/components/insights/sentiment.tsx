"use client";

import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { cn } from "cn";

import { useI18n } from "@/i18n/provider";

export type SentimentKey = "veryBullish" | "bullish" | "slightlyBullish" | "neutral" | "slightlyBearish" | "bearish" | "veryBearish";

/** CopyDog's 7-step bias from a long share (0–100): within 5 points of 50
 * neutral, then slightly (< 15), plain (< 30) and very. */
export function sentiment(pctLong: number | null | undefined): { key: SentimentKey; dir: -1 | 0 | 1 } {
  if (pctLong === null || pctLong === undefined || Number.isNaN(pctLong)) return { key: "neutral", dir: 0 };
  const d = pctLong - 50;
  const a = Math.abs(d);
  if (a < 5) return { key: "neutral", dir: 0 };
  const dir = d > 0 ? 1 : -1;
  const level = a < 15 ? "slightly" : a < 30 ? "plain" : "very";
  if (dir > 0) return { key: level === "slightly" ? "slightlyBullish" : level === "very" ? "veryBullish" : "bullish", dir };
  return { key: level === "slightly" ? "slightlyBearish" : level === "very" ? "veryBearish" : "bearish", dir };
}

/** "極度看多 ↗" in green, "中性 →", "看空 ↘" in red. */
export function SentimentText({ pctLong, className }: { pctLong: number | null; className?: string }) {
  const { t } = useI18n();
  const { key, dir } = sentiment(pctLong);
  const Icon = dir > 0 ? ArrowUpRight : dir < 0 ? ArrowDownRight : ArrowRight;
  return (
    <span className={cn("inline-flex items-center gap-[3px] text-[12.5px] leading-[18.75px] font-semibold whitespace-nowrap", dir > 0 ? "text-positive" : dir < 0 ? "text-negative" : "text-muted-foreground", className)}>
      {t(`insights.cohort.sentiment.${key}`)}
      <Icon className="size-[13px]" aria-hidden />
    </span>
  );
}

/** A long / short (or profit / loss) split bar. */
export function SplitBar({ pos, className }: { pos: number | null; className?: string }) {
  const p = pos === null ? 50 : Math.max(0, Math.min(100, pos));
  return (
    <span className={cn("flex h-1 w-full overflow-hidden rounded-full bg-raised", className)} aria-hidden>
      <span className="h-full bg-positive" style={{ width: `${p}%` }} />
      <span className="h-full bg-negative" style={{ width: `${100 - p}%` }} />
    </span>
  );
}
