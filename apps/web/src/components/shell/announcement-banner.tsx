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
    <div className="border-b border-primary/25 bg-primary-soft">
      <div className="mx-auto flex max-w-[1600px] items-start gap-3 px-4 py-2.5 md:items-center md:px-8">
        <Megaphone aria-hidden className="mt-0.5 size-4 shrink-0 text-primary md:mt-0" />
        <p className="min-w-0 flex-1 text-[0.8125rem] leading-relaxed text-foreground">
          <span className="sr-only">{t("topbar.announcement")}: </span>
          {text}
        </p>
        <button
          type="button"
          onClick={() => setDismissed(text)}
          aria-label={t("common.dismiss")}
          className="-m-1 rounded-full p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
