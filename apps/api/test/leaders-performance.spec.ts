import { RoundTripRepository } from "../src/analytics/round-trip.repository.js";
import { actions, fills, leaders, equitySnapshots, positionSnapshots, leaderLists, leaderListItems } from '@trading-dashboard/shared/database';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { RoundTripService } from '../src/analytics/round-trip.service.js';
import { LeadersRepository } from '../src/api/leaders/leaders.repository.js';
import { LEADERS_HISTORY_DAYS, LeadersService } from '../src/api/leaders/leaders.service.js';
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
    const service = new LeadersService(new UnitOfWork(db), new LeadersRepository(db), new RoundTripService(new RoundTripRepository(db)));
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
  const service = new LeadersService(new UnitOfWork(db), new LeadersRepository(db), new RoundTripService(new RoundTripRepository(db)));
  expect(await service.findAll({})).toMatchObject([{ address, rank: 3, openPositionCount: 0, pnl7d: 0, pnl30d: 0, winRate: null, avgHoldTimeSeconds: null, lastActionAt: null }]);
});

it('the public list is computed once for concurrent and repeated callers; admins are not served from it (review 32)', async () => {
  const now = Date.now();
  await db.insert(leaders).values([{ address: '0xcached', tier: 'A' }]);
  await db.insert(actions).values([
    { chain: 'hyperliquid', address: '0xcached', coin: 'BTC', kind: 'open' as const, side: 'long' as const, notionalUsd: '100', avgPx: '100', fillIds: [], ts: new Date(now - 61000) },
    { chain: 'hyperliquid', address: '0xcached', coin: 'BTC', kind: 'close' as const, side: 'long' as const, notionalUsd: '100', avgPx: '100', fillIds: [], ts: new Date(now - 1000) },
  ]);
  const roundTrips = new RoundTripService(new RoundTripRepository(db));
  const reconstruct = vi.spyOn(roundTrips, 'reconstructRoundTripsMany');
  const service = new LeadersService(new UnitOfWork(db), new LeadersRepository(db), roundTrips);
  const answers = await Promise.all(Array.from({ length: 20 }, () => service.findAll({})));
  await service.findAll({});
  expect(reconstruct).toHaveBeenCalledTimes(1);
  expect(answers.every(a => a.length === 1 && a[0]!.avgHoldTimeSeconds === 60)).toBe(true);
  // A Date, not the driver's text: the response schema rejected the text with a 500.
  expect(answers[0]![0]!.lastActionAt).toEqual(new Date(now - 1000));
  // Another filter is its own entry; an admin always gets a fresh answer.
  await service.findAll({ tier: 'A' });
  await service.findAll({}, 'admin');
  await service.findAll({}, 'admin');
  expect(reconstruct).toHaveBeenCalledTimes(4);
});

it('reads a bounded window of action history, not every leader\'s whole past (review 32)', async () => {
  const now = Date.now();
  const day = 86_400_000;
  const at = (daysAgo: number) => new Date(now - daysAgo * day);
  const row = (kind: 'open' | 'close', daysAgo: number, coin: string, fillIds: bigint[] = []) =>
    ({ chain: 'hyperliquid', address: '0xold', coin, kind, side: 'long' as const, notionalUsd: '100', avgPx: '100', fillIds, ts: at(daysAgo) });
  await db.insert(leaders).values([{ address: '0xold' }]);
  await db.insert(fills).values([
    { chain: 'hyperliquid', address: '0xold', tid: 1n, coin: 'BTC', side: 'A', dir: 'Close Long', px: '100', sz: '1', fee: '0', closedPnl: '7', ts: at(10), raw: {} },
    { chain: 'hyperliquid', address: '0xold', tid: 2n, coin: 'ETH', side: 'A', dir: 'Close Long', px: '100', sz: '1', fee: '0', closedPnl: '900', ts: at(200), raw: {} },
  ]);
  await db.insert(actions).values([
    row('open', 400, 'ETH'), row('close', 200, 'ETH', [2n]), // long before the window: not loaded
    row('open', 40, 'BTC'), row('close', 10, 'BTC', [1n]), // closed in the last 30 days, opened inside the window
  ]);
  const repository = new RoundTripRepository(db);
  const history = vi.spyOn(repository, 'history');
  const service = new LeadersService(new UnitOfWork(db), new LeadersRepository(db), new RoundTripService(repository));
  const [leader] = await service.findAll({});
  expect(leader).toMatchObject({ pnl30d: 7, pnl7d: 0, winRate: 1, avgHoldTimeSeconds: 30 * 86_400 });
  const since = history.mock.calls[0]![2]!;
  expect(Math.round((now - since.getTime()) / day)).toBe(LEADERS_HISTORY_DAYS);
  expect((await history.mock.results[0]!.value).map((a: { coin: string }) => a.coin)).toEqual(['BTC', 'BTC']);
});
