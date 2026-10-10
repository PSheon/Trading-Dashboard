import { afterEach, describe, expect, it, vi } from 'vitest';
import { CohortService } from '../src/insights/cohort.service.js';
import type { CohortMemberRow, CohortRepository } from '../src/insights/cohort.repository.js';
import { HyperliquidRestCapacityError } from '../src/hyperliquid/hyperliquid-capacity-error.js';
import { BudgetWaitError } from '../src/hyperliquid/request-budgeter.service.js';
import type { HyperliquidInfoClient } from '../src/hyperliquid/hyperliquid-info.client.js';
import { testConfig } from './config-test-utils.js';

const at = Date.parse('2026-10-10T00:00:00Z');
function member(address: string, rank: number): CohortMemberRow {
  return { chain: 'hyperliquid', address, tier: 'profitable', source: 'pool', rank, pnlAll: '1', roiAll: '1',
    dexes: [], positions: [], perpEquity: '100', fetchedAt: new Date(at - 4 * 3_600_000),
    sweptAt: new Date(at), attemptedAt: null, lastError: null };
}

function setup(fail: (address: string) => unknown) {
  const rows = [member('bad', 1), member('healthy', 2)];
  const repository = {
    nextDue: async (_limit: number, before: Date, retries?: { failureBefore: Date; capacityBefore: Date }) => rows.filter(row => {
      const cutoff = row.lastError?.startsWith('capacity: ') ? retries?.capacityBefore : row.lastError ? retries?.failureBefore : before;
      return row.attemptedAt === null || row.attemptedAt < (cutoff ?? before);
    }).sort((a, b) => (a.attemptedAt?.getTime() ?? 0) - (b.attemptedAt?.getTime() ?? 0) || a.rank - b.rank).slice(0, 1),
    saveFailure: async (address: string, attemptedAt: Date, lastError: string) => Object.assign(rows.find(row => row.address === address)!, { attemptedAt, lastError }),
    saveSnapshot: async (address: string, values: object) => Object.assign(rows.find(row => row.address === address)!, values, { attemptedAt: new Date(Date.now()), lastError: null }),
    membersOf: async () => [], identities: async () => [], lastSnapshotAt: async () => new Map(),
  };
  const base = testConfig().value;
  const config = { value: { ...base, tuning: { ...base.tuning, discovery: { ...base.tuning.discovery, cohortRefreshMinutes: 40 } } } };
  const info = {
    perpDexs: async () => [],
    clearinghouseState: async (address: string) => {
      const error = fail(address);
      if (error) throw error;
      return { assetPositions: [], marginSummary: { accountValue: '100' } };
    },
  };
  const service = new CohortService(config as never, repository as unknown as CohortRepository, info as unknown as HyperliquidInfoClient, {} as never);
  Object.assign(service, { builtAt: at, tokensAt: at - 60_000 });
  return { service, rows };
}

afterEach(() => vi.useRealTimers());
describe('cohort refresh retry scheduling', () => {
  it.each([
    ['shared quota', new HyperliquidRestCapacityError(10_000)],
    ['local budget deadline', new BudgetWaitError('cohort', 50_000)],
    ['local queue capacity', new Error('Hyperliquid queue is full')],
  ])('stops a %s tick without failing unrelated members, then recovers before the 40 minute refresh interval', async (_kind, error) => {
    vi.useFakeTimers(); vi.setSystemTime(at);
    let busy = true;
    const { service, rows } = setup(() => busy ? error : undefined);
    await service.tick(at);
    expect(rows[0].fetchedAt?.getTime()).toBe(at - 4 * 3_600_000);
    expect(rows[1].attemptedAt).toBeNull();
    expect(service.log).toHaveLength(1);
    busy = false;
    vi.setSystemTime(at + 60_000); await service.tick(at + 60_000);
    expect(rows[0].fetchedAt?.getTime()).toBe(at - 4 * 3_600_000);
    expect(rows[1].attemptedAt).toBeNull();
    vi.setSystemTime(at + 120_000); await service.tick(at + 120_000);
    expect(rows[0].lastError).toBeNull();
    expect(rows[0].fetchedAt?.getTime()).toBe(at + 120_000);
    expect(rows[1].fetchedAt?.getTime()).toBe(at + 120_000);
  });

  it('backs off provider failures while allowing healthy members through and retries within five minutes', async () => {
    vi.useFakeTimers(); vi.setSystemTime(at);
    const { service, rows } = setup(address => address === 'bad' ? new Error('provider rejected account') : undefined);
    await service.tick(at);
    expect(rows[1].fetchedAt?.getTime()).toBe(at);
    vi.setSystemTime(at + 60_000); await service.tick(at + 60_000);
    expect(service.log.filter(entry => entry.address === 'bad')).toHaveLength(1);
    vi.setSystemTime(at + 6 * 60_000); await service.tick(at + 6 * 60_000);
    expect(service.log.filter(entry => entry.address === 'bad')).toHaveLength(2);
    expect(rows[0].fetchedAt?.getTime()).toBe(at - 4 * 3_600_000);
  });

  it('gives an overdue healthy account its turn ahead of a repeatedly failing account', async () => {
    vi.useFakeTimers(); vi.setSystemTime(at);
    const { service, rows } = setup(address => address === 'bad' ? new Error('provider rejected account') : undefined);
    await service.tick(at);
    for (const minute of [6, 12, 18, 24, 30, 36]) {
      vi.setSystemTime(at + minute * 60_000); await service.tick(Date.now());
    }
    // Membership rebuilding is independent of this retry scheduling test.
    Object.assign(service, { builtAt: at + 41 * 60_000 });
    vi.setSystemTime(at + 41 * 60_000); await service.tick(Date.now());
    expect(rows[1].fetchedAt?.getTime()).toBe(at + 41 * 60_000);
    expect(service.log.at(-1)?.address).toBe('healthy');
    expect(rows[0].fetchedAt?.getTime()).toBe(at - 4 * 3_600_000);
  });
});
