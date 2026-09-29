import { actions, fills, leaders, equitySnapshots, positionSnapshots, leaderLists, leaderListItems } from '@trading-dashboard/shared/database';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { RoundTripService } from '../src/analytics/round-trip.service.js';
import { LeadersRepository } from '../src/api/leaders/leaders.repository.js';
import { LeadersService } from '../src/api/leaders/leaders.service.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { closeTestDb, getTestDb, truncateAll } from './db-test-utils.js';
const db = getTestDb();
beforeEach(async () => { await truncateAll(db); });
afterAll(closeTestDb);
it('batches leader summaries and keeps counterparty PnL separate', async () => {
  const addresses = Array.from({ length: 12 }, (_, i) => `0xperf${i}`);
  const now = Date.now();
  await db.insert(leaders).values(addresses.map(address => ({ chain: 'hyperliquid', address })));
  await db.insert(fills).values(addresses.map((address, i) => ({ chain: 'hyperliquid', address, tid: 10n, coin: 'BTC', side: 'B', dir: 'Close Long', px: '100', sz: '1', fee: '0', closedPnl: String(i + 1), ts: new Date(now - 1000), raw: {} })));
  await db.insert(actions).values(addresses.flatMap(address => [
    { chain: 'hyperliquid', address, coin: 'BTC', kind: 'open' as const, side: 'long' as const, notionalUsd: '100', avgPx: '100', fillIds: [], ts: new Date(now - 61000) },
    { chain: 'hyperliquid', address, coin: 'BTC', kind: 'close' as const, side: 'long' as const, notionalUsd: '100', avgPx: '100', fillIds: [10n], ts: new Date(now - 1000) },
  ]));
  const selects = vi.spyOn(db, 'select');
  const executes = vi.spyOn(db, 'execute');
  try {
    const service = new LeadersService(new UnitOfWork(db), new LeadersRepository(db), new RoundTripService(db));
    const result = await service.findAll({});
    expect(result).toHaveLength(12);
    for (const [i, address] of addresses.entries()) expect(result.find(row => row.address === address)).toMatchObject({ pnl7d: i + 1, pnl30d: i + 1, winRate: 1, avgHoldTimeSeconds: 60, openPositionCount: 0 });
    expect(selects.mock.calls.length + executes.mock.calls.length).toBeLessThanOrEqual(4);
  } finally { selects.mockRestore(); executes.mockRestore(); }
});

it('uses latest snapshot and import rank while preserving empty-history defaults', async () => {
  const address = '0xempty';
  const old = new Date(Date.now() - 10000); const current = new Date();
  await db.insert(leaders).values({ address });
  await db.insert(equitySnapshots).values([{ address, ts: old, accountValue: '100' }, { address, ts: current, accountValue: '100' }]);
  await db.insert(positionSnapshots).values({ address, coin: 'BTC', ts: old, szi: '1' });
  const lists = await db.insert(leaderLists).values([{ source: 'test', fileName: 'old', importedAt: old }, { source: 'test', fileName: 'new', importedAt: current }]).returning();
  await db.insert(leaderListItems).values([{ address, listId: lists[0]!.id, rank: 8 }, { address, listId: lists[1]!.id, rank: 3 }]);
  const service = new LeadersService(new UnitOfWork(db), new LeadersRepository(db), new RoundTripService(db));
  expect(await service.findAll({})).toMatchObject([{ address, rank: 3, openPositionCount: 0, pnl7d: 0, pnl30d: 0, winRate: null, avgHoldTimeSeconds: null, lastActionAt: null }]);
});
