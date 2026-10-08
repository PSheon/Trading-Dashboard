import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { privateKeyToAccount } from 'viem/accounts';
import { adminSettingsSchema, DEFAULT_COPY_RISK_LIMITS, liveCopyOverviewSchema, type CreateLiveCopyStrategy } from '@trading-dashboard/shared/contracts';
import { appSettings, copyLiveActivations, copyLiveBuilderApprovals, leaders, copyControls, copyAgentSetups, copyExecutionAccounts, copyExecutionWallets, copyLiveExecutions, copyLiveMandates, copyLiveSetups,
  copyLiveStrategyConfigs, copyRiskPolicies, copyStrategies, copyStrategyVersions, copyWalletAuthorizations, paperAccounts, users } from '@trading-dashboard/shared/database';
import { CopyLiveMandateRepository, type MandateRow } from '../src/copy/copy-live-mandate.repository.js';
import { CopyLiveMandateService } from '../src/copy/copy-live-mandate.service.js';
import { PostgresLiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';
import { UnitOfWork, type DbTransaction } from '../src/db/unit-of-work.js';
import { testConfig } from './config-test-utils.js';
import { getTestDb, closeTestDb, insertUser, truncateAll, openCopyTrading, type TestDb } from './db-test-utils.js';

const owner = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const accountId = 'mandate-master', address = `0x${'22'.repeat(20)}`, agentAddress = `0x${'33'.repeat(20)}`, leader = `0x${'44'.repeat(20)}`;
const settings = { direction: 'same' as const, sizingMode: 'fixed' as const, perTradeUsd: 100, maxTotalExposureUsd: null, maxLeverage: 5, copyStartMode: 'delta' as const };
const draft = () => ({ idempotencyKey: 'dedicated-draft-key-0001', leader, sourceNetwork: 'testnet' as const, budgetUsd: '100', settings: { ...settings } });
let db: TestDb, pool: Pool, repository: CopyLiveMandateRepository, service: CopyLiveMandateService, scopes: PostgresLiveRiskScope, uid: number, sid: number, clock: number;
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
  repository = new CopyLiveMandateRepository(db, testConfig());
  service = new CopyLiveMandateService(testConfig(), repository, new UnitOfWork(db), () => clock);
  scopes = new PostgresLiveRiskScope(pool, () => clock);
});
afterAll(async () => { await pool.end(); await closeTestDb(); });
const run = <T>(work: (tx: DbTransaction) => Promise<T>) => new UnitOfWork(db).run(work);
/** A generation as `prepareFromSetup` prepares it: the server fills the intent
 * from the current verified binding (no owner signature exists any more). */
const challenge = (key = 'mandate-generation-key-0001', repo = repository) => run(tx => repo.prepare(tx, uid, accountId, key, () => clock));
const create = (input: CreateLiveCopyStrategy, repo = repository) => run(tx => repo.create(tx, uid, input, () => clock));
const setupId = '00000000-0000-4000-8000-0000000000b1';
/** Activates a prepared generation under a one-click setup's consent, the
 * only way a generation becomes active. */
