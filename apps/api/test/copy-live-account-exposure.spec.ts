import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { copyExecutionAccounts, copyStrategies, copyFundingOperations } from '@trading-dashboard/shared/database';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { getTestDb, closeTestDb, type TestDb } from './db-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import { PostgresLiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';
import { loadLivePreparationAuthority } from '../src/copy/live/postgres-live-risk-authority.js';

let db: TestDb, pool: Pool, seed: Awaited<ReturnType<typeof preparationFixture>>;
beforeAll(() => { db = getTestDb(); pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 }); });
beforeEach(async () => { seed = await preparationFixture(db); });
afterAll(async () => { await pool.end(); await closeTestDb(); });
async function paperAccount(status: 'active' | 'stopped' = 'active') {
  const [strategy] = await db.select().from(copyStrategies).where(eq(copyStrategies.id, 9));
  const [account] = await db.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, 'account'));
  await db.insert(copyStrategies).values({ ...strategy!, id: 10, mode: 'paper', status, allocated: '10', cash: status === 'active' ? '10' : '0',
    leaderAddress: `0x${'55'.repeat(20)}`, stoppedAt: status === 'stopped' ? new Date(now) : null });
  await db.insert(copyExecutionAccounts).values({ ...account!, id: 'paper-placeholder', strategyId: 10, address: `0x${'66'.repeat(20)}`, externalId: 'paper-placeholder', privyWalletId: 'paper-placeholder' });
}
async function accounts() {
  const scope = new PostgresLiveRiskScope(pool, () => now);
  const result = await scope.run({ userId: 1, network: 'testnet', accountAddress: seed.f.identity.accountAddress,
    source: { network: 'testnet', leaderAddress: seed.consent.leaderAddress } }, async (_scope, session) =>
      session.read(tx => loadLivePreparationAuthority(session, tx, { accountId: 'account', mandateId: 'mandate' }, now)));
  return result.accounts.map(a => a.id).sort();
}
describe('actual copy exposure account coverage', () => {
  it('does not treat a pure paper wallet placeholder without actual history as live exposure', async () => {
    await paperAccount();
    expect(await accounts()).toEqual(['account']);
  });
  it.each(['active', 'stopped'] as const)('retains a %s paper-labelled account while actual money is pending', async status => {
    await paperAccount(status);
    await db.insert(copyFundingOperations).values({ id: 'paper-real-money', userId: 1, strategyId: 10, accountId: 'paper-placeholder',
      network: 'testnet', idempotencyKey: 'paper-real-money', address: seed.f.identity.accountAddress,
      destination: `0x${'66'.repeat(20)}`, amount: '5', nonce: now, status: 'prepared' });
    expect(await accounts()).toEqual(['account', 'paper-placeholder']);
  });
  it('conservatively retains an active paper-labelled account with historical actual funding', async () => {
    await paperAccount();
    await db.insert(copyFundingOperations).values({ id: 'paper-real-money', userId: 1, strategyId: 10, accountId: 'paper-placeholder',
      network: 'testnet', idempotencyKey: 'paper-real-money', address: seed.f.identity.accountAddress,
      destination: `0x${'66'.repeat(20)}`, amount: '5', nonce: now, status: 'cancelled' });
    expect(await accounts()).toEqual(['account', 'paper-placeholder']);
  });
});
