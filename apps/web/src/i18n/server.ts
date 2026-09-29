// Server-only: `next/headers` cannot be imported from a client component.
import type { Metadata } from "next";
import { cookies } from "next/headers";

import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from "./config";
import { catalogs, type Messages } from "./messages";

/** The active locale for this request: the `locale` cookie, else zh-TW. */
export async function getLocale(): Promise<Locale> {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export function getMessages(locale: Locale): Messages {
  return catalogs[locale];
}

/** `export const generateMetadata = titled((m) => m.nav.explore)` */
export function titled(pick: (messages: Messages) => string) {
  return async (): Promise<Metadata> => ({ title: pick(getMessages(await getLocale())) });
}
