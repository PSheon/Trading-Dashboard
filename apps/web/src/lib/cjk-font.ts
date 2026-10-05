/** Set once this browser has Noto Sans TC's slices for the pages it saw in
 * its cache (components/shell/cjk-font.tsx): which stylesheet declares the
 * web font and under which family name. The layout then links that
 * stylesheet and puts the font first (<html class="cjk-web">). Shared by the
 * server layout and the client warm-up, so it lives outside the "use
 * client" module. */
export const CJK_FONT_COOKIE = "cjk-font";
export const CJK_FONT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export interface CjkFont {
  /** Same-origin paths of the CSS chunk(s) with the @font-face rules. */
  css: string[];
  /** The family as next/font named it, e.g. `'Noto Sans TC', 'Noto Sans TC Fallback'`. */
  family: string;
}

/** A built CSS chunk under /_next/static, nothing else. */
const CSS_PATH = /^\/_next\/static\/[A-Za-z0-9_.%\-/]+\.css$/;
const FAMILY = /^[A-Za-z0-9 ,'"_-]{1,120}$/;

export function encodeCjkFont(value: CjkFont): string {
  return encodeURIComponent(JSON.stringify(value));
}

/** The cookie's value, or null when it is missing or not exactly what the
 * warm-up writes (it is rendered into the page's head). */
export function parseCjkFont(raw: string | undefined): CjkFont | null {
  if (!raw) return null;
  try {
    // Next hands cookie values over decoded; a raw header value is not.
    const value = JSON.parse(raw.startsWith("{") ? raw : decodeURIComponent(raw)) as Partial<CjkFont>;
    if (!Array.isArray(value.css) || value.css.length === 0 || value.css.length > 3) return null;
    if (!value.css.every((href) => typeof href === "string" && CSS_PATH.test(href) && !href.includes(".."))) return null;
    if (typeof value.family !== "string" || !FAMILY.test(value.family)) return null;
    return { css: value.css, family: value.family };
  } catch {
    return null;
  }
}
