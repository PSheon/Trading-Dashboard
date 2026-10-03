import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { copyExecutionAccounts, copyFundingOperations, copyStrategies, users, walletWithdrawals } from '@trading-dashboard/shared/database';
import { CopyFundingRepository } from '../src/copy/copy-funding.repository.js';
import { WithdrawalRepository } from '../src/wallet/withdrawal.repository.js';
import { PostgresLiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';
import { closeTestDb, getTestDb, insertUser, truncateAll, type TestDb } from './db-test-utils.js';

let db: TestDb, pool: Pool, userId: number, strategyId: number;
const master = `0x${'11'.repeat(20)}`, hub = `0x${'22'.repeat(20)}`, hash = `0x${'aa'.repeat(32)}`;
const accountId = 'transfer-account';
beforeAll(() => { db = getTestDb(); pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
beforeEach(async () => {
  await truncateAll(db);
  userId = (await insertUser(db, { embeddedWalletAddress: hub, privyUserId: 'did:privy:transfer' })).id;
  strategyId = (await db.insert(copyStrategies).values({ userId, leaderAddress: hub, allocated: '100', cash: '100', activatedAt: new Date() }).returning())[0].id;
  await db.insert(copyExecutionAccounts).values({ id: accountId, userId, strategyId, network: 'testnet', privyUserId: 'did:privy:transfer',
    externalId: 'transfer-master', state: 'ready', address: master, privyWalletId: 'master-wallet', ownerQuorumId: 'owner-quorum' });
});
afterAll(async () => { await pool?.end(); await closeTestDb(); });

async function held<T>(write: () => Promise<T>, before: () => Promise<void> = async () => {}): Promise<T> {
  let done = false, failure: unknown, result!: T, pending!: Promise<void>;
  try {
    await new PostgresLiveRiskScope(pool).run({ userId, network: 'testnet', accountAddress: master }, async () => {
      pending = write().then(value => { result = value; done = true; }, error => { failure = error; done = true; });
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !done && !waiting; attempt++) {
        const r = await pool.query<{ waiting: boolean }>("select exists(select 1 from pg_locks where locktype='advisory' and not granted and classid::bigint=7404 and objid::bigint=$1 and objsubid=2) as waiting", [userId]);
        waiting = r.rows[0]?.waiting === true;
        if (!waiting && !done) await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(done, 'transfer writer must wait for original risk scope').toBe(false);
      expect(waiting, 'transfer writer must use the original user namespace').toBe(true);
      const probe = await pool.connect();
      try {
        await probe.query('begin');
        await probe.query('select id from users where id=$1 for update nowait', [userId]);
        await probe.query('select id from copy_execution_accounts where id=$1 for update nowait', [accountId]);
        await probe.query('select id from copy_funding_operations where user_id=$1 for update nowait', [userId]);
        await probe.query('select id from wallet_withdrawals where user_id=$1 for update nowait', [userId]);
      } finally { await probe.query('rollback'); probe.release(); }
      await before();
    });
  } finally { await pending; }
  if (failure) throw failure;
  return result;
}
async function funding(status: 'prepared' | 'unknown' | 'accepted' = 'prepared', attempted = false) {
  return (await db.insert(copyFundingOperations).values({ id: randomUUID(), userId, strategyId, accountId, network: 'testnet', address: hub,
    destination: master, amount: '10', nonce: Date.now(), idempotencyKey: randomUUID(), status,
    claimedAt: status === 'prepared' ? null : new Date(), attemptedAt: attempted ? new Date() : null,
    evidenceHash: status === 'accepted' ? 'a'.repeat(64) : null }).returning())[0];
}
async function withdrawal(status: 'prepared' | 'unknown' = 'prepared', attempted = false) {
  return (await db.insert(walletWithdrawals).values({ id: randomUUID(), userId, network: 'testnet', address: hub, destination: master,
    amount: '10', nonce: Date.now(), origin: 'client', status, claimedAt: status === 'prepared' ? null : new Date(), attemptedAt: attempted ? new Date() : null }).returning())[0];
}

describe('transfer liability writers join the original account risk scope', () => {
  it('fences funding admission before source/account rows and captures its intent', async () => {
    const input = { amount: '10', idempotencyKey: randomUUID() };
    const row = await held(() => new CopyFundingRepository(db).reserve(userId, accountId, 'testnet', input), async () => { input.amount = '99'; });
    expect(row).toMatchObject({ amount: '10', status: 'prepared', destination: master });
  });
  it.each(['claim', 'cancel', 'beginSubmit', 'restoreUnsent', 'finish', 'credit'] as const)('fences funding %s without losing its CAS', async method => {
    const attempted = method === 'finish' || method === 'credit';
    const row = await funding(['claim', 'cancel'].includes(method) ? 'prepared' : 'unknown', attempted);
    const repository = new CopyFundingRepository(db);
    await held(async () => {
      if (method === 'finish') return repository.finish(userId, row.id, 'accepted', 'a'.repeat(64));
      if (method === 'credit') return repository.credit(userId, row.id, { transactionHash: hash, creditedAmount: '9', fee: '1' }, 'a'.repeat(64), row.scanRevision);
      return repository[method](userId, row.id);
    });
    const updated = await repository.find(userId, row.id);
    const expected = { claim: 'unknown', cancel: 'cancelled', beginSubmit: 'unknown', restoreUnsent: 'prepared', finish: 'accepted', credit: 'credited' };
    expect(updated.status).toBe(expected[method]);
    if (method === 'beginSubmit') expect(updated.attemptedAt).toBeInstanceOf(Date);
  });
  it('fences withdrawal admission before source rows and captures scope/intent', async () => {
    const scope = { userId, network: 'testnet' as const, address: hub }, input = { amount: '10', destination: master };
    const row = await held(() => new WithdrawalRepository(db).reserve(scope, input), async () => { scope.address = master; input.amount = '99'; });
    expect(row).toMatchObject({ address: hub, amount: '10', status: 'prepared' });
  });
  it.each(['claim', 'cancel', 'beginSubmit', 'restoreUnsent', 'finish'] as const)('fences withdrawal %s without losing its CAS', async method => {
    const row = await withdrawal(['claim', 'cancel'].includes(method) ? 'prepared' : 'unknown', method === 'finish');
    const repository = new WithdrawalRepository(db);
    await held(async () => method === 'finish' ? repository.finish(userId, row.id, 'accepted', 'a'.repeat(64)) : repository[method](userId, row.id));
    const updated = await repository.find(userId, row.id);
    const expected = { claim: 'unknown', cancel: 'cancelled', beginSubmit: 'unknown', restoreUnsent: 'prepared', finish: 'accepted' };
    expect(updated.status).toBe(expected[method]);
    if (method === 'beginSubmit') expect(updated.attemptedAt).toBeInstanceOf(Date);
  });
  it.each(['funding', 'withdrawal'] as const)('rechecks disabled owner after %s submission waits', async kind => {
    const row = kind === 'funding' ? await funding('unknown') : await withdrawal('unknown');
    const repository = kind === 'funding' ? new CopyFundingRepository(db) : new WithdrawalRepository(db);
    await expect(held<unknown>(() => repository.beginSubmit(userId, row.id), async () => {
      await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId));
    })).rejects.toThrow();
    expect((await repository.find(userId, row.id)).attemptedAt).toBeNull();
  });
  it('preserves late transfer credit after owner disablement', async () => {
    const row = await funding('accepted', true);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId));
    const credited = await held(() => new CopyFundingRepository(db).credit(userId, row.id, { transactionHash: hash, creditedAmount: '9', fee: '1' }, 'a'.repeat(64), row.scanRevision));
    expect(credited).toMatchObject({ status: 'credited', creditedAmount: '9', fee: '1' });
  });
});
