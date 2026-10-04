"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminResolvedWithdrawal, AdminUnresolvedWithdrawals } from "@trading-dashboard/shared/contracts";
import { api, type ApiError } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

/** GET /admin/wallet/withdrawals/unresolved (users.read). */
export function useUnresolvedWithdrawals(enabled = true) {
  return useQuery({
    queryKey: queryKeys.admin.unresolvedWithdrawals,
    queryFn: ({ signal }) => api.get<AdminUnresolvedWithdrawals>("/admin/wallet/withdrawals/unresolved", signal),
    enabled,
    refetchInterval: 60_000,
  });
}

/** POST /admin/wallet/withdrawals/:id/resolve (users.manage, audited). */
export function useResolveWithdrawal() {
  const client = useQueryClient();
  return useMutation<AdminResolvedWithdrawal, ApiError, { id: string; reason: string }>({
    mutationFn: ({ id, reason }) => api.post<AdminResolvedWithdrawal>(`/admin/wallet/withdrawals/${encodeURIComponent(id)}/resolve`, { reason }),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.admin.unresolvedWithdrawals }),
  });
}
