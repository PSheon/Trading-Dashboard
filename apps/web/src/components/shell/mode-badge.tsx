"use client";

import { FlaskConical, Radio, Zap } from "lucide-react";
import { cn } from "cn";

import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { useT } from "@/i18n/provider";
import { useSiteMode, type SiteMode } from "@/lib/site-mode";

const ICON = { paper: FlaskConical, testnet: Radio, live: Zap } as const;
const VARIANT = { paper: "warning", testnet: "default", live: "positive" } as const;

/**
 * The one mode label of the site: beside the wordmark in the header (模擬,
 * 測試網 where testnet copies run, 正式 later). Lists, cards and section
 * titles carry none; the four paper action dialogs pass `mode` to say it
 * once more where money moves.
 */
export function ModeBadge({ mode, className }: { mode?: SiteMode; className?: string }) {
  const site = useSiteMode(), t = useT();
  const value = mode ?? site;
  const Icon = ICON[value];
  return (
    <Tooltip content={t(`mode.${value}Hint`)}>
      <Badge tabIndex={0} variant={VARIANT[value]} data-mode={value} aria-label={`${t("mode.label")}: ${t(`mode.${value}`)}`}
        className={cn("outline-none focus-visible:ring-2 focus-visible:ring-ring", value === "testnet" && "bg-primary/15 text-primary-text", className)}>
        <Icon aria-hidden />
        {t(`mode.${value}`)}
      </Badge>
    </Tooltip>
  );
}
