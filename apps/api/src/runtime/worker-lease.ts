import type { PoolClient } from "pg";

/** Session-scoped, database-local singleton. Keep this dedicated connection open
 * until all worker jobs have drained; never return it to a pool while locked. */
export async function acquireWorkerLease(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(73106, 1) AS acquired");
  return result.rows[0]?.acquired === true;
}

/**
 * Server-side limits for the lease connection, so a worker cut off by a
 * network partition releases the lease within about half a minute instead
 * of the kernel's TCP timeout (hours): Postgres ends a session idle for 30 s
 * (the holder's probe runs every 5 s, so a live holder is never idle that
 * long), and its own keepalives drop a peer that stopped answering.
 */
export const WORKER_LEASE_SESSION_OPTIONS = "-c idle_session_timeout=30s -c tcp_keepalives_idle=10 -c tcp_keepalives_interval=5 -c tcp_keepalives_count=3";
