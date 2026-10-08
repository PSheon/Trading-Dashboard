import { eq, sql } from 'drizzle-orm';
import { copyFundingOperations, copyLiveBuilderApprovals, copyLiveSetupAborts, copyLiveSetups, copyAccountModeOperations, copyAgentSetups, copyExecutionAccounts, copyLiveMandates, copyLiveStopOperations } from '@trading-dashboard/shared/database';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { CopyLiveStopRepository } from '../src/copy/copy-live-stop.repository.js';
import { CopyLiveMandateRepository } from '../src/copy/copy-live-mandate.repository.js';
import { CopyWalletRepository } from '../src/copy/copy-wallet.repository.js';
import { expireStaleReturns } from '../src/copy/copy-live-return.repository.js';
import { CopyAccountModeRepository } from '../src/copy/copy-account-mode.repository.js';
import { CopyAgentRepository } from '../src/copy/copy-agent.repository.js';
import { CopyLiveSetupRepository } from '../src/copy/copy-live-setup.repository.js';
import { CopyFundingRepository } from '../src/copy/copy-funding.repository.js';
import { CopyLiveReturnRepository } from '../src/copy/copy-live-return.repository.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { testConfig } from './config-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';

let db: TestDb, seed: Awaited<ReturnType<typeof preparationFixture>>;
const setupId = '00000000-0000-4000-8000-000000000001';
const abortId = '00000000-0000-4000-8000-000000000002';
beforeEach(async () => { db = getTestDb(); seed = await preparationFixture(db); });
afterAll(closeTestDb);

async function installAbort() {
  await db.insert(copyLiveSetups).values({ id: setupId, userId: 1, strategyId: 9, accountId: 'account', kind: 'start', idempotencyKey: 'abort-original-start-key',
    leaderAddress: seed.consent.leaderAddress, sourceNetwork: 'testnet', budgetUsd: '100', settings: seed.f.strategy.settings });
  await db.insert(copyLiveSetupAborts).values({ id: abortId, userId: 1, setupId, strategyId: 9, accountId: 'account', kind: 'start', network: 'testnet',
    idempotencyKey: 'abort-original-request-key', ownerPrivyUserId: seed.consent.ownerPrivyUserId, ownerAddress: seed.consent.ownerAddress,
    accountAddress: seed.consent.accountAddress, destination: seed.consent.ownerAddress });
}

it('setup abort authority persists independently of transient setup stage and process memory', async () => {
  const result = await db.execute<{ authority: string | null }>(sql`select to_regclass('public.copy_live_setup_aborts')::text as authority`);
  expect(result.rows[0]?.authority).toBe('copy_live_setup_aborts');
});

it('database authority permits at most one original abort return even after the first operation ends', async () => {
  await installAbort();
  const refund = { userId: 1, strategyId: 9, accountId: 'account', network: 'testnet' as const, address: seed.consent.accountAddress,
    destination: seed.consent.ownerAddress, direction: 'to_main' as const, amount: '10', status: 'cancelled' as const, setupAbortId: abortId };
  await db.insert(copyFundingOperations).values({ ...refund, id: 'original-abort-return', idempotencyKey: 'original-abort-return-key', nonce: Date.now() });
  await expect(db.insert(copyFundingOperations).values({ ...refund, id: 'duplicate-abort-return', idempotencyKey: 'different-abort-return-key', nonce: Date.now() + 1 }))
    .rejects.toMatchObject({ cause: { code: '23505', constraint: 'copy_funding_setup_abort_uq' } });
});

it('an abort is a permanent barrier before a prepared deposit can be admitted to the exchange', async () => {
  const repository = new CopyFundingRepository(db);
  const operation = await repository.reserve(1, 'account', 'testnet', { idempotencyKey: 'deposit-original-request-key', amount: '10' });
  await installAbort();
  await db.update(copyFundingOperations).set({ liveSetupId: setupId }).where(eq(copyFundingOperations.id, operation.id));
  await repository.claim(1, operation.id);
  await expect(repository.beginSubmit(1, operation.id)).rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
  expect((await repository.find(1, operation.id)).attemptedAt).toBeNull();
});

