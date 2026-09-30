/**
 * Locale settings shared by the server layout and client components.
 *
 * Why no i18n library: the app has two locales, no localized routes and
 * mostly client-rendered pages, so a typed dictionary + a cookie covers it
 * (see i18n/provider.tsx). The root layout reads the cookie, passes the one
 * active catalog to the client, and switching locale rewrites the cookie and
 * refreshes the server tree.
 */
export const LOCALES = ["zh-TW", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** Each language in its own name, as CopyDog's menu lists them. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  "zh-TW": "繁體中文",
};

export const DEFAULT_LOCALE: Locale = "zh-TW";
export const LOCALE_COOKIE = "locale";
/** One year; the choice is a preference, not a session. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** §11 決策紀錄 "時區": the DB is UTC, every time is shown in Taipei. */
export const TIME_ZONE = "Asia/Taipei";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}
