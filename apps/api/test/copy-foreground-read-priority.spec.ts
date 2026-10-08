import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { copyLiveDispatches, copyLiveMandates, copyFollowerScans, copyFollowerObservationBudget, copyFollowerObservationJobs, copyFundingOperations, copyStrategies, copyExecutionAccounts, copyLiveExecutions, copyLiveRiskReservations } from '@trading-dashboard/shared/database';
import { CopyFollowerScanRepository } from '../src/copy/copy-follower-scan.repository.js';
import { CopyFollowerSnapshotRepository } from '../src/copy/copy-follower-snapshot.repository.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { getTestDb, closeTestDb, insertUser, type TestDb } from './db-test-utils.js';
import { testConfig } from './config-test-utils.js';
import type { AppConfig } from '../src/config/app-config.js';

let db: TestDb, scans: CopyFollowerScanRepository, reports: CopyFollowerSnapshotRepository;
beforeAll(() => { db = getTestDb(); scans = new CopyFollowerScanRepository(db, testConfig()); reports = new CopyFollowerSnapshotRepository(db, testConfig()); });
beforeEach(async () => {
  const seed = await preparationFixture(db);
  await db.insert(copyLiveDispatches).values({ id: 'foreground', mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account',
    sourceFillId: seed.fill.id, leg: 'open', coin: 'BTC', state: 'pending', leaderTime: sql`clock_timestamp()`, receivedAt: sql`clock_timestamp()` });
});
afterAll(closeTestDb);

async function retainedAccount() {
  await db.insert(copyStrategies).values({ id: 10, userId: 1, mode: 'testnet', status: 'stopped', leaderAddress: `0x${'44'.repeat(20)}`, allocated: '0', cash: '0', activatedAt: new Date(), stoppedAt: new Date() });
  await db.insert(copyExecutionAccounts).values({ id: 'residual', userId: 1, strategyId: 10, network: 'testnet', state: 'ready', address: `0x${'77'.repeat(20)}`,
    privyUserId: 'did:privy:risk-source', externalId: 'retained', privyWalletId: 'retained-master', ownerQuorumId: 'owner' });
  await db.insert(copyFundingOperations).values({ id: 'deposit', userId: 1, accountId: 'residual', strategyId: 10, idempotencyKey: 'retained-deposit', network: 'testnet',
    address: `0x${'55'.repeat(20)}`, destination: `0x${'77'.repeat(20)}`, amount: '50', nonce: Date.now(), status: 'credited', evidenceHash: 'e'.repeat(64), transactionHash: `0x${'e'.repeat(64)}`, creditedAmount: '50', fee: '0' });
  await db.insert(copyFollowerObservationJobs).values({ accountId: 'residual', nextRunAt: sql`clock_timestamp() - interval '60 seconds'` });
}

