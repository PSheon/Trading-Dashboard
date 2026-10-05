"use client";

import { usePathname } from "@/i18n/navigation";
import { useEffect } from "react";

import { CJK_FONT_COOKIE, CJK_FONT_COOKIE_MAX_AGE, encodeCjkFont } from "@/lib/cjk-font";

/** Han, kana, CJK punctuation and full-width forms. */
const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;
/** How long after `load` the first warm-up waits: past the page's own data
 * reads (and its LCP), so the slices never compete with them. */
const AFTER_LOAD_MS = 5_000;

/** The same-origin stylesheets that declare `family` (the web font's
 * @font-face rules, in the CSS chunk the dynamic import brought in). */
function stylesheetsDeclaring(family: string): string[] {
  const name = family.replace(/['"]/g, "");
  const hrefs: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    if (!sheet.href) continue;
    try {
      const declares = Array.from(sheet.cssRules).some((rule) => rule instanceof CSSFontFaceRule && rule.style.getPropertyValue("font-family").replace(/['"]/g, "").trim() === name);
      if (declares) hrefs.push(new URL(sheet.href).pathname);
    } catch {
      // A cross-origin sheet's rules can't be read: not ours.
    }
  }
  return hrefs;
}

/**
 * Noto Sans TC off the critical path. Its module (components/shell/
 * noto-font) is not imported by the layout, so a first visit's CSS carries
 * none of its rules and CJK text is drawn in the system's face. A few
 * seconds after `load`, when the browser is idle, the module is imported
 * (its @font-face rules arrive as a CSS chunk; nothing on screen uses the
 * family, so nothing is redrawn) and FontFaceSet.load fetches the slices
 * this page's characters need into the cache; again a little later for the
 * text that came with the data. The cookie then names that stylesheet and
 * the family, and from the next visit the layout links it in the head and
 * puts the web font first (<html class="cjk-web">), `optional`, so a slice
 * that is not cached never swaps in under the reader. Each page visited
 * adds its own characters' slices. Data Saver skips all of it.
 */
export function CjkFontWarmup() {
  const pathname = usePathname();
  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts?.load) return;
    // Not on the fixture / test server: its first import would make the dev
    // server fetch and compile the font's ~100 slices in the middle of a
    // browser-test run (CI run 37262398469 stalled for minutes there).
    if (process.env.NEXT_PUBLIC_API_FIXTURES === "1" && process.env.NEXT_PUBLIC_CJK_WARMUP !== "1") return;
    if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
    let cancelled = false;
    let idle: number | undefined;
    let timer: number | undefined;
    const warm = async () => {
      idle = undefined;
      if (cancelled) return;
      const text = document.body.innerText;
      if (!CJK.test(text)) return;
      const chars = [...new Set(text)].filter((c) => CJK.test(c)).join("");
      try {
        const { notoSansTc } = await import("./noto-font");
        const family = notoSansTc.style.fontFamily;
        const first = family.split(",")[0]?.trim();
        if (cancelled || !first) return;
        // One variable file serves both weights; 700 is asked for too in
        // case the files differ.
        const faces = await Promise.all([document.fonts.load(`500 16px ${first}`, chars), document.fonts.load(`700 16px ${first}`, chars)]);
        if (cancelled || faces.flat().length === 0) return;
        const css = stylesheetsDeclaring(first);
        if (css.length === 0) return;
        document.cookie = `${CJK_FONT_COOKIE}=${encodeCjkFont({ css, family })}; path=/; max-age=${CJK_FONT_COOKIE_MAX_AGE}; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
      } catch {
        // Offline, or the chunk is gone after a deploy: next time.
      }
    };
    const idleThen = (run: () => void) => {
      if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(run, { timeout: 5_000 });
      else idle = window.setTimeout(run, 1_000);
    };
    // A few seconds after load, at an idle moment; and once more a little
    // later for the text that arrived with the page's data.
    const schedule = () => {
      timer = window.setTimeout(() => idleThen(() => {
        void warm();
        timer = window.setTimeout(() => idleThen(() => void warm()), AFTER_LOAD_MS);
      }), AFTER_LOAD_MS);
    };
    if (document.readyState === "complete") schedule();
    else window.addEventListener("load", schedule, { once: true });
    return () => {
      cancelled = true;
      window.removeEventListener("load", schedule);
      window.clearTimeout(timer);
      if (idle !== undefined) {
        if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idle);
        else window.clearTimeout(idle);
      }
    };
  }, [pathname]);
  return null;
}
