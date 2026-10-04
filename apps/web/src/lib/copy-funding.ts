"use client";

import { useLayoutEffect, useRef } from "react";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, sessionKey } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { queryKeys } from "@/lib/query-keys";
import { defaultRetry } from "@/lib/query-policy";
import { copyFundingInputSchema, copyFundingSchema, copyFundingOverviewSchema, usdSendTypedData, WALLET_NETWORKS, type CopyFunding, type CopyFundingClaim, type CopyExecutionAccount, type CopyFundingOverview } from "@trading-dashboard/shared/contracts";
import { runCopyFunding } from "./copy-funding-operation";

const ROOT = "/me/copy/funding";
function useFundingKey() {
  const { status, identity, mode } = useAuth();
  return [...queryKeys.copy.all, "funding", status, mode, identity, sessionKey()] as const;
}
export function useCopyFunding() {
  const { status } = useAuth();
  return useQuery({ queryKey: useFundingKey(), queryFn: async ({ signal }) => copyFundingOverviewSchema.parse(await api.get(ROOT, signal)),
    enabled: status === "signedIn", staleTime: 5_000, refetchInterval: 15_000, refetchOnWindowFocus: true, ...defaultRetry });
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
const fundingRecoverySchema = z.array(z.string().uuid());
/** Only original operation identifiers are stored, never signatures or credentials. */
export function createFundingJournal(scope: string, storage: Pick<Storage, "getItem" | "setItem">) {
  const key = `copy-funding-uncertainty:v1:${encodeURIComponent(scope)}`;
  const read = () => { const raw = storage.getItem(key); return raw ? fundingRecoverySchema.parse(JSON.parse(raw)) : []; };
  return { read, uncertain: (id: string) => read().includes(id), mark: (id: string) => { const value = read(); if (!value.includes(id)) value.push(id); const encoded = JSON.stringify(fundingRecoverySchema.parse(value)); storage.setItem(key, encoded); if (storage.getItem(key) !== encoded) throw new Error("funding_recovery_unavailable"); } };
}
function sameFunding(original: CopyFunding, raw: CopyFunding) {
  const result = copyFundingSchema.parse(raw);
  for (const field of ["id", "accountId", "strategyId", "network", "address", "destination", "amount", "nonce", "createdAt"] as const) if (result[field] !== original[field]) throw new Error("funding_identity_mismatch");
  return result;
}
export function useConfirmCopyFunding(accounts: readonly CopyExecutionAccount[], operations: readonly CopyFunding[], available: boolean) {
  const auth = useAuth(), latest = useRef(auth), current = useRef({ accounts, operations, available }), mounted = useRef(true), busy = useRef(false);
  const client = useQueryClient(), key = useFundingKey(), recoveryKey = [...key, "uncertainty"];
  useLayoutEffect(() => { latest.current = auth; current.current = { accounts, operations, available }; }, [auth, accounts, operations, available]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const snapshot = () => { const value = latest.current; return { status: mounted.current ? value.status : "disposed", mode: value.mode, identity: value.identity, walletAddress: value.wallet?.address?.toLowerCase() ?? null, session: sessionKey() }; };
  const journal = () => { const value = snapshot(); if (!value.identity || value.status !== "signedIn" || value.mode !== "privy") throw new Error("funding_owner_unavailable"); return createFundingJournal(`${value.mode}:${value.identity}`, window.sessionStorage); };
  const recovery = useQuery({ queryKey: recoveryKey, queryFn: async () => journal().read(), enabled: auth.status === "signedIn" && auth.mode === "privy", retry: false, gcTime: 0 });
  const mutation = useMutation({ retry: false, mutationFn: async (input: CopyFunding) => {
    if (busy.current) throw new Error("funding_action_in_progress"); busy.current = true;
    try {
      const operation = copyFundingSchema.parse(input), owner = snapshot(), account = structuredClone(current.current.accounts.find(a => a.id === operation.accountId));
      if (owner.status !== "signedIn" || owner.mode !== "privy" || !owner.identity || !account) throw new Error("funding_owner_unavailable");
      const authority = () => {
        const currentOwner = snapshot(); if (Object.keys(owner).some(field => owner[field as keyof typeof owner] !== currentOwner[field as keyof typeof owner])) throw new Error("funding_session_changed");
        const found = current.current.accounts.find(a => a.id === account.id);
        if (!found || found.strategyId !== operation.strategyId || found.network !== operation.network || found.address !== operation.destination || found.updatedAt !== account.updatedAt) throw new Error("funding_account_changed");
      };
      const assertCurrent = (op: CopyFunding, phase: "prepared" | "unknown" | "read") => {
        authority(); const found = current.current.operations.find(item => item.id === op.id); if (!found) throw new Error("funding_operation_changed"); sameFunding(op, found);
        if (phase !== "read" && (!current.current.available || account.state !== "ready" || current.current.accounts.find(a => a.id === account.id)?.state !== "ready" || operation.network !== "testnet" || owner.walletAddress !== operation.address || found.status !== phase || found.updatedAt !== op.updatedAt)) throw new Error("funding_operation_changed");
      };
      const saved = journal();
      const post = async <T,>(path: string, body: unknown, beforeSend: () => void) => { authority(); const result = await api.post<T>(path, body, { beforeSend }); authority(); return result; };
      return await runCopyFunding(operation, {
        assertSession: authority, assertCurrent, uncertain: id => saved.uncertain(id), markUncertain: id => saved.mark(id),
        sign: op => { assertCurrent(op, "prepared"); const wallet = latest.current.wallet; if (!wallet?.address || wallet.address.toLowerCase() !== op.address) throw new Error("funding_wallet_mismatch"); return wallet.signTypedData(usdSendTypedData(WALLET_NETWORKS[op.network], op.destination, op.amount, op.nonce)); },
        claim: (id, beforeSend) => post<CopyFundingClaim>(`${ROOT}/${encodeURIComponent(id)}/broadcast`, {}, beforeSend),
        adoptClaim: (original, claimed) => { authority(); const found = current.current.operations.find(item => item.id === original.id); if (!found) throw new Error("funding_operation_changed"); sameFunding(original, found); if (!(found.status === "prepared" && found.updatedAt === original.updatedAt || found.status === "unknown" && found.updatedAt === claimed.updatedAt)) throw new Error("funding_operation_changed"); current.current = { ...current.current, operations: current.current.operations.map(item => item.id === original.id ? claimed : item) }; client.setQueryData(key, (previous: CopyFundingOverview | undefined) => previous ? { ...previous, operations: previous.operations.map(item => item.id === original.id ? claimed : item) } : previous); },
        submit: (op, signature, beforeSend) => post<CopyFunding>(`${ROOT}/${encodeURIComponent(op.id)}/submit`, { signature }, beforeSend),
        reconcile: (id, beforeSend) => post<CopyFunding>(`${ROOT}/${encodeURIComponent(id)}/reconcile`, {}, beforeSend),
      });
    } finally { busy.current = false; }
  }, onSettled: async () => { await Promise.all([client.invalidateQueries({ queryKey: key, exact: true }), client.invalidateQueries({ queryKey: recoveryKey, exact: true }), client.invalidateQueries({ queryKey: queryKeys.wallet.all })]); } });
  return { ...mutation, recovery };
}
export function useCancelCopyFunding() {
  const client = useQueryClient(), key = useFundingKey();
  return useMutation({ mutationFn: async (id: string) => {
    const session = sessionKey(), result = copyFundingSchema.parse(await api.post(`${ROOT}/${encodeURIComponent(id)}/cancel`, {}));
    assertSession(session); return result;
  }, onSettled: () => client.invalidateQueries({ queryKey: key, exact: true }) });
}
