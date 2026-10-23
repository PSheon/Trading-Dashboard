"use client";

import { cn } from "cn";

import { InfoTip } from "@/components/ui/info-tip";
import { useI18n } from "@/i18n/provider";
import { estimateCopyFit } from "@/lib/copy-fit";
import { useTraderFills, useTraderProfile } from "@/lib/queries";
import { FILL_LIMIT } from "./trader-tabs";

/** Before a ratio copy starts: how many of the leader's recent opens the
 * typed amount would have scaled under the minimum order, or into a HIP-3
 * market. It reads the same fill list as the trader page (no extra request)
 * and never changes the amount or the sizing for the user. An open under the
 * minimum is skipped by the copy engine, never raised (D6, 2026-10-23). It
 * suggests no amount of its own: the one suggested minimum budget is the
 * api's pill by the amount (D7/D9).
 *
 * One or two pills (UI rule: states are a pill, never a sentence): the
 * opens under the minimum (warning when any), and the HIP-3 opens apart.
 * The sentences live in each pill's hover tip. */
export function CopyFitSummary({ address, allocation }: { address: string; allocation: number }) {
  const { t, format } = useI18n();
  const profile = useTraderProfile(address);
  const fills = useTraderFills(address, FILL_LIMIT, { enabled: allocation > 0 });
  const fit = estimateCopyFit({ fills: fills.data, leaderEquity: profile.data?.accountValue, allocation });
  if (fit.status !== "ok") {
    if (fit.status === "no_amount") return null;
    // A failed read (Hyperliquid's budget, 503) is said, not shown as a silent gap.
    if (fit.status === "loading") {
      return fills.isError || profile.isError
        ? <Row><FitPill testId="copy-fit-unavailable" label={t("trader.copy.fit.unavailablePill")} tip={t("trader.copy.fit.unavailable")} /></Row>
        : null;
    }
    if (fit.status === "unknown_equity") return <Row><FitPill testId="copy-fit-unknown-equity" label={t("trader.copy.fit.unknownEquityPill")} tip={t("trader.copy.fit.unknownEquity")} /></Row>;
    return <Row><FitPill testId="copy-fit-no-opens" label={t("trader.copy.fit.noOpensPill")} tip={t("trader.copy.fit.noOpens")} /></Row>;
  }
  const sample = t("trader.copy.fit.sample", { from: format.dateTime(fit.from), to: format.dateTime(fit.to) });
  const min = format.num(fit.minNotional);
  return (
    <Row>
      <FitPill
        testId="copy-fit-below-min"
        warn={fit.belowMin > 0}
        label={fit.belowMin > 0 ? t("trader.copy.fit.belowMinPill", { below: fit.belowMin, opens: fit.opens }) : t("trader.copy.fit.allFitPill", { opens: fit.opens })}
        tip={`${fit.belowMin > 0
          ? t("trader.copy.fit.belowMin", { below: fit.belowMin, opens: fit.opens, pct: Math.round((fit.belowMin / fit.opens) * 100), min })
          : t("trader.copy.fit.allFit", { opens: fit.opens, min })} ${sample}`}
      />
      {fit.hip3 > 0 ? <FitPill testId="copy-fit-hip3" warn label={t("trader.copy.fit.hip3Pill", { count: fit.hip3 })} tip={`${t("trader.copy.fit.hip3", { count: fit.hip3 })} ${sample}`} /> : null}
    </Row>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div data-testid="copy-fit" className="flex flex-wrap gap-1.5">{children}</div>;
}

/** As the suggested-budget pill: the state as a chip, the sentence in its ⓘ
 * (hover, focus, tap) and in a visually hidden span for screen readers. */
function FitPill({ testId, warn = false, label, tip }: { testId: string; warn?: boolean; label: string; tip: string }) {
  const { t } = useI18n();
  return (
    <span data-testid={testId} data-warn={warn ? "true" : undefined} className={cn("chip-sm", warn ? "bg-tag-warning text-tag-warning-foreground" : "bg-raised text-muted-foreground")}>
      {label}
      <InfoTip label={t("trader.copy.fit.title")} className="size-4 text-current hover:text-current" iconClassName="size-3">{tip}</InfoTip>
    </span>
  );
}
