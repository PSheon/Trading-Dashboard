import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { BackgroundJobs } from '../src/runtime/background-jobs.service.js';
import type { HlWsTrade } from '../src/hyperliquid/types.js';
import type { AccountStateService } from '../src/watcher/account-state.service.js';
import type { FeedActionsService } from '../src/watcher/feed-actions.service.js';
import type { FillSyncService } from '../src/watcher/fill-sync.service.js';
import type { TradeFeedService } from '../src/watcher/trade-feed.service.js';
import type { WatcherRepository } from '../src/watcher/watcher.repository.js';
import { COPY_LEADER_TRADED_EVENT, COPY_LEADER_VERIFIED_EVENT } from '../src/watcher/copy-leader-events.js';
import { WatcherService } from '../src/watcher/watcher.service.js';
import { COPIED_CATCH_UP_MS } from '../src/config/constants/background.js';

const T0 = 1_790_000_000_000;
const trade = (tid: number, time: number): HlWsTrade => ({ coin: 'BTC', side: 'B', px: '1', sz: '1', time, hash: '0x', tid, users: ['0xa', '0xz'] });

function setup(active: string[], copied: string[], mainnet: string[]) {
  const emit = vi.fn(), order: string[] = [];
  const catchUp = vi.fn(async (address: string) => { order.push(address); return { inserted: 0, actions: 0, complete: true, through: 0 }; });
  const repository = { activeAddresses: async () => active, copiedAddresses: async () => ({ copied: new Set(copied), mainnet: new Set(mainnet) }) };
  const watcher = new WatcherService({ setWatched: vi.fn(), status: () => ({}), start: async () => {}, stop: async () => {} } as unknown as TradeFeedService,
    { sync: vi.fn(async () => ({ fetched: 0, inserted: 0, actions: 0, missingTids: [], latestFillTime: null })), catchUp,
      getLastFillAt: () => null, getFastPathStats: () => ({ verified: 0, corrected: 0 }) } as unknown as FillSyncService,
    { getEquityUsd: () => null, dropBooks: vi.fn() } as unknown as AccountStateService,
    { process: vi.fn(async () => 0) } as unknown as FeedActionsService,
    repository as unknown as WatcherRepository, new BackgroundJobs(), { emit } as unknown as EventEmitter2);
  return { watcher, emit, order };
}
afterEach(() => { vi.useRealTimers(); });

describe('watcher: realtime copy triggers', () => {
  it('emits a copy trigger at once for a leader a testnet copy follows on mainnet, and only for those', async () => {
    vi.useFakeTimers({ now: T0 });
    const { watcher, emit } = setup(['0xa', '0xb'], ['0xa', '0xb'], ['0xa']);
    await watcher.refreshWatched();
    watcher.onTrade('0xa', trade(7, T0 - 300));
    watcher.onTrade('0xb', trade(8, T0 - 200));
    expect(emit.mock.calls.filter(c => c[0] === COPY_LEADER_TRADED_EVENT)).toEqual([[COPY_LEADER_TRADED_EVENT, { address: '0xa', time: T0 - 300, tid: 7 }]]);
    watcher.stop();
  });

  it('a running watcher (the copy or all worker) sweeps copied leaders first and has each audited after its catch-up', async () => {
    const { watcher, emit, order } = setup(['0xc', '0xd', '0xe', '0xf', '0xg', '0xa'], ['0xa'], []);
    await watcher.start();
    await watcher.sweep();
    watcher.stop();
    expect(order[0]).toBe('0xa');
    expect(new Set(emit.mock.calls.filter(c => c[0] === COPY_LEADER_VERIFIED_EVENT).map(c => JSON.stringify(c)))).toEqual(new Set([JSON.stringify([COPY_LEADER_VERIFIED_EVENT, { address: '0xa' }])]));
  });

  it('a read worker\'s sweep (a watcher never started) still catches copied leaders up first, but emits no audit: nothing listens there; the copy worker\'s catchUpCopied audits them', async () => {
    vi.useFakeTimers({ now: T0 });
    const read = setup(['0xc', '0xd', '0xa'], ['0xa'], []);
    await read.watcher.sweep();
    expect(read.order[0]).toBe('0xa');
    expect(read.emit).not.toHaveBeenCalled();
    // The copy worker's watcher runs: its periodic catch-up audits the copied leader.
    const copy = setup(['0xc', '0xd', '0xa'], ['0xa'], []);
    await copy.watcher.start();
    await vi.waitFor(() => expect(copy.emit).toHaveBeenCalledWith(COPY_LEADER_VERIFIED_EVENT, { address: '0xa' }));
    copy.emit.mockClear(); copy.order.length = 0;
    await vi.advanceTimersByTimeAsync(COPIED_CATCH_UP_MS);
    expect(copy.order).toContain('0xa');
    expect(copy.emit.mock.calls.filter(c => c[0] === COPY_LEADER_VERIFIED_EVENT)).toEqual([[COPY_LEADER_VERIFIED_EVENT, { address: '0xa' }]]);
    copy.watcher.stop();
  });

  it('catches up every watched copied leader between sweeps', async () => {
    const { watcher, emit, order } = setup(['0xa', '0xb'], ['0xa', '0xq'], ['0xa']);
    await watcher.start();
    await vi.waitFor(() => expect(order).toContain('0xa'));
    order.length = 0;
    await watcher.catchUpCopied();
    watcher.stop();
    expect(order).toEqual(['0xa']); // 0xq is not watched
    expect(emit).toHaveBeenCalledWith(COPY_LEADER_VERIFIED_EVENT, { address: '0xa' });
  });
});
