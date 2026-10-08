import * as schema from '@trading-dashboard/shared/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CopyLivePortfolioRepository } from '../src/copy/copy-live-portfolio.repository.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import { buildOrderAction } from '../src/copy/live/live-order.js';
import { planLiveReservation } from '../src/copy/live/live-risk-reservation.js';
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

describe('owner-scoped current-generation execution summary', () => {
  const summary = async () => (await stage() as unknown as { executionSummary?: {
    pending: number; confirming: number; oldestPendingAt: string | null; lastCompletedAt: string | null;
    sourceThrough: string | null; observedAt: string;
  } | null }).executionSummary;
  const dispatch = (id: string, state: 'pending' | 'submitted' | 'settled' | 'refused', extra = {}) => db.insert(schema.copyLiveDispatches).values({
    id, mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', sourceFillId: seed.fill.id,
    leg: 'open', coin: 'BTC', state, leaderTime: new Date(now - 1000), receivedAt: new Date(now),
    createdAt: new Date(now), updatedAt: new Date(now), ...extra,
  });
  const execution = async () => {
    const f = seed.f, intent = f.intent;
    const payload = planLiveReservation({ now, identity: f.identity, localSource: f.localSource, intent,
      action: buildOrderAction(intent), market: f.market, quote: f.quote, leverage: f.leverageProofs[0]!, fees: f.fees,
      policy: f.policy, expiresAt: now + 60_000 });
    await db.insert(schema.copyLiveExecutions).values({ key: payload.key, network: 'testnet', accountAddress: f.identity.accountAddress,
      signerAddress: `0x${'33'.repeat(20)}`, cloid: intent.cloid, nonce: now, userId: 1, strategyId: 9,
      state: 'filled', record: { key: payload.key }, updatedAt: new Date(now) });
    return payload;
  };
  it('shows pending and confirming separately; a filled ACK is not a completed settlement', async () => {
    const payload = await execution();
    await dispatch('queued', 'pending');
    await dispatch('acknowledged', 'submitted', { leg: 'close', executionKey: payload.key, ackedAt: new Date(now) });
    expect(await summary()).toMatchObject({ pending: 1, confirming: 1, oldestPendingAt: new Date(now - 1000).toISOString(), lastCompletedAt: null,
      sourceThrough: new Date(now).toISOString() });
    expect(Number.isFinite(Date.parse((await summary())!.observedAt))).toBe(true);
  });
  it('only shows completion after the original verified settlement releases its reservation', async () => {
    const payload = await execution(), intent = seed.f.intent;
    await dispatch('terminal', 'settled', { executionKey: payload.key, settledAt: new Date(now + 1000) });
    expect(await summary()).toMatchObject({ lastCompletedAt: null, confirming: 1 });
    await db.insert(schema.copyLiveRiskReservations).values({ ...payload, cloid: intent.cloid, coin: intent.market!.coin,
      dex: intent.market!.dex, asset: intent.asset, payload: payload as unknown as Record<string, unknown>,
      state: 'released', attemptedAt: new Date(now), releaseReason: 'verified_settlement', releaseEvidenceDigest: 'a'.repeat(64),
      createdAt: new Date(payload.createdAt), expiresAt: new Date(payload.expiresAt), updatedAt: new Date(now + 1000) });
    expect(await summary()).toMatchObject({ lastCompletedAt: new Date(now + 1000).toISOString(), confirming: 0 });
  });
  it('excludes prior consent generations from current pending work and refusal alerts', async () => {
    const [current] = await db.select().from(schema.copyLiveMandates);
    await db.insert(schema.copyLiveMandates).values({ ...current!, id: 'previous', idempotencyKey: 'previous-mandate-0001', state: 'stopped',
      intent: { ...current!.intent, mandateId: 'previous' }, nonce: now - 60_000, createdAt: new Date(now - 60_000) });
    await dispatch('previous-queued', 'pending', { mandateId: 'previous' });
    await dispatch('previous-refused', 'refused', { mandateId: 'previous', leg: 'close', reason: 'stale_signal' });
    expect(await summary()).toMatchObject({ pending: 0, confirming: 0, oldestPendingAt: null });
    expect((await stage()).lastRefusal).toBeNull();
    expect(await new CopyLivePortfolioRepository(db).items(2)).toEqual([]);
  });
  it('returns unknown without a current consent generation rather than inventing zero pending work', async () => {
    await db.delete(schema.copyLiveMandates);
    expect(await summary()).toBeNull();
  });
  it('does not import another account into this consent generation summary', async () => {
    await db.insert(schema.copyStrategies).values({ id: 10, userId: 1, mode: 'testnet', leaderAddress: `0x${'77'.repeat(20)}`, allocated: '0', cash: '0', activatedAt: new Date(now) });
    await db.insert(schema.copyExecutionAccounts).values({ id: 'other-account', userId: 1, strategyId: 10, network: 'testnet', state: 'requested',
      privyUserId: 'did:privy:risk-source', externalId: 'other-external' });
    await dispatch('foreign-account', 'pending', { accountId: 'other-account' });
    expect(await summary()).toMatchObject({ pending: 0, confirming: 0 });
  });
});

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
    expect(await stage()).toMatchObject({ stage: 'sweeping', automaticReturn: false, sweep: null });
    // An account with the automatic return, its sweep in flight, then credited.
    await db.update(schema.copyExecutionAccounts).set({ masterPolicyId: 'policy-1', masterPolicyFingerprint: 'c'.repeat(64), masterSignerQuorumId: 'worker',
      sweepDestination: `0x${'55'.repeat(20)}`, signerAttachedAt: new Date(now) });
    await db.insert(schema.copyFundingOperations).values({ id: '55555555-5555-4555-8555-555555555555', userId: 1, accountId: 'account', strategyId: 9, idempotencyKey: 'sweep:44444444-4444-4444-8444-444444444444',
      network: 'testnet', address: seed.f.identity.accountAddress, destination: `0x${'55'.repeat(20)}`, amount: '97.5', nonce: now + 5, direction: 'to_main', stopId: '44444444-4444-4444-8444-444444444444',
      status: 'accepted', claimedAt: new Date(now), attemptedAt: new Date(now), evidenceHash: 'e'.repeat(64) });
    expect(await stage()).toMatchObject({ stage: 'sweeping', automaticReturn: true, sweep: { amount: '97.5', status: 'accepted' } });
    await db.update(schema.copyLiveStopOperations).set({ state: 'stopped' });
    await db.update(schema.copyStrategies).set({ status: 'stopped', stoppedAt: new Date(now) });
    expect(await stage()).toMatchObject({ stage: 'stopped', stop: null, sweep: { amount: '97.5' } });
    const fill = seed.fill;
    await db.insert(schema.copyLiveDispatches).values({ id: 'refused-leg', mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', sourceFillId: fill.id, leg: 'open', coin: 'BTC',
      state: 'refused', reason: 'live_source_price_deviation', leaderTime: new Date(now), receivedAt: new Date(now) });
    expect((await stage()).lastRefusal).toMatchObject({ reason: 'live_source_price_deviation' });
    expect(await new CopyLivePortfolioRepository(db).items(2)).toEqual([]);
  });
  it('a start that ended without a generation after its deposit arrived offers the return (sweeping), then shows it returned', async () => {
    await db.delete(schema.copyLiveMandates);
    await funding('credited');
    await db.update(schema.copyStrategies).set({ status: 'stopped', stoppedAt: new Date(now) });
    expect(await stage()).toMatchObject({ stage: 'sweeping', stop: null, mandate: null, sweep: null, pendingTransfer: null });
    const back = { id: '66666666-6666-4666-8666-666666666666', userId: 1, accountId: 'account', strategyId: 9, idempotencyKey: 'return-abandoned-0001', network: 'testnet' as const,
      address: seed.f.identity.accountAddress, destination: `0x${'55'.repeat(20)}`, amount: '50', nonce: now + 9, direction: 'to_main' as const, status: 'prepared' as const };
    await db.insert(schema.copyFundingOperations).values(back);
    expect(await stage()).toMatchObject({ stage: 'sweeping', pendingTransfer: { direction: 'to_main', status: 'prepared' } });
    await db.update(schema.copyFundingOperations).set({ status: 'credited', claimedAt: new Date(now), attemptedAt: new Date(now), evidenceHash: 'e'.repeat(64),
      transactionHash: `0x${'c'.repeat(64)}`, creditedAmount: '49', fee: '1' }).where(eq(schema.copyFundingOperations.id, back.id));
    expect(await stage()).toMatchObject({ stage: 'stopped', sweep: { amount: '49', status: 'credited' } });
  });
  it("an unconfirmed setup carries its consent while it can still be signed (繼續設定 opens the confirm sheet)", async () => {
    const at = Date.now(), owner = `0x${'55'.repeat(20)}`;
    const intent = { kind: 'start', setupId: '77777777-7777-4777-8777-777777777777', userId: 1, ownerAddress: owner, ownerPrivyUserId: 'did:privy:risk-source', strategyId: 9,
      leaderAddress: `0x${'44'.repeat(20)}`, sourceNetwork: 'testnet', network: 'testnet', budgetUsd: '100', settingsDigest: 'a'.repeat(64), accountId: 'account',
      accountAddress: seed.f.identity.accountAddress, accountAbstraction: 'disabled', agentAddress: `0x${'33'.repeat(20)}`, agentPolicyId: 'policy', agentPolicyFingerprint: 'a'.repeat(64),
      workerQuorumId: 'worker', agentValidUntil: at + 30 * 86_400_000, builderAddress: null, builderMaxFeeTenthsOfBps: 0, sweepDestination: owner, masterPolicyId: '', masterPolicyFingerprint: '',
      fundingOperationId: '88888888-8888-4888-8888-888888888888', fundingNonce: at, fundingAmount: '100', nonce: at, consentExpiresAt: at + 300_000, setupDeadline: at + 86_400_000 };
    await db.insert(schema.copyLiveSetups).values({ id: intent.setupId, userId: 1, strategyId: 9, accountId: 'account', kind: 'start', idempotencyKey: 'portfolio-setup-key-0001',
      stage: 'awaiting_consent', leaderAddress: intent.leaderAddress, sourceNetwork: 'testnet', budgetUsd: '100', settings: {}, intent, intentDigest: 'f'.repeat(64), consentExpiresAt: new Date(at + 300_000) });
    expect((await stage()).setup).toMatchObject({ id: intent.setupId, stage: 'awaiting_consent', consent: intent });
    await db.update(schema.copyLiveSetups).set({ consentExpiresAt: new Date(at - 1) });
    expect((await stage()).setup).toMatchObject({ stage: 'awaiting_consent', consent: null });
    // consentOf: only a setup still awaiting its consent, with an intent that parses.
    await db.update(schema.copyLiveSetups).set({ consentExpiresAt: new Date(at + 300_000), intent: { ...intent, budgetUsd: 'not a budget' } });
    expect((await stage()).setup).toMatchObject({ stage: 'awaiting_consent', consent: null });
    await db.update(schema.copyLiveSetups).set({ intent });
    expect((await stage()).setup!.consent).toMatchObject({ setupId: intent.setupId });
    const confirmed = { consentDigest: 'c'.repeat(64), confirmedAt: new Date(at), setupDeadline: new Date(at + 86_400_000) };
    for (const later of ['provisioning', 'consented', 'funding_submitted', 'failed'] as const) {
      await db.update(schema.copyLiveSetups).set({ stage: later, ...(['consented', 'funding_submitted'].includes(later) ? confirmed : {}) });
      expect((await stage()).setup, later).toMatchObject({ stage: later, consent: null });
    }
    await db.update(schema.copyLiveSetups).set({ stage: 'awaiting_consent', intent: null, consentDigest: null, confirmedAt: null, setupDeadline: null });
    expect((await stage()).setup).toMatchObject({ consent: null });
  });
  it("a deposit whose credit was never seen by its setup's deadline holds nothing and is offered back like a credited one", async () => {
    await db.delete(schema.copyLiveMandates);
    const setupId = '99999999-9999-4999-8999-999999999999';
    await db.insert(schema.copyLiveSetups).values({ id: setupId, userId: 1, strategyId: 9, accountId: 'account', kind: 'start', idempotencyKey: 'portfolio-uncredited-0001',
      stage: 'funding_submitted', leaderAddress: `0x${'44'.repeat(20)}`, sourceNetwork: 'testnet', budgetUsd: '50', settings: {},
      consentDigest: 'c'.repeat(64), intentDigest: 'd'.repeat(64), confirmedAt: new Date(now), setupDeadline: new Date(now + 86_400_000) });
    await funding('accepted', '33333333-3333-4333-8333-333333333333', { liveSetupId: setupId });
    // While the setup waits for it: the deposit is in flight.
    expect(await stage()).toMatchObject({ stage: 'setup', pendingTransfer: { direction: 'to_account', status: 'accepted' } });
    // The setup ended at its deadline, then was cancelled (its strategy stopped).
    await db.update(schema.copyLiveSetups).set({ stage: 'cancelled', issue: 'setup_deposit_uncredited' });
    await db.update(schema.copyStrategies).set({ status: 'stopped', stoppedAt: new Date(now) });
    expect(await stage()).toMatchObject({ stage: 'sweeping', pendingTransfer: null });
  });
});
