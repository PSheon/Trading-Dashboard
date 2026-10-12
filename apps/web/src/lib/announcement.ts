import type { AnnouncementSettings } from "@trading-dashboard/shared/contracts";

/** The dismissed announcement, as a cookie so the server leaves a banner
 * the visitor closed out of the first HTML (with localStorage it was drawn
 * and then removed after hydration, moving the page up). The value is a
 * short hash of what the banner says: a new announcement shows again. */
export const ANNOUNCEMENT_COOKIE = "announcement-dismissed";
export const ANNOUNCEMENT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
/** "Learn more" when the admin set no link. */
export const ANNOUNCEMENT_DEFAULT_HREF = "/help";

/** FNV-1a, 32 bit, as 8 hex digits. */
export function announcementHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface AnnouncementContent {
  /** The admin's pill text; null shows the default ("Public beta"). */
  label: string | null;
  /** The short phrase (the old single `text` when no summary is set). */
  summary: string;
  href: string;
  /** What a dismissal remembers. */
  hash: string;
}

/**
 * What the banner shows in this locale (zh-TW, else English), or null when
 * it is off or empty. An announcement stored before label/summary/href
 * existed shows its `text` as the summary under the default pill and link.
 * The hash covers label, summary and href, so editing any of them shows the
 * banner again; for an announcement with only a summary it is the summary's
 * own hash, which keeps dismissals made before 2026-10-12 valid.
 */
export function announcementContent(announcement: AnnouncementSettings | undefined, locale: string): AnnouncementContent | null {
  if (!announcement?.enabled) return null;
  const l = locale === "zh-TW" ? "zh-TW" : "en";
  const summary = (announcement.summary?.[l].trim() || announcement.text[l].trim());
  if (!summary) return null;
  const label = announcement.label?.[l].trim() || null;
  const storedHref = announcement.href?.trim() || null;
  const href = storedHref ?? ANNOUNCEMENT_DEFAULT_HREF;
  const hash = announcementHash(label === null && storedHref === null ? summary : [label ?? "", summary, href].join("\n"));
  return { label, summary, href, hash };
}