it('a late builder driver cannot acquire financial authority after abort', async () => {
  const repository = new CopyLiveReturnRepository(db, testConfig());
  const operation = await repository.reserveBuilder(1, 'account', { idempotencyKey: 'builder-original-request-key', builderAddress: `0x${'99'.repeat(20)}`, maxFeeTenthsBps: 1, now: Date.now() });
  await installAbort();
  await db.update(copyLiveBuilderApprovals).set({ liveSetupId: setupId }).where(eq(copyLiveBuilderApprovals.id, operation.id));
  await expect(repository.beginBuilder(1, operation.id)).rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
  expect((await repository.builder(1, operation.id)).attemptedAt).toBeNull();
});

it('an aborted setup cannot create an untagged deposit before a late parent update', async () => {
  await installAbort();
  const repository = new CopyFundingRepository(db);
  await expect(repository.reserve(1, 'account', 'testnet', { idempotencyKey: 'aborted-child-deposit-key', amount: '10' }, undefined, setupId))
    .rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
  expect(await db.select().from(copyFundingOperations)).toHaveLength(0);
});

it('an aborted setup cannot create an untagged builder child before a late parent update', async () => {
  await installAbort();
  const repository = new CopyLiveReturnRepository(db, testConfig());
  await expect(repository.reserveBuilder(1, 'account', { idempotencyKey: 'aborted-child-builder-key', builderAddress: `0x${'99'.repeat(20)}`, maxFeeTenthsBps: 1,
    now: Date.now(), liveSetupId: setupId })).rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
  expect(await db.select().from(copyLiveBuilderApprovals)).toHaveLength(0);
});

it('an original attempted builder outcome still reconciles after the abort barrier without acquiring a new attempt', async () => {
  const repository = new CopyLiveReturnRepository(db, testConfig());
  const operation = await repository.reserveBuilder(1, 'account', { idempotencyKey: 'attempted-original-builder-key', builderAddress: `0x${'99'.repeat(20)}`, maxFeeTenthsBps: 1, now: Date.now() });
  await installAbort();
  const attemptedAt = new Date();
  await db.update(copyLiveBuilderApprovals).set({ liveSetupId: setupId, state: 'unknown', attemptedAt }).where(eq(copyLiveBuilderApprovals.id, operation.id));
  expect(await repository.beginBuilder(1, operation.id)).toBeNull();
  await repository.finishBuilder(1, operation.id, 'accepted', 'e'.repeat(64));
  expect(await repository.builder(1, operation.id)).toMatchObject({ state: 'accepted', attemptedAt });
});


it('a late driver cannot rewrite the setup or acquire a new lease after the durable abort', async () => {
  await installAbort();
  const repository = new CopyLiveSetupRepository(db), row = await repository.find(1, setupId);
  expect(await repository.transition(row, { issue: 'old_driver_retry' })).toBeNull();
  expect(await repository.lease(setupId, 60_000)).toBeNull();
});

it('an abort fences new agent preparation without retiring the existing generation’s agent', async () => {
  await installAbort();
  const repository = new CopyAgentRepository(db);
  const before = await db.select().from(copyAgentSetups);
  await expect(db.transaction(tx => repository.ensure(tx, 1, 'account', { idempotencyKey: 'aborted-renewal-agent-key', validForDays: 1 }, 'worker',
    { liveSetupId: setupId, renewal: true }, 'testnet'))).rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
  expect(await db.select().from(copyAgentSetups)).toEqual(before);
});

it('a pending mode operation cannot cross the durable attemptedAt boundary after abort', async () => {
  await installAbort();
  const repository = new CopyAccountModeRepository(db, testConfig()), at = Date.now();
  const [row] = await db.insert(copyAccountModeOperations).values({ id: 'aborted-mode', userId: 1, strategyId: 9, accountId: 'account', network: 'testnet',
    idempotencyKey: 'aborted-mode-request-key', accountAddress: seed.consent.accountAddress, accountWalletId: 'master', accountOwnerQuorumId: 'owner',
    ownerPrivyUserId: seed.consent.ownerPrivyUserId, ownerAddress: seed.consent.ownerAddress, liveSetupId: setupId,
    nonce: at, consentExpiresAt: new Date(at + 300_000), intent: {}, intentDigest: 'd'.repeat(64), consentDigest: 'c'.repeat(64) }).returning();
  await expect(db.transaction(tx => repository.transition(row!, { submissionState: 'unknown', attemptedAt: new Date(), attemptProof: {} }, tx)))
    .rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
  expect((await db.select().from(copyAccountModeOperations))[0]!.attemptedAt).toBeNull();
});

