"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CopyStrategyCommand, CreateCopyStrategyRequest, PatchCopyStrategyRequest } from "@trading-dashboard/shared/contracts";

import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { CopyOrdersView, CopyOverview, CopyStrategyView } from "@/lib/contracts";
import { defaultRetry } from "@/lib/query-policy";
import { queryKeys } from "@/lib/query-keys";

/** Paper positions are marked with the api's 3 s mids; a 10 s poll keeps
 * PnL moving without hammering it. */
const COPY_REFETCH_MS = 10_000;

/** GET /me/copy — the paper account and every copy (signed in only). */
export function useCopyOverview() {
  const { status } = useAuth();
  return useQuery({
    queryKey: queryKeys.copy.overview,
    queryFn: ({ signal }) => api.get<CopyOverview>("/me/copy", signal),
    enabled: status === "signedIn",
    staleTime: 5_000,
    refetchInterval: COPY_REFETCH_MS,
    ...defaultRetry,
  });
}

/** The live (not stopped) copy of `leader`, if any. */
export function useCopyOf(leader: string): CopyStrategyView | undefined {
  const overview = useCopyOverview();
  const address = leader.toLowerCase();
  return overview.data?.strategies.find((s) => s.leaderAddress === address && s.status !== "stopped");
}

export function useCopyOrders(strategyId: number | null) {
  const { status } = useAuth();
  return useQuery({
    queryKey: queryKeys.copy.orders(strategyId ?? 0),
    queryFn: ({ signal }) => api.get<CopyOrdersView>(`/me/copy/strategies/${strategyId}/orders`, signal),
    enabled: status === "signedIn" && strategyId !== null,
    staleTime: 5_000,
    refetchInterval: COPY_REFETCH_MS,
    ...defaultRetry,
  });
}

function useCopyMutation<V>(fn: (vars: V) => Promise<CopyStrategyView>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.copy.all }),
  });
}

/** POST /me/copy/strategies — start a paper copy (CopyDog's configure). */
export function useStartCopy() {
  return useCopyMutation((body: Partial<CreateCopyStrategyRequest> & { leader: string; allocationUsd: number }) =>
    api.post<CopyStrategyView>("/me/copy/strategies", body));
}

export function usePatchCopy() {
  return useCopyMutation(({ id, patch }: { id: number; patch: PatchCopyStrategyRequest }) => api.patch<CopyStrategyView>(`/me/copy/strategies/${id}`, patch));
}

export function useAddCopyFunds() {
  return useCopyMutation(({ id, amountUsd }: { id: number; amountUsd: number }) => api.post<CopyStrategyView>(`/me/copy/strategies/${id}/funds`, { amountUsd }));
}

export function useCopyCommand() {
  return useCopyMutation(({ id, command }: { id: number; command: CopyStrategyCommand }) => api.post<CopyStrategyView>(`/me/copy/strategies/${id}/commands`, { command }));
}

/** Days since a copy started, as CopyDog's "{n}d". */
export function copyDays(createdAt: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 86_400_000));
}
