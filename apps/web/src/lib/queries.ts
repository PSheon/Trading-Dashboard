"use client";

import { busyRetry, computingRetry } from "@/lib/query-policy";
import { traderProfileOptions } from "@/lib/trader-query-options";
import { queryKeys } from "@/lib/query-keys";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ActionFeedItem,
  ActiveWithin,
  AlertEntry,
  BoardMarket,
  BoardResponse,
  BoardSort,
  BoardWindow,
  CopyScoreResponse,
  HomeBoardsResponse,
  TradingStyle,
  CrowdResponse,
  Favorite,
  PublicSettings,
  PortfolioResponse,
  SparklinesResponse,
  TraderActivityResponse,
  TraderAnalyticsResponse,
  TraderTradesResponse,
  TradeWindow,
  TraderFill,
  TraderOrdersResponse,
  TradersResponse,
  TraderTransfersResponse,
  TraderTwapsResponse,
  TraderWindow,
} from "@/lib/contracts";

import { useState } from "react";

import { actionsQueryString, mergeFetched, type ActionsParams } from "@/lib/action-stream";
import { api, isBusy } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useActionStream } from "@/lib/use-action-stream";
import { isStreamingTrader } from "@/lib/use-live-trader";

/**
 * React Query hooks for the Stage 2 endpoints. Polling follows how fast the
 * data changes: the leaderboard every 15 min upstream, portfolios cached 60 s
 * by the api, the action feed live.
 */

/** GET /settings — public site settings (announcement, featured traders,
 * market chips, vault and activity defaults, low-sample threshold, referral
 * code). */
export function useSiteSettings() {
  return useQuery({
    queryKey: queryKeys.siteSettings,
    queryFn: ({ signal }) => api.get<PublicSettings>("/settings", signal),
    staleTime: 5 * 60_000,
    refetchInterval: false,
  });
}

