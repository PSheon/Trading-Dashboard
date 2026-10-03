import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeTestDb, getTestDb } from './db-test-utils.js';
import { PostgresLiveRiskScope, type LiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';

let pool: Pool;
let scopes: PostgresLiveRiskScope;
const identity = { userId: 1, network: 'testnet' as const, accountAddress: `0x${'ab'.repeat(20)}` };
beforeAll(() => { getTestDb(); pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); scopes = new PostgresLiveRiskScope(pool); });
afterAll(async () => { await pool?.end(); await closeTestDb(); });
describe('distributed user and account risk serialization', () => {
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
    try {
      const controlled = new PostgresLiveRiskScope(pool, () => now);
      await controlled.run(identity, async scope => {
        const original = client.query;
        client.query = (async (...args: Parameters<typeof query>) => { const result = await query(...args); now += 5001; return result; }) as typeof client.query;
        try { await expect(scope.assertHeld()).rejects.toThrow('live_risk_serialization_stale'); }
        finally { client.query = original; }
        expect(() => scope.assertFresh()).toThrow('live_risk_serialization_lost');
      });
    } finally { connect.mockRestore(); }
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
