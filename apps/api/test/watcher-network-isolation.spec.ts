import { afterAll, beforeEach, expect, it } from 'vitest';
import { copyLiveStrategyConfigs, copyStrategies, leaders } from '@trading-dashboard/shared/database';
import type { AppConfig } from '../src/config/app-config.js';
import { FillSyncRepository } from '../src/watcher/fill-sync.repository.js';
import { WatcherRepository } from '../src/watcher/watcher.repository.js';
import { testConfig } from './config-test-utils.js';
import { closeTestDb, getTestDb, insertUser, truncateAll } from './db-test-utils.js';

const db = getTestDb();
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const configFor = (network: 'mainnet' | 'testnet'): AppConfig => {
  const value = testConfig().value;
  return { value: { ...value, hyperliquid: { ...value.hyperliquid, wallet: { ...value.hyperliquid.wallet, network } } } } as AppConfig;
};
beforeEach(() => truncateAll(db));
afterAll(closeTestDb);

it.each(['mainnet', 'testnet'] as const)('%s monitoring prioritizes its own copies and paper, retaining other-network history', async network => {
  const owner = await insertUser(db);
  const other = network === 'mainnet' ? 'testnet' : 'mainnet';
  const rows = [
    { coin: 1, mode: 'paper' as const, network: other, status: 'active' as const, source: null },
    { coin: 2, mode: 'testnet' as const, network, status: 'active' as const, source: 'mainnet' as const },
    { coin: 3, mode: 'testnet' as const, network: other, status: 'active' as const, source: 'mainnet' as const },
    { coin: 4, mode: 'testnet' as const, network, status: 'paused' as const, source: 'mainnet' as const },
    { coin: 5, mode: 'testnet' as const, network, status: 'stopping' as const, source: 'mainnet' as const },
    { coin: 6, mode: 'testnet' as const, network, status: 'stopped' as const, source: 'mainnet' as const },
    { coin: 7, mode: 'testnet' as const, network, status: 'active' as const, source: 'testnet' as const },
    // An eligible paper copy still needs its source, even when the same
    // leader also has an ineligible historical actual copy.
    { coin: 1, mode: 'testnet' as const, network: other, status: 'active' as const, source: 'mainnet' as const },
  ] as const;
  for (const row of rows) {
    const [strategy] = await db.insert(copyStrategies).values({ userId: owner.id, leaderAddress: address(row.coin), mode: row.mode,
      network: row.network, status: row.status, allocated: row.mode === 'paper' ? '100' : '0', cash: row.mode === 'paper' ? '100' : '0',
      activatedAt: new Date(), stoppedAt: row.status === 'stopped' ? new Date() : null }).returning();
    if (row.source) await db.insert(copyLiveStrategyConfigs).values({ strategyId: strategy.id, userId: owner.id,
      idempotencyKey: `network-isolation-${strategy.id}`, sourceNetwork: row.source, budgetUsd: '50', strategyVersion: 1 });
  }
  await db.insert(leaders).values(Array.from({ length: 7 }, (_, i) => ({ address: address(i + 1), active: true, tier: 'A' as const })));
  const config = configFor(network);
  const watcher = new WatcherRepository(db, config);
  const fills = new FillSyncRepository(db, config);
  const copied = await watcher.copiedAddresses();
  expect([...copied.copied].sort()).toEqual([1, 2, 4, 5].map(address));
  expect([...copied.mainnet].sort()).toEqual([2, 4, 5].map(address));
  for (let n = 1; n <= 7; n++) expect(await fills.isCopied(address(n)), `leader ${n}`).toBe([1, 2, 4, 5].includes(n));
  // Ordinary leader monitoring and historical strategies are preserved.
  expect(await watcher.activeAddresses()).toHaveLength(7);
  expect(await db.select().from(copyStrategies)).toHaveLength(rows.length);
});