it('does not let repeated recovery snapshots postpone another account ordinary five-minute turn', async () => {
  await retainedAccount();
  const [recovery] = await db.insert(copyStrategies).values({ id: 11, userId: 1, mode: 'testnet', status: 'stopped', leaderAddress: `0x${'88'.repeat(20)}`, allocated: '0', cash: '0', activatedAt: new Date(), stoppedAt: new Date() }).returning();
  await db.insert(copyExecutionAccounts).values({ id: 'recovering', userId: 1, strategyId: recovery.id, network: 'testnet', state: 'ready', address: `0x${'99'.repeat(20)}`,
    privyUserId: 'did:privy:risk-source', externalId: 'recovering', privyWalletId: 'recovering-master', ownerQuorumId: 'owner' });
  await db.insert(copyFundingOperations).values({ id: 'recovery-deposit', userId: 1, accountId: 'recovering', strategyId: recovery.id, network: 'testnet',
    idempotencyKey: 'recovery-deposit-original', direction: 'to_account', address: `0x${'55'.repeat(20)}`, destination: `0x${'99'.repeat(20)}`,
    amount: '10', nonce: Date.now(), status: 'accepted', claimedAt: new Date(), attemptedAt: new Date(), evidenceHash: 'e'.repeat(64) });
  await db.insert(copyFollowerObservationJobs).values({ accountId: 'recovering', nextRunAt: sql`clock_timestamp() - interval '600 seconds'` });
  await db.insert(copyFollowerObservationBudget).values({ network: 'testnet', nextAllowedAt: sql`clock_timestamp() - interval '1 second'`, nextSnapshotAllowedAt: sql`clock_timestamp() + interval '300 seconds'` });
  const [before] = await db.select().from(copyFollowerObservationBudget);
  for (let minute = 0; minute < 3; minute++) {
    expect(await new CopyFollowerSnapshotRepository(db, testConfig()).claim()).toMatchObject({ accountId: 'recovering' });
    expect((await db.select().from(copyFollowerObservationBudget))[0].nextSnapshotAllowedAt).toEqual(before.nextSnapshotAllowedAt);
    await db.update(copyFollowerObservationBudget).set({ nextAllowedAt: sql`clock_timestamp() - interval '1 second'` });
    await db.update(copyFollowerObservationJobs).set({ nextRunAt: sql`clock_timestamp() - interval '600 seconds'` }).where(eq(copyFollowerObservationJobs.accountId, 'recovering'));
    await db.update(copyLiveDispatches).set({ leaderTime: sql`clock_timestamp()` });
  }
  await db.update(copyFollowerObservationBudget).set({ nextSnapshotAllowedAt: sql`clock_timestamp() - interval '1 second'` });
  expect(await new CopyFollowerSnapshotRepository(db, testConfig()).claim()).toMatchObject({ accountId: 'residual' });
  expect(await reports.claim()).toBeNull(); // Ordinary fairness does not bypass the global 60-second limit.
  expect((await db.select().from(copyFollowerObservationBudget))[0].nextReceiptAllowedAt).toBeNull();
  expect((await db.select().from(copyLiveDispatches))[0].state).toBe('pending');
});

it('counts an ordinary idle snapshot before granting another account busy-period fairness', async () => {
  await db.update(copyLiveDispatches).set({ state: 'refused', reason: 'signal_expired' });
  await db.insert(copyFollowerObservationBudget).values({ network: 'testnet', nextAllowedAt: sql`clock_timestamp() - interval '1 second'`, nextSnapshotAllowedAt: sql`clock_timestamp() - interval '1 second'` });
  expect(await reports.claim()).toMatchObject({ accountId: 'account' });
  const [budget] = await db.select().from(copyFollowerObservationBudget);
  expect(budget.nextSnapshotAllowedAt!.getTime()).toBeGreaterThan(Date.now() + 290_000);
  await retainedAccount();
  await db.update(copyFollowerObservationBudget).set({ nextAllowedAt: sql`clock_timestamp() - interval '241 seconds'` });
  await db.update(copyLiveDispatches).set({ state: 'pending', reason: null, leaderTime: sql`clock_timestamp()` });
  expect(await reports.claim()).toBeNull();
  await db.update(copyFollowerObservationBudget).set({ nextSnapshotAllowedAt: sql`clock_timestamp() - interval '1 second'` });
  expect(await reports.claim()).toMatchObject({ accountId: 'residual' });
});

it('initializes snapshot fairness once and preserves both markers when no account is eligible', async () => {
  expect(await reports.claim()).toBeNull();
  const [before] = await db.select().from(copyFollowerObservationBudget);
  expect(before.nextSnapshotAllowedAt).toBeInstanceOf(Date);
  expect(await new CopyFollowerSnapshotRepository(db, testConfig()).claim()).toBeNull();
  const [after] = await db.select().from(copyFollowerObservationBudget);
  expect(after.nextSnapshotAllowedAt).toEqual(before.nextSnapshotAllowedAt);
  expect(after.nextAllowedAt).toEqual(before.nextAllowedAt);
});

