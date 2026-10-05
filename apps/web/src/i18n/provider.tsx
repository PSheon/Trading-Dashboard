"use client";

import { useRouter } from "next/navigation";
import { createContext, use, useCallback, useMemo, useTransition } from "react";

import { createFormatter, type Formatter } from "@/lib/format";
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, localePath, type Locale } from "./config";
import type { MessageKey, Messages } from "./messages";

export type TranslateValues = Record<string, string | number>;
export type Translate = (key: MessageKey, values?: TranslateValues) => string;

interface I18nContextValue {
  locale: Locale;
  t: Translate;
  format: Formatter;
  /** Saves the choice (the cookie) and opens the same page, with the same
   * query, under the new locale's prefix. */
  setLocale: (next: Locale) => void;
  switching: boolean;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/** The visitor's saved language: where an unprefixed URL sends them. */
export function writeLocaleCookie(locale: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
}

/** The saved language, if any. */
export function readLocaleCookie(): string | null {
  const match = document.cookie.split("; ").find((part) => part.startsWith(`${LOCALE_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(LOCALE_COOKIE.length + 1)) : null;
}

function lookup(messages: Messages, key: string): string | undefined {
  let node: unknown = messages;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

export function I18nProvider({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: Messages;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [switching, startTransition] = useTransition();

  const t = useCallback<Translate>(
    (key, values) => {
      const template = lookup(messages, key);
      if (template === undefined) {
        if (process.env.NODE_ENV !== "production") console.warn(`[i18n] missing key ${key}`);
        return key;
      }
      if (!values) return template;
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in values ? String(values[name]) : match,
      );
    },
    [messages],
  );

  const format = useMemo(() => createFormatter(locale), [locale]);

  const setLocale = useCallback(
    (next: Locale) => {
      writeLocaleCookie(next);
      if (next === locale) return;
      const { pathname, search, hash } = window.location;
      startTransition(() => router.replace(localePath(next, `${pathname}${search}${hash}`), { scroll: false }));
    },
    [locale, router],
  );

  const value = useMemo(
    () => ({ locale, t, format, setLocale, switching }),
    [locale, t, format, setLocale, switching],
  );

  return <I18nContext value={value}>{children}</I18nContext>;
}

function useI18nContext(): I18nContextValue {
  const ctx = use(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}

export function useI18n() {
  return useI18nContext();
}

/** The page's locale, or the default outside a provider (a link rendered
 * on its own). */
export function useCurrentLocale(): Locale {
  return use(I18nContext)?.locale ?? DEFAULT_LOCALE;
}

export function useT(): Translate {
  return useI18nContext().t;
}

export function useFormat(): Formatter {
  return useI18nContext().format;
}
