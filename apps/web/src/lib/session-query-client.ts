import { defaultRetry } from "@/lib/query-policy";
import { QueryClient } from "@tanstack/react-query";

export function createSessionQueryClient() {
  return new QueryClient({ defaultOptions: { queries: {
    refetchInterval: 10_000,
    // Off by default (leaderboards, fills and analytics are costly and poll
    // on their own); queries whose figures the user reads (balances,
    // portfolio, copies, a trader's KPIs) turn it on.
    refetchOnWindowFocus: false,
    staleTime: 5_000,
    ...defaultRetry,
  } } });
}
