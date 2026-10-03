"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, sessionKey } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { defaultRetry } from "@/lib/query-policy";
import { queryKeys } from "@/lib/query-keys";
import type { CopyExecutionAccount, CopyExecutionWallets, CopyWalletGrant } from "@trading-dashboard/shared/contracts";

export type ExecutionNetwork = "testnet" | "mainnet";
export type ExecutionWallet = CopyExecutionAccount;
export type WalletAuthorization = CopyWalletGrant;
export type ExecutionWalletOverview = CopyExecutionWallets;

function useExecutionWalletKey() {
  const { status, identity, mode } = useAuth();
  return [...queryKeys.copy.all, "execution-wallets", status, mode, identity, sessionKey()] as const;
}

export function useExecutionWallets() {
  const { status } = useAuth();
  return useQuery({
    queryKey: useExecutionWalletKey(),
    queryFn: ({ signal }) => api.get<ExecutionWalletOverview>("/me/copy/execution-wallets", signal),
    enabled: status === "signedIn",
    staleTime: 5_000,
    ...defaultRetry,
  });
}

function useWalletMutation<V, T extends ExecutionWallet | WalletAuthorization>(
  collection: "accounts" | "authorizations", send: (variables: V) => Promise<T>,
) {
  const client = useQueryClient();
  const key = useExecutionWalletKey();
  return useMutation({
    mutationFn: send,
    onSuccess: (item) => {
      client.setQueryData<ExecutionWalletOverview>(key, (current) => current ? {
        ...current,
        [collection]: [...current[collection].filter((entry) => entry.id !== item.id), item],
      } : current);
    },
    onSettled: () => client.invalidateQueries({ queryKey: key, exact: true }),
  });
}

export function useCreateExecutionWallet() {
  return useWalletMutation("accounts", ({ strategyId, network }: { strategyId: number; network: ExecutionNetwork }) =>
    api.post<ExecutionWallet>(`/me/copy/strategies/${strategyId}/execution-wallet`, { network }));
}

export function useReconcileExecutionWallet() {
  return useWalletMutation("accounts", (id: string) =>
    api.post<ExecutionWallet>(`/me/copy/execution-wallets/${encodeURIComponent(id)}/reconcile`, {}));
}

export function useRevokeWalletAuthorization() {
  return useWalletMutation("authorizations", (id: string) =>
    api.post<WalletAuthorization>(`/me/copy/wallet-authorizations/${encodeURIComponent(id)}/revoke`, {}));
}