it.each([['policy_prepared', 'policy_unknown'], ['wallet_prepared', 'wallet_unknown']] as const)(
  'abort seals a late SDK provisioning attempt from %s to %s', async (state, next) => {
    await installAbort();
    const [row] = await db.insert(copyAgentSetups).values({ id: `aborted-${state}`, userId: 1, strategyId: 9, accountId: 'account', network: 'testnet',
      idempotencyKey: `aborted-${state}-key`, validForDays: 1, externalId: `external-${state}`, policyAttemptId: `policy-${state}`,
      workerQuorumId: 'worker', accountAddress: seed.consent.accountAddress, accountWalletId: 'master', accountOwnerQuorumId: 'owner',
      state, liveSetupId: setupId, expiresAt: new Date(Date.now() + 86_400_000) }).returning();
    await expect(new CopyAgentRepository(db).transition(row!, { state: next })).rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
    expect((await db.select().from(copyAgentSetups).where(eq(copyAgentSetups.id, row!.id)))[0]!.state).toBe(state);
  });

it('abort prevents a paused original master-wallet driver from beginning new SDK creation', async () => {
  await installAbort();
  await db.update(copyExecutionAccounts).set({ state: 'requested' }).where(eq(copyExecutionAccounts.id, 'account'));
  await expect(new CopyWalletRepository(db).claimCreation('account')).rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
  expect((await db.select().from(copyExecutionAccounts))[0]!.state).toBe('requested');
});

it('a unique abort refund waits for fresh proof rather than expiring as a browser consent', async () => {
  await installAbort();
  await db.insert(copyFundingOperations).values({ id: 'waiting-abort-refund', userId: 1, strategyId: 9, accountId: 'account', network: 'testnet',
    address: seed.consent.accountAddress, destination: seed.consent.ownerAddress, direction: 'to_main', amount: '10', setupAbortId: abortId,
    idempotencyKey: `abort:${abortId}`, nonce: Date.now(), createdAt: new Date(Date.now() - 600_000) });
  await db.transaction(tx => expireStaleReturns(tx, 'account'));
  expect((await db.select().from(copyFundingOperations))[0]!.status).toBe('prepared');
});

it('a plain top-up prepared before abort cannot acquire an exchange attempt afterwards', async () => {
  const repository = new CopyFundingRepository(db);
  const op = await repository.reserve(1, 'account', 'testnet', { idempotencyKey: 'plain-topup-pre-abort-key', amount: '10' });
  await repository.claim(1, op.id); await installAbort();
  await expect(repository.beginSubmit(1, op.id)).rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
  expect((await repository.find(1, op.id)).attemptedAt).toBeNull();
});

it('a plain return prepared before abort cannot compete with its proof-bound refund', async () => {
  const repository = new CopyLiveReturnRepository(db, testConfig());
  const op = await repository.reserve(1, 'account', { idempotencyKey: 'plain-return-pre-abort-key', amount: '10', sweep: false });
  await installAbort();
  await expect(repository.begin(1, op.id)).rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
  expect((await repository.find(1, op.id)).attemptedAt).toBeNull();
});

it('new ordinary funding is refused while an account abort is pending, and completed pending edits release the account', async () => {
  await installAbort(); const repository = new CopyFundingRepository(db);
  await expect(repository.reserve(1, 'account', 'testnet', { idempotencyKey: 'plain-topup-after-abort-key', amount: '10' }))
    .rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
  await db.update(copyLiveSetupAborts).set({ state: 'done', kind: 'edit' }).where(eq(copyLiveSetupAborts.id, abortId));
  expect(await repository.reserve(1, 'account', 'testnet', { idempotencyKey: 'plain-topup-after-abort-key', amount: '10' })).toMatchObject({ liveSetupId: null, attemptedAt: null });
});

it('a plain builder approval cannot start an SDK attempt during an account abort', async () => {
  const repository = new CopyLiveReturnRepository(db, testConfig());
  const op = await repository.reserveBuilder(1, 'account', { idempotencyKey: 'plain-builder-pre-abort-key', builderAddress: `0x${'99'.repeat(20)}`, maxFeeTenthsBps: 1, now: Date.now() });
  await installAbort();
  await expect(repository.beginBuilder(1, op.id)).rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
});

