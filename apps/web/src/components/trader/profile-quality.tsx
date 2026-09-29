"use client";
import type { TraderProfileResponse } from "@/lib/contracts";
import { useNow } from "@/lib/use-now";
import { useI18n } from "@/i18n/provider";
const labels = { dexes: "trader.sourceDexes", spot: "trader.sourceSpot", accountMode: "trader.sourceMode",
  staking: "trader.sourceStaking", prices: "trader.sourcePrices", stats: "trader.sourceStats", analytics: "trader.sourceAnalytics" } as const;
export function ProfileQuality({ quality }: { quality: TraderProfileResponse["dataQuality"] }) {
  const { t, format } = useI18n();
  const now = useNow();
  if (!quality) return null;
  const isStale = (source: (typeof quality.sources)[string]) => source.stale || (source.asOf !== null && now - Date.parse(source.asOf) > source.maxAgeMs);
  return <details className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
    <summary className="cursor-pointer">{t("trader.sourceDetails")}{Object.values(quality.sources).some(isStale) ? ` · ${t("trader.sourceStale")}` : ""}</summary>
    <dl className="mt-2 space-y-2">{Object.entries(quality.sources).map(([key, source]) => (
      <div key={key}>
        <dt>{key.startsWith("perp:") ? t("trader.sourcePerp", { dex: key.slice(5) }) : key in labels ? t(labels[key as keyof typeof labels]) : key}</dt>
        <dd>{source.status === "unavailable" ? t("trader.sourceUnavailable") : <>
          {source.asOf ? <time dateTime={source.asOf}>{format.dateTime(source.asOf)}</time> : "—"}
          {isStale(source) ? ` · ${t("trader.sourceStale")}` : ""}
        </>}</dd>
      </div>
    ))}</dl>
  </details>;
}
