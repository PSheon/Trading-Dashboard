// Server-only: `next/root-params` cannot be imported from a client component.
import type { Metadata } from "next";
import { locale as rootLocale } from "next/root-params";

import { DEFAULT_LOCALE, isLocale, type Locale } from "./config";
import { catalogs, type Messages } from "./messages";

/** The active locale for this request: the URL's `/<locale>/` segment (the
 * root layout's param, readable from any server component). An unknown
 * segment never reaches a page (the root layout answers 404), so the
 * default here only covers code that runs outside the `[locale]` tree. */
export async function getLocale(): Promise<Locale> {
  let value: string | undefined;
  try {
    value = await rootLocale();
  } catch {
    // Outside a page render (unit tests render pages directly).
  }
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export function getMessages(locale: Locale): Messages {
  return catalogs[locale];
}

/** `export const generateMetadata = titled((m) => m.nav.explore)` */
export function titled(pick: (messages: Messages) => string) {
  return async (): Promise<Metadata> => ({ title: pick(getMessages(await getLocale())) });
}
