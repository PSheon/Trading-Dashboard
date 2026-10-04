"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, sessionKey } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { WalletHistory, WalletSummary } from "@/lib/contracts";
import {
  MIN_BRIDGE_USDC,
  erc20TransferData,
  networkConfig,
  usdcString,
  usdcToUnits,
  withdraw3TypedData,
} from "@/lib/hyperliquid-network";
import { busyRetry } from "@/lib/query-policy";
import { queryKeys } from "@/lib/query-keys";
import { createWithdrawalJournal, migrateWithdrawalJournal, runDurableWithdrawal, withdrawalStorageKey } from "@/lib/withdrawal-operation";
import { walletWithdrawalSchema, type WalletWithdrawal, type WalletWithdrawalClaim } from "@trading-dashboard/shared/contracts";

/** The header pill, portfolio and modals share one read; the api caches
 * 15 s, so polling faster buys nothing. */
const WALLET_REFETCH_MS = 20_000;

/** GET /me/wallet — the main account on the wallet network. */
export function useWallet() {
  const { status } = useAuth();
  return useQuery({
    queryKey: queryKeys.wallet.summary,
    queryFn: ({ signal }) => api.get<WalletSummary>("/me/wallet", signal),
    enabled: status === "signedIn",
    staleTime: 10_000,
    refetchInterval: WALLET_REFETCH_MS,
    ...busyRetry,
  });
}

/** GET /me/wallet/history — deposits, withdrawals and transfers. */
export function useWalletHistory() {
  const { status } = useAuth();
  return useQuery({
    queryKey: queryKeys.wallet.history,
    queryFn: ({ signal }) => api.get<WalletHistory>("/me/wallet/history", signal),
    enabled: status === "signedIn",
    staleTime: 30_000,
    ...busyRetry,
  });
}

/** The wallet address to show: the api's (read from Privy server side),
 * else the browser's embedded wallet while the api hasn't seen it yet. */
export function useWalletAddress(): string | null {
  const { wallet } = useAuth();
  const summary = useWallet();
  return summary.data?.address ?? wallet?.address?.toLowerCase() ?? null;
}

/** A Privy / wallet refusal reads as "cancelled", anything else as itself. */
export function signErrorMessage(error: unknown): { rejected: boolean; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  return { rejected: /reject|denied|cancel|closed/i.test(message), message };
}

/**
 * Bridge the deposit address's Arbitrum USDC to Hyperliquid: one ERC-20
 * transfer to Bridge2, signed and sent by the user's own embedded wallet in
 * the browser (`sponsor` asks Privy to pay the gas). Bridge2 credits the
 * sender's Hyperliquid account in about a minute. Never below 5 USDC: the
 * bridge doesn't credit (and loses) smaller amounts.
 */
export function useBridgeDeposit() {
  const { wallet } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ summary, sponsor }: { summary: WalletSummary; sponsor: boolean }) => {
      if (!wallet?.address) throw new Error("No wallet");
      if (!summary.address || summary.address !== wallet.address.toLowerCase()) throw new Error("Wallet mismatch");
      const usdc = summary.arbitrum?.usdc ?? 0;
      if (usdc < MIN_BRIDGE_USDC) throw new Error(`Below the ${MIN_BRIDGE_USDC} USDC minimum`);
      const network = networkConfig(summary.network);
      const data = erc20TransferData(network.bridge, usdcToUnits(usdcString(usdc)));
      return wallet.sendTransaction({ to: network.usdc, data, chainId: network.arbitrumChainId }, sponsor);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.wallet.all }),
  });
}

const WITHDRAWALS = "/me/wallet/withdrawals";
type WalletIdentity = Pick<WalletSummary, "network" | "address">;
async function withWithdrawalLock<T>(summary: WalletIdentity, work: () => Promise<T>): Promise<T> {
  if (!navigator.locks) return work(); // Server CAS remains authoritative.
  return navigator.locks.request(withdrawalStorageKey(summary.network, summary.address!), { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error("withdrawal_pending");
    return work();
  });
}
async function migrateLegacyWithdrawal(summary: WalletIdentity, expectedSession = sessionKey()) {
  if (sessionKey() !== expectedSession) throw new Error("withdrawal_identity_mismatch");
  await migrateWithdrawalJournal(localStorage, summary.network, summary.address!, (input) => {
    if (sessionKey() !== expectedSession) throw new Error("withdrawal_identity_mismatch");
    return api.post<WalletWithdrawal>(`${WITHDRAWALS}/import`, input);
  });
}

