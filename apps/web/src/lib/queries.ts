"use client";

import { useToast } from "@/components/ui/toast";
import { useT } from "@/i18n/provider";
import { computingRetry, TRADER_RETRIES, traderRetry } from "@/lib/query-policy";
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
  CohortDetail,
  CohortHistory,
  CohortTier,
  CohortWindow,
  CoinBoardResponse,
  CoinIndexResponse,
  CopyScoreResponse,
  HomeBoardsResponse,
  DiscoverSearchResponse,
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
import type { WireChartSnapshots } from "@trading-dashboard/shared/contracts";

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
/** What a server-rendered page read for a query (`prefetchPublic`), used as
 * its initial data so the page shows it before the browser asks. */
export interface InitialRead<T> {
  data: T;
  fetchedAt: number;
}
const seeded = <T,>(initial: InitialRead<T> | null | undefined) =>
  initial ? { initialData: initial.data, initialDataUpdatedAt: initial.fetchedAt } : {};

export function useSiteSettings(initial?: InitialRead<PublicSettings> | null) {
  return useQuery({
    queryKey: queryKeys.siteSettings,
    queryFn: ({ signal }) => api.get<PublicSettings>("/settings", signal),
    ...seeded(initial),
    // The api applies a save at once; an open tab learns of it (an
    // announcement, the maintenance notice) within a minute or on focus.
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useCrowd() {
  return useQuery({
    queryKey: queryKeys.crowd,
    queryFn: ({ signal }) => api.get<CrowdResponse>("/insights/crowd", signal),
    refetchInterval: 60_000,
  });
}

/** `accountPnl` / `accountRoi`: Hyperliquid's leaderboard figures, the whole account. */
export type TraderSort = "accountPnl" | "accountRoi" | "volume" | "accountValue";

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

/** `enabled: false` holds the request until the caller's defaults are known
 * (the full leaderboard waits for the admin settings, so the first request
 * isn't replaced, and aborted, by a second one). */
export function useTraders(params: TradersParams, options: { enabled?: boolean } = {}) {
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
    enabled: options.enabled ?? true,
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

/** GET /insights/cohorts/:tier: a PnL tier's positioning (the api
 * refreshes members every ~15 min and caches the view 30 s). */
export function useCohort(tier: CohortTier) {
  return useQuery({
    queryKey: queryKeys.cohort(tier),
    queryFn: ({ signal }) => api.get<CohortDetail>(`/insights/cohorts/${tier}`, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

/** GET /insights/cohorts/:tier/history?window=: 倉位傾向 and BTC. */
export function useCohortHistory(tier: CohortTier, window: CohortWindow) {
  return useQuery({
    queryKey: queryKeys.cohortHistory(tier, window),
    queryFn: ({ signal }) => api.get<CohortHistory>(`/insights/cohorts/${tier}/history?window=${window}`, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}

/** GET /discover/home: every home row and the calculator's traders. */
export function useHomeBoards(initial?: InitialRead<HomeBoardsResponse> | null) {
  return useQuery({
    queryKey: queryKeys.discover.home,
    queryFn: ({ signal }) => api.get<HomeBoardsResponse>("/discover/home", signal),
    ...seeded(initial),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** GET /discover/coins: CopyDog's 市場 index, from the pool snapshot. */
export function useCoinIndex() {
  return useQuery({
    queryKey: queryKeys.discover.coins,
    queryFn: ({ signal }) => api.get<CoinIndexResponse>("/discover/coins", signal),
    staleTime: 30_000,
    refetchInterval: 5 * 60_000,
  });
}

/** GET /discover/coins/:coin: one coin's leaderboard (`coin` is the
 * Hyperliquid name, "xyz:TSLA"). */
export function useCoinBoard(coin: string) {
  return useQuery({
    queryKey: queryKeys.discover.coin(coin),
    queryFn: ({ signal }) => api.get<CoinBoardResponse>(`/discover/coins/${encodeURIComponent(coin)}`, signal),
    staleTime: 30_000,
    // An empty board whose market the api could not look up yet (`listed`
    // null: its catalog read was still running) asks again soon, so "no such
    // market" becomes the 404 without a reload.
    refetchInterval: (query) => (query.state.data && query.state.data.items.length === 0 && query.state.data.listed == null ? 5_000 : 5 * 60_000),
  });
}

/** GET /discover/search: the header search's dropdown (the api caches each
 * query 30 s). Disabled for an empty query; the previous list stays while
 * the next one loads, as CopyDog's does. */
export function useDiscoverSearch(q: string) {
  const query = q.trim();
  return useQuery({
    queryKey: queryKeys.discover.search(query.toLowerCase()),
    queryFn: ({ signal }) => api.get<DiscoverSearchResponse>(`/discover/search?${new URLSearchParams({ q: query, limit: "5" })}`, signal),
    enabled: query.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
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
    ...traderRetry,
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
    ...traderRetry,
  });
}

/** GET /traders/:address/activity: sample size and last trade, loaded
 * alongside the profile (it costs the api more and arrives later). */
export function useTraderActivity(address: string) {
  return useQuery({
    queryKey: queryKeys.trader.activity(address),
    queryFn: ({ signal }) => api.get<TraderActivityResponse>(`/traders/${address}/activity`, signal),
    refetchInterval: 60_000,
    ...traderRetry,
  });
}

/** GET /traders/:address/chart-snapshots: what the trader held along the
 * chart's window (CopyDog's chart-snapshots; watched traders only). */
export function useChartSnapshots(address: string, window: TraderWindow) {
  return useQuery({
    queryKey: ["trader", address.toLowerCase(), "chart-snapshots", window],
    queryFn: ({ signal }) => api.get<WireChartSnapshots>(`/traders/${address}/chart-snapshots?window=${window}`, signal),
    staleTime: 60_000,
    refetchInterval: 300_000,
    retry: 1,
  });
}

export function usePortfolio(address: string, window: TraderWindow, market: "all" | "perp") {
  return useQuery({
    queryKey: queryKeys.trader.portfolio(address, window, market),
    queryFn: ({ signal }) =>
      api.get<PortfolioResponse>(`/traders/${address}/portfolio?window=${window}&market=${market}`, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    ...traderRetry,
  });
}

/**
 * A cold address's trade analytics take the api a while (it reads the
 * address's fill history from Hyperliquid): it answers 503 busy until they
 * are stored, and these queries keep asking, with the trader page's
 * backoff, for up to ~10 minutes. The page shows placeholders only for the
 * first few answers (`isComputing`), then its settled look, and fills in
 * when the data arrives.
 */
export { ANALYTICS_BUSY_RETRIES } from "@/lib/query-policy";

/** Still computing: no data yet, and either the first answer is on its way
 * or the last few were busy. Past `TRADER_RETRIES` busy answers the request
 * goes on in the background but the page no longer waits on it. */
export function isComputing(query: { data?: unknown; failureReason: Error | null; failureCount: number; isPending: boolean }): boolean {
  return query.data === undefined && query.failureCount <= TRADER_RETRIES && (query.isPending || isBusy(query.failureReason));
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
    ...traderRetry,
  });
}

/** GET /traders/:address/twap: running TWAP orders (the TWAP tab). */
export function useTraderTwap(address: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.trader.twap(address),
    queryFn: ({ signal }) => api.get<TraderTwapsResponse>(`/traders/${address}/twap`, signal),
    enabled,
    refetchInterval: 60_000,
    ...traderRetry,
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
    ...traderRetry,
  });
}

export function useTraderFills(address: string, limit = 100) {
  return useQuery({
    queryKey: queryKeys.trader.fills(address, limit),
    queryFn: ({ signal }) => api.get<TraderFill[]>(`/traders/${address}/fills?limit=${limit}`, signal),
    refetchInterval: livePoll(address),
    ...traderRetry,
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
  const toast = useToast();
  const t = useT();
  const mutation = useMutation({
    mutationFn: async ({ address, favorite }: { address: string; favorite: boolean }) => {
      if (favorite) await api.put<Favorite>(`/me/favorites/${address}`);
      else await api.delete<void>(`/me/favorites/${address}`);
    },
    // CopyDog: "Failed to add to watchlist" / "… remove from …" toasts.
    onError: (_error, { favorite }) => toast.error(t(favorite ? "favorites.addFailed" : "favorites.removeFailed")),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.favorites });
      void queryClient.invalidateQueries({ queryKey: queryKeys.favoriteGroups });
      void queryClient.invalidateQueries({ queryKey: queryKeys.traders.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.trader.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.actions.all });
      // Unfavoriting drops the trader from its groups (server-side cascade).
      void queryClient.invalidateQueries({ queryKey: queryKeys.favoriteGroups });
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
