import { localeEnum } from "@trading-dashboard/shared/contracts";

/**
 * Locale settings shared by the server layout and client components.
 *
 * Why no i18n library: there are no localized routes and pages are mostly
 * client-rendered, so a typed dictionary + a cookie covers it (see
 * i18n/provider.tsx). The root layout reads the cookie, passes the one
 * active catalog to the client, and switching locale rewrites the cookie and
 * refreshes the server tree.
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
export const LOCALE_COOKIE = "locale";
/** One year; the choice is a preference, not a session. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** §11 決策紀錄 "時區": the DB is UTC, every time is shown in Taipei. */
export const TIME_ZONE = "Asia/Taipei";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}
