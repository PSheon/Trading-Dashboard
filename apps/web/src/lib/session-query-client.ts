import { defaultRetry } from "@/lib/query-policy";
import { QueryClient } from "@tanstack/react-query";

export function createSessionQueryClient() {
  return new QueryClient({ defaultOptions: { queries: {
    refetchInterval: 10_000,
    refetchOnWindowFocus: false,
    staleTime: 5_000,
    ...defaultRetry,
  } } });
}