async function activate(row: MandateRow, repo = repository) {
  await db.insert(copyLiveSetups).values({ id: setupId, userId: uid, strategyId: sid, kind: 'start', idempotencyKey: 'mandate-live-setup-key-0001', leaderAddress: leader, sourceNetwork: row.sourceNetwork, budgetUsd: '100', settings }).onConflictDoNothing();
  return run(tx => repo.activate(tx, row, { liveSetupId: setupId, consentDigest: 'c'.repeat(64) }, clock));
}
const strategy = async () => (await db.select().from(copyStrategies).where(eq(copyStrategies.id, sid)))[0];
const stored = async () => (await db.select().from(copyLiveMandates))[0];
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
    const created = await create(draft());
    expect(created).toMatchObject({ mode: 'actual', network: 'testnet', status: 'paused', pauseNewRisk: true, budgetUsd: '100', settings });
    expect(created.id).not.toBe(paper.id);
    expect((await db.select().from(copyStrategies).where(eq(copyStrategies.id, created.id)))[0]).toMatchObject({ mode: 'testnet', allocated: '0', cash: '0', withdrawn: '0', fees: '0', funding: '0', realizedPnl: '0' });
    expect(await db.select().from(paperAccounts)).toEqual([]);
    expect(await create(draft())).toEqual(created);
    await expect(create({ ...draft(), budgetUsd: '101' })).rejects.toMatchObject({ status: 409 });
  });
  it.each([{ budgetUsd: '99.999999' }, { budgetUsd: '100000.000001' }])('refuses a budget outside the policy %j', async change => {
    await expect(create({ ...draft(), leader: `0x${'55'.repeat(20)}`, ...change })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(paperAccounts)).toEqual([]);
    expect(await db.select().from(copyStrategies)).toHaveLength(1);
  });
  it('names each refusal of a new copy so the UI can say why (one-click plan §3e)', async () => {
    const fresh = { ...draft(), idempotencyKey: 'route-fresh-draft-key-0001', leader: `0x${'55'.repeat(20)}` };
    const code = (input: CreateLiveCopyStrategy) => create(input).then(() => { throw new Error('created'); }, (error: { response?: unknown }) => error.response);
    expect(await code({ ...fresh, budgetUsd: '99' })).toMatchObject({ code: 'below_min_allocation' });
    expect(await code({ ...fresh, budgetUsd: '100001' })).toMatchObject({ code: 'above_max_allocation' });
    expect(await code({ ...fresh, leader, idempotencyKey: 'route-same-leader-0001' })).toMatchObject({ code: 'already_copying' });
    expect(await code({ ...fresh, settings: { ...settings, maxLeverage: 20 } })).toMatchObject({ code: 'leverage_above_limit' });
    await db.update(copyControls).set({ pauseNewRisk: true }).where(eq(copyControls.scope, 'platform'));
    expect(await code(fresh)).toMatchObject({ code: 'copy_paused' });
    await db.update(copyControls).set({ pauseNewRisk: false });
    await db.update(copyRiskPolicies).set({ limits: { ...DEFAULT_COPY_RISK_LIMITS, maxStrategiesPerUser: 1 } });
    expect(await code(fresh)).toMatchObject({ code: 'strategy_limit' });
    await db.update(appSettings).set({ value: { copyTradingEnabled: false } }).where(eq(appSettings.key, 'general'));
    expect(await code(fresh)).toMatchObject({ code: 'copy_not_open' });
  });
  it('a mainnet leader is watched within the site-wide cap: at the cap a new address is refused and nothing is created', async () => {
    const [general] = await db.select().from(appSettings).where(eq(appSettings.key, 'general'));
    const capped = `0x${'66'.repeat(20)}`, under = `0x${'77'.repeat(20)}`;
    await db.insert(leaders).values({ address: `0x${'88'.repeat(20)}`, active: true, source: 'favorite' });
    await db.update(appSettings).set({ value: { ...(general!.value as object), maxWatchedAddresses: 1 } }).where(eq(appSettings.key, 'general'));
    await expect(create({ ...draft(), idempotencyKey: 'mainnet-capped-key-0001', leader: capped, sourceNetwork: 'mainnet' }))
      .rejects.toMatchObject({ status: 409, response: { code: 'watch_capacity', limit: 1 } });
    expect(await db.select().from(copyStrategies)).toHaveLength(1);
    expect(await db.select().from(leaders).where(eq(leaders.address, capped))).toEqual([]);
    await db.update(appSettings).set({ value: { ...(general!.value as object), maxWatchedAddresses: 2 } }).where(eq(appSettings.key, 'general'));
    expect(await create({ ...draft(), idempotencyKey: 'mainnet-under-key-0001', leader: under, sourceNetwork: 'mainnet' })).toMatchObject({ sourceNetwork: 'mainnet' });
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
    expect(repository.decode(await challenge())).toMatchObject({ builderAddress: builder, builderMaxFeeTenthsOfBps: 10 });
  });
  it('reads a revenue section missing a key with its default (no builder, fee 0), as the orders\' check does', async () => {
    await db.update(appSettings).set({ value: { builderFeeTenthsBps: 0 } }).where(eq(appSettings.key, 'revenue'));
    expect(repository.decode(await challenge())).toMatchObject({ builderAddress: null, builderMaxFeeTenthsOfBps: 0 });
  });
  it('requires an explicitly stored complete risk policy, not schema default authority', async () => {
    await db.delete(copyRiskPolicies);
    await expect(create({ ...draft(), leader: `0x${'55'.repeat(20)}` })).rejects.toMatchObject({ status: 503 });
    await db.insert(copyRiskPolicies).values({ limits: { minAllocationUsd: 100 }, reason: 'incomplete' });
    await expect(challenge()).rejects.toMatchObject({ status: 503 });
  });
  it('disabled deployment advertises preparationfalse and never automatic execution', async () => {
    const old = process.env.COPY_TRADING_MODE; process.env.COPY_TRADING_MODE = 'disabled';
    try {
      expect(liveCopyOverviewSchema.parse(await service.overview(uid)).capabilities).toEqual({ strategyPreparation: false, automaticExecution: false, setupAbort: false, sourceNetworks: ['mainnet', 'testnet'], actualAllowed: false });
    } finally { if (old === undefined) delete process.env.COPY_TRADING_MODE; else process.env.COPY_TRADING_MODE = old; }
  });
});

