import { defaultRetry } from "@/lib/query-policy";
import { QueryClient } from "@tanstack/react-query";

export function createSessionQueryClient() {
  return new QueryClient({ defaultOptions: { queries: {
    // No polling unless a query asks for it: searches, admin lists and
    // local journals never meant to (audit #8). Live status opts in.
    refetchInterval: false,
    // Off by default (leaderboards, fills and analytics are costly and poll
    // on their own); queries whose figures the user reads (balances,
    // portfolio, copies, a trader's KPIs) turn it on.
    refetchOnWindowFocus: false,
    staleTime: 5_000,
    ...defaultRetry,
  } } });
}
