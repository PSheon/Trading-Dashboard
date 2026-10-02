"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useToast } from "@/components/ui/toast";
import { useT } from "@/i18n/provider";
import { api, apiErrorCode, type ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { FAVORITE_GROUPS_MAX, type FavoriteGroup, type FavoriteGroupInput, type TraderCardsResponse } from "@/lib/contracts";
import { queryKeys } from "@/lib/query-keys";

/**
 * Favorites groups (CopyDog's watchlist groups) and the watchlist cards.
 * Every write refreshes the group list; membership changes are applied to
 * the cached list at once so chips and tags don't flicker. A write that
 * fails raises CopyDog's toast ("Failed to create group", …).
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

/** The toast for a failed group write: the 409 reasons by name, else
 * "Failed to update group". */
function useGroupFailure() {
  const toast = useToast();
  const t = useT();
  return (error: unknown) => {
    const code = apiErrorCode(error);
    toast.error(
      code === "group_name_exists" ? t("favorites.groups.exists") :
      code === "group_limit" ? t("favorites.groups.limit", { limit: FAVORITE_GROUPS_MAX }) :
      t("favorites.groups.failed"),
    );
  };
}

/** POST /me/favorite-groups; 409 `group_name_exists` / `group_limit`. */
export function useCreateFavoriteGroup() {
  const refresh = useRefresh();
  const failed = useGroupFailure();
  return useMutation<FavoriteGroup, ApiError, FavoriteGroupInput>({
    mutationFn: (body) => api.post<FavoriteGroup>("/me/favorite-groups", body),
    onError: failed,
    onSettled: refresh,
  });
}

export function useDeleteFavoriteGroup() {
  const refresh = useRefresh();
  const failed = useGroupFailure();
  return useMutation<void, ApiError, number>({
    mutationFn: (id) => api.delete<void>(`/me/favorite-groups/${id}`),
    onError: failed,
    onSettled: refresh,
  });
}

/** Adds `address` to group `id`, or removes it (`member: false`). */
export function useToggleGroupMember() {
  const client = useQueryClient();
  const failed = useGroupFailure();
  return useMutation<unknown, ApiError, { id: number; address: string; member: boolean }>({
    mutationFn: ({ id, address, member }) =>
      member ? api.put<void>(`/me/favorite-groups/${id}/members/${address}`) : api.delete<void>(`/me/favorite-groups/${id}/members/${address}`),
    onMutate: ({ id, address, member }) => {
      client.setQueryData<FavoriteGroup[]>(queryKeys.favoriteGroups, (groups) =>
        groups?.map((g) => (g.id !== id ? g : { ...g, addresses: member ? [...new Set([...g.addresses, address])] : g.addresses.filter((a) => a !== address) })),
      );
    },
    onError: failed,
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