describe('server-filled consent generations', () => {
  it('returns the same immutable generation across replay and concurrent replicas, and activates it awaiting its funded start', async () => {
    const [first, second] = await Promise.all([challenge(), challenge()]);
    expect(first).toEqual(second); expect(repository.decode(first)).toMatchObject({ userId: uid, strategyId: sid, sourceNetwork: 'testnet', budgetUsd: '100', accountRevision: 1,
      ownerPrivyUserId: 'did:privy:mandate-owner', ownerAddress: owner.address.toLowerCase(), setupRevision: 1, authorizationVersion: 1 });
    expect(await db.select().from(copyLiveMandates)).toHaveLength(1);
    const active = await activate(first);
    expect(active).toMatchObject({ state: 'active', consentKind: 'setup', liveSetupId: setupId, consentDigest: 'c'.repeat(64) });
    expect(await activate(active)).toEqual(active);
    expect(await strategy()).toMatchObject({ status: 'paused', pauseNewRisk: true, cash: '0' });
    // Activation leaves the generation awaiting its funded start, bound to the current control revision.
    expect(await db.select().from(copyLiveActivations)).toMatchObject([{ mandateId: first.id, state: 'pending', controlRevision: (await strategy())!.controlRevision, activatedAt: null }]);
    expect((await service.overview(uid)).capabilities.automaticExecution).toBe(false);
  });
  it('cross-owner preparation is404 and disabled owner reads are rejected', async () => {
    const other = (await insertUser(db)).id;
    await expect(run(tx => repository.prepare(tx, other, accountId, 'foreign-generation-key-0001', () => clock))).rejects.toMatchObject({ status: 404 });
    await db.update(users).set({ disabledAt: new Date(clock) }).where(eq(users.id, uid));
    await expect(service.overview(uid)).rejects.toMatchObject({ status: 404 });
  });
  it('pause/revoke are local barriers, preserve unknown journals and never settle or refund', async () => {
    const prepared = await activate(await challenge());
    await db.insert(copyLiveExecutions).values({ key: 'uncertain-original', userId: uid, strategyId: sid, network: 'testnet', accountAddress: address,
      signerAddress: agentAddress, cloid: `0x${'88'.repeat(16)}`, nonce: clock, state: 'unknown', record: { original: 'uncertainty' }, updatedAt: new Date(clock) });
    expect((await service.pause(uid, prepared.id)).state).toBe('paused');
    await db.update(copyWalletAuthorizations).set({ revokedAt: new Date(clock) });
    expect((await service.revoke(uid, prepared.id)).state).toBe('revoked');
    expect((await service.revoke(uid, prepared.id)).state).toBe('revoked');
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
    await create({ ...draft(), leader: `0x${'55'.repeat(20)}` });
    expect(await db.select().from(copyControls).where(eq(copyControls.scope, 'user'))).toMatchObject([{ scopeId: uid, pauseNewRisk: false, reduceOnly: false, revision: 0 }]);
    await db.delete(copyControls).where(eq(copyControls.scope, 'platform'));
    await expect(create({ ...draft(), idempotencyKey: 'another-draft-key-0001', leader: `0x${'66'.repeat(20)}` })).rejects.toMatchObject({ status: 409 });
  });
});


