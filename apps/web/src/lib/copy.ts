"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { wireCopyEventsSchema, type WireCopyEvents, type CopyStrategyCommand, type CreateCopyStrategyRequest, type PatchCopyStrategyRequest, type WireCopyPerformance, type CopyPerformanceWindow, type WireCopyPortfolio, type WireCopyTrades } from "@trading-dashboard/shared/contracts";

import { api, apiErrorCode, sessionKey } from "@/lib/api";
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
    refetchOnWindowFocus: true,
    ...defaultRetry,
  });
}

/** The live (not stopped) copy of `leader`, if any. */
export function useCopyOf(leader: string): CopyStrategyView | undefined {
  const overview = useCopyOverview();
  const address = leader.toLowerCase();
  return overview.data?.strategies.find((s) => s.leaderAddress === address && s.status !== "stopped");
}

export function useCopyOrders(strategyId: number | null, before?: string) {
  const { status } = useAuth();
  return useQuery({
    queryKey: [...queryKeys.copy.orders(strategyId ?? 0), before ?? "latest"],
    queryFn: ({ signal }) => api.get<CopyOrdersView>(`/me/copy/strategies/${strategyId}/orders${before ? `?before=${before}` : ""}`, signal),
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
  const { identity, mode } = useAuth();
  // Keyed by who is signed in (a cold load starts before the identity is
  // known, and an account switch must never reuse another's keys).
  const operation = useMemo(() => createCopyOperation(`orbie:copy-operations:start:${mode}:${identity ?? "session"}`), [identity, mode]);
  return useCopyMutation((body: Partial<CreateCopyStrategyRequest> & { leader: string; allocationUsd: number }) =>
    operation.run(body, (idempotencyKey) => api.post<CopyStrategyView>("/me/copy/strategies", { ...body, idempotencyKey })));
}

export function usePatchCopy() {
  return useCopyMutation(({ id, patch }: { id: number; patch: PatchCopyStrategyRequest }) => api.patch<CopyStrategyView>(`/me/copy/strategies/${id}`, patch));
}

export function useAddCopyFunds() {
  const { identity, mode } = useAuth();
  // Keyed by who is signed in (a cold load starts before the identity is
  // known, and an account switch must never reuse another's keys).
  const operation = useMemo(() => createCopyOperation(`orbie:copy-operations:funds:${mode}:${identity ?? "session"}`), [identity, mode]);
  return useCopyMutation((body: { id: number; amountUsd: number }) => operation.run(body, (idempotencyKey) => api.post<CopyStrategyView>(`/me/copy/strategies/${body.id}/funds`, { amountUsd: body.amountUsd, idempotencyKey })));
}

/** Keep the same operation key after an uncertain response; a confirmed
 * success makes the next identical submission a new operation. */
export function createCopyOperation(storageKey?: string) {
  let pending = new Map<string, string>();
  const refresh = () => {
    if (!storageKey || typeof window === "undefined") return;
    try { pending = new Map(JSON.parse(sessionStorage.getItem(storageKey) ?? "[]")); } catch { /* Storage is optional. */ }
  };
  refresh();
  const persist = () => {
    if (!storageKey || typeof window === "undefined") return;
    try { sessionStorage.setItem(storageKey, JSON.stringify([...pending])); } catch { /* Retain in memory when storage is blocked. */ }
  };
  return {
    pendingBodies<T>(): T[] {
      refresh();
      return [...pending.keys()].flatMap((body) => {
        try { return [JSON.parse(body) as T]; } catch { return []; }
      });
    },
    async run<T>(body: unknown, send: (key: string) => Promise<T>): Promise<T> {
      // Several mounted controls may share this action namespace.
      refresh();
      const fingerprint = JSON.stringify(body);
      const key = pending.get(fingerprint) ?? crypto.randomUUID();
      pending.set(fingerprint, key);
      persist();
      let result: T;
      try { result = await send(key); }
      catch (error) {
        // These responses are produced before any withdrawal ledger mutation.
        if (["strategy_stopped", "collateral_unavailable", "no_free_collateral", "risk_policy_invalid"].includes(apiErrorCode(error) ?? "")) {
          refresh(); pending.delete(fingerprint); persist();
        }
        throw error;
      }
      refresh();
      pending.delete(fingerprint);
      persist();
      return result;
    },
  };
}

export function useWithdrawCopyFunds() {
  const { identity, mode } = useAuth();
  const operation = useMemo(() => createCopyOperation(`orbie:copy-operations:withdraw:${mode}:${identity ?? "session"}`), [identity, mode]);
  const mutation = useCopyMutation((body: { id: number; amountUsd: number }) => operation.run(body, (idempotencyKey) => api.post<CopyStrategyView>(`/me/copy/strategies/${body.id}/withdraw-funds`, { amountUsd: body.amountUsd, idempotencyKey })));
  return { ...mutation, pendingOperations: operation.pendingBodies<{ id: number; amountUsd: number }>() };
}

export type { CopyPerformanceWindow };
export type CopyPerformanceView = WireCopyPerformance;

export function useCopyPerformance(strategyId: number, window: CopyPerformanceWindow = "7d") {
  const { status } = useAuth();
  return useQuery({
    queryKey: [...queryKeys.copy.all, "performance", strategyId, window],
    queryFn: ({ signal }) => api.get<CopyPerformanceView>(`/me/copy/strategies/${strategyId}/performance?window=${window}`, signal),
    enabled: status === "signedIn",
    staleTime: 30_000,
    refetchInterval: 60_000,
    ...defaultRetry,
  });
}

export type CopyPortfolioView = WireCopyPortfolio;
export type CopyClosedTradeView = WireCopyTrades["items"][number];

/** GET /me/copy/portfolio: every copy merged (CopyDog's portfolio chart),
 * today's PnL and each copy's curve. */
export function useCopyPortfolio(window: CopyPerformanceWindow = "all", enabled = true) {
  const { status } = useAuth();
  return useQuery({
    queryKey: [...queryKeys.copy.all, "portfolio", window],
    queryFn: ({ signal }) => api.get<CopyPortfolioView>(`/me/copy/portfolio?window=${window}`, signal),
    enabled: status === "signedIn" && enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    placeholderData: (previous) => previous,
    ...defaultRetry,
  });
}

/** GET /me/copy/trades: closed copy trades, best / worst / latest first. */
export function useCopyTrades(sort: "best" | "worst" | "recent", limit = 5, strategyId?: number) {
  const { status } = useAuth();
  return useQuery({
    queryKey: [...queryKeys.copy.all, "trades", sort, limit, strategyId ?? null],
    queryFn: ({ signal }) => api.get<WireCopyTrades>(`/me/copy/trades?sort=${sort}&limit=${limit}${strategyId ? `&strategyId=${strategyId}` : ""}`, signal),
    enabled: status === "signedIn",
    staleTime: 30_000,
    refetchInterval: 60_000,
    ...defaultRetry,
  });
}

export type CopyStreamStatus = "connecting" | "live" | "down" | "off";
let streamStatus: CopyStreamStatus = "off";
const streamListeners = new Set<() => void>();
/** Set by useCopyStream (GET /me/copy/stream). */
export function setCopyStreamStatus(next: CopyStreamStatus) {
  if (next === streamStatus) return;
  streamStatus = next;
  for (const notify of streamListeners) notify();
}
/** The copy stream's state: while it is live the events list stops polling. */
export const copyStreamStatus = {
  get: () => streamStatus,
  subscribe(notify: () => void) { streamListeners.add(notify); return () => { streamListeners.delete(notify); }; },
};

/** The owner's events list key (the stream writes into the same entry). */
export function copyEventsKey(status: string, mode: string, identity: string | null | undefined) {
  return [...queryKeys.copy.all, "events", status, mode, identity, sessionKey()] as const;
}

function subscribeVisibility(notify: () => void) {
  document.addEventListener("visibilitychange", notify);
  return () => document.removeEventListener("visibilitychange", notify);
}

/** Decimal bigint IDs remain strings across reconnects. Retain a bounded
 * activity tail while the cursor keeps advancing through confirmed events. */
export function mergeCopyEvents(previous: WireCopyEvents | undefined, page: WireCopyEvents): WireCopyEvents {
  const byId = new Map((previous?.items ?? []).map((event) => [event.id, event]));
  for (const event of page.items) byId.set(event.id, event);
  const items = [...byId.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0).slice(-Math.max(100, previous?.items.length ?? 0));
  const cursor = previous && BigInt(previous.nextCursor) > BigInt(page.nextCursor) ? previous.nextCursor : page.nextCursor;
  return { items, nextCursor: cursor, previousCursor: items[0]?.id ?? null, hasMore: previous?.hasMore || byId.size > items.length || page.hasMore };
}

export function useCopyEvents() {
  const { status, identity, mode } = useAuth();
  const queryClient = useQueryClient();
  const visible = useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible", () => false);
  const queryKey = copyEventsKey(status, mode, identity);
  const live = useSyncExternalStore(copyStreamStatus.subscribe, () => copyStreamStatus.get() === "live", () => false);
  const catchingUp = useRef(false);
  const enabled = status === "signedIn" && visible;
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const previous = queryClient.getQueryData<WireCopyEvents>(queryKey);
      const cursor = previous?.nextCursor ?? "0";
      let page = wireCopyEventsSchema.parse(await api.get<WireCopyEvents>(`/me/copy/events?after=${cursor}&limit=100`, signal));
      let merged = mergeCopyEvents(previous, page);
      // Initial hasMore means older history. Positive cursors instead replay
      // missed events; drain bounded batches immediately on reconnect.
      catchingUp.current = cursor !== "0" && Boolean(page.hasMore);
      for (let batch = 1; catchingUp.current && batch < 10; batch++) {
        const after = merged.nextCursor;
        page = wireCopyEventsSchema.parse(await api.get<WireCopyEvents>(`/me/copy/events?after=${after}&limit=100`, signal));
        merged = mergeCopyEvents(merged, page);
        catchingUp.current = Boolean(page.hasMore) && merged.nextCursor !== after;
      }
      return merged;
    },
    enabled,
    staleTime: 10_000,
    gcTime: 60_000,
    // The stream pushes events while it is live; polling covers it otherwise.
    refetchInterval: () => enabled ? (catchingUp.current ? 1_000 : live ? false : 15_000) : false,
    refetchIntervalInBackground: false,
    ...defaultRetry,
  });
  const older = useMutation({
    mutationFn: async () => {
      const current = queryClient.getQueryData<WireCopyEvents>(queryKey);
      const before = current?.items[0]?.id;
      if (!before) return;
      return wireCopyEventsSchema.parse(await api.get<WireCopyEvents>(`/me/copy/events?before=${before}&limit=100`));
    },
    onSuccess: (page) => {
      if (!page) return;
      queryClient.setQueryData<WireCopyEvents>(queryKey, (current) => {
        const byId = new Map([...page.items, ...(current?.items ?? [])].map((event) => [event.id, event]));
        const items = [...byId.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
        return { items, nextCursor: current?.nextCursor ?? page.nextCursor, previousCursor: items[0]?.id ?? null, hasMore: page.hasMore };
      });
    },
  });
  const key = JSON.stringify(queryKey);
  useEffect(() => {
    const scopedKey = JSON.parse(key) as readonly unknown[];
    if (!enabled) void queryClient.cancelQueries({ queryKey: scopedKey, exact: true });
    return () => { void queryClient.cancelQueries({ queryKey: scopedKey, exact: true }); };
  }, [enabled, key, queryClient]);
  return { ...query, loadOlder: older.mutate, isLoadingOlder: older.isPending, olderError: older.isError };
}

export function useCopyCommand() {
  const { identity, mode } = useAuth();
  // Keyed by who is signed in (a cold load starts before the identity is
  // known, and an account switch must never reuse another's keys).
  const operation = useMemo(() => createCopyOperation(`orbie:copy-operations:command:${mode}:${identity ?? "session"}`), [identity, mode]);
  return useCopyMutation((body: { id: number; command: CopyStrategyCommand }) => operation.run(body, (idempotencyKey) => api.post<CopyStrategyView>(`/me/copy/strategies/${body.id}/commands`, { command: body.command, idempotencyKey })));
}

/** Days since a copy started, as CopyDog's "{n}d". */
export function copyDays(createdAt: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 86_400_000));
}
