import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DEFAULT_COPY_RISK_LIMITS } from '@trading-dashboard/shared/contracts';
import { copyAgentSetups, copyExecutionAccounts, copyExecutionWallets, copyFollowerAccountState,
  copyPositions, copyStrategies, copyStrategyVersions, copyWalletAuthorizations, users } from '@trading-dashboard/shared/database';
import { PostgresLiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';
import { CopyRepository } from '../src/copy/copy.repository.js';
import { CopyStrategyService } from '../src/copy/copy-strategy.service.js';
import { CopyExecutionService } from '../src/copy/copy-execution.service.js';
import { AssetMap } from '../src/copy/copy-market.service.js';
import { CopyAgentRepository } from '../src/copy/copy-agent.repository.js';
import { CopyWalletRepository } from '../src/copy/copy-wallet.repository.js';
import { CopyWalletService } from '../src/copy/copy-wallet.service.js';
import { CopyFollowerLedger } from '../src/copy/live/copy-follower-ledger.js';
import { AdminUsersRepository } from '../src/admin/admin-users.repository.js';
import { AdminUsersService } from '../src/admin/admin-users.service.js';
import { AccountRepository } from '../src/users/account.repository.js';
import { AccountDeletionService } from '../src/users/account-deletion.service.js';
import { AuthRepository } from '../src/common/auth/auth.repository.js';
import { WalletRepository } from '../src/wallet/wallet.repository.js';
import { SettingsRepository } from '../src/settings/settings.repository.js';
import { SettingsService } from '../src/settings/settings.service.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { Dec } from '../src/common/decimal/dec.js';
import { testConfig } from './config-test-utils.js';
import { closeTestDb, getTestDb, insertUser, truncateAll, type TestDb } from './db-test-utils.js';

let db: TestDb, pool: Pool, scopes: PostgresLiveRiskScope, uid: number, strategyId: number;
const address = `0x${'11'.repeat(20)}`, ownerAddress = `0x${'22'.repeat(20)}`;
const accountId = 'writer-account', walletId = 'writer-agent', grantId = 'writer-grant';
const settings = { direction: 'same' as const, sizingMode: 'ratio' as const, perTradeUsd: null,
  maxTotalExposureUsd: null, maxLeverage: null, copyStartMode: 'delta' as const };
beforeAll(() => { db = getTestDb(); pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); scopes = new PostgresLiveRiskScope(pool); });
beforeEach(async () => {
  await truncateAll(db);
  uid = (await insertUser(db, { privyUserId: 'did:privy:writer' })).id;
  strategyId = (await db.insert(copyStrategies).values({ userId: uid, leaderAddress: ownerAddress, allocated: '100', cash: '100', activatedAt: new Date() }).returning())[0].id;
  await db.insert(copyStrategyVersions).values({ strategyId, version: 1, settings, createdByUserId: uid });
  await db.insert(copyExecutionAccounts).values({ id: accountId, userId: uid, strategyId, network: 'testnet', privyUserId: 'did:privy:writer',
    externalId: 'writer-master', state: 'ready', address, privyWalletId: 'master-wallet', ownerQuorumId: 'owner-quorum' });
  await db.insert(copyExecutionWallets).values({ id: walletId, userId: uid, strategyId, network: 'testnet', accountAddress: address,
    privyWalletId: 'agent-wallet', privyOwnerId: 'owner-quorum', signerAddress: ownerAddress });
  await db.insert(copyWalletAuthorizations).values({ id: grantId, walletId, version: 1, scopes: ['copy:trade', 'copy:reduce'],
    validFrom: new Date(), expiresAt: new Date(Date.now() + 86400000), exchangeApprovedAt: new Date() });
});
afterAll(async () => { await pool?.end(); await closeTestDb(); });

/** Observe an actual waiter, not just a timer that could hide a slow writer.
 * Always release the scope and drain the writer even when the RED assertion fails. */
