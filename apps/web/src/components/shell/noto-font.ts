import { Noto_Sans_TC } from "next/font/google";

/** Noto Sans TC, the CJK web font, in a module of its own: it is imported
 * only by CjkFontWarmup's dynamic import, so its @font-face rules (≈ 76 KB
 * gzipped: one rule per unicode-range slice and weight) arrive as a CSS
 * chunk after the page has loaded instead of in the first paint's CSS.
 * Never preloaded; `optional`: a slice that is not ready at once is never
 * swapped in later. */
export const notoSansTc = Noto_Sans_TC({
  variable: "--font-noto-tc",
  weight: ["500", "700"],
  display: "optional",
  preload: false,
});