/** Pending metadata is scoped by network, account and the signed-in session;
 * the authoritative journal survives browser and device changes. */
export function useWithdrawalRecovery(summary: WalletIdentity) {
  const { status } = useAuth();
  return useQuery({
    queryKey: [...queryKeys.wallet.all, "withdrawal", summary.network, summary.address],
    queryFn: async ({ signal }) => {
      if (!summary.address) return null;
      const expectedSession = sessionKey();
      if (createWithdrawalJournal(localStorage, summary.network, summary.address).read()) await withWithdrawalLock(summary, () => migrateLegacyWithdrawal(summary, expectedSession));
      const raw = await api.get<WalletWithdrawal | null>(`${WITHDRAWALS}/current`, signal);
      if (!raw) return null;
      const operation = walletWithdrawalSchema.parse(raw);
      if (operation.network !== summary.network || operation.address !== summary.address.toLowerCase()) throw new Error("withdrawal_identity_mismatch");
      return operation;
    },
    staleTime: 0,
    refetchInterval: 10_000,
    enabled: status === "signedIn" && Boolean(summary.address),
    retry: false,
  });
}

export function useCancelWithdrawalPreparation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<WalletWithdrawal>(`${WITHDRAWALS}/${encodeURIComponent(id)}/cancel`, {}),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.wallet.all }),
  });
}

export const WITHDRAW_MUTATION_KEY = ["wallet", "withdraw"] as const;

export interface WithdrawVariables {
  summary: WalletSummary;
  destination: string;
  amount: string;
  operationId?: string;
  /** The "withdrawing…" toast, dismissed when the result is known. */
  toastId?: number;
}

/** Sign in the browser, persist the nonce before broadcast, and reconcile
 * ambiguous results by the exact withdrawal nonce. Never create a fresh
 * withdrawal as a retry of an uncertain one.
 *
 * `result` callbacks belong to the mutation itself, not to one `mutate`
 * call: TanStack drops a call's callbacks when its component unmounts, so a
 * dialog closed after signing would never tell the user what happened. */
export function useWithdraw(result: { onSuccess?: (data: WalletWithdrawal, variables: WithdrawVariables) => void; onError?: (error: Error, variables: WithdrawVariables) => void } = {}) {
  const { wallet } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: WITHDRAW_MUTATION_KEY,
    onSuccess: result.onSuccess ? (data: WalletWithdrawal, variables: WithdrawVariables) => result.onSuccess!(data, variables) : undefined,
    onError: result.onError ? (error: Error, variables: WithdrawVariables) => result.onError!(error, variables) : undefined,
    mutationFn: async ({ summary, destination, amount, operationId }: WithdrawVariables) => {
      if (!summary.address) throw new Error("No wallet");
      if (!operationId && (!wallet?.address || summary.address !== wallet.address.toLowerCase())) throw new Error("Wallet mismatch");
      const startingSession = sessionKey();
      const network = networkConfig(summary.network);
      return withWithdrawalLock(summary, async () => {
        await migrateLegacyWithdrawal(summary, startingSession);
        if (sessionKey() !== startingSession) throw new Error("withdrawal_identity_mismatch");
        return runDurableWithdrawal({ destination, amount, operationId }, {
          network: summary.network, address: summary.address!,
          reserve: (input) => api.post<WalletWithdrawal>(WITHDRAWALS, input),
          claim: (id) => api.post<WalletWithdrawalClaim>(`${WITHDRAWALS}/${encodeURIComponent(id)}/broadcast`, {}),
          cancel: (id) => api.post<WalletWithdrawal>(`${WITHDRAWALS}/${encodeURIComponent(id)}/cancel`, {}),
          reconcile: (id) => api.post<WalletWithdrawal>(`${WITHDRAWALS}/${encodeURIComponent(id)}/reconcile`, {}),
          sign: (op) => {
            if (!wallet?.address || summary.address !== wallet.address.toLowerCase() || sessionKey() !== startingSession) throw new Error("Wallet mismatch");
            return wallet.signTypedData(withdraw3TypedData(network, op.destination, op.amount, op.nonce));
          },
          submit: async (op, signature) => {
            if (sessionKey() !== startingSession) throw new Error("withdrawal_unknown");
            return api.post<WalletWithdrawal>(`${WITHDRAWALS}/${encodeURIComponent(op.id)}/submit`, { signature });
          },
        });
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.wallet.all }),
  });
}
