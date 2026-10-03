import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { privateKeyToAccount } from 'viem/accounts';
import { accountModeOwnerConsentTypedData } from '@trading-dashboard/shared/contracts';
import { copyAccountModeOperations, copyExecutionAccounts, copyExecutionWallets, copyStrategies, copyWalletAuthorizations, copySignerNonces, users } from '@trading-dashboard/shared/database';
import { CopyAccountModeRepository } from '../src/copy/copy-account-mode.repository.js';
import { CopyAccountModeService } from '../src/copy/copy-account-mode.service.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { accountModeTypedData, type AccountModeIntent, type AccountModeObservation } from '../src/copy/live/privy-account-mode-client.js';
import type { UserWalletProvisioner } from '../src/copy/live/privy-wallet-provisioner.js';
import type { AccountModeClient, AccountModeAbsenceReader, AccountModeAbsenceProof } from '../src/copy/copy-account-mode.service.js';
import { closeTestDb, getTestDb, insertUser, truncateAll, type TestDb } from './db-test-utils.js';
import { testConfig } from './config-test-utils.js';

const owner = privateKeyToAccount(`0x${'01'.repeat(32)}`), master = privateKeyToAccount(`0x${'02'.repeat(32)}`), foreign = privateKeyToAccount(`0x${'03'.repeat(32)}`);
const address = master.address.toLowerCase(), accountId = 'mode-account', key = 'mode-preparation-key-001';
let db: TestDb, uid: number, stranger: number, strategyId: number, service: CopyAccountModeService;
let repository: CopyAccountModeRepository, provider: UserWalletProvisioner, exchange: AccountModeClient, absence: AccountModeAbsenceReader;
let configured = false, dexNull = false;
const observation = (intent: AccountModeIntent): AccountModeObservation => ({ network: 'testnet', accountAddress: intent.accountAddress,
  role: 'user', abstraction: configured ? 'disabled' : 'default', dexAbstraction: configured && !dexNull ? false : null,
  portfolioMarginEnabled: false, earliestObservedAt: Date.now(), completedAt: Date.now(), source: 'https://api.hyperliquid-testnet.xyz/info',
  sourceDigest: `0x${'11'.repeat(32)}`, status: configured && !dexNull ? 'confirmed' : 'unproven',
  issue: configured && dexNull ? 'account_mode_legacy_state_unproven' : configured ? null : 'account_mode_standard_unproven' });
