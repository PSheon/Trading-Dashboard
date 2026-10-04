"use client";

import { useRouter } from "next/navigation";
import { createContext, use, useCallback, useMemo, useTransition } from "react";

import { createFormatter, type Formatter } from "@/lib/format";
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, type Locale } from "./config";
import type { MessageKey, Messages } from "./messages";

export type TranslateValues = Record<string, string | number>;
export type Translate = (key: MessageKey, values?: TranslateValues) => string;

interface I18nContextValue {
  locale: Locale;
  t: Translate;
  format: Formatter;
  /** Writes the cookie and re-renders the server tree in the new locale. */
  setLocale: (next: Locale) => void;
  switching: boolean;
}

const I18nContext = createContext<I18nContextValue | null>(null);

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
      if (next === locale) return;
      document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(next)}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
      startTransition(() => router.refresh());
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

export function useT(): Translate {
  return useI18nContext().t;
}

export function useFormat(): Formatter {
  return useI18nContext().format;
}
