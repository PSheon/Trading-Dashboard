"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { CJK_FONT_COOKIE, CJK_FONT_COOKIE_MAX_AGE } from "@/lib/cjk-font";

/** Han, kana, CJK punctuation and full-width forms. */
const CJK = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/**
 * Noto Sans TC off the critical path. A first visit draws CJK text in the
 * system's face and asks for none of the web font before the page has
 * loaded; once it has and the browser is idle, the slices this page's text
 * needs are fetched into the cache (FontFaceSet.load: nothing on screen
 * uses the family yet, so nothing is redrawn; again a few seconds later for
 * the text that came with the data), and the cookie tells the
 * next visit to use them from the first paint. Each page visited adds its
 * own characters' slices. Data Saver skips all of it.
 */
export function CjkFontWarmup() {
  const pathname = usePathname();
  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts?.load) return;
    if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
    let cancelled = false;
    let idle: number | undefined;
    const warm = () => {
      idle = undefined;
      if (cancelled) return;
      const text = document.body.innerText;
      if (!CJK.test(text)) return;
      const chars = [...new Set(text)].filter((c) => CJK.test(c)).join("");
      // The family as next/font named it (the first entry of its variable).
      const family = getComputedStyle(document.documentElement).getPropertyValue("--font-noto-tc").split(",")[0]?.trim();
      if (!family) return;
      // One variable file serves both weights; 700 is asked for too in case
      // the files differ.
      void Promise.all([document.fonts.load(`500 16px ${family}`, chars), document.fonts.load(`700 16px ${family}`, chars)])
        .then((faces) => {
          if (cancelled || faces.flat().length === 0) return;
          document.cookie = `${CJK_FONT_COOKIE}=1; path=/; max-age=${CJK_FONT_COOKIE_MAX_AGE}; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
        })
        .catch(() => undefined);
    };
    let later: number | undefined;
    const idleThen = (run: () => void) => {
      if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(run, { timeout: 5_000 });
      else idle = window.setTimeout(run, 2_000);
    };
    // Once at the first idle moment, and once more a few seconds on, for
    // the text that arrived with the page's data (names, coins, notes).
    const schedule = () => idleThen(() => {
      warm();
      later = window.setTimeout(() => idleThen(warm), 6_000);
    });
    // After `load`, so no slice competes with the page's own requests.
    if (document.readyState === "complete") schedule();
    else window.addEventListener("load", schedule, { once: true });
    return () => {
      cancelled = true;
      window.removeEventListener("load", schedule);
      window.clearTimeout(later);
      if (idle !== undefined) {
        if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idle);
        else window.clearTimeout(idle);
      }
    };
  }, [pathname]);
  return null;
}
