import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { copyEquitySnapshots, copyExecutionAccounts, copyFollowerObservationBudget, copyFollowerObservations, copyFundingOperations, copyStrategies } from '@trading-dashboard/shared/database';
import { CopyFollowerSnapshotRepository } from '../src/copy/copy-follower-snapshot.repository.js';
import { CopyPerformanceService } from '../src/copy/copy-performance.service.js';
import { CopyRepository } from '../src/copy/copy.repository.js';
import type { CopyMarketService } from '../src/copy/copy-market.service.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import type { LiveAccountSnapshot } from '../src/copy/live/live-account-observer.js';
import { fixture, now, account } from './copy-live-risk-test-utils.js';
import { testConfig } from './config-test-utils.js';
import { closeTestDb, getTestDb, insertUser, truncateAll, type TestDb } from './db-test-utils.js';

let db: TestDb, snapshots: CopyFollowerSnapshotRepository, performance: CopyPerformanceService, userId: number;
const market = { midPrices: vi.fn(async () => { throw new Error('no exchange read for actual copies'); }) } as unknown as CopyMarketService;
const snapshot = (): LiveAccountSnapshot => structuredClone(fixture().accountSource.snapshot);
const main = `0x${'66'.repeat(20)}`;
type Funding = Partial<typeof copyFundingOperations.$inferInsert> & { id: string };
const funding = (row: Funding) => db.insert(copyFundingOperations).values({ userId, accountId: 'account', strategyId: 9, idempotencyKey: `key-${row.id}`, network: 'testnet',
  address: main, destination: account, amount: '50', nonce: now - 100_000 + row.id.length, status: 'credited', evidenceHash: 'e'.repeat(64),
  transactionHash: `0x${row.id.padEnd(64, '0').replace(/[^0-9a-f]/g, 'd')}`, creditedAmount: '49', fee: '1',
  claimedAt: new Date(now - 60_000), attemptedAt: new Date(now - 60_000), createdAt: new Date(now - 90_000), updatedAt: new Date(now - 30_000), ...row });
async function observe(edit?: (s: LiveAccountSnapshot) => void) {
  const claim = await snapshots.claim(); expect(claim).not.toBeNull();
  const s = snapshot(); edit?.(s);
  expect(await snapshots.save(claim!, s)).toBe(true);
}
const rows = () => db.select().from(copyEquitySnapshots).orderBy(copyEquitySnapshots.time);

beforeAll(() => {
  db = getTestDb(); snapshots = new CopyFollowerSnapshotRepository(db, testConfig());
  performance = new CopyPerformanceService(new CopyRepository(db), new UnitOfWork(db), market, testConfig());
});
beforeEach(async () => {
  await truncateAll(db); await db.delete(copyFollowerObservationBudget); vi.spyOn(Date, 'now').mockReturnValue(now);
  const user = await insertUser(db); userId = user.id;
  await db.insert(copyStrategies).values({ id: 9, userId, leaderAddress: `0x${'44'.repeat(20)}`, mode: 'testnet', network: 'testnet', status: 'active', allocated: '0', cash: '0',
    activatedAt: new Date(now - 3_600_000), createdAt: new Date(now - 3_600_000) });
  await db.insert(copyExecutionAccounts).values({ id: 'account', userId, strategyId: 9, network: 'testnet', state: 'ready', address: account, privyUserId: user.privyUserId,
    externalId: 'live-performance-fixture', privyWalletId: 'master', ownerQuorumId: 'owner' });
  await funding({ id: 'deposit' });
});
afterEach(() => vi.restoreAllMocks()); afterAll(closeTestDb);

describe('actual copy performance snapshots', () => {
  it('records the stored observation: equity, credited net deposits, PnL and exposure at the observation time', async () => {
    await observe();
    await performance.capture();
    await performance.capture(); // Same observation: one row, no duplicate.
    expect(await rows()).toEqual([{ strategyId: 9, time: new Date(now), equity: '100', netDeposits: '49', totalPnl: '51', exposureUsd: '0' }]);
    expect(market.midPrices).not.toHaveBeenCalled();
  });
  it('subtracts credited returns and ignores transfers sent after the observation or never sent', async () => {
    await funding({ id: 'return', direction: 'to_main', address: account, destination: main, amount: '10', creditedAmount: '9.5', fee: '0.5' });
    await funding({ id: 'later', attemptedAt: new Date(now + 1000), createdAt: new Date(now + 500), updatedAt: new Date(now + 2000) });
    await funding({ id: 'cancelled', status: 'cancelled', claimedAt: null, attemptedAt: null, transactionHash: null, creditedAmount: null, fee: null, evidenceHash: null });
    await observe();
    await performance.capture();
    expect(await rows()).toMatchObject([{ equity: '100', netDeposits: '39', totalPnl: '61' }]);
  });
  it.each([
    ['in flight at the observation', { status: 'accepted' as const, transactionHash: null, creditedAmount: null, fee: null }],
    ['credited only after the observation', { updatedAt: new Date(now + 5000) }],
  ])('writes nothing while a transfer is %s (net deposits unknown)', async (_, edit) => {
    await funding({ id: 'second', ...edit });
    await observe();
    await performance.capture();
    expect(await rows()).toEqual([]);
  });
  it('writes nothing without a valid observation (never zero)', async () => {
    await performance.capture();
    expect(await rows()).toEqual([]);
    await observe();
    await db.update(copyFollowerObservations).set({ snapshot: sql`jsonb_set(snapshot, '{perpEquity}', '"5000"')` });
    await performance.capture();
    expect(await rows()).toEqual([]);
  });
  it('keeps network separation and skips stopped copies', async () => {
    await observe();
    await db.update(copyStrategies).set({ status: 'stopped', stoppedAt: new Date(now) });
    await performance.capture();
    await db.update(copyStrategies).set({ status: 'active', stoppedAt: null, network: 'mainnet' });
    await db.update(copyExecutionAccounts).set({ network: 'mainnet' });
    await performance.capture();
    expect(await rows()).toEqual([]);
  });
  it("serves the owner's actual copy history and hides it from others", async () => {
    await observe();
    await performance.capture();
    const history = await performance.history(userId, 9, { window: 'all' });
    expect(history).toMatchObject({ strategyId: 9, mode: 'actual', network: 'testnet', coverage: { firstSnapshotAt: new Date(now) } });
    expect(history.points).toContainEqual({ time: new Date(now), equity: 100, totalPnl: 51, netDeposits: 49, exposureUsd: 0 });
    const other = await insertUser(db);
    await expect(performance.history(other.id, 9, { window: 'all' })).rejects.toMatchObject({ status: 404 });
    expect((await db.select().from(copyStrategies).where(eq(copyStrategies.id, 9)))[0]!.mode).toBe('testnet');
  });
});
