import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { copyFollowerScans, copyExecutionAccounts, copyExecutionWallets, copyWalletAuthorizations, copyLiveExecutions, copyLiveRiskReservations, copyLiveExecutionEvidence,
  copyFollowerReceipts, copyFollowerLedger, copyFollowerAccountState, copyStrategies, users } from '@trading-dashboard/shared/database';
import { PostgresLiveSettlement } from '../src/copy/live/postgres-live-settlement.js';
import { PostgresLiveRiskScope, type LiveRiskDatabaseSession } from '../src/copy/live/postgres-live-risk-scope.js';
import { CopyFollowerLedger } from '../src/copy/live/copy-follower-ledger.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import type { LiveReservationSettlementInput } from '../src/copy/live/live-reservation-settlement.js';
import { parseLiveOrderEvidence, parseLiveIocAcknowledgement, captureLiveOrderIdentity } from '../src/copy/live/live-order-evidence.js';
import { parseFollowerFill, followerReceiptDigestV1 } from '../src/copy/live/actual-fill-accounting.js';
import { buildOrderAction, intentFingerprint } from '../src/copy/live/live-order.js';
import { planLiveReservation } from '../src/copy/live/live-risk-reservation.js';
import { decodeLiveSettlementProof } from '../src/copy/live/live-settlement-proof.js';
import { fixture, now as base } from './copy-live-risk-test-utils.js';
import { closeTestDb, getTestDb, insertUser, truncateAll, type TestDb } from './db-test-utils.js';
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
function input(status = 'filled', size = '1'): Mutable<LiveReservationSettlementInput> {
  const f = fixture(), record = { key: f.reservations.own.key, fingerprint: f.reservations.own.fingerprint, nonce: base,
    authorization: { id: 'grant', version: 4, userId: 1, strategyId: 9, walletId: 'agent', privyOwnerId: 'agent-owner',
      accountAddress: f.intent.accountAddress, signerAddress: `0x${'33'.repeat(20)}` as `0x${string}`, network: 'testnet' as const,
      scopes: ['copy:trade' as const], validFrom: base - 1, expiresAt: base + 60000, revokedAt: null, exchangeApprovedAt: base - 1 },
    action: f.action, market: f.market, state: 'unknown' as const, expiresAfter: base + 60000, createdAt: base, updatedAt: base };
  const raw = { status: 'order', order: { status, statusTimestamp: base + 10, order: { coin: 'BTC', oid: 10, cloid: f.intent.cloid,
    side: 'B', reduceOnly: false, tif: 'Gtc', origSz: '1', sz: status === 'filled' ? '0' : '1', limitPx: '100', timestamp: base,
    isTrigger: false, isPositionTpsl: false, children: [] } } };
  const evidence = parseLiveOrderEvidence({ record, market: f.market, raw, checkedAt: base + 20, completedAt: base + 25, now: base + 100 });
  const payload = planLiveReservation({ now: base, identity: f.identity, localSource: f.localSource, intent: f.intent, action: f.action,
    market: f.market, quote: f.quote, leverage: f.leverageProofs[0]!, fees: f.fees, policy: f.policy, expiresAt: base + 60000 });
  const source = structuredClone(f.accountSource) as Mutable<typeof f.accountSource>; source.checkedAt = base + 60; source.snapshot.observedAt = base + 30;
  source.snapshot.completedAt = base + 50; source.snapshot.coverage.earliestProviderTime = base + 40; source.snapshot.dexes[0]!.providerTime = base + 40;
  const fillRaw = { coin: 'BTC', oid: 10, tid: 123, side: 'B', time: base + 5, sz: size, px: '100', feeToken: 'USDC', fee: '0.1', builderFee: '0.02', closedPnl: '0' };
  const fill = parseFollowerFill(fillRaw, { network: 'testnet', accountAddress: f.intent.accountAddress });
  const row = { key: fill.key, accountId: 'account', network: 'testnet' as const, accountAddress: f.intent.accountAddress, kind: 'fill' as const,
    sourceId: fill.tid, coin: fill.coin, providerTime: fill.time, digest: followerReceiptDigestV1(fillRaw), record: { ...fill, raw: fillRaw },
    executionKey: record.key, attribution: 'execution' as const,
    ledger: [{ receiptKey: fill.key, component: 'exchange_fee' as const, amount: '-0.08', token: 'USDC' as const },
      { receiptKey: fill.key, component: 'builder_fee' as const, amount: '-0.02', token: 'USDC' as const }] };
  const value: LiveReservationSettlementInput = { now: base + 100, accountId: 'account', record, reservation: { payload, state: 'unknown', revision: 2, attemptedAt: base,
    exchangeOrderId: null, releaseEvidenceDigest: null, updatedAt: base }, evidence, acknowledgement: null, accountSource: source,
    receipts: { accountId: 'account', checkedAt: base + 70, completeForOrder: true, rows: [row] } };
  return structuredClone(value) as Mutable<LiveReservationSettlementInput>;
}