async function heldWriter<T>(write: () => Promise<T>, before: () => Promise<void>, namespace = 7404): Promise<T> {
  let done = false, result!: T, failure: unknown, pending!: Promise<void>;
  try {
    await scopes.run({ userId: uid, network: 'testnet', accountAddress: address }, async () => {
      pending = write().then(value => { result = value; done = true; }, error => { failure = error; done = true; });
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !done && !waiting; attempt++) {
        const locks = await pool.query<{ waiting: boolean }>('select exists(select 1 from pg_locks where locktype=\'advisory\' and not granted and classid::bigint=$1 and objid::bigint=$2 and objsubid=2) as waiting', [namespace, namespace === 7404 ? uid : 0]);
        waiting = locks.rows[0]?.waiting === true;
        if (!waiting && !done) await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(done, 'writer committed or rejected before original scope release').toBe(false);
      expect(waiting, 'writer must wait on the exact scope namespace').toBe(true);
      // The waiting writer must not retain user/account/strategy/grant rows.
      // Taking these rows first would permit lock inversions with other writers.
      const probe = await pool.connect();
      try {
        await probe.query('begin');
        await probe.query('select id from users where id=$1 for update nowait', [uid]);
        await probe.query('select id from copy_strategies where id=$1 for update nowait', [strategyId]);
        await probe.query('select id from copy_execution_accounts where id=$1 for update nowait', [accountId]);
        await probe.query('select id from copy_wallet_authorizations where id=$1 for update nowait', [grantId]);
      } finally {
        await probe.query('rollback');
        probe.release();
      }
      await before();
    });
  } finally { await pending; }
  if (failure) throw failure;
  return result;
}
const userRow = async () => (await db.select().from(users).where(eq(users.id, uid)))[0];
const accountRow = async () => (await db.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, accountId)))[0];
const strategyRow = async () => (await db.select().from(copyStrategies).where(eq(copyStrategies.id, strategyId)))[0];
const grantRow = async () => (await db.select().from(copyWalletAuthorizations).where(eq(copyWalletAuthorizations.id, grantId)))[0];

