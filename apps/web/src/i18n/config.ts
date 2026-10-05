import { localeEnum } from "@trading-dashboard/shared/contracts";

/**
 * Locale settings shared by the server layout, the proxy and client
 * components.
 *
 * The language is in the URL, as DonutMe's is: every page lives under
 * `/<locale>/…` with the prefix always shown (`/zh-TW/explore`,
 * `/en/trader/0x…`). An unprefixed URL (an old bookmark, a Telegram link, a
 * shared link) is redirected by the proxy (src/proxy.ts) to the visitor's
 * language: the `locale` cookie, then Accept-Language, then zh-TW. The
 * cookie is the visitor's saved choice: the language switcher writes it,
 * and a signed-in account's language is adopted into it.
 *
 * Why no i18n library: Next 16's `next/root-params` gives every server
 * component the URL's locale, and the typed catalogs below (with their own
 * `{name}` interpolation) don't fit next-intl's ICU messages; see
 * i18n/navigation.tsx for the locale-aware Link and router.
 *
 * CopyDog's eleven languages, in its menu order (the shared `localeEnum`,
 * which also validates PATCH /me).
 */
export const LOCALES = localeEnum;
export type Locale = (typeof LOCALES)[number];

/** Each language in its own name, as CopyDog's menu lists them. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  "zh-TW": "繁體中文",
  "zh-CN": "简体中文",
  ko: "한국어",
  ja: "日本語",
  ru: "Русский",
  tr: "Türkçe",
  vi: "Tiếng Việt",
  es: "Español",
  pt: "Português",
  id: "Bahasa Indonesia",
};

/** Open Graph `og:locale` per language. */
export const OG_LOCALES: Record<Locale, string> = {
  en: "en_US",
  "zh-TW": "zh_TW",
  "zh-CN": "zh_CN",
  ko: "ko_KR",
  ja: "ja_JP",
  ru: "ru_RU",
  tr: "tr_TR",
  vi: "vi_VN",
  es: "es_ES",
  pt: "pt_BR",
  id: "id_ID",
};

/**
 * The `Intl` locale for numbers. CopyDog keeps "$6,293,415.05" and
 * "37.89%" in every language (dates and relative times follow the
 * language), so money and percentages read the same everywhere and never
 * widen a column ("6 293 415,05 $"). 繁中 keeps its own, which matches.
 */
export function numberLocale(locale: Locale): string {
  return locale === "zh-TW" ? "zh-TW" : "en-US";
}

export const DEFAULT_LOCALE: Locale = "zh-TW";
/** The request header the proxy sets to the page's path (with its locale),
 * for canonical and hreflang URLs of pages that don't name their own. */
export const PATH_HEADER = "x-orbie-path";
export const LOCALE_COOKIE = "locale";
/** One year; the choice is a preference, not a session. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Every time on the site is written in UTC, whatever the viewer's own zone
 * (owner, 2026-10-02: 「改統一UTC0」; it replaces Asia/Taipei). Where a time
 * carries a zone label, the label is `TIME_ZONE_LABEL`. */
export const TIME_ZONE = "UTC";
export const TIME_ZONE_LABEL = "UTC";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** `/explore` → `/zh-TW/explore`; `/` → `/zh-TW`. Query and hash are kept.
 * A path that already carries a locale has it replaced. External URLs,
 * `#hash`-only and protocol-relative links pass through. */
export function localePath(locale: Locale, href: string): string {
  if (!href.startsWith("/") || href.startsWith("//")) return href;
  const { path } = splitLocale(href);
  return path === "/" ? `/${locale}` : path.startsWith("/?") || path.startsWith("/#") ? `/${locale}${path.slice(1)}` : `/${locale}${path}`;
}

/** `/en/trader/0x…?a=1` → `{ locale: "en", path: "/trader/0x…?a=1" }`;
 * an unprefixed path → `{ locale: null, path }`. */
export function splitLocale(href: string): { locale: Locale | null; path: string } {
  const match = /^\/([^/?#]+)(.*)$/.exec(href);
  if (match && isLocale(match[1])) {
    const rest = match[2];
    return { locale: match[1], path: rest === "" ? "/" : rest.startsWith("/") ? rest : `/${rest}` };
  }
  return { locale: null, path: href };
}

/** Which of our languages an Accept-Language header asks for first, or
 * null: an exact tag wins, then Chinese by script or region (Hant, TW, HK,
 * MO → zh-TW; Hans, CN, SG and bare zh → zh-CN), then the language alone
 * (pt-BR → pt, en-GB → en). Entries are taken in q order. */
export function negotiateLocale(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const tags = header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find(Boolean);
      return { tag: tag.trim().toLowerCase(), q: q === undefined ? 1 : Number(q), index };
    })
    .filter((entry) => entry.tag && entry.tag !== "*" && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of tags) {
    const exact = LOCALES.find((locale) => locale.toLowerCase() === tag);
    if (exact) return exact;
    const [language, ...subtags] = tag.split("-");
    if (language === "zh") return subtags.some((sub) => ["hant", "tw", "hk", "mo"].includes(sub)) ? "zh-TW" : "zh-CN";
    const base = LOCALES.find((locale) => locale.toLowerCase() === language);
    if (base) return base;
  }
  return null;
}
