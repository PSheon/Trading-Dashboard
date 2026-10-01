"use client";

import { queryKeys } from "@/lib/query-keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useToast } from "@/components/ui/toast";
import { useT } from "@/i18n/provider";
import type {
  Favorite,
  PatchFavoriteAlertRequest,
  TelegramLinkResponse,
  TelegramStatus,
  TelegramTestResponse,
} from "@/lib/contracts";
import { telegramLinkResponseSchema } from "@/lib/contracts";

import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

/**
 * Telegram linking (official bot) and per-favorite trade alerts
 * (CopyDog-style: side + minimum size, up to `maxAlertTraders` traders).
 */

export const TELEGRAM_KEY = queryKeys.telegram;

/** GET /me/telegram. While the page waits for the user to press Start in
 * Telegram, `pollUntil` (epoch ms, the link's expiry) makes it poll every
 * `pollMs` until the chat shows up as linked or that time passes. */
export function useTelegramStatus(options: { pollMs?: number; pollUntil?: number | null } = {}) {
  const { status } = useAuth();
  const { pollMs = 2_000, pollUntil = null } = options;
  return useQuery({
    queryKey: TELEGRAM_KEY,
    queryFn: ({ signal }) => api.get<TelegramStatus>("/me/telegram", signal),
    enabled: status === "signedIn",
    refetchInterval: (query) =>
      pollUntil !== null && Date.now() < pollUntil && !query.state.data?.linked ? pollMs : false,
    refetchIntervalInBackground: pollUntil !== null,
  });
}

/** Whether `url` is the official bot's deep link (`https://t.me/…`); the
 * settings page opens it, so nothing else is followed. */
export function isTelegramLinkUrl(url: unknown): url is string {
  return telegramLinkResponseSchema.shape.url.safeParse(url).success;
}

/** A failed link is CopyDog's "Could not connect Telegram" toast, with the
 * api's reason when it has one. */
export function useCreateTelegramLink() {
  const toast = useToast();
  const t = useT();
  return useMutation<TelegramLinkResponse, ApiError>({
    mutationFn: async () => {
      const link = await api.post<TelegramLinkResponse>("/me/telegram/link");
      if (!isTelegramLinkUrl(link.url)) throw new ApiError(502, "Unexpected Telegram link", { code: "invalid_telegram_link" });
      return link;
    },
    onError: (error) =>
      toast.error(error.code === "rate_limited" ? t("settings.rateLimited") : error.code === "telegram_not_configured" ? t("settings.unavailable") : error.message),
  });
}

/** CopyDog confirms with a "Telegram disconnected" toast. */
export function useUnlinkTelegram() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const t = useT();
  return useMutation<void, ApiError>({
    mutationFn: () => api.delete<void>("/me/telegram"),
    onSuccess: () => toast.success(t("settings.unlinked")),
    onError: (error) => toast.error(error.message),
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
 * alert_limit (with `limit`); as on CopyDog they are toasts (the limit an
 * info one). */
export function useSetFavoriteAlert() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const t = useT();
  return useMutation<Favorite, ApiError, { address: string; patch: PatchFavoriteAlertRequest }>({
    mutationFn: ({ address, patch }) => api.patch<Favorite>(`/me/favorites/${address}/alert`, patch),
    onError: (error) => {
      if (error.code === "telegram_not_linked") toast.error(t("alerts.notLinked"));
      else if (error.code === "alert_limit") toast.info(t("alerts.limit", { limit: typeof error.details.limit === "number" ? error.details.limit : 3 }));
      else toast.error(error.message);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<Favorite[]>(queryKeys.favorites, (list) =>
        list?.map((f) => (f.address === saved.address ? saved : f)),
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.favorites }),
  });
}

/** Favorite first (trader page bell). */
export function useAddFavorite() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const t = useT();
  return useMutation<Favorite, ApiError, string>({
    mutationFn: (address) => api.put<Favorite>(`/me/favorites/${address}`),
    onError: () => toast.error(t("favorites.addFailed")),
    onSuccess: (saved) => {
      queryClient.setQueryData<Favorite[]>(queryKeys.favorites, (list) =>
        list ? [saved, ...list.filter((f) => f.address !== saved.address)] : list,
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.favorites });
      void queryClient.invalidateQueries({ queryKey: queryKeys.trader.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.traders.all });
    },
  });
}
