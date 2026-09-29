"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import type { Locale } from "@/i18n/config";
import type { Messages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { AuthProvider } from "@/lib/auth";

/**
 * Client-side providers: i18n (active catalog from the server), React Query
 * (§11 決策紀錄: poll REST, no WS to the browser — each query sets its own
 * cadence, 10 s by default) and auth (Privy when configured).
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
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchInterval: 10_000,
            refetchOnWindowFocus: false,
            staleTime: 5_000,
            retry: (count, error) => {
              const status = (error as { status?: number }).status;
              if (status && status >= 400 && status < 500) return false;
              return count < 1;
            },
          },
        },
      }),
  );

  return (
    <I18nProvider locale={locale} messages={messages}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}
