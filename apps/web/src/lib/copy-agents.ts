"use client";

import { useQuery } from "@tanstack/react-query";
import { copyAgentOverviewSchema } from "@trading-dashboard/shared/contracts";
import { api, sessionKey } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { queryKeys } from "@/lib/query-keys";
import { defaultRetry } from "@/lib/query-policy";

const ROOT = "/me/copy/agents";

/** The signed-in owner a guarded flow started with (lib/copy-live.ts). */
export interface AgentOwnerSnapshot { status: string; mode: string; identity: string | null; session: string; walletAddress: string | null }

function useAgentKey() {
  const { status, identity, mode, wallet } = useAuth();
  return [...queryKeys.copy.all, "agents", status, mode, identity, sessionKey(), wallet?.address?.toLowerCase()] as const;
}
/** The owner's copy agents, read only: a one-click setup's worker approves
 * each agent under the owner's policy (the browser signs nothing for it). */
export function useCopyAgents() {
  const { status, mode } = useAuth();
  return useQuery({ queryKey: useAgentKey(), queryFn: async ({ signal }) => copyAgentOverviewSchema.parse(await api.get(ROOT, signal)), enabled: status === "signedIn" && mode === "privy", staleTime: 5_000, refetchInterval: 15_000, ...defaultRetry });
}
