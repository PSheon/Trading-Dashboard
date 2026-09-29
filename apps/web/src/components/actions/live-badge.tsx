"use client";

import { cn } from "cn";

import { useI18n } from "@/i18n/provider";
import type { StreamStatus } from "@/lib/use-action-stream";

/** "Live" while the action stream is open; "Refreshing" while it
 * reconnects (the list polls meanwhile). Nothing before the first
 * connection or when not streaming. */
export function LiveBadge({ status, className }: { status: StreamStatus; className?: string }) {
  const { t } = useI18n();
  if (status === "off" || status === "connecting") return null;
  const live = status === "live";
  return (
    <span
      role="status"
      data-stream={status}
      title={live ? t("actions.liveHint") : t("actions.pollingHint")}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-semibold tracking-wide",
        live ? "bg-positive-soft text-positive" : "bg-raised text-muted-foreground",
        className,
      )}
    >
      <span className="relative flex size-1.5">
        {live ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-positive opacity-60" /> : null}
        <span className={cn("relative inline-flex size-1.5 rounded-full", live ? "bg-positive" : "bg-subtle-foreground")} />
      </span>
      {live ? t("actions.live") : t("actions.polling")}
    </span>
  );
}
