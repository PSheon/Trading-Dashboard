import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeTestDb, getTestDb, truncateAll, type TestDb } from './db-test-utils.js';

let db: TestDb;
const leader = `0x${'44'.repeat(20)}`, streamId = `testnet:${leader}`;
beforeAll(() => { db = getTestDb(); });
beforeEach(async () => { await truncateAll(db); });
afterAll(closeTestDb);
it('requires durable provenance tables and restrictive authority foreign keys', async () => {
  const tables = await db.execute<{ name: string }>(sql`select tablename as name from pg_tables where schemaname = 'public' and tablename in
    ('copy_live_source_streams','copy_live_source_fills','copy_live_signal_legs','copy_live_intent_provenance','copy_live_reduction_carry')`);
  expect(tables.rows.map(r => r.name).sort()).toEqual(['copy_live_intent_provenance','copy_live_reduction_carry','copy_live_signal_legs','copy_live_source_fills','copy_live_source_streams']);
  const fks = await db.execute<{ count: number }>(sql`select count(*)::int as count from pg_constraint where contype = 'f' and confdeltype = 'r'
    and conrelid in ('copy_live_source_fills'::regclass,'copy_live_signal_legs'::regclass,'copy_live_intent_provenance'::regclass,'copy_live_reduction_carry'::regclass)`);
  expect(fks.rows[0]?.count).toBeGreaterThanOrEqual(7);
});
it('requires explicit bounded coverage before a stream can become ready', async () => {
  await db.execute(sql`insert into copy_live_source_streams(id,network,leader_address) values (${streamId},'testnet',${leader})`);
  await expect(db.execute(sql`update copy_live_source_streams set state = 'ready' where id = ${streamId}`)).rejects.toThrow();
  await expect(db.execute(sql`update copy_live_source_streams set state = 'ready', coverage_from = now(), coverage_through = now() - interval '1 second', coverage_digest = ${'a'.repeat(64)} where id = ${streamId}`)).rejects.toThrow();
  await db.execute(sql`update copy_live_source_streams set state = 'ready', coverage_from = now() - interval '1 second', coverage_through = now(), coverage_digest = ${'a'.repeat(64)} where id = ${streamId}`);
  expect((await db.execute<{ state: string }>(sql`select state from copy_live_source_streams where id = ${streamId}`)).rows[0]?.state).toBe('ready');
});
it('rejects authority-free source fills rather than treating generic imported history as trusted', async () => {
  await db.execute(sql`insert into copy_live_source_streams(id,network,leader_address) values (${streamId},'testnet',${leader})`);
  const insert = (network: string, stream: string, tid: string, px: string, digest: string, version: number) => db.execute(sql`insert into copy_live_source_fills
    (id,stream_id,network,leader_address,tid,provider_time,received_at,coin,oid,trade_key,px,sz,side,start_position,normalized,raw,source_digest,origin_version)
    values (${`${network}:${leader}:${tid}`},${stream},${network},${leader},${tid},now(),now(),'BTC','7','oid:7',${px},'1','B','0','{}'::jsonb,'{}'::jsonb,${digest},${version})`);
  await expect(insert('mainnet', streamId, '1', '100', 'a'.repeat(64), 1)).rejects.toThrow();
  await expect(insert('testnet', 'missing', '1', '100', 'a'.repeat(64), 1)).rejects.toThrow();
  await expect(insert('testnet', streamId, '0', '100', 'a'.repeat(64), 1)).rejects.toThrow();
  await expect(insert('testnet', streamId, '1', '0', 'a'.repeat(64), 1)).rejects.toThrow();
  await expect(insert('testnet', streamId, '1', '100', 'bad', 1)).rejects.toThrow();
  await expect(insert('testnet', streamId, '1', '100', 'a'.repeat(64), 2)).rejects.toThrow();
  await insert('testnet', streamId, '1', '100', 'a'.repeat(64), 1);
  await expect(insert('testnet', streamId, '1', '101', 'b'.repeat(64), 1)).rejects.toThrow();
  expect((await db.execute<{ px: string }>(sql`select px from copy_live_source_fills`)).rows).toEqual([{ px: '100' }]);
  await expect(db.execute(sql`delete from copy_live_source_streams`)).rejects.toThrow();
});
