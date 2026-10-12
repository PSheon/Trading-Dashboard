"use client";

import { X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "@/i18n/navigation";
import { useI18n } from "@/i18n/provider";
import { ANNOUNCEMENT_COOKIE, ANNOUNCEMENT_COOKIE_MAX_AGE, announcementContent } from "@/lib/announcement";
import { useSiteSettings } from "@/lib/queries";
import { readLocalStorage } from "@/lib/use-local-storage";

/** Where a dismissal used to be kept (the text itself); read once to carry
 * it over to the cookie. */
const LEGACY_DISMISS_KEY = "announcement-dismissed";
const noSubscription = () => () => {};
const remember = (hash: string) => {
  document.cookie = `${ANNOUNCEMENT_COOKIE}=${hash}; path=/; max-age=${ANNOUNCEMENT_COOKIE_MAX_AGE}; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
};

/** Site-wide banner from GET /settings `announcement`, in the active
 * locale: one 36px line — a pill (label), a short phrase (summary, from
 * md up) and "Learn more" (href, default /help), then ✕. The full
 * explanation lives on the help page ("What does open beta mean?").
 * Dismissing hides this exact announcement until an admin changes it.
 * `dismissed`: the hash the server read from the cookie, so a closed
 * banner is never drawn and then removed. */
export function AnnouncementBanner({ dismissed: initialDismissed = null }: { dismissed?: string | null }) {
  const { t, locale } = useI18n();
  const { data } = useSiteSettings();
  const [dismissed, setDismissed] = useState<string | null>(initialDismissed);

  const content = announcementContent(data?.announcement, locale);
  const hash = content?.hash ?? "";
  const dismiss = () => {
    remember(hash);
    setDismissed(hash);
  };

  // A dismissal saved before the cookie (localStorage) moves over once.
  const legacy = useSyncExternalStore(noSubscription, () => readLocalStorage(LEGACY_DISMISS_KEY), () => null);
  const legacyDismissed = content !== null && legacy === content.summary;
  useEffect(() => {
    if (legacyDismissed) remember(hash);
  }, [legacyDismissed, hash]);

  if (!content || dismissed === hash || legacyDismissed) return null;
  const external = /^https:\/\//.test(content.href);
  const more = (
    <>
      {t("topbar.announcementMore")}
      <span aria-hidden> ›</span>
    </>
  );
  const moreClass = "shrink-0 rounded-full text-[0.8125rem] font-bold whitespace-nowrap text-primary-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div className="page-frame pt-3 md:pt-1">
      <div data-testid="announcement-banner"
        className="flex h-9 items-center gap-2.5 rounded-full bg-raised pr-1 pl-1.5 text-foreground">
        <span className="inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full bg-raised px-2 text-xs font-bold whitespace-nowrap text-primary-text">
          <span aria-hidden className="size-1.5 rounded-full bg-primary" />
          <span className="sr-only">{t("topbar.announcement")}: </span>
          {content.label ?? t("topbar.announcementLabel")}
        </span>
        <p data-testid="announcement-summary" className="hidden min-w-0 truncate text-[0.8125rem] font-bold md:inline">
          {content.summary}
        </p>
        {/* Phones show no phrase; screen readers still read it. */}
        <span className="sr-only md:hidden">{content.summary} </span>
        {external ? (
          <a href={content.href} target="_blank" rel="noopener noreferrer" className={moreClass}>{more}</a>
        ) : (
          <Link href={content.href} className={moreClass}>{more}</Link>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("topbar.announcementClose")}
          className="relative ml-auto flex size-7 shrink-0 before:absolute before:-inset-2 before:content-[''] items-center justify-center rounded-full outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden className="size-4" strokeWidth={2.6} />
        </button>
      </div>
    </div>
  );
}
