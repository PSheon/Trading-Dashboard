import { Pool } from 'pg';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { copyAgentSetups, copyControls, copyExecutionAccounts, copyExecutionWallets, copyLiveExecutions,
  copyLiveRiskReservations, copyRiskPolicies, copyStrategies, copyStrategyVersions, copyWalletAuthorizations } from '@trading-dashboard/shared/database';
import { copyLiveStrategyConfigs, copyLiveMandates, copyLiveSourceStreams, copyLiveSourceFills, copyLiveSignalLegs, copyLiveIntentProvenance } from '@trading-dashboard/shared/database';
import { liveCopyMandateIntentSchema } from '@trading-dashboard/shared/contracts';
import { digest } from '../src/copy/copy-live-mandate-evidence.js';
import { liveCopySettingsDigest } from '../src/copy/copy-live-mandate-consent.js';
import type { LiveAccountRiskInput } from '../src/copy/live/live-account-risk.js';
import { PostgresLiveReservations } from '../src/copy/live/postgres-live-reservations.js';
import { PostgresLiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';
import { buildOrderAction, executionKey, intentFingerprint } from '../src/copy/live/live-order.js';
import { fixture, now } from './copy-live-risk-test-utils.js';
import { closeTestDb, getTestDb, insertUser, truncateAll, type TestDb } from './db-test-utils.js';
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
let db: TestDb, pool: Pool, scopes: PostgresLiveRiskScope, repository: PostgresLiveReservations, f: Mutable<LiveAccountRiskInput>;
const ownerAddress = `0x${'11'.repeat(20)}`, signerAddress = `0x${'33'.repeat(20)}`;
beforeAll(() => { db = getTestDb(); pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); scopes = new PostgresLiveRiskScope(pool, () => now); repository = new PostgresLiveReservations(() => now); });
beforeEach(async () => {
  await truncateAll(db); f = fixture() as Mutable<LiveAccountRiskInput>;
  const user = await insertUser(db, { privyUserId: 'did:privy:reservation-owner', embeddedWalletAddress: ownerAddress });
  f.identity.userId = user.id; f.intent.userId = user.id; f.accountSource.userId = user.id; f.userExposureProof.userId = user.id; f.reservations.userId = user.id;
  f.accountSource.snapshot.perpEquity = '15'; f.accountSource.snapshot.withdrawable = '15';
  Object.assign(f.accountSource.snapshot.dexes[0]!, { equity: '15', rawUsd: '15', withdrawable: '15', crossEquity: '15' });
  await db.insert(copyStrategies).values({ id: 9, userId: user.id, leaderAddress: `0x${'44'.repeat(20)}`, version: 2, allocated: '100', cash: '999999', activatedAt: new Date(now) });
  await db.insert(copyStrategyVersions).values({ strategyId: 9, version: 2, settings: f.strategy.settings });
  await db.insert(copyRiskPolicies).values({ version: 3, limits: f.policy.limits });
  await db.insert(copyControls).values([{ scope: 'platform', scopeId: 0 }, { scope: 'user', scopeId: user.id }]);
  await db.insert(copyExecutionAccounts).values({ id: 'account', userId: user.id, strategyId: 9, network: 'testnet', state: 'ready', address: f.intent.accountAddress,
    privyUserId: user.privyUserId, externalId: 'master-external', privyWalletId: 'master', ownerQuorumId: 'master-owner' });
  await db.insert(copyExecutionWallets).values({ id: 'local-agent', userId: user.id, strategyId: 9, network: 'testnet', accountAddress: f.intent.accountAddress,
    privyWalletId: 'agent', privyOwnerId: 'agent-owner', signerAddress });
  await db.insert(copyWalletAuthorizations).values({ id: 'grant', walletId: 'local-agent', version: 4, scopes: ['copy:trade', 'copy:reduce'], validFrom: new Date(now - 1000), expiresAt: new Date(now + 600000), exchangeApprovedAt: new Date(now - 1) });
  await db.insert(copyAgentSetups).values({ id: 'setup', userId: user.id, accountId: 'account', strategyId: 9, network: 'testnet', idempotencyKey: 'reservation-setup',
    externalId: 'agent-external', validForDays: 7, workerQuorumId: 'worker', policyAttemptId: 'policy-attempt', accountAddress: f.intent.accountAddress, accountWalletId: 'master', accountOwnerQuorumId: 'master-owner',
    state: 'active', agentWalletId: 'agent', agentOwnerQuorumId: 'agent-owner', agentAddress: signerAddress, policyId: 'policy', policyFingerprint: 'a'.repeat(64),
    expiresAt: new Date(now + 600000), createdAt: new Date(now), authorizationId: 'grant' });
  await seed(f);
});
afterAll(async () => { await pool?.end(); await closeTestDb(); });
async function seed(input: LiveAccountRiskInput) {
  const key = executionKey(input.intent), fingerprint = intentFingerprint(input.intent, input.action);
  const authorization = { id: 'grant', version: 4, userId: input.identity.userId, strategyId: 9, walletId: 'agent', privyOwnerId: 'agent-owner',
    accountAddress: input.intent.accountAddress, signerAddress, network: 'testnet', scopes: ['copy:trade', 'copy:reduce'], validFrom: now - 1000,
    expiresAt: now + 600000, revokedAt: null, exchangeApprovedAt: now - 1 };
  await db.insert(copyLiveExecutions).values({ key, network: 'testnet', accountAddress: input.intent.accountAddress, signerAddress,
    cloid: input.intent.cloid, nonce: now + (input.intent.cloid === f.intent.cloid ? 0 : 1), userId: input.identity.userId, strategyId: 9, state: 'prepared',
    record: { key, fingerprint, authorization, action: input.action, market: input.market, nonce: now + (input.intent.cloid === f.intent.cloid ? 0 : 1),
      expiresAfter: now + 60000, state: 'prepared', createdAt: now, updatedAt: now }, updatedAt: new Date(now) } as typeof copyLiveExecutions.$inferInsert);
}
const scopeIdentity = () => ({ userId: f.identity.userId, network: 'testnet' as const, accountAddress: f.intent.accountAddress });
async function actualAuthority() {
  // Reconfigure this isolated fixture only. Production creates a separate
  // paused strategy and never converts a paper row or its historical cash.
  const leader = `0x${'44'.repeat(20)}`, sourceId = `testnet:${leader}:1`;
  await db.update(copyStrategies).set({ mode: 'testnet', allocated: '0', cash: '0' }).where(eq(copyStrategies.id, 9));
  await db.insert(copyLiveStrategyConfigs).values({ strategyId: 9, userId: f.identity.userId, sourceNetwork: 'testnet', budgetUsd: '100', strategyVersion: 2, idempotencyKey: 'actual-budget-fixture' });
  const intent = liveCopyMandateIntentSchema.parse({ mandateId: 'mandate', accountId: 'account', userId: f.identity.userId, strategyId: 9, strategyVersion: 2,
    network: 'testnet', sourceNetwork: 'testnet', leaderAddress: leader, accountAddress: f.intent.accountAddress, accountRevision: 1, ownerAddress, ownerPrivyUserId: 'did:privy:reservation-owner',
    setupId: 'setup', setupRevision: 1, executionWalletId: 'local-agent', agentWalletId: 'agent', agentAddress: signerAddress, authorizationId: 'grant', authorizationVersion: 4,
    policyId: 'policy', policyFingerprint: 'a'.repeat(64), workerQuorumId: 'worker', settingsDigest: liveCopySettingsDigest(f.strategy.settings), budgetUsd: '100',
    builderAddress: null, builderMaxFeeTenthsOfBps: 0, plannerVersion: 1, nonce: now - 1000, consentExpiresAt: now + 299000, expiresAt: now + 600000 });
  const { mandateId, consentExpiresAt, expiresAt, ...columns } = intent;
  await db.insert(copyLiveMandates).values({ ...columns, id: mandateId, idempotencyKey: 'actual-mandate-fixture', intent, intentDigest: digest(intent), state: 'active', revision: 2,
    consentDigest: 'd'.repeat(64), activationCursor: new Date(now - 1), consentExpiresAt: new Date(consentExpiresAt), expiresAt: new Date(expiresAt), createdAt: new Date(now - 1000), updatedAt: new Date(now) });
  await db.insert(copyLiveSourceStreams).values({ id: `testnet:${leader}`, network: 'testnet', leaderAddress: leader, state: 'ready', coverageFrom: new Date(now - 1), coverageThrough: new Date(now), coverageDigest: 'a'.repeat(64) });
  await db.insert(copyLiveSourceFills).values({ id: sourceId, streamId: `testnet:${leader}`, network: 'testnet', leaderAddress: leader, tid: '1', providerTime: new Date(now), receivedAt: new Date(now),
    coin: 'BTC', oid: '7', tradeKey: 'oid:7', px: '100', sz: '1', side: 'B', startPosition: '0', raw: {}, normalized: {}, sourceDigest: 'a'.repeat(64) });
  await db.insert(copyLiveSignalLegs).values({ id: 'leg', mandateId: 'mandate', sourceFillId: sourceId, leg: 'open', tradeKey: 'oid:7', sign: 1, size: '1', state: 'prepared', executionKey: executionKey(f.intent), createdAt: new Date(now), updatedAt: new Date(now) });
  await db.insert(copyLiveIntentProvenance).values({ key: executionKey(f.intent), legId: 'leg', mandateId: 'mandate', mandateRevision: 2, sourceDigest: 'a'.repeat(64),
    settingsDigest: intent.settingsDigest, fingerprint: intentFingerprint(f.intent, f.action), plannerVersion: 1, intent: f.intent as unknown as Record<string, unknown>, sizingBasis: { kind: 'fixture' }, admittedAt: new Date(now) });
}
describe('durable actual collateral reservations on original PostgreSQL lock session', () => {
  it('uses the exact consented actual budget while simulated allocated and cash remain zero', async () => {
    await actualAuthority();
    await scopes.run(scopeIdentity(), async (_scope, session) => {
      expect(await repository.hold(session, f)).toMatchObject({ state: 'held', payload: { notionalUsd: '100' } });
    });
    expect((await db.select().from(copyStrategies))[0]).toMatchObject({ mode: 'testnet', allocated: '0', cash: '0' });
  });
  it.each(['budget', 'mandate', 'settings', 'provenance', 'revision', 'ownerWallet', 'masterRevision', 'setupRevision'])('rejects changed actual %s authority before reserving funds', async kind => {
    await actualAuthority();
    if (kind === 'budget') await db.update(copyLiveStrategyConfigs).set({ budgetUsd: '101' });
    if (kind === 'mandate') await db.update(copyLiveMandates).set({ state: 'paused', revision: 3 });
    if (kind === 'settings') f.strategy.settings.maxLeverage = 11;
    if (kind === 'provenance') await db.delete(copyLiveIntentProvenance);
    if (kind === 'revision') await db.update(copyLiveIntentProvenance).set({ mandateRevision: 1 });
    if (kind === 'ownerWallet') await db.execute(sql`update users set embedded_wallet_address = ${`0x${'55'.repeat(20)}`} where id = ${f.identity.userId}`);
    if (kind === 'masterRevision') await db.update(copyExecutionAccounts).set({ revision: 2 });
    if (kind === 'setupRevision') await db.update(copyAgentSetups).set({ revision: 2 });
    await expect(scopes.run(scopeIdentity(), async (_scope, session) => repository.hold(session, f))).rejects.toThrow();
    expect(await db.select().from(copyLiveRiskReservations)).toHaveLength(0);
  });
  it('assesses actual collateral before holding and returns the exact idempotent persisted allocation', async () => {
    await scopes.run(scopeIdentity(), async (_scope, session) => {
      const first = await repository.hold(session, f), duplicate = await repository.hold(session, f);
      expect(first).toEqual(duplicate); expect(first).toMatchObject({ state: 'held', revision: 1, payload: { marginUsd: '10', feeBufferUsd: '0.1' } });
      const proof = await repository.read(session, { accountId: 'account', ownKey: executionKey(f.intent) });
      expect(proof).toMatchObject({ complete: true, own: { state: 'held' }, others: [] });
    });
    expect(await db.select().from(copyLiveRiskReservations)).toHaveLength(1);
    expect((await db.select().from(copyStrategies))[0]!.cash).toBe('999999');
  });
  it('serializes two distinct orders competing for the last actual collateral, without reading paper cash', async () => {
    f.strategy.settings.maxLeverage = 20; f.strategy.settings.maxTotalExposureUsd = 500; f.policy.limits.maxLeverage = 20;
    await db.update(copyStrategyVersions).set({ settings: f.strategy.settings }).where(eq(copyStrategyVersions.strategyId, 9));
    await db.update(copyRiskPolicies).set({ limits: f.policy.limits }).where(eq(copyRiskPolicies.version, 3));
    const second = structuredClone(f); second.intent.cloid = `0x${'cd'.repeat(16)}`; second.action = buildOrderAction(second.intent);
    second.userExposureProof.excludedExecutionKey = executionKey(second.intent); await seed(second);
    await scopes.run(scopeIdentity(), async (_scope, session) => {
      await repository.hold(session, f);
      await expect(scopes.run(scopeIdentity(), async (_other, next) => repository.hold(next, second))).rejects.toThrow('live_risk_busy');
    });
    await scopes.run(scopeIdentity(), async (_scope, session) => { await expect(repository.hold(session, second)).rejects.toThrow('available_collateral'); });
    expect(await db.select().from(copyLiveRiskReservations)).toHaveLength(1);
  });
  it('cannot manufacture collateral from caller-owned reservation arrays or a missing authoritative account proof', async () => {
    f.accountSource.snapshot.coverage.complete = false;
    await expect(scopes.run(scopeIdentity(), async (_scope, session) => repository.hold(session, f))).rejects.toThrow('live_risk_coverage_incomplete');
    expect(await db.select().from(copyLiveRiskReservations)).toHaveLength(0);
  });
  it('never changes uncertain allocations back to held when journal recovery is incomplete', async () => {
    await scopes.run(scopeIdentity(), async (_scope, session) => repository.hold(session, f));
    const key = executionKey(f.intent), [journal] = await db.select().from(copyLiveExecutions).where(eq(copyLiveExecutions.key, key));
    await db.update(copyLiveExecutions).set({ state: 'unknown', record: { ...journal!.record, state: 'unknown' } }).where(eq(copyLiveExecutions.key, key));
    await scopes.run(scopeIdentity(), async (_scope, session) => { await repository.recover(session, 'account');
      await expect(repository.hold(session, f)).rejects.toThrow(); await expect(repository.releaseUnattemptedExpired(session, key)).rejects.toThrow(); });
    expect((await db.select().from(copyLiveRiskReservations))[0]).toMatchObject({ state: 'unknown', releaseReason: null });
  });
  it('limits the held/submitting exemption to the original successful holding session', async () => {
    const key = executionKey(f.intent);
    await scopes.run(scopeIdentity(), async (scope, session) => {
      await repository.hold(session, f);
      await session.transaction(async tx => {
        const [journal] = await tx.select().from(copyLiveExecutions).where(eq(copyLiveExecutions.key, key)); await scope.assertHeld();
        await tx.update(copyLiveExecutions).set({ state: 'submitting', record: { ...journal!.record, state: 'submitting' } }).where(eq(copyLiveExecutions.key, key)); await scope.assertHeld();
      });
      expect((await repository.read(session, { accountId: 'account', ownKey: key })).own.state).toBe('held');
    });
    await scopes.run(scopeIdentity(), async (_scope, successor) => {
      expect((await repository.read(successor, { accountId: 'account', ownKey: key })).own.state).toBe('unknown');
      await repository.recover(successor, 'account');
      expect((await repository.read(successor, { accountId: 'account', ownKey: key })).own.state).toBe('unknown');
    });
  });
  it.each(['allocation', 'policy', 'controls', 'authorization'])('rechecks current %s before committing a hold', async kind => {
    if (kind === 'allocation') await db.update(copyStrategies).set({ allocated: '99' }).where(eq(copyStrategies.id, 9));
    if (kind === 'policy') await db.insert(copyRiskPolicies).values({ version: 4, limits: f.policy.limits });
    if (kind === 'controls') await db.update(copyControls).set({ pauseNewRisk: true }).where(eq(copyControls.scope, 'platform'));
    if (kind === 'authorization') await db.update(copyWalletAuthorizations).set({ revokedAt: new Date(now) }).where(eq(copyWalletAuthorizations.id, 'grant'));
    await expect(scopes.run(scopeIdentity(), async (_scope, session) => repository.hold(session, f))).rejects.toThrow();
    expect(await db.select().from(copyLiveRiskReservations)).toHaveLength(0);
  });
  it.each(['unknown', 'filled', 'cancelled', 'rejected'])('preserves liabilities for attempted or terminal %s journals despite expired deadlines', async state => {
    await scopes.run(scopeIdentity(), async (_scope, session) => repository.hold(session, f));
    const key = executionKey(f.intent), [journal] = await db.select().from(copyLiveExecutions).where(eq(copyLiveExecutions.key, key));
    await db.update(copyLiveExecutions).set({ state, record: { ...journal!.record, state } }).where(eq(copyLiveExecutions.key, key));
    const later = now + 60001, laterScopes = new PostgresLiveRiskScope(pool, () => later), laterRepository = new PostgresLiveReservations(() => later);
    await laterScopes.run(scopeIdentity(), async (_scope, session) => {
      await laterRepository.recover(session, 'account');
      expect((await laterRepository.read(session, { accountId: 'account', ownKey: key })).own.state).toBe('unknown');
      await expect(laterRepository.releaseUnattemptedExpired(session, key)).rejects.toThrow('live_reservation_release_unproven');
    });
    expect((await db.select().from(copyLiveRiskReservations))[0]).toMatchObject({ state: 'unknown', revision: 2, releaseReason: null });
  });
  it('releases only an expired prepared allocation with no durable attempt or order id', async () => {
    await scopes.run(scopeIdentity(), async (_scope, session) => repository.hold(session, f));
    const key = executionKey(f.intent);
    await scopes.run(scopeIdentity(), async (_scope, session) => { await expect(repository.releaseUnattemptedExpired(session, key)).rejects.toThrow('live_reservation_release_unproven'); });
    const later = now + 60000, laterScopes = new PostgresLiveRiskScope(pool, () => later), laterRepository = new PostgresLiveReservations(() => later);
    await laterScopes.run(scopeIdentity(), async (_scope, session) => laterRepository.releaseUnattemptedExpired(session, key));
    const [stored] = await db.select().from(copyLiveRiskReservations);
    expect(stored).toMatchObject({ state: 'released', revision: 2, releaseReason: 'unattempted_expired', attemptedAt: null, exchangeOrderId: null });
    expect(stored!.releaseEvidenceDigest).toMatch(/^[0-9a-f]{64}$/);
  });
  it.each(['quote', 'provider'])('rejects expired %s evidence after COMMIT rather than returning a fresh-looking successful hold', async kind => {
    let clock = now; const timedScopes = new PostgresLiveRiskScope(pool, () => clock), timedRepository = new PostgresLiveReservations(() => clock);
    if (kind === 'quote') f.quote.observedAt = now - 5000;
    if (kind === 'provider') { f.accountSource.snapshot.dexes[0]!.providerTime = now - 5000; f.accountSource.snapshot.coverage.earliestProviderTime = now - 5000; }
    await timedScopes.run(scopeIdentity(), async (_scope, session) => {
      const delayed = { scope: session.scope, read: session.read, transaction: async <T>(work: Parameters<typeof session.transaction<T>>[0]) => {
        const result = await session.transaction(work); clock++; return result;
      } };
      await expect(timedRepository.hold(delayed, f)).rejects.toThrow('live_risk_stale');
    });
    // The committed liability remains conservative; no execution permit was returned.
    expect((await db.select().from(copyLiveRiskReservations))[0]).toMatchObject({ state: 'held', attemptedAt: null });
  });
  it('captures requested account and execution key before SQL queue waits', async () => {
    await scopes.run(scopeIdentity(), async (_scope, session) => {
      await repository.hold(session, f);
      const input = { accountId: 'account', ownKey: executionKey(f.intent) }, originalKey = input.ownKey;
      const pending = repository.read(session, input); input.accountId = 'different-account'; input.ownKey = 'different-key';
      expect((await pending).own.key).toBe(originalKey);
    });
  });
  it('refuses malformed persisted identity instead of claiming complete collateral coverage', async () => {
    await scopes.run(scopeIdentity(), async (_scope, session) => repository.hold(session, f));
    const [stored] = await db.select().from(copyLiveRiskReservations);
    await db.update(copyLiveRiskReservations).set({ payload: { ...stored!.payload, walletId: 'different-agent' } }).where(eq(copyLiveRiskReservations.key, stored!.key));
    await expect(scopes.run(scopeIdentity(), async (_scope, session) => repository.read(session, { accountId: 'account', ownKey: stored!.key }))).rejects.toThrow('live_reservation_record_invalid');
  });
  it('refuses to certify a truncated liability set beyond the supported reservation bound', async () => {
    await scopes.run(scopeIdentity(), async (_scope, session) => repository.hold(session, f));
    const [row] = await db.select().from(copyLiveRiskReservations), [journal] = await db.select().from(copyLiveExecutions);
    for (let first = 1; first <= 5001; first += 500) {
      const holds: (typeof copyLiveRiskReservations.$inferInsert)[] = [], journals: (typeof copyLiveExecutions.$inferInsert)[] = [];
      for (let i = first; i < Math.min(first + 500, 5002); i++) {
        const intent = { ...f.intent, cloid: `0x${i.toString(16).padStart(32, '0')}` as `0x${string}` }, action = buildOrderAction(intent);
        const key = executionKey(intent), fingerprint = intentFingerprint(intent, action), nonce = now + i;
        journals.push({ ...journal!, key, cloid: intent.cloid, nonce, record: { ...journal!.record, key, fingerprint, action, nonce } });
        holds.push({ ...row!, key, cloid: intent.cloid, fingerprint, payload: { ...row!.payload, key, fingerprint, intent, action } });
      }
      await db.insert(copyLiveExecutions).values(journals); await db.insert(copyLiveRiskReservations).values(holds);
    }
    await expect(scopes.run(scopeIdentity(), async (_scope, session) => repository.read(session, { accountId: 'account', ownKey: row!.key }))).rejects.toThrow('live_reservation_coverage_unbounded');
  });
});
