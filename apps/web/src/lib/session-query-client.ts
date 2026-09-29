import { QueryClient } from "@tanstack/react-query";

export function createSessionQueryClient() {
  return new QueryClient({ defaultOptions: { queries: {
    refetchInterval: 10_000,
    refetchOnWindowFocus: false,
    staleTime: 5_000,
    retry: (count, error) => {
      const status = (error as { status?: number }).status;
      if (status && status >= 400 && status < 500) return false;
      return count < 1;
    },
  } } });
}
