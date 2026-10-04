"use client";

import "./globals.css";

import { useSyncExternalStore } from "react";

import { RouteError } from "@/components/route-error";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from "@/i18n/config";
import { GLOBAL_ERROR_TEXT } from "@/lib/global-error-text";


/** The visitor's language without the i18n provider: the `locale` cookie. */
function cookieLocale(): Locale {
  const value = document.cookie.split("; ").find((part) => part.startsWith(`${LOCALE_COOKIE}=`))?.split("=")[1];
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

const noSubscription = () => () => {};

/** The last resort: the root layout itself threw, so this renders its own
 * document — the site's stylesheet and dark theme, no shell, no providers. */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  // Read after hydration: the server renders the default language, and a
  // cookie read during render made the first client frame differ from it.
  const locale = useSyncExternalStore(noSubscription, cookieLocale, () => DEFAULT_LOCALE);
  const text = GLOBAL_ERROR_TEXT[locale];
  return (
    <html lang={locale} className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full bg-background text-foreground">
        <title>{text.title}</title>
        <RouteError error={error} retry={retry} title={text.title} retryLabel={text.retry} homeLabel={text.home} />
      </body>
    </html>
  );
}
