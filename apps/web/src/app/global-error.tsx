"use client";

import "./globals.css";

import { RouteError } from "@/components/route-error";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from "@/i18n/config";
import { GLOBAL_ERROR_TEXT } from "@/lib/global-error-text";

/** The visitor's language without the i18n provider: the `locale` cookie. */
function cookieLocale(): Locale {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const value = document.cookie.split("; ").find((part) => part.startsWith(`${LOCALE_COOKIE}=`))?.split("=")[1];
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** The last resort: the root layout itself threw, so this renders its own
 * document — the site's stylesheet and dark theme, no shell, no providers. */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const locale = cookieLocale();
  const text = GLOBAL_ERROR_TEXT[locale];
  return (
    <html lang={locale} className="dark h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full bg-background text-foreground">
        <title>{text.title}</title>
        <RouteError error={error} retry={retry} title={text.title} retryLabel={text.retry} homeLabel={text.home} />
      </body>
    </html>
  );
}