it('does not let an unrelated retained account spend reporting allowance while a fresh fill is waiting', async () => {
  await retainedAccount();
  await db.insert(copyFollowerObservationBudget).values({ network: 'testnet', nextAllowedAt: sql`clock_timestamp() - interval '1 second'`, nextSnapshotAllowedAt: sql`clock_timestamp() + interval '300 seconds'` });
  expect(await reports.claim()).toBeNull();
  await db.update(copyLiveDispatches).set({ leaderTime: sql`clock_timestamp() - interval '121 seconds'` });
  await db.update(copyFollowerObservationBudget).set({ nextAllowedAt: sql`clock_timestamp() - interval '241 seconds'` });
  expect(await reports.claim()).toMatchObject({ accountId: 'residual' });
});

it('admits the oldest retained account at the original five-minute fairness ceiling despite continuous fresh fills', async () => {
  await retainedAccount();
  await db.insert(copyFollowerObservationBudget).values({ network: 'testnet', nextAllowedAt: sql`clock_timestamp() - interval '1 second'`, nextSnapshotAllowedAt: sql`clock_timestamp() - interval '1 second'` });
  expect(await reports.claim()).toMatchObject({ accountId: 'residual' });
  expect(await reports.claim()).toBeNull();
  expect((await db.select().from(copyLiveDispatches))[0].state).toBe('pending');
});

it('does not consume the fairness allowance when every account has foreground work', async () => {
  await db.insert(copyFollowerObservationBudget).values({ network: 'testnet', nextAllowedAt: sql`clock_timestamp() - interval '1 second'`, nextSnapshotAllowedAt: sql`clock_timestamp() - interval '1 second'` });
  const [before] = await db.select().from(copyFollowerObservationBudget);
  expect(await reports.claim()).toBeNull();
  expect((await db.select().from(copyFollowerObservationBudget))[0].nextAllowedAt).toEqual(before.nextAllowedAt);
  expect((await db.select().from(copyFollowerObservationBudget))[0].nextSnapshotAllowedAt).toEqual(before.nextSnapshotAllowedAt);
});

it('admits an oldest retained receipt scan at its independent five-minute allowance across repository instances', async () => {
  await retainedAccount();
  await db.insert(copyFollowerObservationBudget).values({ network: 'testnet', nextAllowedAt: sql`clock_timestamp() + interval '60 seconds'`, nextReceiptAllowedAt: sql`clock_timestamp() - interval '1 second'` });
  const [before] = await db.select().from(copyFollowerObservationBudget);
  expect(await new CopyFollowerScanRepository(db, testConfig()).claim()).toMatchObject({ accountId: 'residual' });
  const [after] = await db.select().from(copyFollowerObservationBudget);
  expect(after.nextAllowedAt).toEqual(before.nextAllowedAt);
  expect(after.nextSnapshotAllowedAt).toEqual(before.nextSnapshotAllowedAt);
  expect(after.nextReceiptAllowedAt!.getTime()).toBeGreaterThan(before.nextReceiptAllowedAt!.getTime());
  await db.update(copyFollowerScans).set({ nextRunAt: sql`clock_timestamp() - interval '1 second'`, claimToken: null });
  expect(await new CopyFollowerScanRepository(db, testConfig()).claim()).toBeNull();
});

it('initializes bounded receipt fairness once without consuming a null claim or resetting it from foreground scans', async () => {
  expect(await scans.claim()).toBeNull();
  const [before] = await db.select().from(copyFollowerObservationBudget);
  expect(before?.nextReceiptAllowedAt).toBeInstanceOf(Date);
  expect(await scans.claim()).toBeNull();
  expect((await db.select().from(copyFollowerObservationBudget))[0].nextReceiptAllowedAt).toEqual(before.nextReceiptAllowedAt);
  expect(await scans.claimAccount('account')).not.toBeNull();
  expect((await db.select().from(copyFollowerObservationBudget))[0].nextReceiptAllowedAt).toEqual(before.nextReceiptAllowedAt);
});

