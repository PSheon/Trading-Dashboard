"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminLiveAccounts, AdminLiveLatency, AdminLiveOrders, AdminLiveTransfers, AdminRevokedLiveGrant, CopyControlCommand, CopyOrderStatus, CopyRiskLimits,
  CopyStrategyStatus } from "@trading-dashboard/shared/contracts";

import type { MessageKey } from "@/i18n/messages";
import type { Translate } from "@/i18n/provider";
import { api, type ApiError } from "@/lib/api";
import type {
  AdminCopyControlView,
  AdminCopyExposureView,
  AdminCopyOrdersView,
  AdminCopyOverviewView,
  AdminCopyRiskView,
  AdminCopyStrategiesView,
  AdminCopyStrategyDetailView,
} from "@/lib/contracts";
import { queryKeys } from "@/lib/query-keys";

/** The admin pages follow a live system: stop state, backlog and orders move while the page is open. */
const REFETCH_MS = 10_000;

export function useAdminCopyOverview(enabled = true) {
  return useQuery({
    queryKey: queryKeys.admin.copy.overview,
    queryFn: ({ signal }) => api.get<AdminCopyOverviewView>("/admin/copy/overview", signal),
    refetchInterval: REFETCH_MS,
    enabled,
  });
}

export function useAdminCopyExposure() {
  return useQuery({
    queryKey: queryKeys.admin.copy.exposure,
    queryFn: ({ signal }) => api.get<AdminCopyExposureView>("/admin/copy/exposure", signal),
    refetchInterval: REFETCH_MS,
  });
}

export function useAdminCopyStrategies(filter: { status?: CopyStrategyStatus | ""; userId?: number }) {
  const qs = new URLSearchParams({ limit: "200" });
  if (filter.status) qs.set("status", filter.status);
  if (filter.userId) qs.set("userId", String(filter.userId));
  return useQuery({
    queryKey: queryKeys.admin.copy.strategies(qs.toString()),
    queryFn: ({ signal }) => api.get<AdminCopyStrategiesView>(`/admin/copy/strategies?${qs}`, signal),
    refetchInterval: REFETCH_MS,
  });
}

export function useAdminCopyStrategy(id: number | null) {
  return useQuery({
    queryKey: queryKeys.admin.copy.strategy(id ?? 0),
    queryFn: ({ signal }) => api.get<AdminCopyStrategyDetailView>(`/admin/copy/strategies/${id}`, signal),
    refetchInterval: REFETCH_MS,
    enabled: id !== null,
  });
}

export function useAdminCopyOrders(filter: { status?: readonly CopyOrderStatus[]; limit?: number }) {
  const qs = new URLSearchParams({ limit: String(filter.limit ?? 200) });
  if (filter.status?.length) qs.set("status", filter.status.join(","));
  return useQuery({
    queryKey: queryKeys.admin.copy.orders(qs.toString()),
    queryFn: ({ signal }) => api.get<AdminCopyOrdersView>(`/admin/copy/orders?${qs}`, signal),
    refetchInterval: REFETCH_MS,
  });
}

export function useAdminCopyRisk() {
  return useQuery({
    queryKey: queryKeys.admin.copy.risk,
    queryFn: ({ signal }) => api.get<AdminCopyRiskView>("/admin/copy/risk", signal),
    // The form holds a draft against one version: no background refetch under it.
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
}

/** Testnet copies (B16): execution wallets with agent and grant. */
export function useAdminLiveAccounts() {
  return useQuery({ queryKey: queryKeys.admin.copy.live.accounts, queryFn: ({ signal }) => api.get<AdminLiveAccounts>("/admin/copy/live/accounts", signal), refetchInterval: REFETCH_MS });
}
export function useAdminLiveTransfers() {
  return useQuery({ queryKey: queryKeys.admin.copy.live.transfers, queryFn: ({ signal }) => api.get<AdminLiveTransfers>("/admin/copy/live/transfers", signal), refetchInterval: REFETCH_MS });
}
export function useAdminLiveOrders(state: "open" | "unknown" | "all") {
  return useQuery({ queryKey: queryKeys.admin.copy.live.orders(state), queryFn: ({ signal }) => api.get<AdminLiveOrders>(`/admin/copy/live/orders?state=${state}`, signal), refetchInterval: REFETCH_MS });
}
/** B18: leader fill → signal → sent → answer → booked, P50/P95 in ms. */
export function useAdminLiveLatency(window: "24h" | "7d") {
  return useQuery({ queryKey: queryKeys.admin.copy.live.latency(window), queryFn: ({ signal }) => api.get<AdminLiveLatency>(`/admin/copy/live/latency?window=${window}`, signal), refetchInterval: REFETCH_MS });
}
/** POST /admin/copy/live/grants/:id/revoke (execution.pause; audited). */
export function useRevokeLiveGrant() {
  const client = useQueryClient();
  return useMutation<AdminRevokedLiveGrant, ApiError, { id: string; reason: string; force?: boolean }>({
    mutationFn: ({ id, reason, force }) => api.post<AdminRevokedLiveGrant>(`/admin/copy/live/grants/${encodeURIComponent(id)}/revoke`, force ? { reason, force: true } : { reason }),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.admin.copy.live.accounts }),
  });
}

