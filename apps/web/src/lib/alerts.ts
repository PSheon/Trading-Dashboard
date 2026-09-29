"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Favorite,
  PatchFavoriteAlertRequest,
  TelegramLinkResponse,
  TelegramStatus,
  TelegramTestResponse,
} from "@trading-dashboard/shared";

import { api, type ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

/**
 * Telegram linking (official bot) and per-favorite trade alerts
 * (CopyDog-style: side + minimum size, up to `maxAlertTraders` traders).
 */

export const TELEGRAM_KEY = ["telegram"] as const;

/** GET /me/telegram. While the page waits for the user to press Start in
 * Telegram, `pollUntil` (epoch ms, the link's expiry) makes it poll every
 * `pollMs` until the chat shows up as linked or that time passes. */
export function useTelegramStatus(options: { pollMs?: number; pollUntil?: number | null } = {}) {
  const { status } = useAuth();
  const { pollMs = 2_000, pollUntil = null } = options;
  return useQuery({
    queryKey: TELEGRAM_KEY,
    queryFn: () => api.get<TelegramStatus>("/me/telegram"),
    enabled: status === "signedIn",
    refetchInterval: (query) =>
      pollUntil !== null && Date.now() < pollUntil && !query.state.data?.linked ? pollMs : false,
    refetchIntervalInBackground: pollUntil !== null,
  });
}

export function useCreateTelegramLink() {
  return useMutation<TelegramLinkResponse, ApiError>({
    mutationFn: () => api.post<TelegramLinkResponse>("/me/telegram/link"),
  });
}

export function useUnlinkTelegram() {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError>({
    mutationFn: () => api.delete<void>("/me/telegram"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: TELEGRAM_KEY }),
  });
}

export function useTelegramTest() {
  return useMutation<TelegramTestResponse, ApiError>({
    mutationFn: () => api.post<TelegramTestResponse>("/me/telegram/test"),
  });
}

/** PATCH /me/favorites/:address/alert; the favorites list is updated in
 * place with the answer. 409s carry `code`: telegram_not_linked or
 * alert_limit (with `limit`). */
export function useSetFavoriteAlert() {
  const queryClient = useQueryClient();
  return useMutation<Favorite, ApiError, { address: string; patch: PatchFavoriteAlertRequest }>({
    mutationFn: ({ address, patch }) => api.patch<Favorite>(`/me/favorites/${address}/alert`, patch),
    onSuccess: (saved) => {
      queryClient.setQueryData<Favorite[]>(["favorites"], (list) =>
        list?.map((f) => (f.address === saved.address ? saved : f)),
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["favorites"] }),
  });
}

/** Favorite first (trader page bell). */
export function useAddFavorite() {
  const queryClient = useQueryClient();
  return useMutation<Favorite, ApiError, string>({
    mutationFn: (address) => api.put<Favorite>(`/me/favorites/${address}`),
    onSuccess: (saved) => {
      queryClient.setQueryData<Favorite[]>(["favorites"], (list) =>
        list ? [saved, ...list.filter((f) => f.address !== saved.address)] : list,
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["favorites"] });
      void queryClient.invalidateQueries({ queryKey: ["trader"] });
      void queryClient.invalidateQueries({ queryKey: ["traders"] });
    },
  });
}
