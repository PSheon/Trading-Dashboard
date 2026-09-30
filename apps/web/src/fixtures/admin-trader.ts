import type { AdminTrader } from "@/lib/contracts";
export function fixtureAdminTrader(address: string): AdminTrader {
  const known = address === "0x" + "ab".repeat(20);
  const sampledAt = new Date().toISOString();
  return {
    chain: "hyperliquid",
    address,
    sampledAt,
    identity: {
      displayName: known ? "Research trader" : null,
      xHandle: known ? "research" : null,
      kolRegistered: known,
      leaderboardUpdatedAt: null,
    },
    watch: null,
    discovery: known
      ? {
          inPool: true,
          poolRank: null,
          portfolioAt: null,
          tradesAt: null,
          attemptedAt: sampledAt,
          refreshFailed: true,
        }
      : null,
    references: { favorites: known ? 2 : 0, alerts: known ? 1 : 0 },
    imports: {
      items: known
        ? [{ id: 1, source: "manual", rank: 1, importedAt: sampledAt }]
        : [],
      hasMore: false,
    },
    fills: { firstAt: null, lastAt: null },
    analytics: null,
    history: null,
    backfill: null,
  };
}
