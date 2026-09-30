import type { PoolClient } from "pg";

/** Session-scoped, database-local singleton. Keep this dedicated connection open
 * until all worker jobs have drained; never return it to a pool while locked. */
export async function acquireWorkerLease(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(73106, 1) AS acquired");
  return result.rows[0]?.acquired === true;
}
