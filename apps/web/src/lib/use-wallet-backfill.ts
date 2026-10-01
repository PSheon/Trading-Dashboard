"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { queryKeys } from "@/lib/query-keys";

/** The api looks a missing embedded wallet up at Privy at most every 15 s
 * (WALLET_ADDRESS_RETRY_MS / EMBEDDED_WALLET_RETRY_MS); a read inside that
 * window answers from the throttle, so the second refetch waits it out. */
export const WALLET_BACKFILL_RETRY_MS = 16_000;

/**
 * The embedded wallet is created in the browser right after the first
 * sign-in, after /me and /me/wallet have already run and found none. When
 * its address appears, refetch both so the api learns the address from
 * Privy's record and stores it: once at once, once after its retry window.
 */
export function useWalletBackfill(address: string | null) {
  const client = useQueryClient();
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!address || seen.current === address) return;
    seen.current = address;
    const refetch = () => {
      void client.invalidateQueries({ queryKey: queryKeys.wallet.all });
      void client.invalidateQueries({ queryKey: queryKeys.me });
    };
    refetch();
    const later = setTimeout(refetch, WALLET_BACKFILL_RETRY_MS);
    return () => clearTimeout(later);
  }, [address, client]);
}