describe('actual writers serialize with the original live risk scope', () => {
  it('blocks settings version edits until scope release', async () => {
    const service = new CopyStrategyService(testConfig(), new CopyRepository(db), new UnitOfWork(db), null as never, null as never,
      { current: async () => ({ limits: DEFAULT_COPY_RISK_LIMITS, invalid: false }) } as never, null as never, null as never);
    await heldWriter(() => service.patch(uid, strategyId, { maxLeverage: 5 }), async () => { expect((await strategyRow()).version).toBe(1); });
    expect((await strategyRow()).version).toBe(2);
  });
  it('refuses new master creation if the strategy stopped while waiting', async () => {
    await db.delete(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, accountId));
    const input = { id: accountId, userId: uid, strategyId, network: 'testnet' as const, privyUserId: 'did:privy:writer', externalId: 'new-master' };
    await expect(heldWriter(() => new CopyWalletRepository(db).ensureAccount(input), async () => {
      await db.update(copyStrategies).set({ status: 'stopping' }).where(eq(copyStrategies.id, strategyId));
    })).rejects.toThrow('copy_stopped');
    expect(await accountRow()).toBeUndefined();
  });
  it('preserves existing master replay as a read after strategy stop', async () => {
    await db.update(copyStrategies).set({ status: 'stopped', stoppedAt: new Date() }).where(eq(copyStrategies.id, strategyId));
    expect(await new CopyWalletRepository(db).ensureAccount({ id: 'unused-new-id', userId: uid, strategyId, network: 'testnet',
      privyUserId: 'did:privy:writer', externalId: 'unused-new-external' })).toMatchObject({ id: accountId, state: 'ready', revision: 1 });
    expect(await db.select().from(copyExecutionAccounts)).toHaveLength(1);
  });
  it('blocks user disable before user/admin row locks', async () => {
    await insertUser(db, { role: 'admin' });
    const service = new AdminUsersService(new AdminUsersRepository(db), new UnitOfWork(db), { invalidateUser: vi.fn() } as never);
    await heldWriter(() => service.patch(uid, { disabled: true }, { kind: 'service', permissions: [] }), async () => { expect((await userRow()).disabledAt).toBeNull(); });
    expect((await userRow()).disabledAt).not.toBeNull();
  });
  it('blocks explicit grant revocation and still increments the original version', async () => {
    const service = new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), testConfig(), { available: false } as never);
    await heldWriter(() => service.revoke(uid, grantId), async () => { expect((await grantRow()).revokedAt).toBeNull(); });
    expect(await grantRow()).toMatchObject({ version: 2, revokedAt: expect.any(Date) });
  });
  it.each(['unknown', 'blocked'] as const)('blocks master transition to %s while preserving state CAS', async state => {
    const originalState = state === 'unknown' ? 'requested' : 'ready';
    await db.update(copyExecutionAccounts).set({ state: originalState }).where(eq(copyExecutionAccounts.id, accountId));
    await heldWriter(() => new CopyWalletRepository(db).finish(accountId, state, 'wallet_conflict'), async () => { expect((await accountRow()).state).toBe(originalState); });
    expect((await accountRow()).state).toBe(state);
  });
  it('blocks failed master reverification under the held scope', async () => {
    const row = await accountRow();
    await heldWriter(() => new CopyWalletRepository(db).failReverification(accountId, row, 'verification_pending'), async () => { expect((await accountRow()).state).toBe('ready'); });
    expect((await accountRow()).state).toBe('unknown');
  });
  it('blocks restoring the verified master identity to ready', async () => {
    await db.update(copyExecutionAccounts).set({ state: 'unknown' }).where(eq(copyExecutionAccounts.id, accountId));
    await heldWriter(() => new CopyWalletRepository(db).confirmIdentity(accountId, { id: 'master-wallet', address, ownerQuorumId: 'owner-quorum', externalId: 'writer-master' }), async () => { expect((await accountRow()).state).toBe('unknown'); });
    expect((await accountRow()).state).toBe('ready');
  });
  it('captures the verified master identity before waiting on the scope fence', async () => {
    await db.update(copyExecutionAccounts).set({ state: 'unknown' }).where(eq(copyExecutionAccounts.id, accountId));
    const found = { id: 'master-wallet', address, ownerQuorumId: 'owner-quorum', externalId: 'writer-master' };
    await heldWriter(() => new CopyWalletRepository(db).confirmIdentity(accountId, found), async () => { found.ownerQuorumId = 'foreign-quorum'; });
    expect(await accountRow()).toMatchObject({ state: 'ready', ownerQuorumId: 'owner-quorum' });
  });
  it('blocks standalone agent binding transition while preserving revision CAS', async () => {
    const [row] = await db.insert(copyAgentSetups).values({ id: 'writer-setup', userId: uid, strategyId, accountId, network: 'testnet',
      idempotencyKey: 'writer-setup-key', validForDays: 1, externalId: 'writer-agent-external', policyAttemptId: 'writer-policy', workerQuorumId: 'worker',
      accountAddress: address, accountWalletId: 'master-wallet', accountOwnerQuorumId: 'owner-quorum', expiresAt: new Date(Date.now() + 86400000) }).returning();
    const repository = new CopyAgentRepository(db);
    await heldWriter(() => repository.transition(row, { state: 'blocked', issue: 'agent_conflict' }), async () => { expect((await repository.find(uid, row.id)).revision).toBe(row.revision); });
    expect((await repository.find(uid, row.id)).revision).toBe(row.revision + 1);
    expect(await repository.transition(row, { state: 'revoked' })).toBeNull();
  });
  it('blocks agent setup admission before its initial owner row lock', async () => {
    const repository = new CopyAgentRepository(db);
    const row = await heldWriter(() => db.transaction(tx => repository.ensure(tx, uid, accountId, { idempotencyKey: 'new-setup', validForDays: 1 }, 'worker')),
      async () => { expect(await db.select().from(copyAgentSetups)).toHaveLength(0); });
    expect(row).toMatchObject({ userId: uid, state: 'policy_prepared', revision: 1 });
  });
  it('captures the original agent CAS and requested transition before waiting', async () => {
    const repository = new CopyAgentRepository(db);
    const row = await db.transaction(tx => repository.ensure(tx, uid, accountId, { idempotencyKey: 'captured-setup', validForDays: 1 }, 'worker'));
    const changes = { state: 'blocked' as const, issue: 'agent_conflict' };
    const originalRevision = row.revision;
    await heldWriter(() => repository.transition(row, changes), async () => { row.revision += 1; changes.issue = 'foreign-mutation'; });
    expect(await repository.find(uid, row.id)).toMatchObject({ state: 'blocked', revision: originalRevision + 1, issue: 'agent_conflict' });
  });
  it('blocks grant rotation and agent retirement until scope release', async () => {
    const now = Date.now();
    const [row] = await db.insert(copyAgentSetups).values({ id: 'writer-activate', userId: uid, strategyId, accountId, network: 'testnet',
      idempotencyKey: 'writer-activate-key', validForDays: 1, externalId: 'activate-external', policyAttemptId: 'activate-policy', workerQuorumId: 'worker',
      accountAddress: address, accountWalletId: 'master-wallet', accountOwnerQuorumId: 'owner-quorum', expiresAt: new Date(now + 86400000),
      state: 'approval_unknown', agentWalletId: 'new-agent-wallet', agentOwnerQuorumId: 'owner-quorum', agentAddress: `0x${'33'.repeat(20)}`,
      policyId: 'user-policy', policyFingerprint: 'a'.repeat(64), approvalNonce: now, consentExpiresAt: new Date(now + 300000),
      consentDigest: 'b'.repeat(64), approvalAttemptedAt: new Date(now) }).returning();
    const repository = new CopyAgentRepository(db);
    const active = await heldWriter(() => db.transaction(tx => repository.activate(tx, uid, row, Date.now(), Date.now())), async () => {
      expect((await grantRow()).revokedAt).toBeNull();
      expect((await db.select().from(copyExecutionWallets).where(eq(copyExecutionWallets.id, walletId)))[0].retiredAt).toBeNull();
    });
    expect(active).toMatchObject({ state: 'active', revision: row.revision + 1 });
    expect(await grantRow()).toMatchObject({ version: 2, revokedAt: expect.any(Date) });
    expect((await db.select().from(copyExecutionWallets).where(eq(copyExecutionWallets.id, walletId)))[0].retiredAt).not.toBeNull();
  });
  it('refuses a changed account owner after waiting on its original user fence', async () => {
    const other = (await insertUser(db)).id;
    const repository = new CopyWalletRepository(db);
    await expect(heldWriter(() => repository.finish(accountId, 'blocked', 'wallet_conflict'), async () => {
      await db.update(copyExecutionAccounts).set({ userId: other }).where(eq(copyExecutionAccounts.id, accountId));
    })).rejects.toThrow('wallet_owner_mismatch');
    expect((await accountRow()).state).toBe('ready');
  });
  it('refuses follower quarantine when owner changes during the original user fence wait', async () => {
    const other = (await insertUser(db)).id;
    await expect(heldWriter(() => new CopyFollowerLedger(db, new UnitOfWork(db)).recordInvalidEvidence(accountId, 'follower_receipt_invalid_evidence'), async () => {
      await db.update(copyExecutionAccounts).set({ userId: other }).where(eq(copyExecutionAccounts.id, accountId));
    })).rejects.toThrow('follower_account_identity_changed');
    expect(await db.select().from(copyFollowerAccountState)).toHaveLength(0);
  });
  it('blocks follower quarantine and keeps real late receipts after disable/revoke', async () => {
    const ledger = new CopyFollowerLedger(db, new UnitOfWork(db));
    await heldWriter(() => ledger.recordInvalidEvidence(accountId, 'follower_receipt_invalid_evidence'), async () => { expect(await db.select().from(copyFollowerAccountState)).toHaveLength(0); });
    expect((await db.select().from(copyFollowerAccountState))[0].quarantined).toBe(true);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, uid));
    await db.update(copyWalletAuthorizations).set({ revokedAt: new Date() }).where(eq(copyWalletAuthorizations.id, grantId));
    const receipt = { hash: `0x${'33'.repeat(32)}`, time: Date.now() - 1000, delta: { type: 'funding', coin: 'BTC', usdc: '-0.1' } };
    expect(await ledger.bookFunding(accountId, receipt)).toEqual({ inserted: true, quarantined: true });
    expect(await ledger.bookFunding(accountId, receipt)).toEqual({ inserted: false, quarantined: true });
  });
  it.each(['auth', 'wallet'] as const)('blocks initial embedded address via %s repository', async kind => {
    const repository = kind === 'auth' ? new AuthRepository(db) : new WalletRepository(db);
    await heldWriter<unknown>(() => repository.setEmbeddedWallet(uid, ownerAddress), async () => { expect((await userRow()).embeddedWalletAddress).toBeNull(); });
    expect((await userRow()).embeddedWalletAddress).toBe(ownerAddress);
  });
  it.each([{ general: { copyTradingEnabled: true } }, { revenue: { builderFeeTenthsBps: 10 } }])('blocks relevant platform settings before section rows: %j', async input => {
    const service = new SettingsService(new SettingsRepository(db), new UnitOfWork(db));
    const before = await service.getAll();
    await heldWriter(() => service.patch(input, null), async () => { expect((await service.getAll()).revisions).toEqual(before.revisions); }, 7405);
    const key = input.general ? 'general' : 'revenue';
    expect((await service.getAll()).revisions[key]).not.toBe(before.revisions[key]);
  });
  it('keeps unrelated discovery settings writable during scope', async () => {
    await scopes.run({ userId: uid, network: 'testnet', accountAddress: address }, async () => {
      expect((await new SettingsService(new SettingsRepository(db), new UnitOfWork(db)).patch({ discovery: { lowSampleThreshold: 30 } }, null)).discovery.lowSampleThreshold).toBe(30);
    });
  });
  it('blocks the deletion decision before rows, and never deletes a copy account it could not check', async () => {
    await db.update(copyStrategies).set({ status: 'stopped', stoppedAt: new Date() }).where(eq(copyStrategies.id, strategyId));
    const service = new AccountDeletionService(new AccountRepository(db), null as never, new UnitOfWork(db));
    await expect(heldWriter(() => service.delete(uid), async () => { expect(await userRow()).toBeDefined(); })).rejects.toThrow("Your copy accounts can't be checked");
    expect(await userRow()).toBeDefined();
  });
  it('blocks worker stop settlement before changing the shared strategy status', async () => {
    await db.update(copyStrategies).set({ status: 'stopping' }).where(eq(copyStrategies.id, strategyId));
    const service = new CopyExecutionService(new CopyRepository(db), new UnitOfWork(db), null as never, null as never, null as never);
    expect(await heldWriter(() => service.settleStopping(), async () => { expect((await strategyRow()).status).toBe('stopping'); })).toBe(1);
    expect((await strategyRow()).status).toBe('stopped');
  });
  it('blocks paper liquidation before changing shared strategy status', async () => {
    await db.insert(copyPositions).values({ strategyId, coin: 'BTC', size: '1', entryPx: '200' });
    const mids = { at: new Date(), px: new Map([['BTC', Dec.from(100)]]), missingDexes: new Set<string>() };
    const assets = new AssetMap([['BTC', { szDecimals: 3, maxLeverage: 10, funding: Dec.ZERO, markPx: Dec.from(100) }]]);
    const service = new CopyExecutionService(new CopyRepository(db), new UnitOfWork(db), { midPrices: async () => mids, assetInfo: async () => assets } as never,
      { current: async () => ({ version: 0, limits: DEFAULT_COPY_RISK_LIMITS, invalid: false }) } as never, { get: async () => ({ builderFeeTenthsBps: 0 }) } as never);
    expect(await heldWriter(() => service.liquidate(), async () => { expect((await strategyRow()).status).toBe('active'); })).toBe(1);
    expect((await strategyRow()).status).toBe('paused');
  });
});
