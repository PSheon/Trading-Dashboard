"use client";

import type { TraderActivity } from "@/lib/contracts";
import { ArrowDownRight, ArrowUpRight, Landmark, Star } from "lucide-react";
import { cn } from "cn";

import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/provider";
import { toNumber } from "@/lib/format";
import { useToggleFavorite } from "@/lib/queries";

/** Signed USD, green up / red down. */
export function PnlValue({
  value,
  compact = true,
  className,
  muted = false,
}: {
  value: number | null | undefined;
  compact?: boolean;
  className?: string;
  /** Low sample: shown, but greyed out. */
  muted?: boolean;
}) {
  const { format } = useI18n();
  const n = toNumber(value);
  return (
    <span
      className={cn(
        "num font-semibold",
        muted ? "text-subtle-foreground" : n === null || n === 0 ? "text-foreground" : n > 0 ? "text-positive" : "text-negative",
        className,
      )}
    >
      {format.usd(n, { compact, sign: true })}
    </span>
  );
}

/** ROI as a small pill with an arrow (CopyDog card style). */
export function RoiPill({
  value,
  className,
  muted = false,
  digits,
  label,
}: {
  value: number | null | undefined;
  className?: string;
  muted?: boolean;
  /** CopyDog's desktop chart pill keeps two decimals ("539.50%"). */
  digits?: number;
  /** Preformatted text (CopyDog's phone pill: "1488%"). */
  label?: string;
}) {
  const { format } = useI18n();
  const n = toNumber(value);
  const up = (n ?? 0) >= 0;
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        "num chip-sm gap-0.5",
        muted
          ? "bg-raised text-subtle-foreground"
          : up
            ? "bg-tag-profit text-tag-profit-foreground"
            : "bg-tag-loss text-tag-loss-foreground",
        className,
      )}
    >
      <Arrow className="size-3" strokeWidth={2.5} />
      {label ?? format.pct(n === null ? null : Math.abs(n), digits === undefined ? undefined : { digits })}
    </span>
  );
}

export function VaultBadge({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <Tooltip content={t("common.vaultHint")}>
      <span
        tabIndex={0}
        className={cn(
          "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-border-strong px-1.5 text-[0.625rem] font-semibold text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        <Landmark className="size-2.5" />
        {t("common.vault")}
      </span>
    </Tooltip>
  );
}

/** Dot colour per activity: green = traded today, orange = this week,
 * grey = this month, hollow = not in 30 days. */
export const ACTIVITY_DOT: Record<TraderActivity, string> = {
  day: "bg-positive",
  week: "bg-primary",
  month: "bg-muted-foreground",
  inactive: "border border-subtle-foreground bg-transparent",
};

/**
 * "24h 內交易" / "7 天內交易" / "30 天內交易" / "30 天未交易" (Stage 2 §12):
 * a dot and a short caption, CopyDog's "2H AGO" in spirit. From the
 * leaderboard's volume windows, so it costs no request.
 */
export function ActivityBadge({ activity, className }: { activity: TraderActivity; className?: string }) {
  const { t } = useI18n();
  return (
    <span
      title={t(`common.activityHint.${activity}`)}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-[0.6875rem] leading-none font-medium whitespace-nowrap",
        activity === "inactive" ? "text-subtle-foreground" : "text-muted-foreground",
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", ACTIVITY_DOT[activity])} />
      {t(`common.activity.${activity}`)}
    </span>
  );
}

export function LowSampleTag({
  fills,
  capped,
  threshold,
  className,
}: {
  fills: number;
  capped: boolean;
  threshold: number;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <Tooltip content={t("common.lowSampleHint", { count: fills, threshold })}>
      <span
        tabIndex={0}
        className={cn(
          "num chip-sm bg-tag-warning text-tag-warning-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        {t(capped ? "common.lowSampleCapped" : "common.lowSample", { count: fills })}
      </span>
    </Tooltip>
  );
}

export function FavoriteButton({
  address,
  favorite,
  className,
  size = "md",
  solid = false,
}: {
  address: string;
  favorite: boolean;
  className?: string;
  size?: "sm" | "md";
  /** CopyDog's trader header: a 30px square button whose star is always
   * filled, grey until tracked and then its warning yellow. */
  solid?: boolean;
}) {
  const { t } = useI18n();
  const { toggle, pending, needsLogin } = useToggleFavorite();
  const busy = pending === address;
  const label = needsLogin ? t("auth.loginToFavorite") : favorite ? t("common.unfavorite") : t("common.favorite");
  return (
    <button
      type="button"
      aria-pressed={favorite}
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(address, !favorite);
      }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full outline-none transition-colors hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        solid ? "size-[30px] rounded-md" : size === "sm" ? "size-7" : "size-9",
        favorite ? (solid ? "text-warning" : "text-primary-text") : solid ? "text-muted-foreground hover:text-foreground" : "text-subtle-foreground hover:text-foreground",
        className,
      )}
    >
      <Star className={solid ? "size-[15px]" : size === "sm" ? "size-4" : "size-[18px]"} fill={favorite || solid ? "currentColor" : "none"} />
    </button>
  );
}
