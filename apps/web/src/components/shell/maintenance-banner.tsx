"use client";

import { useEffect } from "react";
import { Wrench } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { TIME_ZONE_LABEL } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";
import { MAINTENANCE_EVENT } from "@/lib/api";
import { useSiteSettings } from "@/lib/queries";
import { queryKeys } from "@/lib/query-keys";
import { useNow } from "@/lib/use-now";

/**
 * Site-wide notice while GET /settings `maintenance.enabled`: the admin's
 * text in the active language (the catalog's own wording when it is empty)
 * and the expected end while that is still ahead. Not dismissible: writes
 * are refused for as long as it shows. A write the api refuses with 503
 * `maintenance` re-reads the settings at once, so the notice appears with
 * the failure and not up to a minute later.
 */
export function MaintenanceBanner() {
  const { t, locale, format } = useI18n();
  const { data } = useSiteSettings();
  const queryClient = useQueryClient();
  const now = useNow();

  useEffect(() => {
    const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.siteSettings });
    window.addEventListener(MAINTENANCE_EVENT, refresh);
    return () => window.removeEventListener(MAINTENANCE_EVENT, refresh);
  }, [queryClient]);

  const maintenance = data?.maintenance;
  if (!maintenance?.enabled) return null;
  const text = maintenance.message[locale === "zh-TW" ? "zh-TW" : "en"].trim() || t("maintenance.body");
  const ahead = maintenance.endsAt !== null && Date.parse(maintenance.endsAt) > now;

  return (
    <div role="status" className="mx-auto max-w-[1600px] px-4 pt-3 md:px-5 md:pt-1">
      <div className="flex items-start gap-3 rounded-[22px] bg-tag-warning px-4 py-2.5 text-tag-warning-foreground">
        <Wrench aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={2.4} />
        <p className="min-w-0 flex-1 text-[0.8125rem] leading-relaxed font-bold">
          <strong className="font-extrabold">{t("maintenance.title")}</strong>
          <span aria-hidden className="mx-1.5">·</span>
          {text}
          {ahead ? <span className="ml-1.5">{t("maintenance.endsAt", { time: `${format.dateTime(maintenance.endsAt!)} ${TIME_ZONE_LABEL}` })}</span> : null}
        </p>
      </div>
    </div>
  );
}
