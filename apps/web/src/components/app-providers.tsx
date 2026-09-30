"use client";

import type { Locale } from "@/i18n/config";
import type { Messages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { AuthProvider } from "@/lib/auth";

/**
 * Client bootstrap: server-selected translations and Privy authentication.
 * Auth owns an identity-scoped QueryClient. Queries set their polling cadence;
 * action SSE and trader WebSockets provide live updates with REST fallback.
 */
export function AppProviders({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: Messages;
  children: React.ReactNode;
}) {
  return (
    <I18nProvider locale={locale} messages={messages}>
      <AuthProvider>{children}</AuthProvider>
    </I18nProvider>
  );
}
