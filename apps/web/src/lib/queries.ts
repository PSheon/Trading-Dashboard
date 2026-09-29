"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ActionFeedItem,
  AlertEntry,
  CrowdResponse,
  Favorite,
  PublicSettings,
  PortfolioResponse,
  SparklinesResponse,
  TraderFill,
  TraderProfileResponse,
  TradersResponse,
  TraderWindow,
} from "@trading-dashboard/shared";

import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

/**
 * React Query hooks for the Stage 2 endpoints. Polling follows how fast the
 * data changes: the leaderboard every 15 min upstream, portfolios cached 60 s
 * by the api, the action feed live.
 */

/** GET /settings — public site settings (announcement, featured traders,
 * market chips, vault default, low-sample threshold, referral code). */
export function useSiteSettings() {
  return useQuery({
    queryKey: ["site-settings"],
    queryFn: () => api.get<PublicSettings>("/settings"),
    staleTime: 5 * 60_000,
    refetchInterval: false,
  });
}

export function useCrowd() {
  return useQuery({
    queryKey: ["crowd"],
    queryFn: () => api.get<CrowdResponse>("/insights/crowd"),
    refetchInterval: 60_000,
  });
}

export type TraderSort = "pnl" | "roi" | "volume" | "accountValue";

export interface TradersParams {
  window: TraderWindow;
  sort: TraderSort;
  order: "asc" | "desc";
  q?: string;
  minAccountValue?: number;
  /** Undefined → the api applies the admin default. */
  hideVaults?: boolean;
  limit: number;
  offset: number;
}

export function useTraders(params: TradersParams) {
  const qs = new URLSearchParams({
    window: params.window,
    sort: params.sort,
    order: params.order,
    limit: String(params.limit),
    offset: String(params.offset),
  });
  if (params.q) qs.set("q", params.q);
  if (params.minAccountValue) qs.set("minAccountValue", String(params.minAccountValue));
  if (params.hideVaults !== undefined) qs.set("hideVaults", String(params.hideVaults));
  return useQuery({
    queryKey: ["traders", qs.toString()],
    queryFn: () => api.get<TradersResponse>(`/traders?${qs.toString()}`),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

export function useSparklines(addresses: string[], window: TraderWindow = "month") {
  const key = addresses.join(",");
  return useQuery({
    queryKey: ["sparklines", window, key],
    queryFn: () =>
      api.get<SparklinesResponse>(
        `/traders/sparklines?addresses=${encodeURIComponent(key)}&window=${window}`,
      ),
    enabled: addresses.length > 0,
    staleTime: 10 * 60_000,
    refetchInterval: false,
  });
}

export function useTraderProfile(address: string) {
  return useQuery({
    queryKey: ["trader", address],
    queryFn: () => api.get<TraderProfileResponse>(`/traders/${address}`),
    refetchInterval: 30_000,
  });
}

export function usePortfolio(address: string, window: TraderWindow, market: "all" | "perp") {
  return useQuery({
    queryKey: ["portfolio", address, window, market],
    queryFn: () =>
      api.get<PortfolioResponse>(`/traders/${address}/portfolio?window=${window}&market=${market}`),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

export function useTraderFills(address: string, limit = 100) {
  return useQuery({
    queryKey: ["trader-fills", address, limit],
    queryFn: () => api.get<TraderFill[]>(`/traders/${address}/fills?limit=${limit}`),
    refetchInterval: 30_000,
  });
}

export interface ActionsParams {
  scope?: "all" | "favorites";
  address?: string;
  coin?: string;
  kind?: string;
  tier?: string;
  limit?: number;
}

export function useActions(params: ActionsParams, options: { enabled?: boolean } = {}) {
  const qs = new URLSearchParams();
  if (params.scope && params.scope !== "all") qs.set("scope", params.scope);
  if (params.address) qs.set("address", params.address);
  if (params.coin) qs.set("coin", params.coin);
  if (params.kind) qs.set("kind", params.kind);
  if (params.tier) qs.set("tier", params.tier);
  qs.set("limit", String(params.limit ?? 100));
  return useQuery({
    queryKey: ["actions", qs.toString()],
    queryFn: () => api.get<ActionFeedItem[]>(`/actions?${qs.toString()}`),
    enabled: options.enabled ?? true,
    refetchInterval: 10_000,
  });
}

export function useAlerts(address: string | undefined, options: { enabled?: boolean } = {}) {
  const qs = new URLSearchParams({ limit: "100" });
  if (address) qs.set("address", address);
  return useQuery({
    queryKey: ["alerts", qs.toString()],
    queryFn: () => api.get<AlertEntry[]>(`/alerts?${qs.toString()}`),
    enabled: options.enabled ?? true,
    refetchInterval: 30_000,
  });
}

export function useFavorites() {
  const { status } = useAuth();
  return useQuery({
    queryKey: ["favorites"],
    queryFn: () => api.get<Favorite[]>("/me/favorites"),
    enabled: status === "signedIn",
    refetchInterval: 60_000,
  });
}

/** Star / unstar. Signed out → opens the login instead. */
export function useToggleFavorite() {
  const queryClient = useQueryClient();
  const { status, login } = useAuth();
  const mutation = useMutation({
    mutationFn: async ({ address, favorite }: { address: string; favorite: boolean }) => {
      if (favorite) await api.put<Favorite>(`/me/favorites/${address}`);
      else await api.delete<void>(`/me/favorites/${address}`);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["favorites"] });
      void queryClient.invalidateQueries({ queryKey: ["traders"] });
      void queryClient.invalidateQueries({ queryKey: ["trader"] });
      void queryClient.invalidateQueries({ queryKey: ["actions"] });
    },
  });

  return {
    canToggle: status === "signedIn",
    needsLogin: status === "signedOut",
    pending: mutation.isPending ? mutation.variables?.address : undefined,
    toggle(address: string, next: boolean) {
      if (status !== "signedIn") {
        if (status === "signedOut") login();
        return;
      }
      mutation.mutate({ address, favorite: next });
    },
  };
}
