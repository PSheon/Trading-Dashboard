"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import type { WireFundsHistory } from "@trading-dashboard/shared/contracts";

import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { TraderTransfer } from "@/lib/contracts";
import { defaultRetry } from "@/lib/query-policy";

export type FundsFlowView = WireFundsHistory["items"][number];

/** GET /me/funds/history, page by page (older on demand). */
export function useFundsHistory() {
  const { status } = useAuth();
  return useInfiniteQuery({
    queryKey: ["funds", "history"],
    queryFn: ({ pageParam, signal }) => api.get<WireFundsHistory>(`/me/funds/history?limit=50${pageParam ? `&before=${pageParam}` : ""}`, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: status === "signedIn",
    staleTime: 30_000,
    ...defaultRetry,
  });
}

/** One row of the money-flow history. */
export type FundsRow =
  | { source: "hub"; id: string; time: number; transfer: TraderTransfer }
  | { source: "orbie"; id: string; time: number; flow: FundsFlowView; hubHash: string | null };

export type FundsFilter = "all" | "transfers" | "copies" | "fees";

/**
 * The hub wallet's ledger (Hyperliquid's own record) and Orbie's flows as
 * one list, newest first. A hub transfer that is the on-chain side of a copy
 * funding (sent to that copy's wallet, same amount, within a day) is folded
 * into the funding row, which keeps its hash: one move, both sides. A hub
 * withdrawal Orbie submitted that the ledger already shows is shown once,
 * as the ledger's. Hub rows older than the oldest Orbie row loaded wait
 * until that page is loaded, so the list stays in time order.
 */
export function mergeFunds(hub: TraderTransfer[] | undefined, flows: FundsFlowView[], complete: boolean): FundsRow[] {
  const hubRows = (hub ?? []).map((transfer) => ({ source: "hub" as const, id: `hub:${transfer.hash}:${transfer.kind}:${String(transfer.time)}`, time: Date.parse(String(transfer.time)), transfer }));
  const used = new Set<string>();
  const near = (a: number, b: number, ms: number) => Math.abs(a - b) <= ms;
  const orbie: FundsRow[] = flows.flatMap((flow) => {
    const time = Date.parse(String(flow.time));
    const wallet = flow.counterparty?.toLowerCase() ?? null;
    if (flow.kind === "copy_funding" && wallet) {
      const match = hubRows.find((h) => !used.has(h.id) && h.transfer.direction === "out" && h.transfer.to === wallet
        && near(h.transfer.amount, Math.abs(flow.amount), 0.01) && near(h.time, time, 86_400_000));
      if (match) used.add(match.id);
      return [{ source: "orbie" as const, id: flow.id, time, flow, hubHash: match?.transfer.hash ?? flow.txHash }];
    }
    if (flow.kind === "hub_withdrawal" && flow.status === "accepted") {
      const match = hubRows.find((h) => !used.has(h.id) && h.transfer.kind === "withdraw" && near(h.transfer.amount, Math.abs(flow.amount), 1.01) && near(h.time, time, 6 * 3_600_000));
      if (match) return [];
    }
    return [{ source: "orbie" as const, id: flow.id, time, flow, hubHash: flow.txHash }];
  });
  const oldest = flows.length ? Math.min(...flows.map((f) => Date.parse(String(f.time)))) : Infinity;
  const hubShown = hubRows.filter((h) => !used.has(h.id) && (complete || h.time >= oldest));
  return [...orbie, ...hubShown].sort((a, b) => b.time - a.time);
}

export function rowMatches(row: FundsRow, filter: FundsFilter): boolean {
  if (filter === "all") return true;
  if (row.source === "hub") return filter === "transfers";
  const kind = row.flow.kind;
  if (filter === "fees") return kind === "fees" || kind === "funding";
  if (filter === "copies") return kind === "copy_deposit" || kind === "copy_withdrawal" || kind === "copy_sweep" || kind === "copy_write_off" || kind === "copy_funding";
  return kind === "hub_withdrawal" || kind === "copy_funding";
}
