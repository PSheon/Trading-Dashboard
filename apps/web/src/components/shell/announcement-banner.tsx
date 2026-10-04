"use client";

import { Megaphone, X } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { useSiteSettings } from "@/lib/queries";
import { useLocalStorage } from "@/lib/use-local-storage";

const DISMISS_KEY = "announcement-dismissed";

/** Site-wide banner from GET /settings `announcement`, in the active
 * locale. Dismissing hides that exact text until an admin changes it. */
export function AnnouncementBanner() {
  const { t, locale } = useI18n();
  const { data } = useSiteSettings();
  const [dismissed, setDismissed] = useLocalStorage(DISMISS_KEY);

  const announcement = data?.announcement;
  const text = announcement?.enabled ? announcement.text[locale === "zh-TW" ? "zh-TW" : "en"].trim() : "";
  if (!text || dismissed === text) return null;

  return (
    <div className="mx-auto max-w-[1600px] px-4 pt-3 md:px-5 md:pt-1">
      <div className="flex items-start gap-3 rounded-[22px] bg-tag-alert px-4 py-2.5 text-tag-alert-foreground animate-in fade-in-0 slide-in-from-top-1 motion-reduce:animate-none md:items-center">
        <Megaphone aria-hidden className="mt-0.5 size-4 shrink-0 md:mt-0" strokeWidth={2.4} />
        <p className="min-w-0 flex-1 text-[0.8125rem] leading-relaxed font-bold">
          <span className="sr-only">{t("topbar.announcement")}: </span>
          {text}
        </p>
        <button
          type="button"
          onClick={() => setDismissed(text)}
          aria-label={t("common.dismiss")}
          className="-m-1 flex size-8 items-center justify-center rounded-full outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" strokeWidth={2.6} />
        </button>
      </div>
    </div>
  );
}