export function useCrowd() {
  return useQuery({
    queryKey: queryKeys.crowd,
    queryFn: ({ signal }) => api.get<CrowdResponse>("/insights/crowd", signal),
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
  /** Traded within this window (§12); undefined → the admin default. */
  active?: ActiveWithin;
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
  if (params.active !== undefined) qs.set("active", params.active);
  return useQuery({
    queryKey: queryKeys.traders.list(qs.toString()),
    queryFn: ({ signal }) => api.get<TradersResponse>(`/traders?${qs.toString()}`, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

export interface BoardParams {
  market: BoardMarket;
  /** "top100", "kol" or a coin ("BTC", "xyz:TSLA"). */
  board: string;
  sort: BoardSort;
  window: BoardWindow;
  style?: TradingStyle;
}

/** GET /discover/boards: one explore board (fixed top 100), from the api's
 * discovery pool; it changes a row at a time, so a minute's polling is
 * plenty. The previous board stays up while the next one loads. */
export function useBoard(params: BoardParams) {
  const qs = new URLSearchParams({ market: params.market, board: params.board, sort: params.sort, window: params.window });
  if (params.style) qs.set("style", params.style);
  return useQuery({
    queryKey: queryKeys.discover.board(qs.toString()),
    queryFn: ({ signal }) => api.get<BoardResponse>(`/discover/boards?${qs.toString()}`, signal),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** GET /discover/home: every home row and the calculator's traders. */
export function useHomeBoards() {
  return useQuery({
    queryKey: queryKeys.discover.home,
    queryFn: ({ signal }) => api.get<HomeBoardsResponse>("/discover/home", signal),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** GET /traders/:address/copy-score: the rail's 複製評分 (shares the api's
 * portfolio cache with the chart, so it costs no extra upstream read). */
export function useCopyScore(address: string) {
  return useQuery({
    queryKey: queryKeys.trader.copyScore(address),
    queryFn: ({ signal }) => api.get<CopyScoreResponse>(`/traders/${address}/copy-score`, signal),
    staleTime: 5 * 60_000,
    refetchInterval: false,
    ...busyRetry,
  });
}

/** Asks again this often while some addresses are still loading … */
export const SPARKLINE_RETRY_MS = 3_000;
/** … at most this many times. */
export const SPARKLINE_MAX_POLLS = 10;

/** Addresses the api left out of a sparkline answer (still loading). */
export function missingSparklines(addresses: string[], data: SparklinesResponse | undefined): string[] {
  return data ? addresses.filter((a) => !(a in data)) : [];
}

/**
 * PnL sparklines for a row of traders. The api answers within a few seconds
 * with the ones it has and leaves the rest out while they load into its
 * cache (a cold explore page), so this asks again until every address is
 * in, rendering each as it arrives.
 */
export function useSparklines(addresses: string[], window: TraderWindow = "month") {
  const key = addresses.join(",");
  return useQuery({
    queryKey: queryKeys.sparklines(window, key),
    queryFn: ({ signal }) =>
      api.get<SparklinesResponse>(
        `/traders/sparklines?addresses=${encodeURIComponent(key)}&window=${window}`,
        signal,
      ),
    enabled: addresses.length > 0,
    staleTime: 10 * 60_000,
    refetchInterval: (query) =>
      missingSparklines(addresses, query.state.data).length > 0 && query.state.dataUpdateCount <= SPARKLINE_MAX_POLLS
        ? SPARKLINE_RETRY_MS
        : false,
  });
}

/** While the trader page streams an address from Hyperliquid's WebSocket,
 * its REST data is only the fallback: refresh it rarely. */
const POLL_MS = 30_000;
const POLL_WHILE_LIVE_MS = 5 * 60_000;
const livePoll = (address: string) => () => (isStreamingTrader(address) ? POLL_WHILE_LIVE_MS : POLL_MS);

/** GET /traders/:address: the first paint (account, positions, stats). */
export function useTraderProfile(address: string) {
  return useQuery({
    ...traderProfileOptions(address),
    refetchInterval: query => query.state.data?.dataQuality?.partial ? 5_000 : livePoll(address)(),
    ...busyRetry,
  });
}

/** GET /traders/:address/activity: sample size and last trade, loaded
 * alongside the profile (it costs the api more and arrives later). */
export function useTraderActivity(address: string) {
  return useQuery({
    queryKey: queryKeys.trader.activity(address),
    queryFn: ({ signal }) => api.get<TraderActivityResponse>(`/traders/${address}/activity`, signal),
    refetchInterval: 60_000,
    ...busyRetry,
  });
}

export function usePortfolio(address: string, window: TraderWindow, market: "all" | "perp") {
  return useQuery({
    queryKey: queryKeys.trader.portfolio(address, window, market),
    queryFn: ({ signal }) =>
      api.get<PortfolioResponse>(`/traders/${address}/portfolio?window=${window}&market=${market}`, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    ...busyRetry,
  });
}

/**
 * A cold address's trade analytics take the api a while (it reads the
 * address's fill history from Hyperliquid): it answers 503 busy until they
 * are stored, and these queries keep asking, every Retry-After, for up to
 * ~10 minutes. The page shows a "computing" state meanwhile.
 */
export { ANALYTICS_BUSY_RETRIES } from "@/lib/query-policy";

/** Still computing: no data yet and the last answer was busy. */
export function isComputing(query: { data?: unknown; failureReason: Error | null; isPending: boolean }): boolean {
  return query.data === undefined && (query.isPending || isBusy(query.failureReason));
}

/** GET /traders/:address/analytics: win rate, trade count, best / worst,
 * coins and tiers, for any address (served from the api's store). */
export function useTraderAnalytics(address: string, window: TradeWindow) {
  return useQuery({
    queryKey: queryKeys.trader.analytics(address, window),
    queryFn: ({ signal }) => api.get<TraderAnalyticsResponse>(`/traders/${address}/analytics?window=${window}`, signal),
    placeholderData: keepPreviousData,
    // The api refreshes a stored answer older than 10 minutes on read.
    refetchInterval: 2 * 60_000,
    ...computingRetry,
  });
}

export type TradeStatusFilter = "all" | "closed" | "open";
export const TRADES_PAGE = 50;

/** GET /traders/:address/trades: the round-trip ledger, "show more" pages. */
export function useTraderTrades(address: string, status: TradeStatusFilter, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.trader.trades(address, status),
    refetchInterval: 2 * 60_000,
    queryFn: ({ pageParam, signal }) =>
      api.get<TraderTradesResponse>(
        `/traders/${address}/trades?status=${status}&limit=${TRADES_PAGE}${pageParam ? `&cursor=${pageParam}` : ""}`,
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    ...computingRetry,
  });
}

/** GET /traders/:address/orders: resting orders across dexes (the 訂單
 * tab), loaded when the tab opens; the api keeps them 30 s. */
export function useTraderOrders(address: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.trader.orders(address),
    queryFn: ({ signal }) => api.get<TraderOrdersResponse>(`/traders/${address}/orders`, signal),
    enabled,
    refetchInterval: 30_000,
    ...busyRetry,
  });
}

/** GET /traders/:address/twap: running TWAP orders (the TWAP tab). */
export function useTraderTwap(address: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.trader.twap(address),
    queryFn: ({ signal }) => api.get<TraderTwapsResponse>(`/traders/${address}/twap`, signal),
    enabled,
    refetchInterval: 60_000,
    ...busyRetry,
  });
}

/** GET /traders/:address/transfers: 90 days of ledger updates (the 轉帳
 * tab and the live feed). */
export function useTraderTransfers(address: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.trader.transfers(address),
    queryFn: ({ signal }) => api.get<TraderTransfersResponse>(`/traders/${address}/transfers`, signal),
    enabled,
    refetchInterval: 5 * 60_000,
    ...busyRetry,
  });
}

export function useTraderFills(address: string, limit = 100) {
  return useQuery({
    queryKey: queryKeys.trader.fills(address, limit),
    queryFn: ({ signal }) => api.get<TraderFill[]>(`/traders/${address}/fills?limit=${limit}`, signal),
    refetchInterval: livePoll(address),
    ...busyRetry,
  });
}

export type { ActionsParams };

/** Poll interval of an /actions list: the stream down (or none) → 10 s;
 * the stream live → a slow safety net. */
export const ACTIONS_POLL_MS = 10_000;
export const ACTIONS_LIVE_POLL_MS = 60_000;

export function useActions(params: ActionsParams, options: { enabled?: boolean; refetchInterval?: number } = {}) {
  const queryClient = useQueryClient();
  const qs = actionsQueryString(params);
  const queryKey = queryKeys.actions.list(qs);
  return useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const fetched = await api.get<ActionFeedItem[]>(`/actions?${qs}`, signal);
      // Keep rows the live stream added after the server read this answer.
      return params.before ? fetched : mergeFetched(fetched, queryClient.getQueryData<ActionFeedItem[]>(queryKey), params.limit ?? 100);
    },
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchInterval ?? ACTIONS_POLL_MS,
  });
}

/**
 * An /actions list kept live by GET /actions/stream (new rows pushed within
 * a second or two, corrections applied in place), with polling as the
 * fallback: every 10 s while the stream is down, every 60 s while it's live.
 * `highlight`: ids of rows that just arrived.
 */
export function useLiveActions(params: ActionsParams, options: { enabled?: boolean } = {}) {
  const enabled = options.enabled ?? true;
  const [live, setLive] = useState(false);
  const query = useActions(params, { enabled, refetchInterval: live ? ACTIONS_LIVE_POLL_MS : ACTIONS_POLL_MS });
  const stream = useActionStream(params, enabled && query.isSuccess);
  const isLive = stream.status === "live";
  if (isLive !== live) setLive(isLive);
  return { query, status: stream.status, highlight: stream.highlight };
}

export function useAlerts(address: string | undefined, options: { enabled?: boolean } = {}) {
  const qs = new URLSearchParams({ limit: "100" });
  if (address) qs.set("address", address);
  return useQuery({
    queryKey: queryKeys.alerts(qs.toString()),
    queryFn: ({ signal }) => api.get<AlertEntry[]>(`/alerts?${qs.toString()}`, signal),
    enabled: options.enabled ?? true,
    refetchInterval: 30_000,
  });
}

export function useFavorites() {
  const { status } = useAuth();
  return useQuery({
    queryKey: queryKeys.favorites,
    queryFn: ({ signal }) => api.get<Favorite[]>("/me/favorites", signal),
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.favorites });
      void queryClient.invalidateQueries({ queryKey: queryKeys.traders.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.trader.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.actions.all });
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
