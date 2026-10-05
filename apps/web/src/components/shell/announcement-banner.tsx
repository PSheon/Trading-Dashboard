"use client";

import { Megaphone, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useI18n } from "@/i18n/provider";
import { ANNOUNCEMENT_COOKIE, ANNOUNCEMENT_COOKIE_MAX_AGE, announcementHash } from "@/lib/announcement";
import { useSiteSettings } from "@/lib/queries";
import { readLocalStorage } from "@/lib/use-local-storage";

/** Where a dismissal used to be kept (the text itself); read once to carry
 * it over to the cookie. */
const LEGACY_DISMISS_KEY = "announcement-dismissed";
const noSubscription = () => () => {};

/** Site-wide banner from GET /settings `announcement`, in the active
 * locale. Dismissing hides that exact text until an admin changes it.
 * `dismissed`: the hash the server read from the cookie, so a closed
 * banner is never drawn and then removed. */
export function AnnouncementBanner({ dismissed: initialDismissed = null }: { dismissed?: string | null }) {
  const { t, locale } = useI18n();
  const { data } = useSiteSettings();
  const [dismissed, setDismissed] = useState<string | null>(initialDismissed);

  const announcement = data?.announcement;
  const text = announcement?.enabled ? announcement.text[locale === "zh-TW" ? "zh-TW" : "en"].trim() : "";
  const hash = text ? announcementHash(text) : "";
  const remember = (value: string) => {
    document.cookie = `${ANNOUNCEMENT_COOKIE}=${value}; path=/; max-age=${ANNOUNCEMENT_COOKIE_MAX_AGE}; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
  };
  const dismiss = () => {
    remember(hash);
    setDismissed(hash);
  };

  // A dismissal saved before the cookie (localStorage) moves over once.
  const legacy = useSyncExternalStore(noSubscription, () => readLocalStorage(LEGACY_DISMISS_KEY), () => null);
  const legacyDismissed = Boolean(text) && legacy === text;
  useEffect(() => {
    if (legacyDismissed) remember(hash);
  }, [legacyDismissed, hash]);

  if (!text || dismissed === hash || legacyDismissed) return null;

  return (
    <div className="page-frame pt-3 md:pt-1">
      <div className="flex items-start gap-3 rounded-[22px] bg-tag-alert px-4 py-2.5 text-tag-alert-foreground md:items-center">
        <Megaphone aria-hidden className="mt-0.5 size-4 shrink-0 md:mt-0" strokeWidth={2.4} />
        <p className="min-w-0 flex-1 text-[0.8125rem] leading-relaxed font-bold">
          <span className="sr-only">{t("topbar.announcement")}: </span>
          {text}
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("common.dismiss")}
          className="-m-1 flex size-8 items-center justify-center rounded-full outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" strokeWidth={2.6} />
        </button>
      </div>
    </div>
  );
}
