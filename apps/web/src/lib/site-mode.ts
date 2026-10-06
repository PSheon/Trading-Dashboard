"use client";

import { useLiveCopyDeployment } from "@/lib/copy-live-setup";

/**
 * The deployment's copy mode, the one source the header's mode badge reads.
 * 模擬 (paper) everywhere copies use virtual funds; where this deployment
 * runs actual copies for the visitor (the api's `capabilities`), 正式 (live)
 * on a mainnet deployment and 測試網 only on a testnet one, so a public
 * paper build never shows either.
 */
export type SiteMode = "paper" | "testnet" | "live";

export function useSiteMode(): SiteMode {
  const deployment = useLiveCopyDeployment();
  if (!deployment?.available) return "paper";
  return deployment.network === "mainnet" ? "live" : "testnet";
}
