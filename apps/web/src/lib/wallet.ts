"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { WalletHistory, WalletSummary } from "@/lib/contracts";
import {
  MIN_BRIDGE_USDC,
  erc20TransferData,
  networkConfig,
  usdcString,
  usdcToUnits,
  withdraw3Request,
  withdraw3TypedData,
} from "@/lib/hyperliquid-network";
import { busyRetry } from "@/lib/query-policy";
import { queryKeys } from "@/lib/query-keys";

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

/** Hyperliquid's answer to an exchange request. */
interface ExchangeReply {
  status: "ok" | "err";
  response?: unknown;
}

/**
 * Withdraw USDC to an Arbitrum address: the user's embedded wallet signs a
 * `withdraw3` action (EIP-712) in the browser and the signed request goes
 * straight to Hyperliquid's exchange endpoint on the wallet network. The
 * api never sees the signature. Hyperliquid takes its $1 fee from `amount`.
 */
export function useWithdraw() {
  const { wallet } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ summary, destination, amount }: { summary: WalletSummary; destination: string; amount: string }) => {
      if (!wallet?.address) throw new Error("No wallet");
      if (!summary.address || summary.address !== wallet.address.toLowerCase()) throw new Error("Wallet mismatch");
      const network = networkConfig(summary.network);
      const time = Date.now();
      const signature = await wallet.signTypedData(withdraw3TypedData(network, destination, amount, time));
      const res = await fetch(network.exchangeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withdraw3Request(network, destination, amount, time, signature)),
      });
      const reply = (await res.json().catch(() => null)) as ExchangeReply | null;
      if (!res.ok || reply?.status !== "ok") {
        throw new Error(typeof reply?.response === "string" ? reply.response : `Hyperliquid answered ${res.status}`);
      }
      return reply;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.wallet.all }),
  });
}