describe('original generation evidence and durable barriers', () => {
  it.each(['intentMirror', 'columnMirror', 'digest'] as const)('refuses internally contradictory %s evidence even with a shape-valid hash', async change => {
    const prepared = await challenge(), intent = repository.decode(prepared);
    if (change === 'intentMirror') {
      const { liveCopyMandateIntentSchema } = await import('@trading-dashboard/shared/contracts');
      const changed = liveCopyMandateIntentSchema.parse({ ...intent, budgetUsd: '120' });
      await db.update(copyLiveMandates).set({ intent: changed, intentDigest: createHash('sha256').update(JSON.stringify(changed)).digest('hex') });
    }
    if (change === 'columnMirror') await db.update(copyLiveMandates).set({ budgetUsd: '120' });
    if (change === 'digest') await db.update(copyLiveMandates).set({ intentDigest: 'f'.repeat(64) });
    await expect(service.revoke(uid, prepared.id)).rejects.toMatchObject({ status: 409 });
    await expect(service.overview(uid)).rejects.toMatchObject({ status: 409 });
    expect((await stored()).state).toBe('prepared');
  });
  it('accepts JSONB property reordering while retaining the exact canonical generation', async () => {
    const prepared = await challenge();
    await db.update(copyLiveMandates).set({ intent: Object.fromEntries(Object.entries(repository.decode(prepared)).reverse()) });
    expect((await activate(await repository.find(uid, prepared.id))).state).toBe('active');
  });
  it('archives expired consent and creates a separate generation without rewriting its original intent', async () => {
    const original = await challenge(), intent = repository.decode(original); clock = intent.consentExpiresAt + 1;
    const next = await challenge('mandate-generation-key-0002');
    expect(next.id).not.toBe(original.id); expect(next.nonce).toBe(clock);
    const rows = await db.select().from(copyLiveMandates);
    expect(rows.find(row => row.id === original.id)).toMatchObject({ state: 'expired', intent });
    expect(await challenge('mandate-generation-key-0002')).toEqual(next);
    await expect(activate(rows.find(row => row.id === original.id)!)).rejects.toMatchObject({ status: 409 });
  });
  it('preparation rechecks grant expiry after the original user lock waits', async () => {
    await expect(waitWriter(() => challenge(), () => { clock += 86400000; })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(copyLiveMandates)).toEqual([]);
  });
  it('local revoke waits for the original risk scope and preserves the original generation', async () => {
    const prepared = await activate(await challenge());
    await waitWriter(() => service.revoke(uid, prepared.id), () => { clock += 1000; });
    expect(await stored()).toMatchObject({ state: 'revoked', intent: prepared.intent, updatedAt: new Date(clock) });
  });
  it('disabled preparation still permits reads and local risk removal', async () => {
    const prepared = await activate(await challenge());
    const old = process.env.COPY_TRADING_MODE; process.env.COPY_TRADING_MODE = 'disabled';
    try {
      expect((await service.overview(uid)).mandates).toHaveLength(1);
      expect((await service.pause(uid, prepared.id)).state).toBe('paused');
      expect((await service.revoke(uid, prepared.id)).state).toBe('revoked');
    } finally { if (old === undefined) delete process.env.COPY_TRADING_MODE; else process.env.COPY_TRADING_MODE = old; }
  });
});

