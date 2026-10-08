import type { Pool, PoolClient, QueryConfig } from 'pg';
import { LiveBoundaryError } from '../live/wallet-authorization.js';

export interface SettlementClaim {
  readonly signal: AbortSignal;
  assertFresh(): void;
  assertHeld(): Promise<void>;
}
const fail = () => new LiveBoundaryError('live_settlement_claim_lost');
/** Bounds queue admission, including a pool that resolves a cancelled waiter late. */
export function acquireSettlementConnection(pool: Pool, signal: AbortSignal, waitMs = 250): Promise<PoolClient> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error: Error) => { if (finished) return; finished = true; cleanup(); reject(error); };
    const onAbort = () => finish(fail());
    const timer = setTimeout(() => finish(new LiveBoundaryError('live_settlement_pool_busy')), waitMs);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    void pool.connect().then(client => {
      if (finished || signal.aborted) { client.release(); if (!finished) onAbort(); return; }
      finished = true; cleanup(); resolve(client);
    }, error => finish(error instanceof Error ? error : fail()));
  });
}
/** A scheduling lease only. Original DAL remains the sole release authority.
 * Session lock disappears on crash; no transaction spans HTTP or quota waits. */
export class CopyLiveSettlementClaims {
  constructor(private readonly pool: Pool, private readonly now = Date.now) {}
  async run(key: string, work: (claim: SettlementClaim) => Promise<void>, signal?: AbortSignal): Promise<boolean> {
    if (!/^testnet:0x[0-9a-f]{40}:0x[0-9a-f]{32}$/.test(key)) throw new LiveBoundaryError('live_settlement_claim_identity');
    const max = this.pool.options.max ?? 10;
    // Claim + original risk connection, and one slot retained for other callers.
    if (max <= 2 || this.pool.totalCount - this.pool.idleCount > max - 3) return false;
    const abort = new AbortController();
    let client: PoolClient;
    try { client = await acquireSettlementConnection(this.pool, signal ? AbortSignal.any([signal, abort.signal]) : abort.signal); }
    catch { return false; }
    let held = false, lost = false, checkedAt = 0, checking: Promise<void> | undefined;
    const lose = () => { lost = true; abort.abort(); };
    signal?.addEventListener('abort', lose, { once: true });
    if (signal?.aborted) lose();
    client.on('error', lose); client.on('end', lose);
    const assertFresh = () => {
      if (!held || lost || abort.signal.aborted || this.now() < checkedAt || this.now() - checkedAt > 1500) throw fail();
    };
    const assertHeld = (): Promise<void> => {
      if (!held || lost || abort.signal.aborted) return Promise.reject(fail());
      if (checking) return checking;
      checking = (async () => {
        const started = this.now();
        try {
          const result = await client.query<{ held: boolean }>({ text: `select exists(select 1 from pg_locks where pid=pg_backend_pid()
            and locktype='advisory' and granted and mode='ExclusiveLock' and objsubid=1
            and classid::bigint=((hashtextextended($1, 31)>>32)&4294967295)
            and objid::bigint=(hashtextextended($1, 31)&4294967295)) as held`, values: [`copy-live-settlement:${key}`], query_timeout: 1000 } as QueryConfig);
          if (result.rows[0]?.held !== true) throw fail();
          checkedAt = started; assertFresh();
        } catch { lose(); throw fail(); }
      })().finally(() => { checking = undefined; });
      return checking;
    };
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const lifetime = setTimeout(lose, 240000); lifetime.unref?.();
    try {
      if (abort.signal.aborted) throw fail();
      const locked = await client.query<{ held: boolean }>({ text: 'select pg_try_advisory_lock(hashtextextended($1, 31)) as held', values: [`copy-live-settlement:${key}`], query_timeout: 1000 } as QueryConfig);
      held = locked.rows[0]?.held === true;
      if (!held) return false;
      await assertHeld();
      heartbeat = setInterval(() => { void assertHeld().catch(lose); }, 1000); heartbeat.unref?.();
      const interrupted = new Promise<never>((_resolve, reject) => {
        abort.signal.addEventListener('abort', () => reject(fail()), { once: true });
      });
      await Promise.race([work(Object.freeze({ signal: abort.signal, assertFresh, assertHeld })), interrupted]);
      await assertHeld();
      return true;
    } catch (error) { lose(); throw error; } finally {
      clearInterval(heartbeat); clearTimeout(lifetime);
      // Fence all retained callbacks before unlocking or returning the client.
      abort.abort();
      if (checking) await checking.catch(() => {});
      if (held && !lost) {
        try { await client.query({ text: 'select pg_advisory_unlock(hashtextextended($1, 31))', values: [`copy-live-settlement:${key}`], query_timeout: 1000 } as QueryConfig); }
        catch { lost = true; }
      }
      held = false;
      signal?.removeEventListener('abort', lose);
      client.removeListener('error', lose); client.removeListener('end', lose);
      client.release(lost);
    }
  }
}