it('a plain mode operation cannot sign after its account acquires an abort barrier', async () => {
  const repository = new CopyAccountModeRepository(db, testConfig());
  const row = await db.transaction(tx => repository.ensure(tx, 1, 'account', 'plain-mode-pre-abort-key'));
  await installAbort();
  await expect(repository.transition(row, { submissionState: 'signing' })).rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
});

it('a plain agent approval cannot sign after its account acquires an abort barrier', async () => {
  await installAbort();
  const row = (await db.select().from(copyAgentSetups).where(eq(copyAgentSetups.id, 'setup')))[0]!;
  await expect(new CopyAgentRepository(db).transition(row, { state: 'approval_signing' })).rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
});

it('a cached prepared generation cannot activate after its original setup abort', async () => {
  const [prepared] = await db.update(copyLiveMandates).set({ state: 'prepared', activationCursor: null }).returning();
  await installAbort();
  await expect(db.transaction(tx => new CopyLiveMandateRepository(db, testConfig()).activate(tx, prepared!,
    { liveSetupId: setupId, consentDigest: 'c'.repeat(64) }, prepared!.createdAt.getTime() + 1)))
    .rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
  expect((await db.select().from(copyLiveMandates))[0]).toMatchObject({ state: 'prepared', activationCursor: null });
});

it('new plain builder children cannot be admitted behind a pending account abort', async () => {
  await installAbort();
  await expect(new CopyLiveReturnRepository(db, testConfig()).reserveBuilder(1, 'account', { idempotencyKey: 'plain-builder-after-abort-key',
    builderAddress: `0x${'99'.repeat(20)}`, maxFeeTenthsBps: 1, now: Date.now() })).rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
});

it('new plain mode children cannot be admitted behind a pending account abort', async () => {
  await installAbort();
  await expect(db.transaction(tx => new CopyAccountModeRepository(db, testConfig()).ensure(tx, 1, 'account', 'plain-mode-after-abort-key')))
    .rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
});

it('plain agent provisioning cannot poison the original abort with a newly admitted SDK child', async () => {
  await installAbort();
  await db.update(copyAgentSetups).set({ expiresAt: new Date(Date.now() - 1) });
  const before = await db.select().from(copyAgentSetups);
  await expect(db.transaction(tx => new CopyAgentRepository(db).ensure(tx, 1, 'account', { idempotencyKey: 'plain-agent-after-abort-key', validForDays: 1 }, 'worker')))
    .rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
  expect(await db.select().from(copyAgentSetups)).toEqual(before);
});

it.each(['edit', 'renewal', 'start'] as const)('a pending %s abort admits only its permitted genuine generation stop return', async kind => {
  const mandates = new CopyLiveMandateRepository(db, testConfig()), stops = new CopyLiveStopRepository(db, mandates);
  const original = (await db.select().from(copyLiveMandates))[0]!;
  const stop = await db.transaction(tx => stops.request(tx, 1, original.id,
    { idempotencyKey: 'genuine-old-generation-stop-key', expectedMandateRevision: original.revision }, Date.now));
  const at = new Date();
  await db.update(copyLiveStopOperations).set({ state: 'flat', flatCertificate: { positions: [], restingOrders: [] }, flatDigest: 'f'.repeat(64), flatVerifiedAt: at, updatedAt: at })
    .where(eq(copyLiveStopOperations.id, stop.id));
  await db.update(copyExecutionAccounts).set({ sweepDestination: seed.consent.ownerAddress, masterPolicyId: 'original-master-policy', masterPolicyFingerprint: 'c'.repeat(64), masterSignerQuorumId: 'worker', signerAttachedAt: new Date() });
  await installAbort(); await db.update(copyLiveSetups).set({ kind }).where(eq(copyLiveSetups.id, setupId)); await db.update(copyLiveSetupAborts).set({ kind }).where(eq(copyLiveSetupAborts.id, abortId));
  const returns = new CopyLiveReturnRepository(db, testConfig()), refund = await returns.reserveSystem(stop, '10');
  expect(refund).toMatchObject({ stopId: stop.id, setupAbortId: null });
  if (kind === 'start') {
    await expect(returns.begin(1, refund!.id, true)).rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
    expect((await returns.find(1, refund!.id)).attemptedAt).toBeNull();
  } else expect(await returns.begin(1, refund!.id, true)).toMatchObject({ status: 'unknown', attemptedAt: expect.any(Date), stopId: stop.id });
});
