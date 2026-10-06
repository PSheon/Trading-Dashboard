"use client";

import { useLiveCopyAvailable } from "@/lib/copy-live-setup";

/**
 * The deployment's copy mode, the one source the header's mode badge reads.
 * 模擬 (paper) everywhere copies use virtual funds; 測試網 only where this
 * deployment runs testnet copies for the visitor (the api's
 * `capabilities.automaticExecution`, so a public paper build never shows
 * it); 正式 (live) is reserved for the mainnet launch.
 */
export type SiteMode = "paper" | "testnet" | "live";

export function useSiteMode(): SiteMode {
  return useLiveCopyAvailable() ? "testnet" : "paper";
}
