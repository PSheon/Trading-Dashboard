import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { copyLiveSourceFills, copyLiveSourceStreams } from '@trading-dashboard/shared/database';
import { CopyLiveSourceRepository } from '../src/copy/copy-live-source.repository.js';
import { HyperliquidLiveSourceClient } from '../src/copy/copy-live-source.client.js';
import { parseLiveSourceFill, liveSourceDigest } from '../src/copy/live/copy-live-source-evidence.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { closeTestDb, getTestDb, truncateAll, type TestDb } from './db-test-utils.js';
const leader = `0x${'11'.repeat(20)}`, now = 2100;
const raw = (tid = 1) => ({ tid, oid: 7, time: 1500, coin: 'BTC', side: 'B', px: '100', sz: '1', startPosition: '0' });
let db: TestDb, uow: UnitOfWork, repository: CopyLiveSourceRepository;
beforeAll(() => { db = getTestDb(); uow = new UnitOfWork(db); repository = new CopyLiveSourceRepository(db); });
beforeEach(async () => { await truncateAll(db); });
afterAll(closeTestDb);
const ensure = () => uow.run(tx => repository.ensure(tx, leader));
async function read(rows = [raw()]) {
  return new HyperliquidLiveSourceClient('testnet', async () => undefined, (async (_url, init) => Response.json(JSON.parse(String(init?.body)).type === 'userFillsByTime' ? rows : [])) as typeof fetch, () => now)
    .read({ leaderAddress: leader, from: 1000, to: 2000, maxRequests: 6 });
}
const apply = (revision: number, result: Awaited<ReturnType<typeof read>>) => uow.run(tx => repository.apply(tx, revision, result, now));
describe('immutable actual-network source storage', () => {
  it('persists complete bounded acquisition with exact network identity and no legacy fill fallback', async () => {
    const stream = await ensure(); expect(stream).toMatchObject({ id: `testnet:${leader}`, state: 'unproven', coverageFrom: null });
    const result = await apply(stream.revision, await read());
    expect(result).toMatchObject({ kind: 'recorded', stream: { state: 'ready', coverageFrom: new Date(1000), coverageThrough: new Date(2000), revision: 2 } });
    expect((await db.select().from(copyLiveSourceFills))[0]).toMatchObject({ id: `testnet:${leader}:1`, network: 'testnet', leaderAddress: leader, tid: '1', sourceDigest: (await read()).fills[0].sourceDigest });
  });
  it('preserves original fill receivedAt on repeated reads and refuses a stale cursor writer', async () => {
    const stream = await ensure(), first = await read(); await apply(stream.revision, first);
    const before = await db.select().from(copyLiveSourceFills);
    const stale = await apply(stream.revision, first); expect(stale.kind).toBe('stale');
    expect(await db.select().from(copyLiveSourceFills)).toEqual(before); expect(stale.stream.revision).toBe(2);
    expect((await apply(2, first)).kind).toBe('recorded'); expect(await db.select().from(copyLiveSourceFills)).toEqual(before);
  });
  it('durably quarantines contradictory duplicate identity while preserving the first immutable record', async () => {
    const stream = await ensure(); await apply(stream.revision, await read());
    const before = await db.select().from(copyLiveSourceFills), changed = await read([{ ...raw(), px: '101' }]);
    expect(await apply(2, changed)).toMatchObject({ kind: 'quarantined', stream: { state: 'quarantined', lastIssue: 'duplicate_conflict' } });
    expect(await db.select().from(copyLiveSourceFills)).toEqual(before);
    expect((await apply(3, await read())).stream.state).toBe('quarantined');
  });
  it('quarantines contradictory stale evidence rather than ignoring an identity conflict', async () => {
    const stream = await ensure(); await apply(stream.revision, await read());
    expect((await apply(stream.revision, await read([{ ...raw(), sz: '2' }]))).kind).toBe('quarantined');
  });
  it('retains prior coverage when capped/incomplete reads cannot advance a gap', async () => {
    const stream = await ensure(); await apply(stream.revision, await read());
    const capped = await new HyperliquidLiveSourceClient('testnet', async () => undefined, (async (_url, init) => Response.json(JSON.parse(String(init?.body)).type === 'userFillsByTime' ? Array.from({ length: 500 }, (_, i) => raw(i + 1)) : [])) as typeof fetch, () => now)
      .read({ leaderAddress: leader, from: 1000, to: 2000, maxRequests: 1 });
    expect((await apply(2, capped)).stream).toMatchObject({ state: 'gap', lastIssue: 'incomplete_coverage', coverageThrough: new Date(2000) });
  });
  it('rejects unsigned mutable result tampering and mismatched source evidence before storage', async () => {
    const stream = await ensure(), result = await read(); result.fills[0].px = '1000';
    await expect(apply(stream.revision, result)).rejects.toThrow(); expect(await db.select().from(copyLiveSourceFills)).toEqual([]);
    const result2 = await read(); result2.fills[0] = parseLiveSourceFill(raw(), { network: 'testnet', leaderAddress: `0x${'33'.repeat(20)}`, from: 1000, to: 2000, receivedAt: now, kind: 'fills' });
    const { sourceDigest: _, ...body } = result2; result2.sourceDigest = liveSourceDigest(body);
    await expect(apply(stream.revision, result2)).rejects.toThrow();
  });
  it('records provider gaps but never resets quarantine on a later successful read', async () => {
    const stream = await ensure();
    expect((await uow.run(tx => repository.fail(tx, leader, stream.revision, 'source_unavailable', now))).stream.state).toBe('gap');
    expect((await uow.run(tx => repository.fail(tx, leader, 2, 'invalid_fill', now))).stream.state).toBe('quarantined');
    const replay = await ensure(); expect(replay.state).toBe('quarantined');
    expect((await apply(replay.revision, await read())).stream.state).toBe('quarantined');
  });
  it('detects stored mirror drift without accepting overwritten normalized authority', async () => {
    const stream = await ensure(); await apply(stream.revision, await read());
    await db.update(copyLiveSourceFills).set({ px: '101' }).where(eq(copyLiveSourceFills.id, `testnet:${leader}:1`));
    expect((await apply(2, await read())).stream).toMatchObject({ state: 'quarantined', lastIssue: 'invalid_fill' });
    expect((await db.select().from(copyLiveSourceStreams))[0].state).toBe('quarantined');
  });
  async function channels(ordinary:unknown[],twap:unknown[]){
    return new HyperliquidLiveSourceClient('testnet',async()=>undefined,(async(_url,init)=>Response.json(JSON.parse(String(init?.body)).type==='userFillsByTime'?ordinary:twap)) as typeof fetch,()=>now)
      .read({leaderAddress:leader,from:1000,to:2000,maxRequests:6});
  }
  it('preserves immutable first evidence when a later channel proves the same already-known TWAP trade',async()=>{
    const stream=await ensure(),ordinary={...raw(),twapId:9,hash:`0x${'00'.repeat(32)}`,fee:'0.1',unknown:{value:'same'}};
    await apply(stream.revision,await channels([ordinary],[]));const before=await db.select().from(copyLiveSourceFills);
    expect((await apply(2,await channels([],[{twapId:9,fill:ordinary}]))).stream.state).toBe('ready');
    expect(await db.select().from(copyLiveSourceFills)).toEqual(before);expect(before[0].tradeKey).toBe('twap:9');
  });
  it.each(['economic','raw','trade'])('quarantines cross-channel %s contradiction without rewriting the first record',async kind=>{
    const stream=await ensure(),ordinary={...raw(),twapId:9,fee:'0.1'};await apply(stream.revision,await channels([ordinary],[]));
    const before=await db.select().from(copyLiveSourceFills),incoming={...ordinary,...(kind==='economic'?{sz:'2'}:kind==='raw'?{fee:'0.2'}:{twapId:10})};
    const result=await apply(2,await channels([],[{twapId:kind==='trade'?10:9,fill:incoming}]));
    expect(result).toMatchObject({kind:'quarantined',stream:{lastIssue:'duplicate_conflict'}});expect(await db.select().from(copyLiveSourceFills)).toEqual(before);
  });
  it('never reclassifies an already-persisted oid trade as a different TWAP identity',async()=>{
    const stream=await ensure();await apply(stream.revision,await channels([raw()],[]));
    expect((await apply(2,await channels([],[{twapId:9,fill:raw()}]))).kind).toBe('quarantined');
    expect((await db.select().from(copyLiveSourceFills))[0].tradeKey).toBe('oid:7');
  });
  it('persists no invented oid identity for an uncorrelated zero-hash TWAP fill',async()=>{
    const stream=await ensure();expect((await apply(stream.revision,await channels([{...raw(),hash:`0x${'00'.repeat(32)}`}],[]))).stream.state).toBe('gap');
    expect(await db.select().from(copyLiveSourceFills)).toEqual([]);
  });
});
