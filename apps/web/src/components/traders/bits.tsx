"use client";

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
}: {
  value: number | null | undefined;
  className?: string;
  muted?: boolean;
}) {
  const { format } = useI18n();
  const n = toNumber(value);
  const up = (n ?? 0) >= 0;
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        "num inline-flex h-6 items-center gap-0.5 rounded-full px-2 text-xs font-semibold",
        muted
          ? "bg-raised text-subtle-foreground"
          : up
            ? "bg-positive-soft text-positive"
            : "bg-negative-soft text-negative",
        className,
      )}
    >
      <Arrow className="size-3" strokeWidth={2.5} />
      {format.pct(n === null ? null : Math.abs(n))}
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
          "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-border-strong px-1.5 text-[0.625rem] font-semibold tracking-wide text-muted-foreground uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        <Landmark className="size-2.5" />
        {t("common.vault")}
      </span>
    </Tooltip>
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
          "num inline-flex h-6 items-center rounded-full bg-warning/12 px-2 text-[0.6875rem] font-semibold text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
}: {
  address: string;
  favorite: boolean;
  className?: string;
  size?: "sm" | "md";
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
        size === "sm" ? "size-7" : "size-9",
        favorite ? "text-primary" : "text-subtle-foreground hover:text-foreground",
        className,
      )}
    >
      <Star className={size === "sm" ? "size-4" : "size-[18px]"} fill={favorite ? "currentColor" : "none"} />
    </button>
  );
}
