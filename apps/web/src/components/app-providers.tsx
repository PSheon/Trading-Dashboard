"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

/**
 * §11 決策紀錄: "前端即時更新 — React Query 每 10 秒輪詢 REST；不做 WS 到前端".
 * A 10s default refetchInterval lives here so every query opts into the
 * same polling cadence unless a page overrides it.
 */
export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchInterval: 10_000,
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
