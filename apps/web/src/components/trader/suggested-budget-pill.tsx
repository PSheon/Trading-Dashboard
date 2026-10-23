"use client";

import { cn } from "cn";

import { InfoTip } from "@/components/ui/info-tip";
import { useI18n } from "@/i18n/provider";

/**
 * The leader's suggested minimum budget (decision D7/D9, 2026-10-23): one
 * pill, 建議 ≥ $X, next to the budget. It turns warning when the budget it
 * is compared with (`budget`, when known) is under the suggestion. The one
 * sentence that explains the figure lives in the hover tip (`tip`), or,
 * where no button may nest (a card that is a button), in the pill's title
 * for hover and a visually hidden span for screen readers.
 */
export function SuggestedBudgetPill({ suggested, budget, tip = true, className, testId = "copy-suggested-budget" }: {
  suggested: number; budget: number | null; tip?: boolean; className?: string; testId?: string;
}) {
  const { t, format } = useI18n();
  const below = budget !== null && budget > 0 && budget < suggested;
  const explanation = t("trader.copy.suggestedMinTip");
  return (
    <span data-testid={testId} data-below={below ? "true" : undefined} title={tip ? undefined : explanation}
      className={cn("chip-sm", below ? "bg-tag-warning text-tag-warning-foreground" : "bg-raised text-muted-foreground", className)}>
      {t("trader.copy.suggestedMin", { amount: format.num(suggested) })}
      {tip ? <InfoTip label={t("common.moreInfo")} className="size-4 text-current hover:text-current" iconClassName="size-3">{explanation}</InfoTip> : <span className="sr-only">{explanation}</span>}
    </span>
  );
}
