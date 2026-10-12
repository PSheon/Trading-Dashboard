import { sql } from 'drizzle-orm';
import type { DbTransaction } from '../db/unit-of-work.js';

/** COPY_USER keys are users.id (serial, from 1) and must fit int4. Every
 * (7404, userId) acquirer checks this before taking the lock, so a missing or
 * zero id can never become a shared/bogus lock key. */
export function assertCopyUserLockId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0 || userId > 2147483647) throw new Error('Invalid copy user lock identity');
}

/** Match PostgresLiveRiskScope's session fences. Acquire before row locks;
 * callers own a short local transaction that never spans provider requests. */
export async function lockCopyUser(tx: DbTransaction, userId: number): Promise<void> {
  assertCopyUserLockId(userId);
  await tx.execute(sql`select pg_advisory_xact_lock(7404, ${userId})`);
}

export async function lockCopyPlatform(tx: DbTransaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(7405, 0)`);
}