it('counts the last ordinary idle receipt admission before granting busy-period fairness to a new stream', async () => {
  await db.update(copyLiveDispatches).set({ state: 'refused', reason: 'signal_expired' });
  await db.insert(copyFollowerObservationBudget).values({ network: 'testnet', nextAllowedAt: sql`clock_timestamp() + interval '60 seconds'`, nextReceiptAllowedAt: sql`clock_timestamp() - interval '1 second'` });
  expect(await scans.claim()).toMatchObject({ accountId: 'account' });
  await retainedAccount();
  // One scheduled minute has passed: the global scan gate is open but the
  // newly waiting source is still young. An old elapsed marker must not let
  // the next background account take a second pass within five minutes.
  await db.update(copyFollowerScans).set({ nextRunAt: sql`clock_timestamp() + interval '59 seconds'` });
  await db.update(copyLiveDispatches).set({ state: 'pending', reason: null, leaderTime: sql`clock_timestamp()` });
  expect(await scans.claim()).toBeNull();
  await db.update(copyFollowerObservationBudget).set({ nextReceiptAllowedAt: sql`clock_timestamp() - interval '1 second'` });
  expect(await scans.claim()).toMatchObject({ accountId: 'residual' });
});

it.each(['future','account-mismatch','strategy-mismatch'] as const)('ignores a %s dispatch for global receipt priority', async kind => {
  if (kind === 'future') await db.update(copyLiveDispatches).set({ leaderTime: sql`clock_timestamp() + interval '60 seconds'` });
  else {
    await retainedAccount();
    await db.update(copyLiveDispatches).set(kind === 'account-mismatch' ? { accountId: 'residual' } : { strategyId: 10 });
  }
  expect(await scans.claim()).not.toBeNull();
  expect(await reports.claim()).not.toBeNull();
});

it('preserves mainnet reporting eligibility during a stopping pending dispatch', async () => {
  await db.update(copyExecutionAccounts).set({ network: 'mainnet' });
  await db.update(copyLiveMandates).set({ network: 'mainnet', state: 'stopping' });
  const base = testConfig().value;
  const config = { value: { ...base, hyperliquid: { ...base.hyperliquid, wallet: { ...base.hyperliquid.wallet, network: 'mainnet' } } } } as AppConfig;
  expect(await new CopyFollowerSnapshotRepository(db, config).claim()).toBeNull();
});

it('defers scheduled receipt work while a fresh foreground fill needs the shared bucket, without advancing coverage', async () => {
  expect(await scans.claim()).toBeNull();
  expect(await db.select().from(copyFollowerScans)).toHaveLength(0);
  // The financial settler still owns its immediate receipt path.
  expect(await scans.claimAccount('account')).toMatchObject({ accountId: 'account', through: null });
});

it('keeps stopping-account receipt recovery available during foreground work', async () => {
  await db.update(copyLiveMandates).set({ state: 'stopping' });
  expect(await scans.claim()).toMatchObject({ accountId: 'account' });
});

it('keeps accepted withdrawal receipt recovery available during foreground work', async () => {
  await db.insert(copyFundingOperations).values({ id: 'refund', userId: 1, accountId: 'account', strategyId: 9,
    idempotencyKey: 'foreground-refund-recovery', network: 'testnet', direction: 'to_main',
    address: `0x${'22'.repeat(20)}`, destination: `0x${'66'.repeat(20)}`, amount: '10', nonce: Date.now(), status: 'accepted', evidenceHash: 'e'.repeat(64) });
  expect(await scans.claim()).toMatchObject({ accountId: 'account' });
});

