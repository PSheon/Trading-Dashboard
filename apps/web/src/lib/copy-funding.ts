"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, sessionKey } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { queryKeys } from "@/lib/query-keys";
import { defaultRetry } from "@/lib/query-policy";
import { copyFundingInputSchema, copyFundingSchema, copyFundingOverviewSchema, usdSendTypedData, WALLET_NETWORKS, type CopyFunding, type CopyFundingClaim } from "@trading-dashboard/shared/contracts";
import { runCopyFunding } from "./copy-funding-operation";

const ROOT = "/me/copy/funding";
function useFundingKey() {
  const { status, identity, mode } = useAuth();
  return [...queryKeys.copy.all, "funding", status, mode, identity, sessionKey()] as const;
}
export function useCopyFunding() {
  const { status } = useAuth();
  return useQuery({ queryKey: useFundingKey(), queryFn: async ({ signal }) => copyFundingOverviewSchema.parse(await api.get(ROOT, signal)),
    enabled: status === "signedIn", staleTime: 5_000, refetchInterval: 15_000, ...defaultRetry });
}
function assertSession(start: string) { if (sessionKey() !== start) throw new Error("funding_session_changed"); }
export function useReserveCopyFunding() {
  const client = useQueryClient(), key = useFundingKey();
  return useMutation({ mutationFn: async ({ accountId, amount, idempotencyKey }: { accountId: string; amount: string; idempotencyKey: string }) => {
    const session = sessionKey();
    const result = copyFundingSchema.parse(await api.post(`/me/copy/execution-wallets/${encodeURIComponent(accountId)}/funding`, copyFundingInputSchema.parse({ amount, idempotencyKey })));
    assertSession(session); return result;
  }, onSettled: () => client.invalidateQueries({ queryKey: key, exact: true }) });
}
export function useConfirmCopyFunding() {
  const { wallet } = useAuth();
  const client = useQueryClient(), key = useFundingKey();
  return useMutation({ mutationFn: async (operation: CopyFunding) => {
    const session = sessionKey();
    const post = async <T,>(path: string, body: unknown) => { assertSession(session); const result = await api.post<T>(path, body); assertSession(session); return result; };
    return runCopyFunding(operation, {
      assertSession: () => assertSession(session),
      sign: (op) => {
        assertSession(session);
        if (!wallet?.address || wallet.address.toLowerCase() !== op.address || op.network !== "testnet") throw new Error("funding_wallet_mismatch");
        return wallet.signTypedData(usdSendTypedData(WALLET_NETWORKS[op.network], op.destination, op.amount, op.nonce));
      },
      claim: (id) => post<CopyFundingClaim>(`${ROOT}/${encodeURIComponent(id)}/broadcast`, {}),
      submit: (op, signature) => post<CopyFunding>(`${ROOT}/${encodeURIComponent(op.id)}/submit`, { signature }),
      reconcile: (id) => post<CopyFunding>(`${ROOT}/${encodeURIComponent(id)}/reconcile`, {}),
    });
  }, onSettled: async () => { await client.invalidateQueries({ queryKey: key, exact: true }); await client.invalidateQueries({ queryKey: queryKeys.wallet.all }); } });
}
export function useCancelCopyFunding() {
  const client = useQueryClient(), key = useFundingKey();
  return useMutation({ mutationFn: async (id: string) => {
    const session = sessionKey(), result = copyFundingSchema.parse(await api.post(`${ROOT}/${encodeURIComponent(id)}/cancel`, {}));
    assertSession(session); return result;
  }, onSettled: () => client.invalidateQueries({ queryKey: key, exact: true }) });
}
