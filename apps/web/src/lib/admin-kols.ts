"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiError } from "@/lib/api";
import type { Kol, KolImportResponse } from "@/lib/contracts";
import { queryKeys } from "@/lib/query-keys";

export interface KolDraft {
  address: string;
  displayName: string | null;
  avatarUrl: string | null;
  xHandle: string | null;
  verified: boolean;
  sortOrder: number;
}

/** The KOL registry (admin). Every change refreshes the list and the
 * public boards that show KOL names. */
export function useKols() {
  return useQuery({
    queryKey: queryKeys.admin.kols,
    queryFn: ({ signal }) => api.get<Kol[]>("/admin/kols", signal),
    refetchInterval: false,
  });
}

function useInvalidate() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: queryKeys.admin.kols });
    void client.invalidateQueries({ queryKey: queryKeys.discover.home });
    void client.invalidateQueries({ queryKey: queryKeys.discover.boards });
  };
}

export function useSaveKol() {
  const invalidate = useInvalidate();
  return useMutation<Kol, ApiError, { draft: KolDraft; existing: boolean }>({
    mutationFn: ({ draft, existing }) => {
      const { address, ...rest } = draft;
      return existing ? api.patch<Kol>(`/admin/kols/${address}`, rest) : api.post<Kol>("/admin/kols", draft);
    },
    onSuccess: invalidate,
  });
}

export function useRemoveKol() {
  const invalidate = useInvalidate();
  return useMutation<void, ApiError, string>({
    mutationFn: (address) => api.delete<void>(`/admin/kols/${address}`),
    onSuccess: invalidate,
  });
}

export function useImportKols() {
  const invalidate = useInvalidate();
  return useMutation<KolImportResponse, ApiError, { csv: string; replace: boolean }>({
    mutationFn: (body) => api.post<KolImportResponse>("/admin/kols/import", body),
    onSuccess: invalidate,
  });
}
