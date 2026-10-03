import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { copyStrategies, copyOrders, copyReservations, copyPaperFills, copyLedger, copySignalLegs, copyEquitySnapshots, copyEvents } from '@trading-dashboard/shared/database';
import { CopyRepository } from '../src/copy/copy.repository.js';
import { closeTestDb, getTestDb, insertUser, truncateAll, type TestDb } from './db-test-utils.js';

let db: TestDb, repository: CopyRepository, userId: number, orderId: bigint;
const leader = `0x${'44'.repeat(20)}`;
const order = () => ({ strategyId: 9, userId, cloid: `0x${'ab'.repeat(16)}`, strategyVersion: 1, riskPolicyVersion: 1,
  leaderAddress: leader, coin: 'BTC', leg: 'open' as const, side: 'B' as const, reduceOnly: false, size: '1', signalPx: '100', signalTime: new Date(), signalTids: [1n], status: 'risk_approved' as const, controlRevisions: { platform: 0, user: 0, strategy: 0 } });
beforeAll(() => { db = getTestDb(); repository = new CopyRepository(db); });
beforeEach(async () => {
  await truncateAll(db); userId = (await insertUser(db)).id;
  await db.insert(copyStrategies).values({ id: 9, userId, leaderAddress: leader, mode: 'testnet', status: 'paused', allocated: '0', cash: '0', activatedAt: new Date() });
  // Existing corrupt/legacy child fixtures are not proof of paper mode.
  orderId = (await db.insert(copyOrders).values(order()).returning())[0]!.id;
});
afterAll(closeTestDb);
describe('paper writes reject an actual parent even without the public service', () => {
  it('rejects insertion of an actual strategy through the paper DAL', async () => {
    await expect(db.transaction(tx => repository.insertStrategy(tx, { userId, leaderAddress: `0x${'55'.repeat(20)}`, mode: 'testnet', status: 'paused', allocated: '0', cash: '0', activatedAt: new Date() }))).rejects.toThrow('paper_strategy_required');
  });
  it('refuses new paper orders on an actual strategy', async () => {
    await expect(db.transaction(tx => repository.insertOrder(tx, { ...order(), cloid: `0x${'cd'.repeat(16)}` }))).rejects.toThrow('paper_strategy_required');
    expect(await db.select().from(copyOrders)).toHaveLength(1);
  });
  it('refuses simulated reservation/fill/ledger/leg insertion on an actual strategy', async () => {
    await expect(db.transaction(tx => repository.insertReservation(tx, { orderId, strategyId: 9, userId, coin: 'BTC', notional: '100', margin: '10' }))).rejects.toThrow('paper_strategy_required');
    await expect(db.transaction(tx => repository.insertPaperFill(tx, { orderId, strategyId: 9, coin: 'BTC', side: 'B', size: '1', px: '100', basePx: '100', priceSource: 'mid', slippageBps: '0', fee: '0', builderFee: '0', realizedPnl: '0' }))).rejects.toThrow('paper_strategy_required');
    await expect(db.transaction(tx => repository.insertLedger(tx, [{ strategyId: 9, userId, kind: 'allocate', amount: '100' }]))).rejects.toThrow('paper_strategy_required');
    await expect(db.transaction(tx => repository.claimLeg(tx, { strategyId: 9, tid: 1n, leg: 'open', strategyVersion: 1, coin: 'BTC', fillTime: new Date() }))).rejects.toThrow('paper_strategy_required');
    expect(await db.select().from(copyReservations)).toHaveLength(0); expect(await db.select().from(copyPaperFills)).toHaveLength(0);
    expect(await db.select().from(copyLedger)).toHaveLength(0); expect(await db.select().from(copySignalLegs)).toHaveLength(0);
  });
  it('refuses paper equity snapshots and events bound to an actual strategy', async () => {
    await expect(db.transaction(tx => repository.runtime.snapshot(tx, { strategyId: 9, time: new Date(), equity: '100', totalPnl: '0', netDeposits: '100', exposureUsd: '0' }))).rejects.toThrow('paper_strategy_required');
    await expect(db.transaction(tx => repository.runtime.appendEvent(tx, userId, 9, 'funds_added', { mode: 'paper', amount: '100' }))).rejects.toThrow('paper_strategy_required');
    expect(await db.select().from(copyEquitySnapshots)).toHaveLength(0); expect(await db.select().from(copyEvents)).toHaveLength(0);
  });
});
