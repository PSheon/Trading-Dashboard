import { afterEach, describe, expect, it, vi } from 'vitest';
import { CohortService } from '../src/insights/cohort.service.js';
import type { CohortMemberRow, CohortRepository } from '../src/insights/cohort.repository.js';
import { HyperliquidRestCapacityError } from '../src/hyperliquid/hyperliquid-capacity-error.js';
import { BudgetWaitError, currentBudgetConsumer } from '../src/hyperliquid/request-budgeter.service.js';
import { BackgroundJobs } from '../src/runtime/background-jobs.service.js';
import type { HyperliquidInfoClient } from '../src/hyperliquid/hyperliquid-info.client.js';
import { testConfig } from './config-test-utils.js';

const at = Date.parse('2026-10-10T00:00:00Z');
function member(address: string, rank: number): CohortMemberRow {
  return { chain: 'hyperliquid', address, tier: 'profitable', source: 'pool', rank, pnlAll: '1', roiAll: '1',
    dexes: [], positions: [], perpEquity: '100', fetchedAt: new Date(at - 4 * 3_600_000),
    sweptAt: new Date(at), attemptedAt: null, lastError: null };
}

function setup(fail: (address: string) => unknown, worker = false) {
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
  const config = { value: { ...base, app: { ...base.app, nodeEnv: worker ? 'production' : base.app.nodeEnv }, tuning: { ...base.tuning, discovery: { ...base.tuning.discovery, cohortRefreshMinutes: 40 } } } };
  const info = {
    clearinghouseStates: async (address: string, dexes: readonly string[], _rank: number, onDispatch: () => void): Promise<{assetPositions: never[]; marginSummary: {accountValue: string}}[]> => {
      onDispatch();
      return Promise.all(dexes.map(() => info.clearinghouseState(address)));
    },
    perpDexs: async () => [],
    clearinghouseState: async (address: string) => {
      const error = fail(address);
      if (error) throw error;
      return { assetPositions: [], marginSummary: { accountValue: '100' } };
    },
  };
  const jobs = new BackgroundJobs();
  const service = new CohortService(config as never, repository as unknown as CohortRepository, info as unknown as HyperliquidInfoClient, {} as never, jobs);
  Object.assign(service, { builtAt: at, tokensAt: at - 60_000 });
  return { service, rows, info, jobs, repository, config };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe('cohort refresh retry scheduling', () => {
  it.each([[40, 120], [10, 60]])('passes the %s minute policy\'s exact %s minute freshness cutoff to the real refresh queue', async (interval, freshness) => {
    vi.useFakeTimers(); vi.setSystemTime(at);
    const f = setup(() => undefined);
    f.config.value.tuning.discovery.cohortRefreshMinutes = interval;
    const next = vi.spyOn(f.repository, 'nextDue');
    await f.service.tick(at);
    expect(next).toHaveBeenCalledWith(1, new Date(at - interval * 60_000), expect.objectContaining({
      staleBefore: new Date(at - freshness * 60_000),
    }));
  });

  it.each([1, 1_000, 10_000, 65_000])('resumes other members after the validated %s ms pre-dispatch hint, retaining the failed member cooldown', async (hint) => {
    vi.useFakeTimers(); vi.setSystemTime(at);
    const { service, rows, info } = setup(() => undefined);
    const send = info.clearinghouseStates;
    let busy = true;
    info.clearinghouseStates = async (...args) => {
      if (busy) throw new HyperliquidRestCapacityError(hint);
      return send(...args);
    };
    await service.tick(at);
    expect(service.log[0]).toMatchObject({ calls: 0, weight: 0, ok: false });
    busy = false;
    const retryAt = at + Math.max(1_000, hint);
    vi.setSystemTime(retryAt - 1); await service.tick(Date.now());
    expect(rows[1].attemptedAt).toBeNull();
    vi.setSystemTime(retryAt); await service.tick(Date.now());
    expect(rows[1].fetchedAt?.getTime()).toBe(retryAt);
    expect(rows[0].fetchedAt?.getTime()).toBe(at - 4 * 3_600_000);
    expect(rows[0].lastError).toMatch(/^capacity: /);
  });

  it('does not trust arbitrary retry fields on a local queue error', async () => {
    vi.useFakeTimers(); vi.setSystemTime(at);
    let busy = true;
    const { service, rows, info } = setup(() => undefined);
    const send = info.clearinghouseStates;
    info.clearinghouseStates = async (...args) => {
      if (busy) throw Object.assign(new Error('Hyperliquid queue is full'), { retryAfterMs: 1 });
      return send(...args);
    };
    await service.tick(at); busy = false;
    vi.setSystemTime(at + 60_000); await service.tick(Date.now());
    expect(rows[1].attemptedAt).toBeNull();
    vi.setSystemTime(at + 120_000); await service.tick(Date.now());
    expect(rows[1].fetchedAt?.getTime()).toBe(at + 120_000);
  });

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

// Exercise the real worker entry point: a cron-only retry leaves released
// capacity idle until the next minute, even with a validated shorter hint.
describe('cohort worker capacity wakeup', () => {
  function worker(hint: number, trusted = true) {
    vi.useFakeTimers(); vi.setSystemTime(at);
    const f = setup(() => undefined, true);
    const send = f.info.clearinghouseStates;
    const labels: Array<string | undefined> = [];
    let busy = true;
    f.info.clearinghouseStates = async (...args) => {
      labels.push(currentBudgetConsumer());
      if (busy) throw trusted ? new HyperliquidRestCapacityError(hint)
        : Object.assign(new Error('Hyperliquid queue is full'), { retryAfterMs: hint });
      return send(...args);
    };
    return { ...f, labels, release: () => { busy = false; } };
  }

  it.each([1_000, 10_000])('wakes at the validated %s ms release without a second cron, preserving member cooldown and consumer cap context', async (hint) => {
    const f = worker(hint);
    await f.service.onTick(); f.release();
    await vi.advanceTimersByTimeAsync(hint - 1);
    expect(f.rows[1].attemptedAt).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.rows[1].fetchedAt?.getTime()).toBe(at + hint);
    expect(f.rows[0].fetchedAt?.getTime()).toBe(at - 4 * 3_600_000);
    expect(f.rows[0].lastError).toMatch(/^capacity: /);
    expect(f.labels).toEqual(['cohort', 'cohort']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a cron before release cannot cancel the pending capacity wakeup or start early', async () => {
    const f = worker(10_000);
    await f.service.onTick(); f.release();
    await vi.advanceTimersByTimeAsync(5_000); await f.service.onTick();
    expect(f.rows[1].attemptedAt).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.rows[1].fetchedAt?.getTime()).toBe(at + 10_000);
    expect(f.labels).toHaveLength(2);
  });

  it('module destruction cancels the wakeup and refuses later cron admission', async () => {
    const f = worker(1_000);
    await f.service.onTick(); f.release();
    expect(vi.getTimerCount()).toBe(1);
    f.service.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000); await f.service.onTick();
    expect(f.rows[1].attemptedAt).toBeNull();
    expect(f.labels).toHaveLength(1);
  });

  it('a stopping BackgroundJobs cannot dispatch the scheduled read', async () => {
    const f = worker(1_000);
    await f.service.onTick(); f.release(); f.jobs.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.rows[1].attemptedAt).toBeNull();
    expect(f.labels).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('untrusted retry properties retain the entire conservative pause', async () => {
    const f = worker(1, false);
    await f.service.onTick(); f.release();
    await vi.advanceTimersByTimeAsync(64_999);
    expect(f.rows[1].attemptedAt).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.rows[1].fetchedAt?.getTime()).toBe(at + 65_000);
    expect(f.rows[0].lastError).toMatch(/^capacity: /);
  });

  it('ordinary test environment never starts a worker or arms a timer', async () => {
    vi.useFakeTimers(); vi.setSystemTime(at);
    const f = setup(() => undefined);
    await f.service.onTick(); await vi.advanceTimersByTimeAsync(120_000);
    expect(f.service.log).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('concurrent entries share one flight, including shutdown before it settles', async () => {
    vi.useFakeTimers(); vi.setSystemTime(at);
    const f = setup(() => undefined, true);
    let release!: () => void;
    const tick = vi.spyOn(f.service, 'tick').mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const first = f.service.onTick(), second = f.service.onTick();
    expect(second).toBe(first);
    await Promise.resolve();
    f.service.onModuleDestroy(); release(); await first;
    await vi.advanceTimersByTimeAsync(120_000); await f.service.onTick();
    expect(tick).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
