import * as schema from '@trading-dashboard/shared/database';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CopyLivePortfolioRepository } from '../src/copy/copy-live-portfolio.repository.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';

let db: TestDb, seed: Awaited<ReturnType<typeof preparationFixture>>;
const stage = async () => (await new CopyLivePortfolioRepository(db).items(1))[0]!;
const funding = (status: 'prepared' | 'unknown' | 'accepted' | 'credited', id = '33333333-3333-4333-8333-333333333333', extra: Record<string, unknown> = {}) =>
  db.insert(schema.copyFundingOperations).values({ id, userId: 1, accountId: 'account', strategyId: 9, idempotencyKey: `fund-${id}`, network: 'testnet',
    address: `0x${'55'.repeat(20)}`, destination: seed.f.identity.accountAddress, amount: '50', nonce: now + Number(id.at(-1)), status,
    ...(status === 'prepared' ? {} : { claimedAt: new Date(now), attemptedAt: new Date(now), evidenceHash: 'a'.repeat(64) }),
    ...(status === 'credited' ? { transactionHash: `0x${'b'.repeat(64)}`, creditedAmount: '50', fee: '0' } : {}), ...extra });

beforeEach(async () => { db = getTestDb(); seed = await preparationFixture(db); await db.update(schema.copyStrategies).set({ status: 'paused', pauseNewRisk: true }); });
afterAll(async () => { await closeTestDb(); });

describe('testnet copy stages for the portfolio', () => {
  it('follows setup → needs_deposit → funding → awaiting_credit → starting → active', async () => {
    await db.update(schema.copyLiveMandates).set({ state: 'prepared' });
    expect(await stage()).toMatchObject({ stage: 'setup', sourceNetwork: 'testnet', accountAddress: seed.f.identity.accountAddress });
    await db.update(schema.copyLiveMandates).set({ state: 'active' });
    expect(await stage()).toMatchObject({ stage: 'needs_deposit', mandate: { id: 'mandate', state: 'active' } });
    await funding('prepared'); expect((await stage()).stage).toBe('funding');
    await db.update(schema.copyFundingOperations).set({ status: 'accepted', claimedAt: new Date(now), attemptedAt: new Date(now), evidenceHash: 'a'.repeat(64) });
    expect(await stage()).toMatchObject({ stage: 'awaiting_credit', pendingTransfer: { direction: 'to_account', status: 'accepted', amount: '50' } });
    await db.update(schema.copyFundingOperations).set({ status: 'credited', transactionHash: `0x${'b'.repeat(64)}`, creditedAmount: '50', fee: '0' });
    await db.insert(schema.copyLiveActivations).values({ mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', state: 'pending', controlRevision: 0, requestedAt: new Date(now) });
    expect((await stage()).stage).toBe('starting');
    await db.update(schema.copyStrategies).set({ status: 'active', pauseNewRisk: false });
    expect(await stage()).toMatchObject({ stage: 'active', pendingTransfer: null });
  });
  it('shows a stop as stopping, then sweeping while flat, then stopped; and the latest refusal', async () => {
    await funding('credited'); await db.update(schema.copyStrategies).set({ status: 'stopping' });
    const values = { userId: 1, strategyId: 9, accountId: 'account', mandateId: 'mandate', idempotencyKey: 'portfolio-stop-0001', originalMandateRevision: 2, network: 'testnet' as const,
      accountAddress: seed.f.identity.accountAddress, ownerPrivyUserId: 'did:privy:risk-source', ownerAddress: `0x${'55'.repeat(20)}`, accountWalletId: 'master', accountOwnerQuorumId: 'owner',
      originalIntentDigest: 'a'.repeat(64), originalConsentDigest: 'b'.repeat(64), targetManifest: {}, targetDigest: 'c'.repeat(64), trackedExecutionCount: 0, trackingComplete: true,
      createdAt: new Date(now), updatedAt: new Date(now) };
    await db.insert(schema.copyLiveStopOperations).values({ ...values, id: '44444444-4444-4444-8444-444444444444', state: 'closing' });
    expect(await stage()).toMatchObject({ stage: 'stopping', stop: { state: 'closing' } });
    await db.update(schema.copyLiveStopOperations).set({ state: 'flat', flatCertificate: {}, flatDigest: 'd'.repeat(64), flatVerifiedAt: new Date(now) });
    expect((await stage()).stage).toBe('sweeping');
    await db.update(schema.copyLiveStopOperations).set({ state: 'stopped' });
    await db.update(schema.copyStrategies).set({ status: 'stopped', stoppedAt: new Date(now) });
    expect(await stage()).toMatchObject({ stage: 'stopped', stop: null });
    const fill = seed.fill;
    await db.insert(schema.copyLiveDispatches).values({ id: 'refused-leg', mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', sourceFillId: fill.id, leg: 'open', coin: 'BTC',
      state: 'refused', reason: 'live_source_price_deviation', leaderTime: new Date(now), receivedAt: new Date(now) });
    expect((await stage()).lastRefusal).toMatchObject({ reason: 'live_source_price_deviation' });
    expect(await new CopyLivePortfolioRepository(db).items(2)).toEqual([]);
  });
});
