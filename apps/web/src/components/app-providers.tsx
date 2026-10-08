"use client";

import type { Locale } from "@/i18n/config";
import type { Messages } from "@/i18n/messages";
import { ToastProvider, ToastSessionBoundary } from "@/components/ui/toast";
import { I18nProvider } from "@/i18n/provider";
import { Suspense } from "react";
import { ReferralRouteCapture } from "@/components/settings/referral";
import { AuthProvider } from "@/lib/auth";
import type { ThemeChoice } from "@/lib/theme";
import { ThemeProvider } from "@/lib/use-theme";

/**
 * Client bootstrap: server-selected translations, Orbie's notifications and Privy
 * authentication. Auth owns an identity-scoped QueryClient. Queries set
 * their polling cadence; action SSE and trader WebSockets provide live
 * updates with REST fallback.
 */
export function AppProviders({
  locale,
  messages,
  themeChoice = "system",
  children,
}: {
  locale: Locale;
  messages: Messages;
  themeChoice?: ThemeChoice;
  children: React.ReactNode;
}) {
  return (
    <ThemeProvider initialChoice={themeChoice}>
    <I18nProvider locale={locale} messages={messages}>
      <ToastProvider>
        <AuthProvider>
          <ToastSessionBoundary>
            <Suspense fallback={null}>
              <ReferralRouteCapture />
            </Suspense>
            {children}
          </ToastSessionBoundary>
        </AuthProvider>
      </ToastProvider>
    </I18nProvider>
    </ThemeProvider>
  );
}
