"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { CreateFavoriteGroupRequest, FavoriteGroup, PatchFavoriteGroupRequest, TraderCardsResponse } from "@/lib/contracts";
import { queryKeys } from "@/lib/query-keys";

/**
 * Favorites groups (CopyDog's watchlist groups) and the watchlist cards.
 * Every write refreshes the group list; membership changes are applied to
 * the cached list at once so chips and tags don't flicker.
 */

/** GET /me/favorite-groups. */
export function useFavoriteGroups() {
  const { status } = useAuth();
  return useQuery({
    queryKey: queryKeys.favoriteGroups,
    queryFn: ({ signal }) => api.get<FavoriteGroup[]>("/me/favorite-groups", signal),
    enabled: status === "signedIn",
    refetchInterval: false,
  });
}

function useRefresh() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: queryKeys.favoriteGroups });
}

/** POST /me/favorite-groups; 409 `group_exists` / `group_limit`. */
export function useCreateFavoriteGroup() {
  const refresh = useRefresh();
  return useMutation<FavoriteGroup, ApiError, CreateFavoriteGroupRequest>({
    mutationFn: (body) => api.post<FavoriteGroup>("/me/favorite-groups", body),
    onSettled: refresh,
  });
}

export function usePatchFavoriteGroup() {
  const refresh = useRefresh();
  return useMutation<FavoriteGroup, ApiError, { id: number; patch: PatchFavoriteGroupRequest }>({
    mutationFn: ({ id, patch }) => api.patch<FavoriteGroup>(`/me/favorite-groups/${id}`, patch),
    onSettled: refresh,
  });
}

export function useDeleteFavoriteGroup() {
  const refresh = useRefresh();
  return useMutation<void, ApiError, number>({
    mutationFn: (id) => api.delete<void>(`/me/favorite-groups/${id}`),
    onSettled: refresh,
  });
}

/** Adds `address` to group `id`, or removes it (`member: false`). */
export function useToggleGroupMember() {
  const client = useQueryClient();
  return useMutation<unknown, ApiError, { id: number; address: string; member: boolean }>({
    mutationFn: ({ id, address, member }) =>
      member ? api.put<FavoriteGroup>(`/me/favorite-groups/${id}/members/${address}`) : api.delete<void>(`/me/favorite-groups/${id}/members/${address}`),
    onMutate: ({ id, address, member }) => {
      client.setQueryData<FavoriteGroup[]>(queryKeys.favoriteGroups, (groups) =>
        groups?.map((g) => (g.id !== id ? g : { ...g, members: member ? [...new Set([...g.members, address])] : g.members.filter((a) => a !== address) })),
      );
    },
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.favoriteGroups }),
  });
}

/** GET /discover/cards: watchlist cards for these addresses (the api's
 * discovery pool, else the leaderboard; no upstream calls). */
export function useTraderCards(addresses: string[]) {
  const key = addresses.join(",");
  return useQuery({
    queryKey: queryKeys.discover.cards(key),
    queryFn: ({ signal }) => api.get<TraderCardsResponse>(`/discover/cards?addresses=${key}`, signal),
    enabled: addresses.length > 0,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