describe('the deployment allowlist on every mandate path (security review)', () => {
  /** A mainnet deployment whose COPY_LIVE_ALLOWED_PRIVY_USER_IDS does or doesn't list the fixture owner. */
  const mainnet = (allowed: boolean) => {
    const base = testConfig();
    return { get value() { const v = base.value; return { ...v, hyperliquid: { ...v.hyperliquid, wallet: { ...v.hyperliquid.wallet, network: 'mainnet' } },
      copy: { ...v.copy, mode: 'live', live: { network: 'mainnet', caps: { maxStrategiesPerUser: 10 }, builderFee: false, testnetSourceIntervalMs: 60_000,
        allowedPrivyUserIds: new Set([allowed ? 'did:privy:mandate-owner' : 'did:privy:paul-only']), maxSourceDeviationBps: 500, slippageBps: 30, intervalMs: 3000, weightPerMin: 300 } } }; } } as never;
  };
  const services = (allowed: boolean) => { const repository = new CopyLiveMandateRepository(db, mainnet(allowed)); return { repository, service: new CopyLiveMandateService(mainnet(allowed), repository, new UnitOfWork(db), () => clock) }; };
  const notAllowed = { response: expect.objectContaining({ code: 'live_not_allowed' }) };
  beforeEach(async () => {
    // The fixture's copy, moved to mainnet with the deployment.
    for (const table of [copyExecutionAccounts, copyExecutionWallets, copyAgentSetups, copyStrategies]) await db.update(table).set({ network: 'mainnet' } as never);
    await db.update(copyLiveStrategyConfigs).set({ sourceNetwork: 'mainnet' });
  });

  it('a non-listed owner gets no mandate created, prepared, activated or resumed on a mainnet deployment, by any path', async () => {
    const listed = services(true), unlisted = services(false);
    await expect(create({ ...draft(), sourceNetwork: 'mainnet', idempotencyKey: 'unlisted-draft-key-0001' }, unlisted.repository)).rejects.toMatchObject(notAllowed);
    await expect(challenge('mandate-generation-key-0001', unlisted.repository)).rejects.toMatchObject(notAllowed);
    // Prepared while listed, then the owner left the list: no activation by a setup's consent …
    const prepared = await challenge('mandate-generation-key-0001', listed.repository);
    expect(prepared.network).toBe('mainnet');
    await expect(new UnitOfWork(db).run(tx => unlisted.repository.prepareFromSetup(tx, uid, { id: '00000000-0000-4000-8000-000000000009', kind: 'start', consentDigest: 'a'.repeat(64),
      intent: { setupId: '00000000-0000-4000-8000-000000000009', userId: uid, network: 'mainnet', ownerPrivyUserId: 'did:privy:mandate-owner' } as never, settings }, () => clock))).rejects.toMatchObject(notAllowed);
    // … nor straight through the repository.
    await expect(activate(prepared, unlisted.repository)).rejects.toMatchObject(notAllowed);
    expect((await stored())!.state).toBe('prepared');
    // Activated and paused while listed: no resume once unlisted.
    expect((await activate(prepared, listed.repository)).state).toBe('active');
    expect((await listed.service.pause(uid, prepared.id)).state).toBe('paused');
    await expect(unlisted.service.resume(uid, prepared.id)).rejects.toMatchObject(notAllowed);
    expect((await stored())!.state).toBe('paused');
    // Pausing and revoking (risk only goes down) stay open to the owner.
    expect((await unlisted.service.revoke(uid, prepared.id)).state).toBe('revoked');
  });
});