let db: TestDb, pool: Pool, scopes: PostgresLiveRiskScope, repository: PostgresLiveSettlement, f: ReturnType<typeof input>, clock: number;
beforeAll(() => { db = getTestDb(); pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 }); scopes = new PostgresLiveRiskScope(pool, () => clock); });
beforeEach(async () => {
  await truncateAll(db); clock = base + 100; repository = new PostgresLiveSettlement(() => clock); f = input();
  const user = await insertUser(db, { privyUserId: 'did:privy:settlement-owner' });
  // truncate resets the serial primary key. Bind the whole original intent before any source is created.
  expect(user.id).toBe(f.record.authorization.userId);
  await db.insert(copyStrategies).values({ id: 9, userId: user.id, leaderAddress: `0x${'44'.repeat(20)}`, allocated: '100', cash: '999999', status: 'stopped', activatedAt: new Date(base), stoppedAt: new Date(base + 90) });
  await db.insert(copyExecutionAccounts).values({ id: 'account', userId: user.id, strategyId: 9, network: 'testnet', state: 'ready', address: f.record.authorization.accountAddress,
    privyUserId: user.privyUserId, externalId: 'settlement-master', privyWalletId: 'master', ownerQuorumId: 'owner' });
  await db.insert(copyExecutionWallets).values({ id: 'local-agent', userId: user.id, strategyId: 9, network: 'testnet', accountAddress: f.record.authorization.accountAddress,
    privyWalletId: 'agent', privyOwnerId: 'agent-owner', signerAddress: f.record.authorization.signerAddress });
  await db.insert(copyWalletAuthorizations).values({ id: 'grant', walletId: 'local-agent', version: 4, scopes: ['copy:trade'],
    validFrom: new Date(base - 1), expiresAt: new Date(base + 60000), revokedAt: new Date(base + 90) });
  await db.insert(copyLiveExecutions).values({ key: f.record.key, network: 'testnet', accountAddress: f.record.authorization.accountAddress, signerAddress: f.record.authorization.signerAddress,
    cloid: f.record.action.orders[0].c, nonce: f.record.nonce, userId: user.id, strategyId: 9, state: f.record.state,
    record: f.record as unknown as Record<string, unknown>, updatedAt: new Date(f.record.updatedAt) });
  const p = f.reservation.payload;
  await db.insert(copyLiveRiskReservations).values({ ...p, cloid: p.intent.cloid, coin: 'BTC', dex: '', asset: 0, payload: p as unknown as Record<string, unknown>,
    expiresAt: new Date(p.expiresAt), createdAt: new Date(p.createdAt), updatedAt: new Date(base), state: 'unknown', revision: 2, attemptedAt: new Date(base) });
});
afterAll(async () => { await pool?.end(); await closeTestDb(); });
const identity = () => ({ userId: f.record.authorization.userId, network: 'testnet' as const, accountAddress: f.record.authorization.accountAddress });
const observe = (session: LiveRiskDatabaseSession) => repository.observe(session, { accountId: 'account', key: f.record.key, evidence: f.evidence });
const settle = (session: LiveRiskDatabaseSession, revision = 2) => repository.settle(session, { accountId: 'account', key: f.record.key, expectedReservationRevision: revision, accountSource: f.accountSource });
async function book() {
  // Actual production immutable booking path on its own connection, before account serialization.
  await db.update(copyLiveExecutions).set({ record: { ...f.record, outcome: { state: 'filled', exchangeOrderId: '10' } } }).where(eq(copyLiveExecutions.key, f.record.key));
  await new CopyFollowerLedger(db, new UnitOfWork(db)).bookFill('account', f.receipts.rows[0]!.record.raw);
}
async function iocAcknowledgement() {
  const intent = { ...f.reservation.payload.intent, timeInForce: 'Ioc' as const }, action = buildOrderAction(intent), fingerprint = intentFingerprint(intent, action);
  f.record.action = action; f.record.fingerprint = fingerprint; f.reservation.payload.action = action; f.reservation.payload.intent = intent; f.reservation.payload.fingerprint = fingerprint;
  await db.update(copyLiveExecutions).set({ record: f.record as unknown as Record<string, unknown> });
  await db.update(copyLiveRiskReservations).set({ fingerprint, payload: f.reservation.payload as unknown as Record<string, unknown> });
  const acknowledgement = parseLiveIocAcknowledgement({ identity: captureLiveOrderIdentity(f.record,f.record.market!),checkedAt:base+15,
    raw:{status:'ok',response:{type:'order',data:{statuses:[{filled:{oid:10,totalSz:'0.5',avgPx:'100'}}]}}} });
  return acknowledgement;
}
describe('same-session PostgreSQL attempted order settlement', () => {
  it('persists a replayable original settlement proof using canonical SQL receipt fields', async () => {
    await book(); await scopes.run(identity(), async (_scope, session) => { await observe(session); expect((await settle(session)).kind).toBe('release'); });
    const [e] = await db.select().from(copyLiveExecutionEvidence);
    expect(e?.settlementProofDigest).toMatch(/^[0-9a-f]{64}$/);
    const proof = decodeLiveSettlementProof(e!.settlementProof, e!.settlementProofDigest!);
    expect(proof.input.now).toBe(base + 100); expect(proof.certificate).toEqual(e!.settlementCertificate);
    expect(Object.keys(proof.input.receipts.rows[0]!).sort()).toEqual(['accountAddress','accountId','attribution','coin','digest','executionKey','key','kind','ledger','network','providerTime','record','sourceId'].sort());
    expect(proof.input.receipts.rows[0]!.ledger).toHaveLength(2);
    clock = base + 100000; expect(decodeLiveSettlementProof(e!.settlementProof,e!.settlementProofDigest!)).toEqual(proof);
    const changed = structuredClone(e!.settlementProof!); (changed.input as {receipts:{rows:{ledger:{amount:string}[]}[]}}).receipts.rows[0]!.ledger[0]!.amount = '-999';
    expect(() => decodeLiveSettlementProof(changed,e!.settlementProofDigest!)).toThrow();
  });
  it('uses actual booked receipt components and atomically releases with a certificate after disable/stop/revocation', async () => {
    await book(); await db.update(users).set({ disabledAt: new Date(base + 90) }).where(eq(users.id, 1));
    await scopes.run(identity(), async (_scope, session) => {
      expect(await observe(session)).toMatchObject({ kind: 'recorded', oid: '10' });
      expect(await settle(session)).toMatchObject({ kind: 'release', certificate: { filledSize: '1', oid: '10' } });
    });
    const [r] = await db.select().from(copyLiveRiskReservations), [e] = await db.select().from(copyLiveExecutionEvidence);
    expect(r).toMatchObject({ state: 'released', revision: 3, releaseReason: 'verified_settlement', exchangeOrderId: '10' });
    expect(e?.settlementDigest).toBe(r?.releaseEvidenceDigest); expect(e?.settlementCertificate).toMatchObject({ filledSize: '1' });
    expect((await db.select().from(copyStrategies))[0]?.cash).toBe('999999');
  });
  it('retains liability when actual SQL ledger components are missing', async () => {
    await book(); await db.delete(copyFollowerLedger).where(eq(copyFollowerLedger.component, 'builder_fee'));
    await scopes.run(identity(), async (_scope, session) => { await observe(session); expect(await settle(session)).toMatchObject({ kind: 'pending', reason: 'live_settlement_ledger_incomplete' }); });
    expect((await db.select().from(copyLiveRiskReservations))[0]?.state).toBe('unknown');
  });
  it('cannot release using caller arrays when no actual SQL receipts exist', async () => {
    await scopes.run(identity(), async (_scope, session) => { await observe(session); expect((await settle(session)).kind).toBe('pending'); });
    expect(await db.select().from(copyFollowerReceipts)).toHaveLength(0);
  });
  it('durably quarantines conflicting normalized provider OID without overwriting the original latch', async () => {
    await scopes.run(identity(), async (_scope, session) => {
      await observe(session); const raw = structuredClone(f.evidence.raw) as { order: { order: { oid: number } } }; raw.order.order.oid = 11;
      const evidence = parseLiveOrderEvidence({ record: f.record, market: f.record.market!, raw, checkedAt: base + 20, completedAt: base + 25, now: clock });
      expect(await repository.observe(session, { accountId: 'account', key: f.record.key, evidence })).toMatchObject({ kind: 'quarantine' });
    });
    expect((await db.select().from(copyLiveExecutionEvidence))[0]?.exchangeOrderId).toBe('10');
    expect((await db.select().from(copyLiveRiskReservations))[0]?.state).toBe('quarantined');
    expect((await db.select().from(copyFollowerAccountState))[0]?.quarantined).toBe(true);
  });
  it('quarantines receipt ledger contradictions durably in the same transaction', async () => {
    await book(); await db.update(copyFollowerLedger).set({ amount: '-1' }).where(eq(copyFollowerLedger.component, 'builder_fee'));
    await scopes.run(identity(), async (_scope, session) => { await observe(session); expect((await settle(session)).kind).toBe('quarantine'); });
    expect((await db.select().from(copyLiveRiskReservations))[0]?.state).toBe('quarantined');
  });
  it('recovers a submitting held allocation conservatively and never returns it to held', async () => {
    await db.update(copyLiveRiskReservations).set({ state: 'held', revision: 1, attemptedAt: null }).where(eq(copyLiveRiskReservations.key, f.record.key));
    await scopes.run(identity(), async (_scope, session) => { await observe(session); await expect(settle(session, 1)).rejects.toThrow('live_settlement_revision_changed'); expect((await settle(session, 2)).kind).toBe('pending'); });
    expect((await db.select().from(copyLiveRiskReservations))[0]).toMatchObject({ state: 'unknown', revision: 2 });
  });
  it('rejects successor stale revisions and keeps the exact original immutable account binding', async () => {
    await book(); await scopes.run(identity(), async (_scope, session) => { await observe(session); await expect(settle(session, 1)).rejects.toThrow('live_settlement_revision_changed'); });
    await db.update(copyExecutionAccounts).set({ address: `0x${'55'.repeat(20)}` }).where(eq(copyExecutionAccounts.id, 'account'));
    await expect(scopes.run(identity(), async (_scope, session) => settle(session))).rejects.toThrow('live_settlement_identity_changed');
  });
  it('retains unknown cancellation quantity after restart even with a local cancelled journal', async () => {
    const raw = structuredClone(f.evidence.raw) as { order: { status: string; order: { sz: string } } }; raw.order.status = 'canceled'; raw.order.order.sz = '0.5';
    f.evidence = structuredClone(parseLiveOrderEvidence({ record: f.record, market: f.record.market!, raw, checkedAt: base + 20, completedAt: base + 25, now: clock }));
    await scopes.run(identity(), async (_scope, session) => observe(session));
    await scopes.run(identity(), async (_scope, session) => expect((await settle(session)).kind).toBe('pending'));
  });

  it('persists a contradictory terminal status quarantine and preserves the original observation', async () => {
    await scopes.run(identity(), async (_scope, session) => {
      await observe(session); const raw = structuredClone(f.evidence.raw) as { order: { status: string; statusTimestamp: number } };
      raw.order.status = 'canceled'; raw.order.statusTimestamp = base + 11;
      const evidence = parseLiveOrderEvidence({ record: f.record, market: f.record.market!, raw, checkedAt: base + 20, completedAt: base + 25, now: clock });
      expect(await repository.observe(session, { accountId: 'account', key: f.record.key, evidence })).toMatchObject({ kind: 'quarantine', reason: 'live_settlement_status_conflict' });
    });
    expect((await db.select().from(copyLiveExecutionEvidence))[0]?.statusObservation).toMatchObject({ providerStatus: 'filled' });
  });
  it('rejects normalized incoming identity tampering before persisting a source', async () => {
    f.evidence.identity.nonce++;
    await expect(scopes.run(identity(), async (_scope, session) => observe(session))).rejects.toThrow('live_settlement_observation_changed');
    expect(await db.select().from(copyLiveExecutionEvidence)).toHaveLength(0);
  });
  it('reads existing quarantine from SQL instead of accepting the caller nonquarantined claim', async () => {
    await book(); await db.insert(copyFollowerAccountState).values({ accountId: 'account', quarantined: true, reason: 'existing_receipt_conflict' });
    await scopes.run(identity(), async (_scope, session) => { await observe(session); expect((await settle(session)).kind).toBe('pending'); });
    expect((await db.select().from(copyLiveRiskReservations))[0]?.state).toBe('unknown');
  });
  it('quarantines exact-order receipts that lost execution attribution instead of ignoring their liability', async () => {
    await book(); await db.update(copyFollowerReceipts).set({ executionKey: null, attribution: 'account' });
    await scopes.run(identity(), async (_scope, session) => { await observe(session); expect((await settle(session)).kind).toBe('quarantine'); });
    expect((await db.select().from(copyFollowerAccountState))[0]?.quarantined).toBe(true);
  });
  it('keeps the existing release certificate immutable across duplicate reconciliation', async () => {
    await book(); await scopes.run(identity(), async (_scope, session) => { await observe(session); await settle(session); });
    const before = (await db.select().from(copyLiveExecutionEvidence))[0]!;
    await scopes.run(identity(), async (_scope, session) => { expect((await observe(session)).kind).toBe('pending'); expect((await settle(session, 3)).kind).toBe('release'); });
    expect((await db.select().from(copyLiveExecutionEvidence))[0]).toEqual(before);
  });
  it('checks the oldest all-venue provider timestamp again after delayed COMMIT', async () => {
    await book(); const market = { ...f.record.market!, observedAt: base + 20 };
    f.evidence = structuredClone(parseLiveOrderEvidence({ record: f.record, market, raw: f.evidence.raw, checkedAt: base + 25, completedAt: base + 25, now: clock }));
    f.accountSource.snapshot.coverage.earliestProviderTime = base + 11; f.accountSource.snapshot.dexes[0]!.providerTime = base + 11;
    await scopes.run(identity(), async (_scope, session) => {
      await observe(session); const delayed: LiveRiskDatabaseSession = { scope: session.scope, read: work => session.read(work), transaction: async work => { const result = await session.transaction(work); clock = base + 5012; return result; } };
      await expect(settle(delayed)).rejects.toThrow('live_settlement_stale');
    });
    expect((await db.select().from(copyLiveRiskReservations))[0]?.state).toBe('released');
  });
  it('quarantines corrupted stored OID evidence even when the digest column was also overwritten', async () => {
    await book(); await scopes.run(identity(), async (_scope, session) => observe(session));
    const raw = structuredClone(f.evidence.raw) as { order: { order: { oid: number } } }; raw.order.order.oid = 11;
    const fake = parseLiveOrderEvidence({ record: f.record, market: f.record.market!, raw, checkedAt: base + 20, completedAt: base + 25, now: clock });
    await db.update(copyLiveExecutionEvidence).set({ statusObservation: fake as unknown as Record<string, unknown>, statusDigest: fake.sourceDigest });
    await scopes.run(identity(), async (_scope, session) => expect((await settle(session)).kind).toBe('quarantine'));
    expect((await db.select().from(copyFollowerAccountState))[0]?.quarantined).toBe(true);
  });
  it('keeps an expired stored provider source pending without labeling ordinary age as corruption', async () => {
    await scopes.run(identity(), async (_scope, session) => observe(session)); clock = base + 5001;
    await scopes.run(identity(), async (_scope, session) => expect(await settle(session)).toMatchObject({ kind: 'pending' }));
    expect((await db.select().from(copyLiveRiskReservations))[0]?.state).toBe('unknown');
  });

  it('persists the original partial IOC acknowledgement before status reads and settles after restart', async () => {
    const acknowledgement = await iocAcknowledgement();
    await scopes.run(identity(), async (_scope, session) => expect(await repository.acknowledge(session,{accountId:'account',key:f.record.key,acknowledgement})).toMatchObject({kind:'recorded',oid:'10'}));
    expect((await db.select().from(copyLiveExecutionEvidence))[0]).toMatchObject({ statusObservation:null, acknowledgementDigest:acknowledgement.responseDigest });
    const raw = structuredClone(f.evidence.raw) as {order:{status:string;order:{tif:string;sz:string}}}; raw.order.status='canceled'; raw.order.order.tif='Ioc';raw.order.order.sz='0.5';
    f.evidence = structuredClone(parseLiveOrderEvidence({ record:f.record,market:f.record.market!,raw,checkedAt:base+20,completedAt:base+25,now:clock }));
    f.receipts.rows[0]!.record.raw.sz='0.5'; await book();
    await scopes.run(identity(),async (_scope,session)=>{await observe(session);expect(await settle(session)).toMatchObject({kind:'release',certificate:{filledSize:'0.5',acknowledgementDigest:acknowledgement.responseDigest}});});
    // The durable source remains the original acknowledgement, even after success.
    expect((await db.select().from(copyLiveExecutionEvidence))[0]?.acknowledgement).toEqual(acknowledgement);
  });

  it('settles a partial IOC whose acknowledgement was lost from the fills the account scan booked past the cancel', async () => {
    await iocAcknowledgement(); // the IOC order, but its answer never reached the journal
    const raw = structuredClone(f.evidence.raw) as {order:{status:string;order:{tif:string;sz:string}}}; raw.order.status='canceled'; raw.order.order.tif='Ioc';raw.order.order.sz='0.5';
    f.evidence = structuredClone(parseLiveOrderEvidence({ record:f.record,market:f.record.market!,raw,checkedAt:base+20,completedAt:base+25,now:clock }));
    f.receipts.rows[0]!.record.raw.sz='0.5'; await book();
    await scopes.run(identity(),async (_scope,session)=>{await observe(session);expect(await settle(session)).toMatchObject({kind:'pending',reason:'live_settlement_quantity_unproven'});});
    // The follower scan booked every fill to 10 s past the cancel, without an issue.
    await db.insert(copyFollowerScans).values({ accountId: 'account', through: base + 10 + 10_000 });
    await scopes.run(identity(),async (_scope,session)=>{await observe(session);expect(await settle(session)).toMatchObject({kind:'release',certificate:{filledSize:'0.5',acknowledgementDigest:null}});});
  });
  it('latches the immutable partial IOC acknowledgement once and quarantines conflicting response quantities', async () => {
    const acknowledgement = await iocAcknowledgement();
    await scopes.run(identity(), async (_scope, session) => {
      const first = await repository.acknowledge(session,{accountId:'account',key:f.record.key,acknowledgement});
      expect(await repository.acknowledge(session,{accountId:'account',key:f.record.key,acknowledgement})).toEqual(first);
      const raw = structuredClone(acknowledgement.raw) as {response:{data:{statuses:{filled:{totalSz:string}}[]}}}; raw.response.data.statuses[0]!.filled.totalSz='0.6';
      const changed = parseLiveIocAcknowledgement({identity:acknowledgement.identity,raw,checkedAt:acknowledgement.checkedAt});
      expect(await repository.acknowledge(session,{accountId:'account',key:f.record.key,acknowledgement:changed})).toMatchObject({kind:'quarantine',reason:'live_settlement_ack_conflict'});
    });
    expect((await db.select().from(copyLiveExecutionEvidence))[0]?.acknowledgement).toEqual(acknowledgement);
    expect((await db.select().from(copyLiveRiskReservations))[0]?.state).toBe('quarantined');
  });
  it('cannot reuse a tombstoned original SQL session', async () => {
    let saved!: LiveRiskDatabaseSession; await scopes.run(identity(), async (_scope, session) => { saved = session; });
    await expect(observe(saved)).rejects.toThrow('live_risk_serialization_lost');
  });
  it('fences the oldest provider time after delayed COMMIT without manufacturing a successful release return', async () => {
    await book(); await scopes.run(identity(), async (_scope, session) => {
      await observe(session); const delayed: LiveRiskDatabaseSession = { scope: session.scope, read: work => session.read(work), transaction: async work => { const value = await session.transaction(work); clock = base + 5041; return value; } };
      await expect(settle(delayed)).rejects.toThrow('live_settlement_stale');
    });
  });
});