beforeAll(() => { db = getTestDb(); });
beforeEach(async () => {
  await truncateAll(db); await db.delete(copySignerNonces); configured = false; dexNull = false;
  uid = (await insertUser(db, { privyUserId: 'did:privy:mode-owner', embeddedWalletAddress: owner.address.toLowerCase() })).id;
  stranger = (await insertUser(db)).id;
  strategyId = (await db.insert(copyStrategies).values({ userId: uid, leaderAddress: foreign.address.toLowerCase(), allocated: '100', cash: '100', activatedAt: new Date() }).returning())[0]!.id;
  await db.insert(copyExecutionAccounts).values({ id: accountId, userId: uid, strategyId, network: 'testnet', privyUserId: 'did:privy:mode-owner',
    externalId: 'dedicated-master', state: 'ready', address, privyWalletId: 'master-wallet', ownerQuorumId: 'owner-quorum' });
  provider = { available: true, findOwned: vi.fn(async () => ({ id: 'master-wallet', address, externalId: 'dedicated-master', ownerQuorumId: 'owner-quorum' })), create: vi.fn() };
  exchange = { available: true, acquire: vi.fn(async () => undefined), signMaster: vi.fn(async (_account, intent) => master.signTypedData(accountModeTypedData(intent))),
    send: vi.fn(async () => { configured = true; return { status: 'ok', response: { type: 'default' } }; }), observe: vi.fn(async intent => observation(intent)) };
  absence = { prove: vi.fn(async (user): Promise<AccountModeAbsenceProof> => ({ network: 'testnet', accountAddress: user, observedAt: Date.now(), completedAt: Date.now(),
    dexes: ['', 'xyz'], sourceDigest: '22'.repeat(32), complete: true as const, empty: true as const })) };
  repository = new CopyAccountModeRepository(db);
  service = new CopyAccountModeService(repository, new UnitOfWork(db), testConfig(), provider, exchange, absence);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(closeTestDb);
async function challenge() { const prepared = await service.prepare(uid, accountId, { idempotencyKey: key }); return service.challenge(uid, prepared.id); }
async function approve() { const c = await challenge(); return service.approve(uid, c.operation.id, await owner.signTypedData(accountModeOwnerConsentTypedData(c.intent)), 'fresh-user-jwt'); }

describe('durable owned-master standard-mode operation', () => {
  async function freshActual(status: 'paused' | 'active' = 'paused', pauseNewRisk = true) {
    strategyId = (await db.insert(copyStrategies).values({ userId: uid, leaderAddress: foreign.address.toLowerCase(), mode: 'testnet', status,
      pauseNewRisk, allocated: '0', cash: '0', activatedAt: new Date() }).returning())[0]!.id;
    await db.update(copyExecutionAccounts).set({ strategyId }).where(eq(copyExecutionAccounts.id, accountId));
  }
  it('permits an explicit mode challenge on a fresh dormant paused testnet strategy', async () => {
    await freshActual();
    const c = await challenge();
    expect(c.intent).toMatchObject({ strategyId, network: 'testnet', accountAddress: address });
    expect(exchange.signMaster).not.toHaveBeenCalled(); expect(exchange.send).not.toHaveBeenCalled();
  });
  it('refuses actual strategies that are active or lack the new-risk pause barrier', async () => {
    await freshActual('active'); await expect(challenge()).rejects.toThrow('account_mode_strategy_not_dormant');
    await db.update(copyStrategies).set({ status: 'paused', pauseNewRisk: false }).where(eq(copyStrategies.id, strategyId));
    await expect(challenge()).rejects.toThrow('account_mode_strategy_not_dormant');
    expect(exchange.signMaster).not.toHaveBeenCalled(); expect(exchange.send).not.toHaveBeenCalled();
  });
  it('retains the existing active-agent dormancy refusal on fresh testnet strategies', async () => {
    await freshActual();
    await db.insert(copyExecutionWallets).values({ id: 'actual-agent', userId: uid, strategyId, network: 'testnet', accountAddress: address,
      privyWalletId: 'agent', privyOwnerId: 'worker', signerAddress: foreign.address.toLowerCase() });
    await db.insert(copyWalletAuthorizations).values({ id: 'actual-grant', walletId: 'actual-agent', version: 1, scopes: ['copy:trade', 'copy:reduce'],
      validFrom: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 600000), exchangeApprovedAt: new Date() });
    await expect(challenge()).rejects.toThrow('account_mode_account_not_dormant');
    expect(exchange.signMaster).not.toHaveBeenCalled(); expect(exchange.send).not.toHaveBeenCalled();
  });
  it('reserves one owner-bound operation without signing, sending or provider creation', async () => {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: key });
    expect(prepared).toMatchObject({ accountId, strategyId, accountAddress: address, submissionState: 'prepared', targetState: 'unproven' });
    expect((await service.prepare(uid, accountId, { idempotencyKey: key })).id).toBe(prepared.id);
    expect((await service.byKey(uid, key)).id).toBe(prepared.id);
    expect(await db.select().from(copyAccountModeOperations)).toHaveLength(1);
    expect(exchange.signMaster).not.toHaveBeenCalled(); expect(exchange.send).not.toHaveBeenCalled(); expect(provider.create).not.toHaveBeenCalled();
    expect((await db.select().from(copyStrategies))[0]).toMatchObject({ mode: 'paper', cash: '100' });
  });
  it('enforces owner scoping and idempotency account binding', async () => {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: key });
    await expect(service.reconcile(stranger, prepared.id)).rejects.toThrow(); await expect(service.byKey(stranger, key)).rejects.toThrow();
    await expect(service.prepare(uid, accountId, { idempotencyKey: 'another-preparation-key' })).rejects.toThrow();
    expect(exchange.send).not.toHaveBeenCalled();
  });
  it('shares monotonic principal nonce and persists original intent before owner review', async () => {
    const clock = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(clock); const ahead = clock + 10;
    await db.insert(copySignerNonces).values({ network: 'testnet', signerAddress: address, nonce: ahead });
    const c = await challenge(); const [row] = await db.select().from(copyAccountModeOperations);
    expect(c.intent.nonce).toBe(ahead + 1); expect(row.intent).toEqual(c.intent);
    expect(c.intent.consentExpiresAt - c.intent.nonce).toBe(300000); expect(row.attemptedAt).toBeNull();
  });
  it('rejects a partially missing persisted intent instead of accepting PostgreSQL NULL CHECK semantics', async () => {
    const c = await challenge();
    await expect(db.update(copyAccountModeOperations).set({ nonce: null }).where(eq(copyAccountModeOperations.id, c.operation.id))).rejects.toThrow();
    expect((await db.select().from(copyAccountModeOperations))[0]!.nonce).toBe(c.intent.nonce);
  });
  it('keeps a duplicate replica approval from replacing an in-progress signing claim', async () => {
    const c = await challenge(), consent = await owner.signTypedData(accountModeOwnerConsentTypedData(c.intent));
    let started!: () => void, release!: () => void;
    const held = new Promise<void>(resolve => { started = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
    exchange.signMaster = vi.fn(async (_master, original) => { started(); await released; return master.signTypedData(accountModeTypedData(original)); });
    const first = service.approve(uid, c.operation.id, consent, 'first-jwt').catch(error => error as Error);
    await held;
    const replica = new CopyAccountModeService(new CopyAccountModeRepository(db), new UnitOfWork(db), testConfig(), provider, exchange, absence);
    try { expect((await replica.approve(uid, c.operation.id, consent, 'second-jwt')).submissionState).toBe('signing'); }
    finally { release(); }
    expect(await first).toMatchObject({ submissionState: 'accepted', targetState: 'supported' });
    expect(exchange.signMaster).toHaveBeenCalledTimes(1); expect(exchange.acquire).toHaveBeenCalledTimes(1); expect(exchange.send).toHaveBeenCalledTimes(1);
  });
  it('records unknown and exact immutable intent before the sole financial POST, then observes mode separately', async () => {
    exchange.send = vi.fn(async (intent) => {
      const [row] = await db.select().from(copyAccountModeOperations);
      expect(row.submissionState).toBe('unknown'); expect(row.attemptedAt).not.toBeNull(); expect(row.intent).toEqual(intent);
      expect(row.intentDigest).toMatch(/^[0-9a-f]{64}$/); expect(row.attemptProof).toBeTruthy(); configured = true;
      return { status: 'ok', response: { type: 'default' } };
    });
    const result = await approve(); expect(result).toMatchObject({ submissionState: 'accepted', targetState: 'supported' });
    expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0); expect(provider.create).not.toHaveBeenCalled();
  });
  it('keeps lost response unknown across restart, new keys and repeated approval without re-signing or resending', async () => {
    exchange.send = vi.fn(async () => { throw new Error('private provider timeout'); });
    const c = await challenge(), consent = await owner.signTypedData(accountModeOwnerConsentTypedData(c.intent));
    expect((await service.approve(uid, c.operation.id, consent, 'jwt')).submissionState).toBe('unknown');
    const restarted = new CopyAccountModeService(new CopyAccountModeRepository(db), new UnitOfWork(db), testConfig(), provider, exchange, absence);
    expect((await restarted.approve(uid, c.operation.id, consent, 'new-jwt')).submissionState).toBe('unknown');
    await expect(restarted.prepare(uid, accountId, { idempotencyKey: 'new-key-after-unknown' })).rejects.toThrow();
    configured = true;
    expect(await restarted.reconcile(uid, c.operation.id)).toMatchObject({ submissionState: 'unknown', targetState: 'supported' });
    expect(exchange.signMaster).toHaveBeenCalledTimes(1); expect(exchange.send).toHaveBeenCalledTimes(1);
  });
  it('does not equate acknowledgment with disabled/null standard proof', async () => {
    dexNull = true; expect(await approve()).toMatchObject({ submissionState: 'accepted', targetState: 'unproven', issue: 'account_mode_legacy_state_unproven' });
    expect(exchange.send).toHaveBeenCalledTimes(1);
  });
  it('observes an already supported account without any mode mutation', async () => {
    configured = true; const p = await service.prepare(uid, accountId, { idempotencyKey: key });
    expect(p.targetState).toBe('supported'); await expect(service.challenge(uid, p.id)).rejects.toThrow();
    expect(exchange.signMaster).not.toHaveBeenCalled(); expect(exchange.send).not.toHaveBeenCalled();
  });
  it.each(['unifiedAccount', 'portfolioMargin', 'disabled-null', 'dex-true', 'missing-role'])('never prepares a signature for unsupported baseline %s', async baseline => {
    exchange.observe = vi.fn(async (intent): Promise<AccountModeObservation> => ({ ...observation(intent), abstraction: baseline === 'disabled-null' || baseline === 'dex-true' ? 'disabled' : baseline === 'missing-role' ? 'default' : baseline as 'unifiedAccount' | 'portfolioMargin',
      dexAbstraction: baseline === 'dex-true' ? true : null, role: baseline === 'missing-role' ? 'missing' : 'user', status: 'unproven' }));
    const p = await service.prepare(uid, accountId, { idempotencyKey: key }); await expect(service.challenge(uid, p.id)).rejects.toThrow();
    expect(exchange.signMaster).not.toHaveBeenCalled(); expect(exchange.send).not.toHaveBeenCalled();
  });
  it('refuses first mode send when complete all-venue absence is unproven', async () => {
    const p = await service.prepare(uid, accountId, { idempotencyKey: key }); absence.prove = vi.fn(async () => { throw new Error('positions or unobserved orders'); });
    await expect(service.challenge(uid, p.id)).rejects.toThrow(); expect(exchange.signMaster).not.toHaveBeenCalled();
  });
  it('refuses an active local live authorization or historic live execution account', async () => {
    const p = await service.prepare(uid, accountId, { idempotencyKey: key });
    await db.insert(copyExecutionWallets).values({ id: 'live-wallet', userId: uid, strategyId, network: 'testnet', accountAddress: address,
      privyWalletId: 'agent', privyOwnerId: 'quorum', signerAddress: foreign.address.toLowerCase() });
    await db.insert(copyWalletAuthorizations).values({ id: 'grant', walletId: 'live-wallet', version: 1, scopes: ['copy:trade'], validFrom: new Date(), expiresAt: new Date(Date.now() + 60000), exchangeApprovedAt: new Date() });
    await expect(service.challenge(uid, p.id)).rejects.toThrow(); expect(exchange.signMaster).not.toHaveBeenCalled();
  });
  it('verifies exact embedded-owner consent before master signing', async () => {
    const c = await challenge();
    await expect(service.approve(uid, c.operation.id, await foreign.signTypedData(accountModeOwnerConsentTypedData(c.intent)), 'jwt')).rejects.toThrow();
    expect(exchange.signMaster).not.toHaveBeenCalled(); expect(exchange.send).not.toHaveBeenCalled();
  });
  it('carries identity and mode checks through signing/budget waits', async () => {
    const c = await challenge(); exchange.acquire = vi.fn(async () => { await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, uid)); });
    await expect(service.approve(uid, c.operation.id, await owner.signTypedData(accountModeOwnerConsentTypedData(c.intent)), 'jwt')).rejects.toThrow();
    expect(exchange.send).not.toHaveBeenCalled(); expect((await db.select().from(copyAccountModeOperations))[0]!.attemptedAt).toBeNull();
  });
  it('supplies a synchronous source/consent fence which rejects delayed principal signing', async () => {
    const c = await challenge(); let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
    exchange.signMaster = vi.fn(async (_account, original, _jwt, assertFreshProof) => {
      expect(assertFreshProof).toBeTypeOf('function'); clock += 5001; assertFreshProof!();
      return master.signTypedData(accountModeTypedData(original));
    });
    await expect(service.approve(uid, c.operation.id, await owner.signTypedData(accountModeOwnerConsentTypedData(c.intent)), 'jwt')).rejects.toThrow('account_mode_evidence_expired');
    expect(exchange.acquire).not.toHaveBeenCalled(); expect(exchange.send).not.toHaveBeenCalled();
    expect((await db.select().from(copyAccountModeOperations))[0]!.attemptedAt).toBeNull();
  });
  it('bounds the oldest preflight source at completion when mode validation consumes the last milliseconds', async () => {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: key });
    const base = Date.now(); let clock = base, modeReads = 0; vi.spyOn(Date, 'now').mockImplementation(() => clock);
    exchange.observe = vi.fn(async original => { if (++modeReads === 2) clock += 100; return observation(original); });
    const inspected = service as unknown as { preflight(userId: number, row: Awaited<ReturnType<CopyAccountModeRepository['find']>>): Promise<{ assertFresh(): void }> };
    const proof = await inspected.preflight(uid, await repository.find(uid, prepared.id));
    let checks = 0; vi.mocked(Date.now).mockImplementation(() => base + (++checks <= 3 ? 4999 : 5001));
    expect(() => proof.assertFresh()).toThrow('account_mode_evidence_expired');
    expect(exchange.signMaster).not.toHaveBeenCalled(); expect(exchange.send).not.toHaveBeenCalled();
  });
  it('preserves attempted uncertainty when exchange preparation ages the supplied final proof', async () => {
    const c = await challenge(), consent = await owner.signTypedData(accountModeOwnerConsentTypedData(c.intent));
    let clock = Date.now(), posts = 0; vi.spyOn(Date, 'now').mockImplementation(() => clock);
    exchange.send = vi.fn(async (_intent, _signature, assertFreshProof) => {
      clock += 5001; assertFreshProof(); posts++; return { status: 'ok', response: { type: 'default' } };
    });
    const result = await service.approve(uid, c.operation.id, consent, 'jwt');
    expect(vi.mocked(exchange.send).mock.calls[0]![2]).toBeTypeOf('function');
    expect(result.submissionState).toBe('unknown'); expect(result.attemptedAt).not.toBeNull(); expect(posts).toBe(0);
    expect(exchange.acquire).toHaveBeenCalledTimes(1); expect(exchange.signMaster).toHaveBeenCalledTimes(1);
    await service.approve(uid, c.operation.id, consent, 'retry-jwt');
    expect(exchange.send).toHaveBeenCalledTimes(1); expect(exchange.signMaster).toHaveBeenCalledTimes(1);
  });
  it('checks consent at the same completion clock as oldest proof after all exchange guard validation', async () => {
    const c = await challenge(), consent = await owner.signTypedData(accountModeOwnerConsentTypedData(c.intent));
    vi.spyOn(Date, 'now').mockReturnValue(c.intent.consentExpiresAt - 1); let posts = 0;
    exchange.send = vi.fn(async (_intent, _signature, assertFreshProof) => {
      const inspected = service as unknown as { assertObservation(row: Awaited<ReturnType<CopyAccountModeRepository['find']>>, proof: AccountModeObservation): void };
      const validate = inspected.assertObservation.bind(service);
      vi.spyOn(inspected, 'assertObservation').mockImplementation((row, proof) => { validate(row, proof); vi.mocked(Date.now).mockReturnValue(c.intent.consentExpiresAt); });
      assertFreshProof(); posts++; return { status: 'ok', response: { type: 'default' } };
    });
    const result = await service.approve(uid, c.operation.id, consent, 'jwt');
    expect(posts).toBe(0); expect(result.submissionState).toBe('unknown'); expect(result.attemptedAt).not.toBeNull();
    expect(exchange.send).toHaveBeenCalledTimes(1); expect(exchange.acquire).toHaveBeenCalledTimes(1);
  });
  it('refuses a master provider identity changed before signing', async () => {
    const c = await challenge(); provider.findOwned = vi.fn(async () => ({ id: 'other-wallet', address, externalId: 'dedicated-master', ownerQuorumId: 'owner-quorum' }));
    await expect(service.approve(uid, c.operation.id, await owner.signTypedData(accountModeOwnerConsentTypedData(c.intent)), 'jwt')).rejects.toThrow();
    expect(exchange.signMaster).not.toHaveBeenCalled(); expect(exchange.send).not.toHaveBeenCalled();
  });
  it('rejects wrong recovered principal signature before reserving submit budget', async () => {
    const c = await challenge(); exchange.signMaster = vi.fn(async (_account, intent) => foreign.signTypedData(accountModeTypedData(intent)));
    await expect(service.approve(uid, c.operation.id, await owner.signTypedData(accountModeOwnerConsentTypedData(c.intent)), 'jwt')).rejects.toThrow();
    expect(exchange.acquire).not.toHaveBeenCalled(); expect(exchange.send).not.toHaveBeenCalled();
  });
  it('allows read-only recovery with copying disabled but prohibits new mutations', async () => {
    exchange.send = vi.fn(async () => { throw new Error('lost'); }); const result = await approve(); configured = true;
    vi.stubEnv('COPY_TRADING_MODE', 'disabled'); expect((await service.reconcile(uid, result.id)).targetState).toBe('supported');
    await expect(service.challenge(uid, result.id)).rejects.toThrow(); expect(exchange.send).toHaveBeenCalledTimes(1);
  });
  it('retains interrupted signing and original nonce until an explicit safe recovery', async () => {
    const c = await challenge();
    await db.update(copyAccountModeOperations).set({ submissionState: 'signing', signingStartedAt: new Date(), claimToken: 'claim', consentDigest: '33'.repeat(32) }).where(eq(copyAccountModeOperations.id, c.operation.id));
    const result = await service.reconcile(uid, c.operation.id); expect(result.submissionState).toBe('signing');
    expect((await db.select().from(copyAccountModeOperations))[0]!.nonce).toBe(c.intent.nonce); expect(exchange.signMaster).not.toHaveBeenCalled(); expect(exchange.send).not.toHaveBeenCalled();
  });
  it('rolls back attempt if a SQL lock wait ages the earliest all-venue proof', async () => {
    const c = await challenge(); let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let release!: () => void, acquired!: () => void;
    const held = new Promise<void>(resolve => { acquired = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => { await tx.select().from(copyStrategies).where(eq(copyStrategies.id, strategyId)).for('update'); acquired(); await released; });
    // First signing claim must carry its source evidence through this lock wait.
    await held;
    const pending = service.approve(uid, c.operation.id, await owner.signTypedData(accountModeOwnerConsentTypedData(c.intent)), 'jwt').catch(error => error as Error);
    try {
      let waiting = false;
      for (let i = 0; i < 200; i++) { const status = await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%copy_strategies%') as waiting`);
        if (status.rows[0]?.waiting) { waiting = true; break; } await new Promise(resolve => setTimeout(resolve, 10)); }
      expect(waiting).toBe(true); clock += 5001;
    } finally { release(); await blocker; }
    await pending; expect(exchange.send).not.toHaveBeenCalled(); expect((await db.select().from(copyAccountModeOperations))[0]!.attemptedAt).toBeNull();
  });
});
