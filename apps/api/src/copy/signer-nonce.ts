import { sql } from 'drizzle-orm';
import { copySignerNonces } from '@trading-dashboard/shared/database';
import type { DbTransaction } from '../db/unit-of-work.js';

/**
 * The one nonce allocator per Hyperliquid signer (account key or agent key), in the caller's tx
 * under the signer's lock: never shared, never below one handed out (max(now, last + 1)).
 * `step` wraps each query; the caller checks clock skew. `pipelined` sends the upsert right
 * behind the lock (one round trip); both must succeed.
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
