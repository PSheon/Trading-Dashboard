/** Set once this browser has Noto Sans TC's slices for the pages it saw in
 * its cache (components/shell/cjk-font.tsx); the layout then puts the web
 * font first (<html class="cjk-web">). Shared by the server layout and the
 * client warm-up, so it lives outside the "use client" module. */
export const CJK_FONT_COOKIE = "cjk-font";
export const CJK_FONT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
