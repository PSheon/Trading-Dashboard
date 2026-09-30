"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiError } from "@/lib/api";
import type { AdminUser, AdminUsersResponse, PatchAdminUserRequest, UserRole } from "@/lib/contracts";
import { queryKeys } from "@/lib/query-keys";

/** Owns server pagination and cache identity; the view owns search debounce and selection. */
export function useAdminUsers(params: { q: string; role: UserRole | ""; limit: number; offset: number }) {
  const qs = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) });
  if (params.q) qs.set("q", params.q);
  if (params.role) qs.set("role", params.role);
  return useQuery({
    queryKey: queryKeys.admin.users.list(qs.toString()),
    queryFn: ({ signal }) => api.get<AdminUsersResponse>(`/admin/users?${qs}`, signal),
    placeholderData: keepPreviousData,
    refetchInterval: false,
  });
}

/** Refresh every cached filter/page after a role or disabled-state change. */
export function useUpdateAdminUser() {
  const client = useQueryClient();
  return useMutation<AdminUser, ApiError, { id: number; patch: PatchAdminUserRequest }>({
    mutationFn: ({ id, patch }) => api.patch<AdminUser>(`/admin/users/${id}`, patch),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.admin.users.all }),
  });
}
