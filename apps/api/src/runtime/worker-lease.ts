import { setTimeout as delay } from "node:timers/promises";
import type { PoolClient } from "pg";
import { WORKER_DB_RETRY_WINDOW_MS, WORKER_LEASE_BACKOFF_MAX_MS, WORKER_LEASE_BACKOFF_MIN_MS, WORKER_LEASE_POLL_MS } from '../config/constants/background.js';

/** Session-scoped, database-local singleton. Keep this dedicated connection open
 * until all worker jobs have drained; never return it to a pool while locked. */
export async function acquireWorkerLease(client: Pick<PoolClient, "query">): Promise<boolean> {
  const result = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(73106, 1) AS acquired");
  return result.rows[0]?.acquired === true;
}

/**
 * The role's leases (runtime/worker-role.ts: copy (73106, 1), read
 * (73106, 2), `all` both), all or none: a process that got only some gives
 * them back at once, so an `all` worker never sits on one lease while it
 * waits for the other (that would hold a `copy` or `read` worker off it).
 */
export async function acquireWorkerLeases(client: Pick<PoolClient, "query">, leases: readonly number[]): Promise<boolean> {
  if (leases.length === 1 && leases[0] === 1) return acquireWorkerLease(client);
  // Each lease is its own literal call site, registered in db/advisory-lock.ts.
  const held: number[] = [];
  for (const key of leases) {
    const sql = key === 1 ? "SELECT pg_try_advisory_lock(73106, 1) AS acquired" : key === 2 ? "SELECT pg_try_advisory_lock(73106, 2) AS acquired" : null;
    if (!sql) throw new Error(`unknown worker lease ${key}`);
    const result = await client.query<{ acquired: boolean }>(sql);
    if (result.rows[0]?.acquired !== true) break;
    held.push(key);
  }
  if (held.length === leases.length) return true;
  for (const key of held) await client.query(key === 1 ? "SELECT pg_advisory_unlock(73106, 1)" : "SELECT pg_advisory_unlock(73106, 2)");
  return false;
}

/**
 * Server-side limits for the lease connection, so a worker cut off by a
 * network partition releases the lease within about half a minute instead
 * of the kernel's TCP timeout (hours): Postgres ends a session idle for 30 s
 * (the holder's probe runs every 5 s, so a live holder is never idle that
 * long), and its own keepalives drop a peer that stopped answering.
 */
export const WORKER_LEASE_SESSION_OPTIONS = "-c idle_session_timeout=30s -c tcp_keepalives_idle=10 -c tcp_keepalives_interval=5 -c tcp_keepalives_count=3";


export interface LeaseClient {
  query: PoolClient["query"];
  release(destroy?: boolean): void;
}

export interface AcquireOwnershipOptions<C extends LeaseClient> {
  connect(): Promise<C>;
  /** Default: `acquireWorkerLease`. */
  acquire?(client: C): Promise<boolean>;
  signal: AbortSignal;
  logger: { log(message: string): void; warn(message: string): void };
  /** Continuous time without a usable database before giving up. */
  retryWindowMs?: number;
  now?(): number;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

/**
 * Connects and takes the worker lease, waiting as standby while another
 * worker holds it. Database failures (cannot connect, or the standby
 * connection fails) are retried on a fresh connection with exponential
 * backoff (1 s → 30 s) for `retryWindowMs` of continuous unavailability,
 * then rethrown; any answer from the database restarts the window. Standby
 * itself is not bounded: a live worker holds the lease. Resolves with the
 * connection that holds the lease. Nothing runs before this resolves, so
 * reconnecting here can never make two workers active.
 */
export async function acquireWorkerOwnership<C extends LeaseClient>(options: AcquireOwnershipOptions<C>): Promise<C> {
  const { signal, logger } = options;
  const acquire = (client: C) => options.acquire ? options.acquire(client) : acquireWorkerLease(client);
  const window = options.retryWindowMs ?? WORKER_DB_RETRY_WINDOW_MS;
  const now = () => options.now ? options.now() : Date.now();
  const sleep = (ms: number) => options.sleep ? options.sleep(ms, signal) : delay(ms, undefined, { signal });
  let failingSince: number | undefined;
  let attempt = 0;
  for (;;) {
    signal.throwIfAborted();
    let client: C | undefined;
    try {
      client = await options.connect();
      for (;;) {
        const acquired = await acquire(client);
        if (failingSince !== undefined) logger.log("Worker database reachable again");
        failingSince = undefined;
        attempt = 0;
        if (acquired) return client;
        await sleep(WORKER_LEASE_POLL_MS);
      }
    } catch (error) {
      client?.release(true);
      if (signal.aborted) throw error;
      const at = now();
      failingSince ??= at;
      const left = failingSince + window - at;
      if (left <= 0) throw error;
      const wait = Math.min(WORKER_LEASE_BACKOFF_MAX_MS, WORKER_LEASE_BACKOFF_MIN_MS * 2 ** attempt, left);
      attempt += 1;
      logger.warn(`Worker database unavailable (attempt ${attempt}, for ${Math.round((at - failingSince) / 1000)} s); retrying in ${Math.round(wait / 1000)} s`);
      await sleep(wait);
    }
  }
}
