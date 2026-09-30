"use client";

import { FlaskConical } from "lucide-react";
import { cn } from "cn";

import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/provider";

/**
 * 模擬: shown wherever paper copy state appears (trader panel, portfolio,
 * phone sheet). Paper copies use virtual USDC and never send an order.
 */
export function PaperBadge({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <Tooltip content={t("trader.copy.paperHint")}>
      <span
        tabIndex={0}
        className={cn(
          "inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-warning/15 px-2 text-[11px] font-bold text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        <FlaskConical className="size-3" aria-hidden />
        {t("trader.copy.paper")}
      </span>
    </Tooltip>
  );
}
