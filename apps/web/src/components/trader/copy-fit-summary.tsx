"use client";

import { Info, TriangleAlert } from "lucide-react";
import { cn } from "cn";

import { useI18n } from "@/i18n/provider";
import { estimateCopyFit } from "@/lib/copy-fit";
import { useTraderFills, useTraderProfile } from "@/lib/queries";
import { FILL_LIMIT } from "./trader-tabs";

/** Before a ratio copy starts: how many of the leader's recent opens the
 * typed amount would have scaled under the minimum order, or into a HIP-3
 * market. It reads the same fill list as the trader page (no extra request)
 * and never changes the amount or the sizing for the user. */
export function CopyFitSummary({ address, allocation }: { address: string; allocation: number }) {
  const { t, format } = useI18n();
  const profile = useTraderProfile(address);
  const fills = useTraderFills(address, FILL_LIMIT, { enabled: allocation > 0 });
  const fit = estimateCopyFit({ fills: fills.data, leaderEquity: profile.data?.accountValue, allocation });
  if (fit.status === "no_amount") return null;
  // A failed read (Hyperliquid's budget, 503) is said, not shown as a silent gap.
  if (fit.status === "loading") return fills.isError || profile.isError ? <Shell warn={false}>{t("trader.copy.fit.unavailable")}</Shell> : null;
  if (fit.status !== "ok") return <Shell warn={false}>{t(fit.status === "unknown_equity" ? "trader.copy.fit.unknownEquity" : "trader.copy.fit.noOpens")}</Shell>;
  return (
    <Shell warn={fit.belowMin + fit.hip3 > 0}>
      <p>{fit.belowMin > 0
        ? t("trader.copy.fit.belowMin", { below: fit.belowMin, opens: fit.opens, pct: Math.round((fit.belowMin / fit.opens) * 100), min: format.num(fit.minNotional) })
        : t("trader.copy.fit.allFit", { opens: fit.opens, min: format.num(fit.minNotional) })}</p>
      {fit.hip3 > 0 ? <p>{t("trader.copy.fit.hip3", { count: fit.hip3 })}</p> : null}
      <p className="mt-1 text-muted-foreground">{t("trader.copy.fit.sample", { from: format.dateTime(fit.from), to: format.dateTime(fit.to) })}</p>
    </Shell>
  );
}

function Shell({ warn, children }: { warn: boolean; children: React.ReactNode }) {
  const { t } = useI18n();
  const Icon = warn ? TriangleAlert : Info;
  return (
    <div data-testid="copy-fit" className={cn("flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs leading-relaxed", warn ? "bg-warning/10 text-warning" : "bg-raised text-muted-foreground")}>
      <Icon className="mt-px size-3.5 shrink-0" />
      <div className="min-w-0">
        <p className="font-bold">{t("trader.copy.fit.title")}</p>
        {typeof children === "string" ? <p>{children}</p> : children}
      </div>
    </div>
  );
}
