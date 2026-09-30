import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { TraderProfileResponse } from "@/lib/contracts";
import { queryKeys } from "@/lib/query-keys";
import { busyRetry } from "@/lib/query-policy";

/** Shared profile request for featured cards and the trader page; observers own polling. */
export function traderProfileOptions(address: string) {
  return queryOptions({
    queryKey: queryKeys.trader.profile(address),
    queryFn: ({ signal }) => api.get<TraderProfileResponse>(`/traders/${address}`, signal),
    ...busyRetry,
  });
}