it.each(['network','owner','strategy','address'] as const)('does not let mismatched funding %s bypass foreground receipt priority', async kind => {
  if (kind === 'strategy') await retainedAccount();
  const owner = kind === 'owner' ? (await insertUser(db)).id : 1;
  await db.insert(copyFundingOperations).values({ id: 'mismatch', userId: owner, accountId: 'account', strategyId: kind === 'strategy' ? 10 : 9,
    idempotencyKey: 'mismatched-recovery', network: kind === 'network' ? 'mainnet' : 'testnet', direction: 'to_main',
    address: `0x${(kind === 'address' ? '55' : '22').repeat(20)}`, destination: `0x${'66'.repeat(20)}`, amount: '10', nonce: Date.now(), status: 'accepted', evidenceHash: 'e'.repeat(64) });
  expect(await scans.claim()).toBeNull();
});

it('restores ordinary receipt scheduling after the foreground source deadline without pretending the dispatch settled', async () => {
  await db.update(copyLiveDispatches).set({ leaderTime: sql`clock_timestamp() - interval '121 seconds'` });
  expect(await scans.claim()).toMatchObject({ accountId: 'account' });
  expect((await db.select().from(copyLiveDispatches))[0].state).toBe('pending');
});

it('does not exempt a terminal filled liability beside a fresh same-account next leg, then admits stale recovery without releasing it', async () => {
  const at = new Date(), key = 'testnet:terminal-held-priority', cloid = `0x${'01'.repeat(16)}`, accountAddress = `0x${'22'.repeat(20)}`;
  await db.insert(copyLiveExecutions).values({ key, network: 'testnet', accountAddress, signerAddress: `0x${'33'.repeat(20)}`,
    cloid, nonce: at.getTime(), userId: 1, strategyId: 9, state: 'filled', record: {}, updatedAt: at });
  await db.insert(copyLiveRiskReservations).values({ key, accountId: 'account', userId: 1, strategyId: 9, network: 'testnet', accountAddress,
    cloid, fingerprint: 'b'.repeat(64), walletId: 'agent', authorizationId: 'grant', strategyVersion: 2, policyVersion: 3, authorizationVersion: 4,
    coin: 'BTC', dex: '', asset: 0, notionalUsd: '10', marginUsd: '1', feeBufferUsd: '0.1', payload: { intent: {}, action: {} }, sourceDigest: 'c'.repeat(64),
    revision: 1, state: 'unknown', exchangeOrderId: '1', attemptedAt: at, expiresAt: new Date(at.getTime() + 60000), createdAt: at, updatedAt: at });
  expect(await scans.claim()).toBeNull();
  expect(await reports.claim()).toBeNull();
  await db.update(copyLiveDispatches).set({ leaderTime: sql`clock_timestamp() - interval '121 seconds'` });
  expect(await scans.claim()).toMatchObject({ accountId: 'account' });
  expect(await reports.claim()).toMatchObject({ accountId: 'account' });
  expect((await db.select().from(copyLiveRiskReservations))[0]).toMatchObject({ state: 'unknown', releaseReason: null, releaseEvidenceDigest: null });
  expect((await db.select().from(copyLiveExecutions))[0].state).toBe('filled');
  expect((await db.select().from(copyLiveDispatches))[0].state).toBe('pending');
});

it('restores ordinary receipt scheduling when foreground work becomes terminal', async () => {
  await db.update(copyLiveDispatches).set({ state: 'refused', reason: 'signal_expired' });
  expect(await scans.claim()).toMatchObject({ accountId: 'account' });
});

it('retains stopping-account reporting even when its last dispatch remains submitted or pending', async () => {
  await db.insert(copyFollowerObservationBudget).values({ network: 'testnet', nextAllowedAt: sql`clock_timestamp() - interval '1 second'`, nextSnapshotAllowedAt: sql`clock_timestamp() - interval '1 second'` });
  await db.update(copyLiveMandates).set({ state: 'stopping' }).where(eq(copyLiveMandates.id, 'mandate'));
  // Stopping is recovery, not foreground admission; reporting must remain available.
  expect(await reports.claim()).toMatchObject({ accountId: 'account' });
});
