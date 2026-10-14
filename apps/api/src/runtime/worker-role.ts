/**
 * What a worker process runs (WORKER_ROLE, docs/design-hl-egress-2026-10-13.md
 * §3, Phase 1a-3). Unset is `all`: today's single worker, which runs
 * everything and holds both leases.
 *
 * - `copy`: real-money work and its signal source (the live engine, stops,
 *   closes, settlement, the setup driver and aborts, the funding monitor,
 *   the watcher runtime with the trade feed and its check, the fast source,
 *   and the terminal settlement loop). Lease (73106, 1).
 * - `read`: everything else (scheduler crons, traders, discovery, cohorts,
 *   revenue, follower snapshots and receipts, paper copy, outbox, Telegram,
 *   retention, archive). Lease (73106, 2).
 */
export const WORKER_ROLES = ["all", "copy", "read"] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

/** The advisory-lock key's second half, per lease. */
export const COPY_LEASE = 1;
export const READ_LEASE = 2;

/** The leases a role must hold, all at once, before it constructs anything. */
export function roleLeases(role: WorkerRole): readonly number[] {
  return role === "all" ? [COPY_LEASE, READ_LEASE] : role === "copy" ? [COPY_LEASE] : [READ_LEASE];
}

export const runsCopy = (role: WorkerRole) => role !== "read";
export const runsRead = (role: WorkerRole) => role !== "copy";

export function workerRoleValue(raw: string | undefined): WorkerRole {
  const value = (raw ?? "").trim().toLowerCase() || "all";
  if (!(WORKER_ROLES as readonly string[]).includes(value)) throw new Error("WORKER_ROLE must be all, copy or read");
  return value as WorkerRole;
}
