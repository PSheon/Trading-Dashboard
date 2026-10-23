import { Client, Pool, type PoolClient } from 'pg';
import { sql } from 'drizzle-orm';
import { PgDatabase, PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeTestDb, getTestDb } from './db-test-utils.js';
import { assertOriginalLiveRiskSession, liveRiskBusyDetail, LiveRiskBusyError, PostgresLiveRiskScope, type LiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';

let pool: Pool;
let scopes: PostgresLiveRiskScope;
const identity = { userId: 1, network: 'testnet' as const, accountAddress: `0x${'ab'.repeat(20)}` };
beforeAll(() => { getTestDb(); pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); scopes = new PostgresLiveRiskScope(pool); });
afterAll(async () => { await pool?.end(); await closeTestDb(); });
/** The backend pid of a scope's own session. */
const backendPid = async (session: Parameters<Parameters<PostgresLiveRiskScope['run']>[1]>[1]) =>
  Number((await session.read(db => db.execute(sql`select pg_backend_pid() as pid`))).rows[0]!.pid);
/** A refusal's pg_locks sessions that are `pid` (fails if pg_locks was not read). */
function ownSessions(refused: LiveRiskBusyError, pid: number) {
  expect(refused.detail.sessions).not.toBeNull();
  return refused.detail.sessions!.filter(session => session.pid === pid);
}
describe('distributed user and account risk serialization', () => {
  it('accepts only the original factory-issued session while that scope is live', async () => {
    let old!: Parameters<Parameters<PostgresLiveRiskScope['run']>[1]>[1];
    await scopes.run(identity, async (_scope, session) => {
      old = session;
      expect(() => assertOriginalLiveRiskSession(session)).not.toThrow();
      expect(() => assertOriginalLiveRiskSession({ ...session })).toThrow('live_risk_serialization_lost');
    });
    await scopes.run(identity, async () => { expect(() => assertOriginalLiveRiskSession(old)).toThrow('live_risk_serialization_lost'); });
  });
  it('fences a captured source stream against ingestion throughout the original scope', async () => {
    const source = { network: 'testnet' as const, leaderAddress: `0x${'44'.repeat(20)}` };
    const key = `live-risk-source:${source.network}:${source.leaderAddress}`;
    await scopes.run({ ...identity, source }, async scope => {
      const writer = await pool.connect();
      try {
        expect((await writer.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1, 8)) as locked', [key])).rows[0]?.locked).toBe(false);
        await scope.assertHeld();
      } finally { writer.release(); }
    });
    const writer = await pool.connect();
    try {
      expect((await writer.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1, 8)) as locked', [key])).rows[0]?.locked).toBe(true);
      await expect(scopes.run({ ...identity, source }, async () => 'unsafe')).rejects.toThrow('live_risk_busy');
    } finally { await writer.query('select pg_advisory_unlock(hashtextextended($1, 8))', [key]); writer.release(); }
  });
  it('rejects an invalid source identity before issuing any database work', async () => {
    const connect = vi.spyOn(pool, 'connect');
    try {
      await expect(scopes.run({ ...identity, source: { network: 'testnet', leaderAddress: 'invalid' } }, async () => 'unsafe')).rejects.toThrow('live_risk_invalid_identity');
      expect(connect).not.toHaveBeenCalled();
    } finally { connect.mockRestore(); }
  });
  it('discards an inherited transaction without committing its unrelated writes', async () => {
    await pool.query('create table if not exists live_scope_probe (id text primary key)');
    await pool.query('delete from live_scope_probe');
    const client = await pool.connect();
    await client.query('begin');
    await client.query("insert into live_scope_probe values ('inherited')");
    const connect = vi.spyOn(pool, 'connect').mockResolvedValueOnce(client as never);
    const release = vi.spyOn(client, 'release');
    const work = vi.fn(async (_scope, session) => session.transaction(async () => 'unsafe'));
    try {
      await expect(scopes.run(identity, work)).rejects.toThrow('live_risk_database_dirty');
      expect(work).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledWith(true);
    } finally { connect.mockRestore(); }
    expect((await pool.query('select * from live_scope_probe')).rows).toEqual([]);
  });
  it('discards a connection when rollback fails, even if the caller catches the error', async () => {
    const client = await pool.connect();
    const connect = vi.spyOn(pool, 'connect').mockResolvedValueOnce(client as never);
    const original = client.query.bind(client);
    const release = vi.spyOn(client, 'release');
    let refused = false;
    client.query = ((...args: Parameters<typeof original>) => {
      const raw: unknown = args[0];
      const command = typeof raw === 'string' ? raw : raw && typeof raw === 'object' && 'text' in raw ? (raw as { text?: string }).text : undefined;
      if (command?.toLowerCase() === 'rollback' && !refused) {
        refused = true; return Promise.reject(new Error('rollback refused'));
      }
      return original(...args);
    }) as typeof client.query;
    try {
      await scopes.run(identity, async (scope, session) => {
        await expect(session.transaction(async () => { throw new Error('callback failed'); })).rejects.toThrow();
        expect(refused).toBe(true);
        expect(() => scope.assertFresh()).toThrow('live_risk_serialization_lost');
        await expect(session.read(async () => 'unsafe')).rejects.toThrow('live_risk_serialization_lost');
      });
      expect(release).toHaveBeenCalledWith(true);
    } finally { connect.mockRestore(); }
  });
  it('enforces a read-only SQL snapshot for proof reads', async () => {
    await pool.query('create table if not exists live_scope_probe (id text primary key)');
    await pool.query('delete from live_scope_probe');
    await scopes.run(identity, async (_scope, session) => {
      await expect(session.read(db => db.execute(sql`insert into live_scope_probe values ('forbidden-read-write')`))).rejects.toThrow();
      const result = await session.read(db => db.execute(sql`select * from live_scope_probe`));
      expect(result.rows).toEqual([]);
    });
  });
  it('runs local reads and transactions on the original lock session', async () => {
    await scopes.run(identity, async (_scope, session) => {
      const read = await session.read(db => db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`));
      const transaction = await session.transaction(async tx => {
        const result = await tx.execute<{ pid: number; locked: boolean }>(sql`select pg_backend_pid() as pid, pg_try_advisory_xact_lock(7404, ${identity.userId}) as locked`);
        return result.rows[0];
      });
      expect(transaction).toEqual({ pid: read.rows[0].pid, locked: true });
    });
  });
  it('refuses overlapping SQL callbacks and tombstones the old session capability', async () => {
    let saved!: Parameters<Parameters<PostgresLiveRiskScope['run']>[1]>[1];
    await scopes.run(identity, async (_scope, session) => {
      saved = session;
      let release!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; });
      const pending = session.read(async () => { await wait; return 'first'; });
      await expect(session.transaction(async () => 'unsafe')).rejects.toThrow('live_risk_database_busy');
      release(); expect(await pending).toBe('first');
    });
    await expect(saved.read(async () => 'unsafe')).rejects.toThrow('live_risk_serialization_lost');
    await expect(saved.transaction(async () => 'unsafe')).rejects.toThrow('live_risk_serialization_lost');
  });
  it('rolls back a local transaction when its owning callback leaves it unawaited', async () => {
    await pool.query('create table if not exists live_scope_probe (id text primary key)');
    await pool.query('delete from live_scope_probe');
    let entered!: () => void, resume!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    let operation!: Promise<void>;
    const run = scopes.run(identity, async (_scope, session) => {
      operation = session.transaction(async tx => {
        await tx.execute(sql`insert into live_scope_probe values ('unawaited')`);
        entered(); await waiting;
      });
      await ready;
    });
    const outcome = run.then(() => null, error => error);
    await Promise.race([ready, outcome.then(error => { if (error) throw error; })]);
    await new Promise(resolve => setImmediate(resolve)); resume();
    expect((await outcome)?.message).toBe('live_risk_database_unawaited');
    await expect(operation).rejects.toThrow('live_risk_serialization_lost');
    expect((await pool.query('select * from live_scope_probe')).rows).toEqual([]);
  });
  it('excludes another account of the same user while the original scope is held', async () => {
    await scopes.run(identity, async scope => {
      await scope.assertHeld(); scope.assertFresh();
      await expect(scopes.run({ ...identity, accountAddress: `0x${'cd'.repeat(20)}` }, async () => 'unsafe'))
        .rejects.toThrow('live_risk_busy');
    });
    expect(await scopes.run(identity, async () => 'next')).toBe('next');
  });
  it('excludes the same account despite changed local ownership', async () => {
    await scopes.run(identity, async () => {
      await expect(scopes.run({ ...identity, userId: 2 }, async () => 'unsafe')).rejects.toThrow('live_risk_busy');
    });
    expect(await scopes.run({ ...identity, userId: 2 }, async () => 'new owner')).toBe('new owner');
  });
  // Gate 11 (2026-10-16): another order's or a settlement's scope holds the
  // user lock a few hundred ms (sampled: ≤ 330 ms); the order's single try
  // failed live_risk_busy, three times, until its signal expired.
  it('tries an exclusive lock held briefly by another holder again within LIVE_RISK_LOCK_WAIT_MS instead of answering busy', async () => {
    const writer = await pool.connect();
    try {
      await writer.query('begin');
      await writer.query('select pg_advisory_xact_lock(7404, $1::integer)', [identity.userId]);
      const released = new Promise(resolve => setTimeout(() => { void writer.query('commit').then(resolve); }, 300));
      const started = performance.now();
      expect(await scopes.run(identity, async () => 'served')).toBe('served');
      expect(performance.now() - started).toBeGreaterThanOrEqual(250);
      await released;
    } finally { writer.release(); }
  });
  // Gate run 9 (2026-10-14): an order waited 12 s, then live_risk_busy, with
  // nothing saying who held the lock.
  it('names the lock and its holder (kind, id, how long) in a live_risk_busy refusal', async () => {
    let clock = 1_000_000;
    const order = new PostgresLiveRiskScope(pool, () => clock, { kind: 'order', id: 'testnet:0xab:0x01' });
    await order.run(identity, async (_scope, session) => {
      // pg_locks spans every database on the server: under a concurrent suite
      // another run's scope can hold the same key in its own database. Only
      // this scope's backend is the holder asserted here.
      const holderPid = await backendPid(session);
      clock += 1_500;
      const refused = await new PostgresLiveRiskScope(pool, () => clock, { kind: 'settlement' }).run({ ...identity, userId: 2 }, async () => 'unsafe').catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(LiveRiskBusyError);
      expect((refused as LiveRiskBusyError).detail).toMatchObject({ lock: 'account', holders: [{ kind: 'order', id: 'testnet:0xab:0x01', heldMs: 1_500 }] });
      // The holding session as pg_locks shows it (any process, any writer).
      expect(ownSessions(refused as LiveRiskBusyError, holderPid)).toEqual([expect.objectContaining({ pid: holderPid })]);
      expect(liveRiskBusyDetail(refused)).toContain('"kind":"order"');
    });
    // A transaction-scoped writer in another session: no scope holds it, pg_locks names it.
    const writer = await pool.connect();
    try {
      await writer.query('begin');
      const writerPid = (await writer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
      await writer.query('select pg_advisory_xact_lock(7404, $1::integer)', [identity.userId]);
      const refused = await scopes.run(identity, async () => 'unsafe').catch((error: unknown) => error) as LiveRiskBusyError;
      expect(refused.detail).toMatchObject({ lock: 'user', holders: [] });
      expect(ownSessions(refused, writerPid)).toEqual([expect.objectContaining({ state: 'idle in transaction' })]);
      expect(ownSessions(refused, writerPid)[0]!.heldMs).toBeGreaterThanOrEqual(0);
      // Which code path: the table (or lock function) of its latest statement
      // (gate run 10: an idle-in-transaction holder nothing could name).
      expect(ownSessions(refused, writerPid)[0]!.last).toBe('pg_advisory_xact_lock');
      await writer.query('select count(*) from copy_live_dispatches');
      const again = await scopes.run(identity, async () => 'unsafe').catch((error: unknown) => error) as LiveRiskBusyError;
      expect(ownSessions(again, writerPid)).toEqual([expect.objectContaining({ state: 'idle in transaction', last: 'copy_live_dispatches' })]);
    } finally { await writer.query('rollback'); writer.release(); }
  });
  it("names only this database's holders: pg_locks lists every database on the server", async () => {
    const elsewhere = new URL(process.env.TEST_DATABASE_URL!); elsewhere.pathname = '/postgres';
    const foreign = new Client({ connectionString: elsewhere.toString() }), writer = await pool.connect();
    await foreign.connect();
    try {
      // The same advisory key held in another database on the same server.
      await foreign.query('begin');
      const foreignPid = (await foreign.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
      await foreign.query('select pg_advisory_xact_lock(7404, $1::integer)', [identity.userId]);
      await writer.query('begin');
      const writerPid = (await writer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
      await writer.query('select pg_advisory_xact_lock(7404, $1::integer)', [identity.userId]);
      const refused = await scopes.run(identity, async () => 'unsafe').catch((error: unknown) => error) as LiveRiskBusyError;
      expect(refused.detail).toMatchObject({ lock: 'user' });
      expect(refused.detail.sessions?.map(s => s.pid)).toEqual([writerPid]);
      expect(refused.detail.sessions?.map(s => s.pid)).not.toContain(foreignPid);
    } finally {
      await writer.query('rollback'); writer.release();
      await foreign.query('rollback'); await foreign.end();
    }
  });
  it('allows independent users/accounts but serializes a user across networks', async () => {
    await scopes.run(identity, async () => {
      expect(await scopes.run({ ...identity, userId: 2, accountAddress: `0x${'cd'.repeat(20)}` }, async () => 'independent')).toBe('independent');
      await expect(scopes.run({ ...identity, network: 'mainnet' }, async () => 'unsafe')).rejects.toThrow('live_risk_busy');
      expect(await scopes.run({ ...identity, userId: 3, network: 'mainnet' }, async () => 'network')).toBe('network');
    });
  });
  it('shares the exact transaction namespaces used by risk and control writers', async () => {
    const writer = await pool.connect();
    try {
      await scopes.run(identity, async () => {
        for (const [namespace, target] of [[7403, 0], [7405, 0], [7404, identity.userId]]) {
          await writer.query('begin');
          try {
            const result = await writer.query<{ locked: boolean }>('select pg_try_advisory_xact_lock($1::integer,$2::integer) as locked', [namespace, target]);
            expect(result.rows[0]?.locked).toBe(false);
          } finally { await writer.query('rollback'); }
        }
      });
      for (const [namespace, target] of [[7403, 0], [7405, 0], [7404, identity.userId]]) {
        await writer.query('begin');
        try {
          const result = await writer.query<{ locked: boolean }>('select pg_try_advisory_xact_lock($1::integer,$2::integer) as locked', [namespace, target]);
          expect(result.rows[0]?.locked).toBe(true);
        } finally { await writer.query('rollback'); }
      }
    } finally { writer.release(); }
  });
  it('old callbacks cannot transfer authority to a successor scope', async () => {
    let previous!: LiveRiskScope;
    await scopes.run(identity, async scope => { previous = scope; await scope.assertHeld(); });
    await scopes.run(identity, async scope => {
      await scope.assertHeld(); scope.assertFresh();
      expect(() => previous.assertFresh()).toThrow('live_risk_serialization_lost');
      await expect(previous.assertHeld()).rejects.toThrow('live_risk_serialization_lost');
    });
  });
  it('releases both locks and invalidates callbacks when work throws', async () => {
    let previous!: LiveRiskScope;
    await expect(scopes.run(identity, async scope => { previous = scope; throw new Error('failed'); })).rejects.toThrow('failed');
    expect(() => previous.assertFresh()).toThrow('live_risk_serialization_lost');
    expect(await scopes.run(identity, async () => 'recovered')).toBe('recovered');
  });
  it('detects lost SQL locks and never restores the original authority', async () => {
    const client = await pool.connect();
    const connect = vi.spyOn(pool, 'connect').mockResolvedValueOnce(client as never);
    try {
      await scopes.run(identity, async scope => {
        await scope.assertHeld();
        await client.query('select pg_advisory_unlock_all()');
        await expect(scope.assertHeld()).rejects.toThrow('live_risk_serialization_lost');
        expect(() => scope.assertFresh()).toThrow('live_risk_serialization_lost');
      });
    } finally { connect.mockRestore(); }
    expect(await scopes.run(identity, async () => 'successor')).toBe('successor');
  });
  it('invalidates synchronous authority when the original client closes without an error event', async () => {
    const client = await pool.connect();
    const connect = vi.spyOn(pool, 'connect').mockResolvedValueOnce(client as never);
    try {
      await scopes.run(identity, async scope => {
        await scope.assertHeld();
        await client.end();
        expect(() => scope.assertFresh()).toThrow('live_risk_serialization_lost');
        await expect(scope.assertHeld()).rejects.toThrow('live_risk_serialization_lost');
      });
    } finally { connect.mockRestore(); }
    expect(await scopes.run(identity, async () => 'successor')).toBe('successor');
  });
  it('expires synchronous proof after 5 seconds and requires a fresh SQL check', async () => {
    let now = 1_790_000_000_000;
    const controlled = new PostgresLiveRiskScope(pool, () => now);
    await controlled.run(identity, async scope => {
      scope.assertFresh(); now += 5001;
      expect(() => scope.assertFresh()).toThrow('live_risk_serialization_stale');
      await scope.assertHeld(); scope.assertFresh();
      now -= 1;
      expect(() => scope.assertFresh()).toThrow('live_risk_serialization_stale');
    });
  });
  it('does not refresh the proof timestamp through a slow SQL wait', async () => {
    let now = 1_790_000_000_000;
    const client = await pool.connect(); const query = client.query.bind(client);
    const connect = vi.spyOn(pool, 'connect').mockResolvedValueOnce(client as never);
    // The slow wait is on the wire, under the scope's counted query (which
    // must stay installed: the scope refuses a connection whose query was
    // replaced while it owns it).
    let slow = false;
    const wire = vi.spyOn(client, 'query').mockImplementation((async (...args: Parameters<typeof query>) => {
      const result = await query(...args); if (slow) now += 5001; return result;
    }) as never);
    try {
      const controlled = new PostgresLiveRiskScope(pool, () => now);
      await controlled.run(identity, async scope => {
        // A statement since the scope's last lock check: the next assertHeld sends its own.
        await client.query('select 1');
        slow = true;
        try { await expect(scope.assertHeld()).rejects.toThrow('live_risk_serialization_stale'); }
        finally { slow = false; }
        expect(() => scope.assertFresh()).toThrow('live_risk_serialization_lost');
      });
    } finally { connect.mockRestore(); wire.mockRestore(); }
  });
  /** The scope's connection, its statements recorded as sent with how many
   * of its earlier ones were still unanswered (0: a new round trip). */
  async function wired(work: (sent: { text: string; inflight: number }[], connection: import('pg').PoolClient) => Promise<void>,
    refuse?: (text: string) => Error | undefined) {
    const connection = await pool.connect(), connect = vi.spyOn(pool, 'connect').mockResolvedValueOnce(connection as never);
    const query = connection.query, sent: { text: string; inflight: number }[] = [];
    let inflight = 0;
    const wire = vi.spyOn(connection, 'query').mockImplementation(function (this: unknown, ...args: unknown[]) {
      const text = String(typeof args[0] === 'string' ? args[0] : (args[0] as { text?: unknown })?.text ?? '').trim();
      sent.push({ text, inflight });
      const refused = refuse?.(text);
      if (refused) return Promise.reject(refused) as never;
      const result = (query as (...values: unknown[]) => unknown).apply(connection, args) as Promise<unknown>;
      inflight++; const done = () => { inflight--; }; void result.then(done, done);
      return result as never;
    } as never);
    try { await work(sent, connection); } finally { connect.mockRestore(); wire.mockRestore(); }
  }
  const kind = (text: string) => text.includes('from pg_locks') ? 'check' : text.split(/\s+/).slice(0, 2).join(' ');
  it('pipelines a read: one round trip for BEGIN, its reads and their lock checks, then COMMIT; the connection goes back as it came', async () => {
    await wired(async (sent, connection) => {
      const installed = connection.query;
      await scopes.run(identity, async (scope, session) => {
        expect((connection as unknown as { pipeline: boolean }).pipeline).toBe(true);
        await scope.assertHeld();
        sent.length = 0;
        const rows = await session.read(async db => {
          const [one, two] = await Promise.all([db.execute(sql`select 1 as one`), db.execute(sql`select 2 as two`)]);
          await scope.assertHeld(); await scope.assertHeld();
          return [one.rows[0], two.rows[0]];
        });
        expect(rows).toEqual([{ one: 1 }, { two: 2 }]);
        // Each statement is followed on the wire by the lock check; every
        // assertHeld (the transaction's, the read's, the scope's) is answered
        // by those: no check of its own.
        expect(sent.map(q => kind(q.text))).toEqual(['begin isolation', 'select set_config(\'statement_timeout\',', 'check',
          'select 1', 'check', 'select 2', 'check', 'commit', 'check']);
        // Two round trips: BEGIN with everything behind it, then COMMIT.
        expect(sent.map(q => q.inflight === 0)).toEqual([true, false, false, false, false, false, false, true, false]);
      });
      expect((connection as unknown as { pipeline: boolean }).pipeline).toBe(false);
      expect(connection.query).toBe(installed);
    });
  });
  it('sends a readsFirst transaction\'s first reads behind BEGIN, refuses a write before BEGIN\'s answer, and after a failed BEGIN sends nothing but ROLLBACK', async () => {
    await pool.query('create table if not exists live_scope_probe (id text primary key)');
    await pool.query('delete from live_scope_probe');
    await wired(async sent => {
      await scopes.run(identity, async (_scope, session) => {
        sent.length = 0;
        const counted = await session.transaction(async tx => {
          const [before] = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from live_scope_probe`)).rows;
          await tx.execute(sql`insert into live_scope_probe values ('reads-first')`);
          return before;
        }, { readsFirst: true });
        expect(counted).toEqual({ n: 0 });
        expect(sent.find(q => q.text.startsWith('select count(*)'))!.inflight).toBeGreaterThan(0);
        await expect(session.transaction(tx => tx.execute(sql`insert into live_scope_probe values ('write-first')`), { readsFirst: true }))
          .rejects.toMatchObject({ cause: expect.objectContaining({ code: 'live_risk_database_dirty' }) });
      });
    });
    await wired(async sent => {
      await expect(scopes.run(identity, (_scope, session) => session.transaction(async tx => {
        await tx.execute(sql`select count(*)::int as n from live_scope_probe`);
        await tx.execute(sql`insert into live_scope_probe values ('after-failed-begin')`);
      }, { readsFirst: true }))).rejects.toThrow();
      const begin = sent.findIndex(q => q.text.startsWith('begin'));
      expect(sent.slice(begin + 1).filter(q => !/^(select|rollback)\b/.test(q.text)).map(q => q.text)).toEqual([]);
    }, text => text.startsWith('begin') ? new Error('begin refused') : undefined);
    expect((await pool.query('select id from live_scope_probe order by id')).rows).toEqual([{ id: 'reads-first' }]);
  });
  it.each(['for update', 'FOR NO KEY UPDATE', 'For Share', 'for  key\n share'])('refuses a row lock (%j) sent before BEGIN\'s answer and sends it after', async lock => {
    // A row-locking read is not a plain read: outside a transaction (BEGIN
    // failed) it would still lock, and wait without the transaction's timeouts.
    await pool.query('create table if not exists live_scope_probe (id text primary key)');
    await pool.query('delete from live_scope_probe');
    await pool.query("insert into live_scope_probe values ('locked')");
    await wired(async sent => {
      await scopes.run(identity, async (_scope, session) => {
        sent.length = 0;
        await expect(session.transaction(tx => tx.execute(sql.raw(`select id from live_scope_probe ${lock}`)), { readsFirst: true }))
          .rejects.toMatchObject({ cause: expect.objectContaining({ code: 'live_risk_database_dirty' }) });
        expect(sent.filter(q => q.text.startsWith('select id from live_scope_probe'))).toEqual([]);
        // Without readsFirst it goes out after BEGIN's answer, behind nothing.
        sent.length = 0;
        const rows = await session.transaction(async tx => (await tx.execute(sql.raw(`select id from live_scope_probe ${lock}`))).rows);
        expect(rows).toEqual([{ id: 'locked' }]);
        expect(sent.find(q => q.text.startsWith('select id from live_scope_probe'))!.inflight).toBe(0);
      });
    });
  });
  it('fails closed when the connection\'s counted query is replaced: no reused lock check proves locks a bypassing statement released', async () => {
    const raw = Client.prototype.query;
    // A statement sent around the scope's counted query (here: releasing
    // every advisory lock) right after an answered check: the next
    // assertHeld must not be answered by that check.
    const connection = await pool.connect(), connect = vi.spyOn(pool, 'connect').mockResolvedValueOnce(connection as never), release = vi.spyOn(connection, 'release');
    try {
      await expect(scopes.run(identity, async (scope, session) => {
        await session.read(db => db.execute(sql`select 1`));
        connection.query = function bypass(this: unknown, ...args: unknown[]) { return (raw as (...values: unknown[]) => unknown).apply(connection, args); } as never;
        await connection.query('select pg_advisory_unlock_all()');
        await scope.assertHeld();
      })).rejects.toThrow('live_risk_serialization_lost');
      expect(release).toHaveBeenCalledWith(true);
    } finally { connect.mockRestore(); }
    // Replaced while idle (nothing sent through it): the next DAL statement
    // is refused and the connection is destroyed rather than reused.
    for (const replace of [(c: PoolClient) => { const counted = c.query; c.query = function wrapped(this: unknown, ...args: unknown[]) { return (counted as (...values: unknown[]) => unknown).apply(c, args); } as never; },
      (c: PoolClient) => { (c as unknown as { pipeline: boolean }).pipeline = false; }]) {
      const client = await pool.connect(), admitted = vi.spyOn(pool, 'connect').mockResolvedValueOnce(client as never), released = vi.spyOn(client, 'release');
      try {
        await expect(scopes.run(identity, async (_scope, session) => {
          replace(client);
          await session.read(db => db.execute(sql`select 1`));
        })).rejects.toThrow('live_risk_serialization_lost');
        expect(released).toHaveBeenCalledWith(true);
      } finally { admitted.mockRestore(); }
    }
    // Replaced after the work's last statement: released destroyed.
    const last = await pool.connect(), admitted = vi.spyOn(pool, 'connect').mockResolvedValueOnce(last as never), released = vi.spyOn(last, 'release');
    try {
      await scopes.run(identity, async (_scope, session) => {
        await session.read(db => db.execute(sql`select 1`));
        last.query = function wrapped(this: unknown, ...args: unknown[]) { return (raw as (...values: unknown[]) => unknown).apply(last, args); } as never;
      });
      expect(released).toHaveBeenCalledWith(true);
    } finally { admitted.mockRestore(); }
  });
  it('tells Drizzle BEGIN answered with a value that throws on any read, and real Drizzle transactions never read it', async () => {
    // drizzle-orm 0.45.3 (pinned) awaits `tx.execute(sql`begin`)` and ignores
    // the result. A Drizzle that reads it fails here: the read throws.
    await pool.query('create table if not exists live_scope_probe (id text primary key)');
    await pool.query('delete from live_scope_probe');
    // Drizzle's execute() is lazy (it runs when awaited): what Drizzle's own
    // await of BEGIN resolved to is recorded as it happens.
    const dialect = new PgDialect(), original = PgDatabase.prototype.execute, begins: unknown[] = [];
    const execute = vi.spyOn(PgDatabase.prototype, 'execute').mockImplementation(function (this: PgDatabase<never>, query) {
      const pending = original.call(this, query);
      if (!/^begin\b/i.test(dialect.sqlToQuery(query as never).sql)) return pending;
      return { then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => pending.then(value => { begins.push(value); return value; }).then(resolve, reject) } as never;
    });
    try {
      await scopes.run(identity, async (_scope, session) => {
        const read = await session.read(async db => (await db.execute<{ n: number }>(sql`select count(*)::int as n from live_scope_probe`)).rows[0]);
        const written = await session.transaction(async tx => {
          const [before] = await tx.select({ n: sql<number>`count(*)::int` }).from(sql`live_scope_probe`);
          await tx.execute(sql`insert into live_scope_probe values ('proxy-begin')`);
          return before;
        }, { readsFirst: true });
        expect([read, written]).toEqual([{ n: 0 }, { n: 0 }]);
      });
      expect(begins).toHaveLength(2);
      for (const answer of begins as Record<string, unknown>[]) {
        expect(answer.then).toBeUndefined();
        for (const read of [() => answer.rows, () => answer.rowCount, () => answer.command, () => Object.keys(answer), () => 'rows' in answer, () => JSON.stringify(answer)])
          expect(read).toThrow('live_risk_database_dirty');
      }
    } finally { execute.mockRestore(); }
    expect((await pool.query('select id from live_scope_probe')).rows).toEqual([{ id: 'proxy-begin' }]);
  });
  it('captures identity before awaiting pool admission', async () => {
    const mutable = { ...identity };
    const pending = scopes.run(mutable, async scope => {
      expect(scope.identity).toEqual(identity);
      expect(Object.isFrozen(scope.identity)).toBe(true);
    });
    mutable.userId = 99; mutable.accountAddress = `0x${'cd'.repeat(20)}`;
    await pending;
  });
  it.each([{ ...identity, userId: 0 }, { ...identity, userId: 2147483648 }, { ...identity, network: 'unknown' }, { ...identity, accountAddress: '0x00' },
    { ...identity, accountAddress: `0x${'00'.repeat(20)}` }])('rejects malformed scope before taking a connection', async input => {
    const connect = vi.spyOn(pool, 'connect');
    try {
      await expect(scopes.run(input as typeof identity, async () => 'unsafe')).rejects.toThrow('live_risk_invalid_identity');
      expect(connect).not.toHaveBeenCalled();
    } finally { connect.mockRestore(); }
  });
});
