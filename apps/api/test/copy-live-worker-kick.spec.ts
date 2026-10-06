import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundJobs } from '../src/runtime/background-jobs.service.js';
import type { CopyLiveEngine } from '../src/copy/live-worker/copy-live-engine.js';
import { CopyLiveWorkerService } from '../src/copy/live-worker/copy-live-worker.service.js';
import { testConfig } from './config-test-utils.js';

const T0 = 1_790_000_000_000, leader = `0x${'44'.repeat(20)}`, G = 2000;
afterEach(() => { vi.useRealTimers(); });

function setup() {
  const log: string[] = [];
  let releasePass: (() => void) | undefined, followUp: number | null = null;
  const engine = {
    witness: vi.fn((_leader: string, _tid: number, time: number) => time + G + 100),
    followUp: vi.fn(() => { const next = followUp; followUp = null; return next; }),
    signal: vi.fn(async (who: string) => { log.push(`signal ${who} @${Date.now() - T0}`); return true; }),
    workLeader: vi.fn(async (who: string) => { log.push(`kick ${who} @${Date.now() - T0}`); }),
    audit: vi.fn(async (who: string) => { log.push(`audit ${who}`); return []; }),
    tick: vi.fn(async () => { log.push(`pass start @${Date.now() - T0}`); await new Promise<void>(resolve => { releasePass = resolve; }); log.push('pass end'); }),
  };
  const service = new CopyLiveWorkerService(testConfig(), new BackgroundJobs(), engine as unknown as CopyLiveEngine);
  service.start(3_600_000);
  return { service, engine, log, releasePass: () => releasePass?.(), setFollowUp: (at: number) => { followUp = at; } };
}

describe('copy live worker: realtime kicks', () => {
  it('reads a leader once its feed trade is G old, even during a pass; its orders wait for the pass', async () => {
    vi.useFakeTimers({ now: T0 });
    const { service, engine, log, releasePass } = setup();
    service.onLeaderTraded({ address: leader, time: T0 - 500, tid: 1 });
    service.onLeaderTraded({ address: leader, time: T0 - 200, tid: 2 }); // later: the earlier kick stands
    await vi.advanceTimersByTimeAsync(1599);
    expect(engine.workLeader).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(engine.workLeader).toHaveBeenCalledTimes(1); expect(log).toEqual([`signal ${leader} @1600`, `kick ${leader} @1600`]);
    // A pass is running when the next trade's kick falls due.
    const pass = service.tick();
    service.onLeaderTraded({ address: leader, time: T0 + 1600, tid: 3 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(engine.workLeader).toHaveBeenCalledTimes(1);
    releasePass(); await pass;
    // The signal is read at 3700, during the pass; the order half after it.
    expect(log.slice(2)).toEqual(['pass start @1600', `signal ${leader} @3700`, 'pass end', `kick ${leader} @6600`]);
    service.onModuleDestroy();
  });

  it('reads again when the source still waits for a reported trade, and audits after the watcher verified', async () => {
    vi.useFakeTimers({ now: T0 });
    const { service, engine, setFollowUp } = setup();
    setFollowUp(T0 + 1000 + 3000);
    service.onLeaderTraded({ address: leader, time: T0 - 2100, tid: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.workLeader).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3999);
    expect(engine.workLeader).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(engine.workLeader).toHaveBeenCalledTimes(2);
    service.onLeaderVerified({ address: leader });
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.audit).toHaveBeenCalledWith(leader);
    service.onModuleDestroy();
  });

  it('ignores triggers before it started (tests, paper mode)', async () => {
    const engine = { witness: vi.fn(() => T0), signal: vi.fn(), workLeader: vi.fn() };
    const service = new CopyLiveWorkerService(testConfig(), new BackgroundJobs(), engine as unknown as CopyLiveEngine);
    service.onLeaderTraded({ address: leader, time: T0, tid: 1 });
    expect(engine.witness).not.toHaveBeenCalled();
  });
});
