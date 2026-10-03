import { sql } from 'drizzle-orm';
import type { DbTransaction } from '../db/unit-of-work.js';

/** Match PostgresLiveRiskScope's session fences. Acquire before row locks;
 * callers own a short local transaction that never spans provider requests. */
export async function lockCopyUser(tx: DbTransaction, userId: number): Promise<void> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || userId > 2147483647) throw new Error('Invalid copy user lock identity');
  await tx.execute(sql`select pg_advisory_xact_lock(7404, ${userId})`);
}

export async function lockCopyPlatform(tx: DbTransaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(7405, 0)`);
}
