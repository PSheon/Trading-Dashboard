import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { copyLiveStrategyConfigs, copyLiveMandates, copyStrategies, copyStrategyVersions, copyExecutionAccounts,
  copyExecutionWallets, copyWalletAuthorizations, copyAgentSetups } from '@trading-dashboard/shared/database';
import { closeTestDb, getTestDb, insertUser, truncateAll, type TestDb } from './db-test-utils.js';

let db: TestDb, userId: number;
const now = 1791000000000, owner = `0x${'11'.repeat(20)}`, master = `0x${'22'.repeat(20)}`, agent = `0x${'33'.repeat(20)}`, leader = `0x${'44'.repeat(20)}`;
let mandate: typeof copyLiveMandates.$inferInsert;
beforeAll(() => { db = getTestDb(); });
beforeEach(async () => {
  await truncateAll(db); userId = (await insertUser(db, { embeddedWalletAddress: owner })).id;
  await db.insert(copyStrategies).values({ id: 9, userId, leaderAddress: leader, mode: 'testnet', status: 'paused', allocated: '0', cash: '0', pauseNewRisk: true, activatedAt: new Date(now) });
  await db.insert(copyStrategyVersions).values({ strategyId: 9, version: 1, settings: { direction: 'same', sizingMode: 'fixed', perTradeUsd: 10, maxLeverage: 2, maxTotalExposureUsd: null, copyStartMode: 'delta' } });
  await db.insert(copyLiveStrategyConfigs).values({ strategyId: 9, userId, idempotencyKey: 'live-draft-fixture', sourceNetwork: 'testnet', budgetUsd: '100', strategyVersion: 1 });
  await db.insert(copyExecutionAccounts).values({ id: 'account', userId, strategyId: 9, network: 'testnet', state: 'ready', privyUserId: 'did:privy:owner', externalId: 'master-fixture', address: master, privyWalletId: 'master-wallet', ownerQuorumId: 'master-owner' });
  await db.insert(copyExecutionWallets).values({ id: 'wallet', userId, strategyId: 9, network: 'testnet', accountAddress: master, signerAddress: agent, privyWalletId: 'agent-wallet', privyOwnerId: 'worker' });
  await db.insert(copyWalletAuthorizations).values({ id: 'grant', walletId: 'wallet', version: 1, scopes: ['copy:trade', 'copy:reduce'], validFrom: new Date(now), expiresAt: new Date(now + 86400000), exchangeApprovedAt: new Date(now) });
  await db.insert(copyAgentSetups).values({ id: 'setup', userId, strategyId: 9, accountId: 'account', network: 'testnet', idempotencyKey: 'setup-fixture-key', validForDays: 1, externalId: 'setup-external', workerQuorumId: 'worker', policyAttemptId: 'policy-attempt', policyId: 'policy', policyFingerprint: 'a'.repeat(64),
    agentWalletId: 'agent-wallet', agentOwnerQuorumId: 'worker', agentAddress: agent, accountAddress: master, accountWalletId: 'master-wallet', accountOwnerQuorumId: 'master-owner', state: 'active', authorizationId: 'grant', expiresAt: new Date(now + 86400000), createdAt: new Date(now) });
  mandate = { id: 'mandate', userId, strategyId: 9, accountId: 'account', setupId: 'setup', executionWalletId: 'wallet', authorizationId: 'grant',
    idempotencyKey: 'mandate-fixture-key', network: 'testnet', sourceNetwork: 'testnet', leaderAddress: leader, accountAddress: master, accountRevision: 1,
    ownerPrivyUserId: 'did:privy:owner', ownerAddress: owner, setupRevision: 1, authorizationVersion: 1, strategyVersion: 1, agentWalletId: 'agent-wallet', agentAddress: agent,
    policyId: 'policy', policyFingerprint: 'a'.repeat(64), workerQuorumId: 'worker', settingsDigest: 'b'.repeat(64), budgetUsd: '100',
    builderAddress: null, builderMaxFeeTenthsOfBps: 0, plannerVersion: 1, nonce: now, intent: { fixture: true }, intentDigest: 'c'.repeat(64),
    state: 'prepared', revision: 1, consentExpiresAt: new Date(now + 300000), expiresAt: new Date(now + 86400000), createdAt: new Date(now), updatedAt: new Date(now) };
});
afterAll(closeTestDb);
describe('actual mandate authority storage', () => {
  it('persists a prepared generation with no signature and no simulated financial allocation', async () => {
    await db.insert(copyLiveMandates).values(mandate);
    expect((await db.select().from(copyLiveMandates))[0]).toMatchObject({ state: 'prepared', consentDigest: null, activationCursor: null, budgetUsd: '100' });
    expect((await db.select().from(copyStrategies))[0]).toMatchObject({ allocated: '0', cash: '0', status: 'paused', pauseNewRisk: true });
  });
  it('requires signed consent and a finite activation cursor for an active generation', async () => {
    await expect(db.insert(copyLiveMandates).values({ ...mandate, state: 'active' })).rejects.toThrow();
    await expect(db.insert(copyLiveMandates).values({ ...mandate, state: 'active', consentDigest: 'd'.repeat(64) })).rejects.toThrow();
    await db.insert(copyLiveMandates).values({ ...mandate, state: 'active', consentDigest: 'd'.repeat(64), activationCursor: new Date(now + 1) });
    expect((await db.select().from(copyLiveMandates))[0]!.state).toBe('active');
  });
  it('allows only one current generation while retaining archived generations and nonce uniqueness', async () => {
    await db.insert(copyLiveMandates).values(mandate);
    await expect(db.insert(copyLiveMandates).values({ ...mandate, id: 'next', idempotencyKey: 'mandate-next-key1', nonce: now + 1 })).rejects.toThrow();
    await db.insert(copyLiveMandates).values({ ...mandate, id: 'old', idempotencyKey: 'mandate-old-key01', state: 'revoked', nonce: now - 1, consentExpiresAt: new Date(now + 299999) });
    expect(await db.select().from(copyLiveMandates)).toHaveLength(2);
    await expect(db.insert(copyLiveMandates).values({ ...mandate, id: 'old-duplicate', idempotencyKey: 'mandate-old-key02', state: 'revoked' })).rejects.toThrow();
  });
  it('rejects invalid budget, identity, hash, planner, fee and temporal authority', async () => {
    const changes: Partial<typeof mandate>[] = [{ budgetUsd: '0' }, { budgetUsd: '100.0000001' }, { accountAddress: owner },
      { agentAddress: master }, { intentDigest: 'broken' }, { policyFingerprint: 'broken' }, { builderMaxFeeTenthsOfBps: 1 },
      { plannerVersion: 2 }, { nonce: 0 }, { consentExpiresAt: new Date(now + 300001) }, { expiresAt: new Date(now + 31 * 86400000) },
      { updatedAt: new Date(now - 1) }];
    for (const change of changes) await expect(db.insert(copyLiveMandates).values({ ...mandate, ...change })).rejects.toThrow();
    expect(await db.select().from(copyLiveMandates)).toHaveLength(0);
  });
  it('protects financial identity dependencies from deletion', async () => {
    await db.insert(copyLiveMandates).values(mandate);
    for (const table of [copyWalletAuthorizations, copyExecutionWallets, copyAgentSetups, copyExecutionAccounts, copyLiveStrategyConfigs])
      await expect(db.delete(table)).rejects.toThrow();
    expect(await db.select().from(copyLiveMandates)).toHaveLength(1);
  });
});
