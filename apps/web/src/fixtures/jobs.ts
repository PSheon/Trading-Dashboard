import type { BackfillJob } from "@/lib/contracts";
const stamp = new Date().toISOString();
export const fixtureJobs: BackfillJob[] = Array.from(
  { length: 30 },
  (_, i) => ({
    id: i + 1,
    chain: "hyperliquid",
    address: `0x${(i + 1).toString(16).padStart(40, "0")}`,
    source: i % 2 ? "import" : "favorite",
    status: i === 29 ? "failed" : i === 28 ? "running" : "completed",
    attempts: i === 29 ? 3 : 1,
    runAttempts: i === 29 ? 3 : 1,
    version: 2,
    createdAt: stamp,
    availableAt: stamp,
    startedAt: stamp,
    completedAt: i < 28 ? stamp : null,
    leaseExpiresAt:
      i === 28 ? new Date(Date.now() + 90000).toISOString() : null,
    fillsFetched: i < 28 ? 100 + i : null,
    lastErrorCode: i === 29 ? "backfill_failed" : null,
  }),
);
