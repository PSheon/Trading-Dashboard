import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@trading-dashboard/shared/database';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { CopyLiveWorkerRepository } from '../src/copy/live-worker/copy-live-worker.repository.js';
import { CopyLiveEngine, type LiveEngineDependencies } from '../src/copy/live-worker/copy-live-engine.js';
import { parseLiveSourceFill, canonicalLiveSourceLegs, liveSourceLegId } from '../src/copy/live/copy-live-source-evidence.js';
import { liveSourceExecutionCloid } from '../src/copy/live/postgres-live-preparation.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';
import { testConfig } from './config-test-utils.js';

let db: TestDb, seed: Awaited<ReturnType<typeof preparationFixture>>, repo: CopyLiveWorkerRepository;
beforeAll(() => { db = getTestDb(); });
beforeEach(async () => { seed = await preparationFixture(db); repo = new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig()); });
afterAll(closeTestDb);
const fingerprint = 'd'.repeat(64);
const key = (fillId: string) => `testnet:${seed.f.identity.accountAddress}:${liveSourceExecutionCloid('mandate', fillId, 'open')}`;
async function partial(oid = '2') {
  const raw = { ...seed.fill.raw, tid: '2', oid, time: now - 500, startPosition: '1' };
  const fill = parseLiveSourceFill(raw, { network: 'testnet', leaderAddress: seed.fill.leaderAddress, from: now - 2000, to: now, receivedAt: now, kind: 'fills' });
  await db.insert(schema.copyLiveSourceFills).values({ ...fill, normalized: { ...fill.normalized }, providerTime: new Date(fill.providerTime), receivedAt: new Date(fill.receivedAt) });
  await repo.record([{ id: 'duplicate', mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', sourceFillId: fill.id, coin: fill.coin, leg: 'open', leaderTime: new Date(fill.providerTime), receivedAt: new Date(fill.receivedAt) }]);
  return (await repo.dispatch('duplicate'))!;
}
async function claimed(state: string) {
  const leg = canonicalLiveSourceLegs(seed.fill).find(value => value.leg === 'open')!;
  const id = liveSourceLegId('mandate', seed.fill.id, 'open'), executionKey = key(seed.fill.id);
  await db.insert(schema.copyLiveExecutions).values({ key: executionKey, network: 'testnet', accountAddress: seed.f.identity.accountAddress, signerAddress: '0x'+'33'.repeat(20), cloid: executionKey.split(':').at(-1)!, nonce: now - 100, userId: 1, strategyId: 9, state, record: { key: executionKey, fingerprint }, updatedAt: new Date(now - 100) });
  await db.insert(schema.copyLiveSignalLegs).values({ id, mandateId: 'mandate', sourceFillId: seed.fill.id, ...leg, fixedTradeClaim: true, executionKey, state: 'prepared', createdAt: new Date(now - 100), updatedAt: new Date(now - 100) });
  await db.insert(schema.copyLiveIntentProvenance).values({ key: executionKey, legId: id, mandateId: 'mandate', mandateRevision: 2, sourceDigest: seed.fill.sourceDigest, settingsDigest: seed.consent.settingsDigest, fingerprint, plannerVersion: 1, intent: {}, sizingBasis: {}, admittedAt: new Date(now - 100) });
}
async function run(row: Awaited<ReturnType<typeof partial>>) {
  const execute = vi.fn(async () => ({ key: 'not-sent', state: 'prepared' }));
  const engine = new CopyLiveEngine({ network: 'testnet', repository: repo, runtime: () => ({ execute }), settler: { settle: vi.fn() } } as unknown as LiveEngineDependencies,
    { testnetSourceIntervalMs: 60000, sourceLagMs: 0, passBudgetMs: 60000 }, () => now);
  await engine.work(row, (await repo.mandates(now))[0]!, 120000);
  return execute;
}
it.each(['prepared', 'submitting', 'unknown', 'resting', 'filled', 'partial', 'cancelled', 'rejected'])('a known %s fixed-open claim prevents expensive duplicate preparation without claiming settlement', async state => {
  await claimed(state); const row = await partial();
  const execute = await run(row);
  expect(execute).not.toHaveBeenCalled();
  expect(await repo.dispatch(row.id)).toMatchObject({ state: 'refused', reason: 'fixed_trade_already_claimed', executionKey: null, attempts: 0 });
  expect((await db.select().from(schema.copyLiveExecutions))[0]!.state).toBe(state);
});
it.each(['rowOwner', 'workOwner', 'network', 'mandate', 'account', 'leader', 'originalSourceMissing'])('does not infer a duplicate from foreign or missing %s bindings', async kind => {
  await claimed('filled'); const row = await partial(), work = (await repo.mandates(now))[0]!;
  const changedRow = { ...row }, changedWork = { ...work };
  if (kind === 'rowOwner') changedRow.userId = 2;
  if (kind === 'workOwner') changedWork.userId = 2;
  if (kind === 'network') changedWork.sourceNetwork = 'mainnet';
  if (kind === 'mandate') changedWork.mandateId = 'foreign-generation';
  if (kind === 'account') changedWork.accountId = 'foreign-account';
  if (kind === 'leader') changedWork.leaderAddress = '0x'+'77'.repeat(20);
  if (kind === 'originalSourceMissing') changedRow.sourceFillId = 'missing-source';
  expect(await repo.knownFixedOpenClaim(changedRow, changedWork)).toBe(false);
});
it.each(['candidateRaw', 'claimedRaw', 'claimedLegTradeKey', 'journalNetwork', 'journalAccount', 'journalCloid', 'journalFingerprint', 'provenanceSource', 'provenanceSettings', 'claimWithoutJournal'])('preserves original preparation when known-claim proof is damaged: %s', async kind => {
  await claimed('filled'); const row = await partial(), work = (await repo.mandates(now))[0]!;
  if (kind === 'candidateRaw' || kind === 'claimedRaw') await db.update(schema.copyLiveSourceFills).set({ raw: { corrupted: true } }).where(eq(schema.copyLiveSourceFills.id, kind === 'candidateRaw' ? row.sourceFillId : seed.fill.id));
  if (kind === 'claimedLegTradeKey') await db.update(schema.copyLiveSignalLegs).set({ tradeKey: 'oid:999' });
  if (kind === 'journalNetwork') await db.update(schema.copyLiveExecutions).set({ network: 'mainnet' });
  if (kind === 'journalAccount') await db.update(schema.copyLiveExecutions).set({ accountAddress: '0x'+'77'.repeat(20) });
  if (kind === 'journalCloid') await db.update(schema.copyLiveExecutions).set({ cloid: '0x'+'8'.repeat(32) });
  if (kind === 'journalFingerprint') await db.update(schema.copyLiveExecutions).set({ record: { key: key(seed.fill.id), fingerprint: 'e'.repeat(64) } });
  if (kind === 'provenanceSource') await db.update(schema.copyLiveIntentProvenance).set({ sourceDigest: 'e'.repeat(64) });
  if (kind === 'provenanceSettings') await db.update(schema.copyLiveIntentProvenance).set({ settingsDigest: 'e'.repeat(64) });
  if (kind === 'claimWithoutJournal') await db.update(schema.copyLiveSignalLegs).set({ executionKey: null, state: 'blocked' });
  expect(await repo.knownFixedOpenClaim(row, work)).toBe(false);
});
it('a no-claim hint cannot weaken the final SQL uniqueness fence when another preparation wins', async () => {
  const row = await partial(), work = (await repo.mandates(now))[0]!;
  expect(await repo.knownFixedOpenClaim(row, work)).toBe(false);
  // Another original preparation wins after the read-only hint.
  await claimed('prepared');
  const [stored] = await db.select().from(schema.copyLiveSourceFills).where(eq(schema.copyLiveSourceFills.id, row.sourceFillId));
  const source = parseLiveSourceFill(stored!.raw, { network: 'testnet', leaderAddress: seed.fill.leaderAddress, from: now-2000, to: now, receivedAt: now, kind: 'fills' });
  const leg = canonicalLiveSourceLegs(source).find(value => value.leg === 'open')!;
  const executionKey = key(source.id);
  await db.insert(schema.copyLiveExecutions).values({ key: executionKey, network: 'testnet', accountAddress: seed.f.identity.accountAddress, signerAddress: '0x'+'33'.repeat(20), cloid: executionKey.split(':').at(-1)!, nonce: now, userId: 1, strategyId: 9, state: 'prepared', record: { key: executionKey }, updatedAt: new Date(now) });
  let code: unknown, constraint: unknown;
  try { await db.insert(schema.copyLiveSignalLegs).values({ id: liveSourceLegId('mandate', source.id, 'open'), mandateId: 'mandate', sourceFillId: source.id, ...leg, fixedTradeClaim: true, executionKey, state: 'prepared', createdAt: new Date(now), updatedAt: new Date(now) }); }
  catch (error) { const cause = (error as { cause?: { code?: string; constraint?: string } }).cause; code = cause?.code; constraint = cause?.constraint; }
  expect({ code, constraint }).toEqual({ code: '23505', constraint: 'copy_live_leg_fixed_trade_uq' });
  expect((await db.select().from(schema.copyLiveSignalLegs)).filter(value => value.fixedTradeClaim)).toHaveLength(1);
});
it('another original exchange order still reaches original preparation', async () => {
  await claimed('filled'); const row = await partial('3');
  expect(await run(row)).toHaveBeenCalledTimes(1);
});
it('the same original TWAP key remains one fixed claim across distinct exchange order IDs', async () => {
  const fill = parseLiveSourceFill({ ...seed.fill.raw, twapId: '9' }, { network: 'testnet', leaderAddress: seed.fill.leaderAddress, from: now-2000, to: now, receivedAt: now, kind: 'fills' });
  await db.update(schema.copyLiveSourceFills).set({ ...fill, normalized: { ...fill.normalized }, providerTime: new Date(fill.providerTime), receivedAt: new Date(fill.receivedAt) }).where(eq(schema.copyLiveSourceFills.id, seed.fill.id));
  seed.fill = fill;
  await claimed('unknown'); const row = await partial('3');
  expect(await run(row)).not.toHaveBeenCalled();
  expect(await repo.dispatch(row.id)).toMatchObject({ state: 'refused', reason: 'fixed_trade_already_claimed' });
});
it('an existing own journal remains in reconciliation and does not become a duplicate refusal', async () => {
  await claimed('unknown'); const row = await partial();
  const executionKey = key(row.sourceFillId);
  await db.insert(schema.copyLiveExecutions).values({ key: executionKey, network: 'testnet', accountAddress: seed.f.identity.accountAddress, signerAddress: '0x'+'33'.repeat(20), cloid: executionKey.split(':').at(-1)!, nonce: now, userId: 1, strategyId: 9, state: 'unknown', record: { key: executionKey }, updatedAt: new Date(now) });
  expect(await run(row)).not.toHaveBeenCalled();
  expect(await repo.dispatch(row.id)).toMatchObject({ state: 'submitted', executionKey });
});