export type CopyControlTarget = { scope: "platform" } | { scope: "user"; userId: number };
export interface CopyControlInput {
  target: CopyControlTarget;
  command: CopyControlCommand;
  reason: string;
  expectedRevision: number;
}

/** POST /admin/copy/controls. Whatever the outcome the read models are
 * refetched: after a 409 the page must show the revision that beat it. */
export function useAdminCopyControl() {
  const client = useQueryClient();
  return useMutation<AdminCopyControlView, ApiError, CopyControlInput>({
    mutationFn: ({ target, command, reason, expectedRevision }) =>
      api.post<AdminCopyControlView>("/admin/copy/controls", { ...target, command, reason, expectedRevision }),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.admin.copy.all }),
  });
}

export function useSaveCopyRisk() {
  const client = useQueryClient();
  return useMutation<AdminCopyRiskView, ApiError, { limits: CopyRiskLimits; reason: string; expectedVersion: number }>({
    mutationFn: (body) => api.put<AdminCopyRiskView>("/admin/copy/risk", body),
    onSuccess: (saved) => {
      client.setQueryData(queryKeys.admin.copy.risk, saved);
      void client.invalidateQueries({ queryKey: queryKeys.admin.copy.overview });
    },
  });
}

/** What the admin types to arm a command. Not translated: it is typed, and
 * the same word in every language. */
export const CONTROL_CONFIRM_WORD: Record<CopyControlCommand, string> = {
  pause_new_risk: "PAUSE",
  reduce_only: "REDUCE ONLY",
  cancel_pending: "CANCEL",
  close_positions: "CLOSE ALL",
  resume: "RESUME",
};

const REASONS = [
  "platform_paused", "platform_reduce_only", "user_paused", "user_reduce_only", "strategy_paused", "strategy_reduce_only",
  "symbol_not_allowed", "symbol_blocked", "stale_signal", "no_price", "price_moved", "frequency", "zero_size", "below_min_notional",
  "leader_equity_unknown", "no_asset_info", "no_per_trade_amount", "nothing_to_reduce", "superseded", "reduce_only_no_position", "reduce_only_clamped", "liquidated",
] as const;
const CAPS = ["max_order", "max_coin_exposure", "max_user_exposure", "max_strategy_exposure", "available_funds"] as const;
const SCOPES = ["platform", "user", "strategy"] as const;

/**
 * An order's reason code as a sentence. Codes come in four shapes: a fixed
 * code; `below_min_after_<cap>` (clamped under the minimum order);
 * `<scope>_paused_before_submit` / `<scope>_reduce_only_before_submit`
 * (stopped between approval and submission); `<scope>_<command>` (cancelled
 * by that stop command). A code this build does not know is shown as it is.
 */
export function copyReasonText(code: string | null, t: Translate): string {
  if (!code) return "—";
  if ((REASONS as readonly string[]).includes(code)) return t(`copyAdmin.reasons.${code}` as MessageKey);
  const cap = CAPS.find((c) => code === `below_min_after_${c}`);
  if (cap) return t("copyAdmin.reasons.belowMinAfter", { cap: t(`copyAdmin.reasons.caps.${cap}`) });
  // "liquidated:equity 45.25 < maintenance 50.63": the figures stay as the api wrote them.
  if (code.startsWith("liquidated:")) return t("copyAdmin.reasons.liquidation", { detail: code.slice("liquidated:".length) });
  for (const scope of SCOPES) {
    if (!code.startsWith(`${scope}_`)) continue;
    const rest = code.slice(scope.length + 1);
    const level = t(`copyAdmin.scope.${scope}`);
    if (rest === "paused_before_submit" || rest === "reduce_only_before_submit") return t("copyAdmin.reasons.beforeSubmit", { scope: level });
    if (rest === "pause" || rest === "stop") return t("copyAdmin.reasons.cancelledBy", { scope: level, command: t(`copyAdmin.commands.${rest === "pause" ? "pause_new_risk" : "close_positions"}`) });
    if (rest in CONTROL_CONFIRM_WORD) return t("copyAdmin.reasons.cancelledBy", { scope: level, command: t(`copyAdmin.commands.${rest as CopyControlCommand}`) });
  }
  return code;
}

/** Seconds the oldest unconsumed signal has waited; null when nothing waits. */
export function signalLagSeconds(oldestPendingAt: string | null, now: number): number | null {
  if (!oldestPendingAt) return null;
  return Math.max(0, Math.round((now - Date.parse(oldestPendingAt)) / 1000));
}
