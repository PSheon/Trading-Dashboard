/** The dismissed announcement, as a cookie so the server leaves a banner
 * the visitor closed out of the first HTML (with localStorage it was drawn
 * and then removed after hydration, moving the page up). The value is a
 * short hash of the text: a new announcement shows again. */
export const ANNOUNCEMENT_COOKIE = "announcement-dismissed";
export const ANNOUNCEMENT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** FNV-1a, 32 bit, as 8 hex digits. */
export function announcementHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
