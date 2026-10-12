import { sql } from 'drizzle-orm';
import { copySignerNonces } from '@trading-dashboard/shared/database';
import type { DbTransaction } from '../db/unit-of-work.js';

/**
 * The one nonce allocator of a Hyperliquid signer. The exchange tracks nonces
 * per signer: the copy account's own key for what it signs (a return, the
 * builder fee, the account mode, the agent approval), the agent's key for
 * what the agent signs (orders, cancels, leverage). Every one of those takes
 * its nonce here, in the caller's transaction and under the signer's lock,
 * so two of them never share a nonce and none goes below one handed out
 * before: at least `now`, else one above the last.
 *
 * `step` wraps each query (a live caller re-checks its risk scope after
 * every statement). The caller checks the clock skew it tolerates.
 * `pipelined`: the upsert is sent right behind the lock instead of after its
 * answer (one round trip on a pipelined session, risk scope); the database
 * still runs it only once the lock is granted, and both must succeed.
 */
export async function allocateSignerNonce(tx: DbTransaction, network: string, signerAddress: string, now: number,
  step: <T>(query: PromiseLike<T>) => Promise<T> = query => Promise.resolve(query), pipelined = false): Promise<number> {
  const lock = () => step(tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`live-nonce:${network}:${signerAddress}`}, 2))`));
  const upsert = () => step(tx.execute<{ nonce: string }>(sql`insert into ${copySignerNonces} (network, signer_address, nonce) values (${network}, ${signerAddress}, ${now})
    on conflict (network, signer_address) do update set nonce = greatest(${now}, ${copySignerNonces.nonce} + 1) returning nonce`));
  let allocated: Awaited<ReturnType<typeof upsert>>;
  if (!pipelined) { await lock(); allocated = await upsert(); }
  else {
    const locked = lock(), allocating = upsert();
    void allocating.catch(() => {});
    await locked; allocated = await allocating;
  }
  return Number(allocated.rows[0]?.nonce);
}
