import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { privateKeyToAccount } from 'viem/accounts';
import { adminSettingsSchema, DEFAULT_COPY_RISK_LIMITS, liveCopyMandateOwnerTypedData, liveCopyOverviewSchema } from '@trading-dashboard/shared/contracts';
import { appSettings, copyLiveActivations, copyLiveBuilderApprovals, leaders, copyControls, copyAgentSetups, copyExecutionAccounts, copyExecutionWallets, copyLiveExecutions, copyLiveMandates,
  copyLiveStrategyConfigs, copyRiskPolicies, copyStrategies, copyStrategyVersions, copyWalletAuthorizations, paperAccounts, users } from '@trading-dashboard/shared/database';
import { CopyLiveMandateRepository } from '../src/copy/copy-live-mandate.repository.js';
import { CopyLiveMandateService } from '../src/copy/copy-live-mandate.service.js';
import { PostgresLiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { testConfig } from './config-test-utils.js';
import { getTestDb, closeTestDb, insertUser, truncateAll, openCopyTrading, type TestDb } from './db-test-utils.js';

const owner = privateKeyToAccount(`0x${'01'.repeat(32)}`), foreign = privateKeyToAccount(`0x${'02'.repeat(32)}`);
const accountId = 'mandate-master', address = `0x${'22'.repeat(20)}`, agentAddress = `0x${'33'.repeat(20)}`, leader = `0x${'44'.repeat(20)}`;
const settings = { direction: 'same' as const, sizingMode: 'fixed' as const, perTradeUsd: 100, maxTotalExposureUsd: null, maxLeverage: 5, copyStartMode: 'delta' as const };
const draft = () => ({ idempotencyKey: 'dedicated-draft-key-0001', leader, sourceNetwork: 'testnet' as const, budgetUsd: '100', settings: { ...settings } });
let db: TestDb, pool: Pool, service: CopyLiveMandateService, scopes: PostgresLiveRiskScope, uid: number, sid: number, clock: number;
beforeAll(() => { db = getTestDb(); pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
beforeEach(async () => {
  await truncateAll(db); clock = Date.now();
  uid = (await insertUser(db, { privyUserId: 'did:privy:mandate-owner', embeddedWalletAddress: owner.address.toLowerCase() })).id;
  await openCopyTrading(db);
  await db.insert(copyControls).values([{ scope: 'platform', scopeId: 0 }, { scope: 'user', scopeId: uid }]);
  await db.insert(appSettings).values({ key: 'revenue', value: adminSettingsSchema.shape.revenue.parse({}) });
  await db.insert(copyRiskPolicies).values({ limits: { ...DEFAULT_COPY_RISK_LIMITS }, reason: 'explicit live policy', createdByUserId: uid });
  sid = (await db.insert(copyStrategies).values({ userId: uid, leaderAddress: leader, mode: 'testnet', status: 'paused', pauseNewRisk: true,
    allocated: '0', cash: '0', activatedAt: new Date(clock) }).returning())[0].id;
  await db.insert(copyStrategyVersions).values({ strategyId: sid, version: 1, settings, createdByUserId: uid });
  await db.insert(copyLiveStrategyConfigs).values({ strategyId: sid, userId: uid, idempotencyKey: 'fixture-draft-key-0001', sourceNetwork: 'testnet', budgetUsd: '100', strategyVersion: 1 });
  await db.insert(copyExecutionAccounts).values({ id: accountId, userId: uid, strategyId: sid, network: 'testnet', privyUserId: 'did:privy:mandate-owner',
    externalId: 'mandate-master-external', state: 'ready', address, privyWalletId: 'privy-master', ownerQuorumId: 'owner-quorum' });
  const expiresAt = new Date(clock + 86400000);
  await db.insert(copyExecutionWallets).values({ id: 'mandate-execution-wallet', userId: uid, strategyId: sid, network: 'testnet', accountAddress: address,
    privyWalletId: 'privy-agent', privyOwnerId: 'owner-quorum', signerAddress: agentAddress });
  await db.insert(copyWalletAuthorizations).values({ id: 'mandate-grant', walletId: 'mandate-execution-wallet', version: 1, scopes: ['copy:trade', 'copy:reduce'],
    validFrom: new Date(clock - 1000), expiresAt, exchangeApprovedAt: new Date(clock - 100) });
  await db.insert(copyAgentSetups).values({ id: 'mandate-setup', userId: uid, strategyId: sid, accountId, network: 'testnet', idempotencyKey: 'mandate-setup-key-0001',
    validForDays: 1, externalId: 'mandate-agent-external', policyAttemptId: 'mandate-policy-attempt', workerQuorumId: 'worker-quorum',
    policyId: 'restricted-policy', policyFingerprint: 'a'.repeat(64), agentWalletId: 'privy-agent', agentOwnerQuorumId: 'owner-quorum', agentAddress,
    accountAddress: address, accountWalletId: 'privy-master', accountOwnerQuorumId: 'owner-quorum', state: 'active', authorizationId: 'mandate-grant',
    expiresAt, createdAt: new Date(clock - 1000), updatedAt: new Date(clock - 100) });
  service = new CopyLiveMandateService(testConfig(), new CopyLiveMandateRepository(db, testConfig()), new UnitOfWork(db), () => clock);
  scopes = new PostgresLiveRiskScope(pool, () => clock);
});
afterAll(async () => { await pool.end(); await closeTestDb(); });
const challenge = () => service.prepare(uid, accountId, { idempotencyKey: 'mandate-generation-key-0001' });
const strategy = async () => (await db.select().from(copyStrategies).where(eq(copyStrategies.id, sid)))[0];
const stored = async () => (await db.select().from(copyLiveMandates))[0];
async function sign() { const prepared = await challenge(); return { prepared, signature: await owner.signTypedData(liveCopyMandateOwnerTypedData(prepared.intent)) }; }
async function waitWriter(write: () => Promise<unknown>, alter: () => Promise<void> | void) {
  let pending!: Promise<unknown>, done = false, failure: unknown;
  try {
    await scopes.run({ userId: uid, network: 'testnet', accountAddress: address }, async () => {
      pending = write().then(result => { done = true; return result; }, error => { done = true; failure = error; });
      let waiting = false;
      for (let i = 0; i < 100 && !done && !waiting; i++) {
        waiting = (await pool.query<{ waiting: boolean }>('select exists(select 1 from pg_locks where locktype=\'advisory\' and not granted and objsubid=2 and classid=7404 and objid=$1) as waiting', [uid])).rows[0].waiting;
        if (!waiting && !done) await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(done).toBe(false); expect(waiting).toBe(true); await alter();
    });
  } finally { await pending; }
  if (failure) throw failure;
}

describe('dedicated testnet preparation', () => {
  it('creates a fresh paused testnet draft beside paper without allocating paper cash', async () => {
    await db.delete(copyAgentSetups); await db.delete(copyWalletAuthorizations); await db.delete(copyExecutionWallets); await db.delete(copyExecutionAccounts);
    await db.delete(copyLiveStrategyConfigs); await db.delete(copyStrategyVersions); await db.delete(copyStrategies);
    const paper = (await db.insert(copyStrategies).values({ userId: uid, leaderAddress: leader, allocated: '100', cash: '100', activatedAt: new Date() }).returning())[0];
    const created = await service.create(uid, draft());
    expect(created).toMatchObject({ mode: 'actual', network: 'testnet', status: 'paused', pauseNewRisk: true, budgetUsd: '100', settings });
    expect(created.id).not.toBe(paper.id);
    expect((await db.select().from(copyStrategies).where(eq(copyStrategies.id, created.id)))[0]).toMatchObject({ mode: 'testnet', allocated: '0', cash: '0', withdrawn: '0', fees: '0', funding: '0', realizedPnl: '0' });
    expect(await db.select().from(paperAccounts)).toEqual([]);
    expect(await service.create(uid, draft())).toEqual(created);
    await expect(service.create(uid, { ...draft(), budgetUsd: '101' })).rejects.toMatchObject({ status: 409 });
  });
  it.each([{ change: { budgetUsd: '99.999999' }, status: 409 }, { change: { budgetUsd: '100000.000001' }, status: 409 },
    { change: { sourceNetwork: 'devnet' }, status: 400 }, { change: { settings: { ...settings, perTradeUsd: null } }, status: 400 },
    { change: { userJwt: 'must-not-be-accepted' }, status: 400 }])('refuses unsupported/invalid draft authority %j', async ({ change, status }) => {
    await expect(service.create(uid, { ...draft(), leader: `0x${'55'.repeat(20)}`, ...change })).rejects.toMatchObject({ status });
    expect(await db.select().from(paperAccounts)).toEqual([]);
    expect(await db.select().from(copyStrategies)).toHaveLength(1);
  });
  it('a mainnet leader is watched within the site-wide cap: at the cap a new address is refused and nothing is created', async () => {
    const [general] = await db.select().from(appSettings).where(eq(appSettings.key, 'general'));
    const capped = `0x${'66'.repeat(20)}`, under = `0x${'77'.repeat(20)}`;
    await db.insert(leaders).values({ address: `0x${'88'.repeat(20)}`, active: true, source: 'favorite' });
    await db.update(appSettings).set({ value: { ...(general!.value as object), maxWatchedAddresses: 1 } }).where(eq(appSettings.key, 'general'));
    await expect(service.create(uid, { ...draft(), idempotencyKey: 'mainnet-capped-key-0001', leader: capped, sourceNetwork: 'mainnet' }))
      .rejects.toMatchObject({ status: 409, response: { code: 'watch_capacity', limit: 1 } });
    expect(await db.select().from(copyStrategies)).toHaveLength(1);
    expect(await db.select().from(leaders).where(eq(leaders.address, capped))).toEqual([]);
    await db.update(appSettings).set({ value: { ...(general!.value as object), maxWatchedAddresses: 2 } }).where(eq(appSettings.key, 'general'));
    expect(await service.create(uid, { ...draft(), idempotencyKey: 'mainnet-under-key-0001', leader: under, sourceNetwork: 'mainnet' })).toMatchObject({ sourceNetwork: 'mainnet' });
    expect((await db.select().from(leaders).where(eq(leaders.address, under)))[0]).toMatchObject({ active: true, source: 'copy' });
  });
  it('with a builder fee configured, consent preparation needs the account\'s approval of at least that fee', async () => {
    const builder = `0x${'77'.repeat(20)}`, revenue = { ...adminSettingsSchema.shape.revenue.parse({}), builderAddress: builder, builderFeeTenthsBps: 10 };
    await db.update(appSettings).set({ value: revenue }).where(eq(appSettings.key, 'revenue'));
    await expect(challenge()).rejects.toMatchObject({ status: 409, response: { code: 'builder_fee_approval_required' } });
    await db.insert(copyLiveBuilderApprovals).values({ id: '22222222-2222-4222-8222-222222222222', userId: uid, accountId, idempotencyKey: 'builder-approval-0001', network: 'testnet',
      accountAddress: address, builderAddress: builder, maxFeeTenthsBps: 5, nonce: clock, state: 'approved', attemptedAt: new Date(clock), createdAt: new Date(clock), updatedAt: new Date(clock) });
    await expect(challenge()).rejects.toMatchObject({ status: 409, response: { code: 'builder_fee_approval_required' } }); // approved below the fee
    await db.update(copyLiveBuilderApprovals).set({ maxFeeTenthsBps: 10 });
    expect((await challenge()).intent).toMatchObject({ builderAddress: builder, builderMaxFeeTenthsOfBps: 10 });
  });
  it('requires an explicitly stored complete risk policy, not schema default authority', async () => {
    await db.delete(copyRiskPolicies);
    await expect(service.create(uid, { ...draft(), leader: `0x${'55'.repeat(20)}` })).rejects.toMatchObject({ status: 503 });
    await db.insert(copyRiskPolicies).values({ limits: { minAllocationUsd: 100 }, reason: 'incomplete' });
    await expect(challenge()).rejects.toMatchObject({ status: 503 });
  });
  it('disabled deployment advertises preparationfalse and never automatic execution', async () => {
    const old = process.env.COPY_TRADING_MODE; process.env.COPY_TRADING_MODE = 'disabled';
    try {
      expect(liveCopyOverviewSchema.parse(await service.overview(uid)).capabilities).toEqual({ strategyPreparation: false, automaticExecution: false, sourceNetworks: ['mainnet', 'testnet'], actualAllowed: false });
      await expect(service.create(uid, draft())).rejects.toMatchObject({ status: 503 });
      await expect(challenge()).rejects.toMatchObject({ status: 503 });
    } finally { if (old === undefined) delete process.env.COPY_TRADING_MODE; else process.env.COPY_TRADING_MODE = old; }
  });
});

describe('exact local owner consent generations', () => {
  it('returns the same immutable challenge across replay and concurrent replicas', async () => {
    const [first, second] = await Promise.all([challenge(), challenge()]);
    expect(first).toEqual(second); expect(first.intent).toMatchObject({ userId: uid, strategyId: sid, sourceNetwork: 'testnet', budgetUsd: '100', accountRevision: 1,
      ownerPrivyUserId: 'did:privy:mandate-owner', ownerAddress: owner.address.toLowerCase(), setupRevision: 1, authorizationVersion: 1 });
    expect(await db.select().from(copyLiveMandates)).toHaveLength(1);
    const { signature } = await sign();
    const [a, b] = await Promise.all([service.approve(uid, first.mandate.id, { consentSignature: signature }), service.approve(uid, first.mandate.id, { consentSignature: signature })]);
    expect(a).toEqual(b); expect(a.state).toBe('active');
    expect(await strategy()).toMatchObject({ status: 'paused', pauseNewRisk: true, cash: '0' });
    // Approval leaves the generation awaiting its funded start, bound to the current control revision.
    expect(await db.select().from(copyLiveActivations)).toMatchObject([{ mandateId: first.mandate.id, state: 'pending', controlRevision: (await strategy())!.controlRevision, activatedAt: null }]);
    expect((await service.overview(uid)).capabilities.automaticExecution).toBe(false);
    expect(JSON.stringify(await stored())).not.toContain(signature);
  });
  it('rejects foreign, expired, malformed and extra-field approval', async () => {
    const { prepared, signature } = await sign();
    await expect(service.approve(uid, prepared.mandate.id, { consentSignature: await foreign.signTypedData(liveCopyMandateOwnerTypedData(prepared.intent)) })).rejects.toMatchObject({ status: 403 });
    await expect(service.approve(uid, prepared.mandate.id, { consentSignature: '0xbad' })).rejects.toMatchObject({ status: 400 });
    await expect(service.approve(uid, prepared.mandate.id, { consentSignature: signature, budgetUsd: '1000' })).rejects.toMatchObject({ status: 400 });
    clock = prepared.intent.consentExpiresAt;
    await expect(service.approve(uid, prepared.mandate.id, { consentSignature: signature })).rejects.toMatchObject({ status: 409 });
    expect((await stored()).state).toBe('prepared');
  });
  it.each(['ownerDisabled', 'ownerDid', 'ownerAddress', 'masterRevision', 'masterAddress', 'masterState', 'setupRevision', 'setupPolicy', 'grantVersion', 'grantRevoked', 'walletRetired', 'settingsVersion', 'settingsDigest', 'configBudget', 'revenueBuilder'] as const)('refuses %s drift after the challenge', async change => {
    const { prepared, signature } = await sign();
    if (change === 'ownerDisabled') await db.update(users).set({ disabledAt: new Date(clock) }).where(eq(users.id, uid));
    if (change === 'ownerDid') await db.update(users).set({ privyUserId: 'did:privy:successor' }).where(eq(users.id, uid));
    if (change === 'ownerAddress') await db.update(users).set({ embeddedWalletAddress: foreign.address.toLowerCase() }).where(eq(users.id, uid));
    if (change === 'masterRevision') await db.update(copyExecutionAccounts).set({ revision: 2 });
    if (change === 'masterAddress') await db.update(copyExecutionAccounts).set({ address: `0x${'66'.repeat(20)}` });
    if (change === 'masterState') await db.update(copyExecutionAccounts).set({ state: 'unknown', issue: 'verification_pending' });
    if (change === 'setupRevision') await db.update(copyAgentSetups).set({ revision: 2 });
    if (change === 'setupPolicy') await db.update(copyAgentSetups).set({ policyFingerprint: 'b'.repeat(64) });
    if (change === 'grantVersion') await db.update(copyWalletAuthorizations).set({ version: 2 });
    if (change === 'grantRevoked') await db.update(copyWalletAuthorizations).set({ revokedAt: new Date(clock) });
    if (change === 'walletRetired') await db.update(copyExecutionWallets).set({ retiredAt: new Date(clock) });
    if (change === 'settingsVersion') await db.update(copyStrategies).set({ version: 2 });
    if (change === 'settingsDigest') await db.update(copyStrategyVersions).set({ settings: { ...settings, perTradeUsd: 50 } });
    if (change === 'configBudget') await db.update(copyLiveStrategyConfigs).set({ budgetUsd: '101' });
    if (change === 'revenueBuilder') await db.update(appSettings).set({ value: { ...adminSettingsSchema.shape.revenue.parse({}), builderAddress: `0x${'77'.repeat(20)}`, builderFeeTenthsBps: 1 } }).where(eq(appSettings.key, 'revenue'));
    await expect(service.approve(uid, prepared.mandate.id, { consentSignature: signature })).rejects.toMatchObject({ status: change === 'ownerDisabled' ? 404 : 409 });
    expect((await stored()).state).toBe('prepared');
    expect((await stored()).consentDigest).toBeNull();
  });
  it('cross-owner challenge/approval is404 and disabledowner reads are rejected', async () => {
    const other = (await insertUser(db)).id;
    await expect(service.prepare(other, accountId, { idempotencyKey: 'foreign-generation-key-0001' })).rejects.toMatchObject({ status: 404 });
    const { prepared, signature } = await sign();
    await expect(service.approve(other, prepared.mandate.id, { consentSignature: signature })).rejects.toMatchObject({ status: 404 });
    await db.update(users).set({ disabledAt: new Date(clock) }).where(eq(users.id, uid));
    await expect(service.overview(uid)).rejects.toMatchObject({ status: 404 });
  });
  it('checks expiry after waiting for the original user scope and emits no activation', async () => {
    const { prepared, signature } = await sign();
    await expect(waitWriter(() => service.approve(uid, prepared.mandate.id, { consentSignature: signature }), () => { clock = prepared.intent.consentExpiresAt; })).rejects.toMatchObject({ status: 409 });
    expect((await stored()).state).toBe('prepared');
  });
  it('captures the signature body before advisory waits', async () => {
    const { prepared, signature } = await sign(), input = { consentSignature: signature };
    await waitWriter(() => service.approve(uid, prepared.mandate.id, input), () => { input.consentSignature = `0x${'00'.repeat(65)}`; });
    expect((await stored()).state).toBe('active');
  });
  it('pause/revoke are local barriers, preserve unknown journals and never settle or refund', async () => {
    const { prepared, signature } = await sign(); await service.approve(uid, prepared.mandate.id, { consentSignature: signature });
    await db.insert(copyLiveExecutions).values({ key: 'uncertain-original', userId: uid, strategyId: sid, network: 'testnet', accountAddress: address,
      signerAddress: agentAddress, cloid: `0x${'88'.repeat(16)}`, nonce: clock, state: 'unknown', record: { original: 'uncertainty' }, updatedAt: new Date(clock) });
    expect((await service.pause(uid, prepared.mandate.id)).state).toBe('paused');
    await db.update(copyWalletAuthorizations).set({ revokedAt: new Date(clock) });
    expect((await service.revoke(uid, prepared.mandate.id)).state).toBe('revoked');
    expect((await service.revoke(uid, prepared.mandate.id)).state).toBe('revoked');
    expect((await db.select().from(copyLiveExecutions))[0]).toMatchObject({ state: 'unknown', record: { original: 'uncertainty' } });
    expect(await strategy()).toMatchObject({ status: 'paused', pauseNewRisk: true, stoppedAt: null, cash: '0' });
    expect(await db.select().from(paperAccounts)).toEqual([]);
  });
});


describe('complete current local admission evidence', () => {
  it.each(['platformMissing', 'userMissing', 'platformWrong', 'platformDuplicate', 'userWrong', 'strategyRunning', 'strategyUnpaused'] as const)('rejects %s before preparing consent', async change => {
    if (change === 'platformMissing' || change === 'platformWrong') await db.delete(copyControls).where(eq(copyControls.scope, 'platform'));
    if (change === 'userMissing' || change === 'userWrong') await db.delete(copyControls).where(eq(copyControls.scope, 'user'));
    if (change === 'platformWrong' || change === 'platformDuplicate') await db.insert(copyControls).values({ scope: 'platform', scopeId: uid + 1 });
    if (change === 'userWrong') await db.insert(copyControls).values({ scope: 'user', scopeId: uid + 1 });
    if (change === 'strategyRunning') await db.update(copyStrategies).set({ status: 'active' });
    if (change === 'strategyUnpaused') await db.update(copyStrategies).set({ pauseNewRisk: false });
    await expect(challenge()).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(copyLiveMandates)).toEqual([]);
  });
  it('creates explicit own user control for a fresh dedicated draft without inventing platform evidence', async () => {
    await db.delete(copyControls).where(eq(copyControls.scope, 'user'));
    await service.create(uid, { ...draft(), leader: `0x${'55'.repeat(20)}` });
    expect(await db.select().from(copyControls).where(eq(copyControls.scope, 'user'))).toMatchObject([{ scopeId: uid, pauseNewRisk: false, reduceOnly: false, revision: 0 }]);
    await db.delete(copyControls).where(eq(copyControls.scope, 'platform'));
    await expect(service.create(uid, { ...draft(), idempotencyKey: 'another-draft-key-0001', leader: `0x${'66'.repeat(20)}` })).rejects.toMatchObject({ status: 409 });
  });
  it.each(['platform', 'user'] as const)('refuses missing %s control after valid signature', async scope => {
    const { prepared, signature } = await sign();
    await db.delete(copyControls).where(eq(copyControls.scope, scope));
    await expect(service.approve(uid, prepared.mandate.id, { consentSignature: signature })).rejects.toMatchObject({ status: 409 });
    expect((await stored()).state).toBe('prepared');
  });
});


describe('original generation recovery and durable barriers', () => {
  it.each(['intentMirror', 'columnMirror', 'digest'] as const)('refuses internally contradictory %s evidence even with a shape-valid hash', async change => {
    const { prepared, signature } = await sign();
    if (change === 'intentMirror') {
      const { liveCopyMandateIntentSchema } = await import('@trading-dashboard/shared/contracts');
      const intent = liveCopyMandateIntentSchema.parse({ ...prepared.intent, budgetUsd: '120' });
      await db.update(copyLiveMandates).set({ intent, intentDigest: createHash('sha256').update(JSON.stringify(intent)).digest('hex') });
    }
    if (change === 'columnMirror') await db.update(copyLiveMandates).set({ budgetUsd: '120' });
    if (change === 'digest') await db.update(copyLiveMandates).set({ intentDigest: 'f'.repeat(64) });
    await expect(service.approve(uid, prepared.mandate.id, { consentSignature: signature })).rejects.toMatchObject({ status: 409 });
    expect((await stored()).state).toBe('prepared');
  });
  it('accepts JSONB property reordering while retaining the exact canonical generation', async () => {
    const { prepared, signature } = await sign();
    await db.update(copyLiveMandates).set({ intent: Object.fromEntries(Object.entries(prepared.intent).reverse()) });
    expect((await service.approve(uid, prepared.mandate.id, { consentSignature: signature })).state).toBe('active');
  });
  it('archives expired consent and creates a separate generation without rewriting its original intent', async () => {
    const original = await challenge(); clock = original.intent.consentExpiresAt + 1;
    const next = await service.prepare(uid, accountId, { idempotencyKey: 'mandate-generation-key-0002' });
    expect(next.mandate.id).not.toBe(original.mandate.id); expect(next.intent.nonce).toBe(clock);
    const rows = await db.select().from(copyLiveMandates);
    expect(rows.find(row => row.id === original.mandate.id)).toMatchObject({ state: 'expired', intent: original.intent });
    expect(await service.prepare(uid, accountId, { idempotencyKey: 'mandate-generation-key-0002' })).toEqual(next);
    const signature = await owner.signTypedData(liveCopyMandateOwnerTypedData(original.intent));
    await expect(service.approve(uid, original.mandate.id, { consentSignature: signature })).rejects.toMatchObject({ status: 409 });
  });
  it('challenge rechecks grant expiry after the original user lock waits', async () => {
    await expect(waitWriter(() => challenge(), () => { clock += 86400000; })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(copyLiveMandates)).toEqual([]);
  });
  it('local revoke waits for the original risk scope and preserves the original generation', async () => {
    const { prepared, signature } = await sign(); await service.approve(uid, prepared.mandate.id, { consentSignature: signature });
    await waitWriter(() => service.revoke(uid, prepared.mandate.id), () => { clock += 1000; });
    expect(await stored()).toMatchObject({ state: 'revoked', intent: prepared.intent, updatedAt: new Date(clock) });
  });
  it('disabled preparation still permits reads and local risk removal', async () => {
    const { prepared, signature } = await sign(); await service.approve(uid, prepared.mandate.id, { consentSignature: signature });
    const old = process.env.COPY_TRADING_MODE; process.env.COPY_TRADING_MODE = 'disabled';
    try {
      expect((await service.overview(uid)).mandates).toHaveLength(1);
      expect((await service.pause(uid, prepared.mandate.id)).state).toBe('paused');
      expect((await service.revoke(uid, prepared.mandate.id)).state).toBe('revoked');
    } finally { if (old === undefined) delete process.env.COPY_TRADING_MODE; else process.env.COPY_TRADING_MODE = old; }
  });
});


it('rolls back activation if pure response validation completes after consent expiry', async () => {
  const { prepared, signature } = await sign();
  const originalWire = CopyLiveMandateRepository.prototype.wire;
  const spy = vi.spyOn(CopyLiveMandateRepository.prototype, 'wire').mockImplementation(function (this: CopyLiveMandateRepository, row) {
    const result = originalWire.call(this, row);
    if (row.state === 'active') clock = prepared.intent.consentExpiresAt;
    return result;
  });
  try {
    await expect(service.approve(uid, prepared.mandate.id, { consentSignature: signature })).rejects.toMatchObject({ status: 409 });
    expect(await stored()).toMatchObject({ state: 'prepared', activationCursor: null, consentDigest: null });
  } finally { spy.mockRestore(); }
});


describe('server-checked readonly original renewal evidence', () => {
  it.each([
    { state: 'prepared', deadline: 'consentBefore', eligible: false, reason: null },
    { state: 'prepared', deadline: 'consent', eligible: true, reason: 'prepared_consent_expired' },
    { state: 'expired', deadline: 'consent', eligible: true, reason: 'prepared_consent_expired' },
    { state: 'active', deadline: 'consent', eligible: false, reason: null },
    { state: 'paused', deadline: 'consent', eligible: false, reason: null },
    { state: 'active', deadline: 'generation', eligible: true, reason: 'generation_expired' },
    { state: 'revoked', deadline: 'consentBefore', eligible: true, reason: 'revoked' },
    { state: 'stopped', deadline: 'generation', eligible: false, reason: null },
  ] as const)('reports $state/$deadline without changing original persisted authority', async ({ state, deadline, eligible, reason }) => {
    const original = await challenge();
    if (['active', 'paused', 'stopped'].includes(state)) {
      const signature = await owner.signTypedData(liveCopyMandateOwnerTypedData(original.intent));
      await service.approve(uid, original.mandate.id, { consentSignature: signature });
    }
    await db.update(copyLiveMandates).set({ state, revision: 3 });
    clock = deadline === 'generation' ? original.intent.expiresAt : original.intent.consentExpiresAt - (deadline === 'consentBefore' ? 1 : 0);
    const before = await db.select().from(copyLiveMandates);
    for (const read of [() => service.originalChallenge(uid, original.mandate.id), () => service.mandateByKey(uid, 'mandate-generation-key-0001')]) {
      const recovered = await read();
      expect(recovered.intent).toEqual(original.intent);
      expect(Reflect.get(recovered, 'renewal')).toEqual({ checkedAt: new Date(clock).toISOString(), eligible, reason, mandateId: original.mandate.id, revision: 3, nonce: original.intent.nonce });
    }
    expect(await db.select().from(copyLiveMandates)).toEqual(before);
  });
  it('samples expiry after the original owner lock wait and final response validation, denying expired activation', async () => {
    const { prepared, signature } = await sign();
    const before = await stored();
    let recovered: Awaited<ReturnType<typeof service.originalChallenge>> | undefined;
    await waitWriter(async () => { recovered = await service.originalChallenge(uid, prepared.mandate.id); }, () => { clock = prepared.intent.consentExpiresAt; });
    expect(recovered).toBeDefined();
    expect(Reflect.get(recovered!, 'renewal')).toMatchObject({ checkedAt: new Date(clock).toISOString(), eligible: true, reason: 'prepared_consent_expired' });
    await expect(service.approve(uid, prepared.mandate.id, { consentSignature: signature })).rejects.toMatchObject({ status: 409 });
    expect(await stored()).toEqual(before);
  });
  it('uses the completion clock after pure wire validation, without refreshing an old consent', async () => {
    const prepared = await challenge(), originalWire = CopyLiveMandateRepository.prototype.wire;
    clock = prepared.intent.consentExpiresAt - 1;
    const spy = vi.spyOn(CopyLiveMandateRepository.prototype, 'wire').mockImplementation(function (this: CopyLiveMandateRepository, row) {
      const result = originalWire.call(this, row); clock = prepared.intent.consentExpiresAt; return result;
    });
    try {
      expect(Reflect.get(await service.originalChallenge(uid, prepared.mandate.id), 'renewal')).toMatchObject({ checkedAt: new Date(clock).toISOString(), eligible: true, reason: 'prepared_consent_expired' });
      expect((await stored()).state).toBe('prepared');
    } finally { spy.mockRestore(); }
  });
  it('keeps archived reads available with expired/revoked old agents while new preparation remains denied', async () => {
    const prepared = await challenge(); clock = prepared.intent.expiresAt;
    await db.update(copyWalletAuthorizations).set({ revokedAt: new Date(clock) });
    await db.update(copyExecutionWallets).set({ retiredAt: new Date(clock) });
    await db.update(copyAgentSetups).set({ state: 'revoked' });
    const before = await stored();
    expect(Reflect.get(await service.originalChallenge(uid, prepared.mandate.id), 'renewal')).toMatchObject({ eligible: true, reason: 'generation_expired' });
    await expect(service.prepare(uid, accountId, { idempotencyKey: 'renewal-new-key-0001' })).rejects.toMatchObject({ status: 409 });
    expect(await stored()).toEqual(before);
  });
  it.each(['masterAddress', 'ownerAddress'] as const)('rejects current %s rebinding even on archived recovery', async change => {
    const prepared = await challenge();
    if (change === 'masterAddress') await db.update(copyExecutionAccounts).set({ address: `0x${'66'.repeat(20)}` });
    else await db.update(users).set({ embeddedWalletAddress: foreign.address.toLowerCase() }).where(eq(users.id, uid));
    await expect(service.originalChallenge(uid, prepared.mandate.id)).rejects.toMatchObject({ status: 409 });
    await expect(service.mandateByKey(uid, 'mandate-generation-key-0001')).rejects.toMatchObject({ status: 409 });
    expect((await stored()).state).toBe('prepared');
  });
});
