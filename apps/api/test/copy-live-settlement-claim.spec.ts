import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireSettlementConnection, CopyLiveSettlementClaims, type SettlementClaim } from '../src/copy/live-worker/copy-live-settlement-claim.js';
import { settlementFencedPool } from '../src/copy/live-worker/copy-live-settlement-fenced-pool.js';
const key = `testnet:0x${'11'.repeat(20)}:0x${'22'.repeat(16)}`;
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function poolFixture() {
  const locks = new Map<string, object>(), clients: (EventEmitter & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> })[] = [];
  const pool = { options: { max: 10 }, totalCount: 0, idleCount: 0, connect: vi.fn(async () => {
    const client = Object.assign(new EventEmitter(), { query: vi.fn(async (input: { text: string; values: string[] }) => {
      const k = input.values?.[0];
      if (input.text.includes('pg_try_advisory_lock')) { const held = !locks.has(k); if (held) locks.set(k, client); return { rows: [{ held }] }; }
      if (input.text.includes('pg_advisory_unlock')) { locks.delete(k); return { rows: [] }; }
      if (input.text.includes('pg_locks')) return { rows: [{ held: locks.get(k) === client }] };
      return { rows: [] };
    }), release: vi.fn(() => { for (const [k, owner] of locks) if (owner === client) locks.delete(k); }) });
    clients.push(client); return client;
  }) } as unknown as Pool;
  return { pool, clients, locks };
}
afterEach(() => vi.useRealTimers());
describe('terminal settlement scheduling claims', () => {
  it('healthy replicas perform one paid work callback for the same durable execution', async () => {
    const f = poolFixture(), release = deferred<void>(), entered = deferred<void>(); let paid = 0;
    const first = new CopyLiveSettlementClaims(f.pool).run(key, async () => { paid++; entered.resolve(); await release.promise; });
    await entered.promise;
    expect(await new CopyLiveSettlementClaims(f.pool).run(key, async () => { paid++; })).toBe(false);
    expect(paid).toBe(1);
    release.resolve(); expect(await first).toBe(true);
    expect(f.locks.size).toBe(0);
  });
  it('connection failure aborts work and tombstones retained provider/SQL callbacks', async () => {
    const f = poolFixture(), entered = deferred<void>(); let retained!: SettlementClaim;
    const running = new CopyLiveSettlementClaims(f.pool).run(key, async c => { retained = c; entered.resolve(); await new Promise(() => {}); });
    await entered.promise;
    f.clients[0]!.emit('error', new Error('connection ended'));
    await expect(running).rejects.toThrow('live_settlement_claim_lost');
    expect(retained.signal.aborted).toBe(true);
    expect(() => retained.assertFresh()).toThrow('live_settlement_claim_lost');
    expect(f.clients[0]!.release).toHaveBeenCalledWith(true);
  });
  it('heartbeat detects server-side loss of the advisory claim within its bounded interval', async () => {
    vi.useFakeTimers();
    const f = poolFixture(), entered = deferred<void>();
    const running = new CopyLiveSettlementClaims(f.pool).run(key, async () => { entered.resolve(); await new Promise(() => {}); });
    const assertion = expect(running).rejects.toThrow('live_settlement_claim_lost');
    await entered.promise; f.locks.clear();
    await vi.advanceTimersByTimeAsync(1000); await assertion;
    expect(f.clients[0]!.release).toHaveBeenCalledWith(true);
  });
  it('shutdown aborts a claimed job without admitting its retained callbacks', async () => {
    const f = poolFixture(), shutdown = new AbortController(), entered = deferred<void>(); let claim!: SettlementClaim;
    const running = new CopyLiveSettlementClaims(f.pool).run(key, async c => { claim = c; entered.resolve(); await new Promise(() => {}); }, shutdown.signal);
    const assertion = expect(running).rejects.toThrow('live_settlement_claim_lost');
    await entered.promise; shutdown.abort(); await assertion;
    expect(() => claim.assertFresh()).toThrow('live_settlement_claim_lost');
  });
  it('small or occupied pools skip before consuming a connection', async () => {
    const f = poolFixture(); f.pool.options.max = 2;
    expect(await new CopyLiveSettlementClaims(f.pool).run(key, async () => {})).toBe(false);
    expect(f.pool.connect).not.toHaveBeenCalled();
    f.pool.options.max = 10;
    Object.assign(f.pool, { totalCount: 10, idleCount: 2 });
    expect(await new CopyLiveSettlementClaims(f.pool).run(key, async () => {})).toBe(false);
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it('already aborted shutdown does not even queue a new claim connection', async () => {
    const f = poolFixture(), shutdown = new AbortController(); shutdown.abort();
    await new CopyLiveSettlementClaims(f.pool).run(key, async () => {}, shutdown.signal).catch(() => false);
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it('bounded pool timeout releases a connection that arrives after admission ended', async () => {
    vi.useFakeTimers();
    const late = deferred<PoolClient>(), release = vi.fn();
    const pool = { connect: () => late.promise } as Pool;
    const attempt = acquireSettlementConnection(pool, new AbortController().signal, 25);
    const assertion = expect(attempt).rejects.toThrow('live_settlement_pool_busy');
    await vi.advanceTimersByTimeAsync(25); await assertion;
    late.resolve({ release } as unknown as PoolClient); await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
  });
  it('an in-flight SQL response after loss cannot dispatch a follow-up or COMMIT', async () => {
    const abort = new AbortController(), response = deferred<{ rows: unknown[] }>();
    const query = vi.fn(() => response.promise), release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const pool = { connect: async () => client } as Pool;
    const claim = { signal: abort.signal, assertFresh: () => { if (abort.signal.aborted) throw Error('claim_lost'); }, assertHeld: async () => {} };
    const fenced = await settlementFencedPool(pool, claim).connect();
    const first = fenced.query('select receipt');
    abort.abort(); response.resolve({ rows: [] });
    await expect(first).rejects.toThrow('claim_lost');
    await expect(fenced.query('commit')).rejects.toThrow('claim_lost');
    expect(query).toHaveBeenCalledOnce();
    fenced.release(); expect(release).toHaveBeenCalledWith(true);
  });
  it('loss during BEGIN discards the actual client even when Drizzle has not entered its finally block', async () => {
    const abort = new AbortController(), response = deferred<{ rows: unknown[] }>(), release = vi.fn();
    const pool = { connect: async () => ({ query: () => response.promise, release }) } as unknown as Pool;
    const claim = { signal: abort.signal, assertFresh: () => { if (abort.signal.aborted) throw Error('claim_lost'); }, assertHeld: async () => {} };
    const client = await settlementFencedPool(pool, claim).connect();
    const begin = client.query('begin'); abort.abort(); response.resolve({ rows: [] });
    await expect(begin).rejects.toThrow('claim_lost');
    expect(release).toHaveBeenCalledWith(true);
  });
  it('ROLLBACK remains allowed after claim loss so the real transaction can unwind', async () => {
    const abort = new AbortController();
    const query = vi.fn(async () => ({ rows: [] })), release = vi.fn();
    const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
    const claim = { signal: abort.signal, assertFresh: () => { if (abort.signal.aborted) throw Error('claim_lost'); }, assertHeld: async () => {} };
    const client = await settlementFencedPool(pool, claim).connect(); abort.abort();
    await client.query('rollback'); client.release();
    expect(query).toHaveBeenCalledWith('rollback'); expect(release).toHaveBeenCalledWith(true);
  });
});
