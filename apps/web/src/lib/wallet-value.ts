import type { WalletSummary } from "@/lib/contracts";

export function walletTotalValue(summary: WalletSummary | undefined): number | null {
  // A failed chain read is unknown, rather than a zero contribution.
  if (summary?.address && (!summary.hyperliquid || !summary.arbitrum)) return null;
  return summary?.totalValue ?? null;
}
