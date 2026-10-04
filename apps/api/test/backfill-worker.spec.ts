import { expect, it, vi } from 'vitest';
import { BackfillWorker } from '../src/jobs/backfill-worker.service.js';
import { BackfillService } from '../src/watcher/backfill.service.js';
import { BackgroundJobs } from '../src/runtime/background-jobs.service.js';
import { TradersWorker } from '../src/traders/traders-worker.module.js';
import { AppConfig } from '../src/config/app-config.js';
import { testConfig } from './config-test-utils.js';
const config = () => new AppConfig({ ...testConfig().value, app: { ...testConfig().value.app, isWorker: true } });
it('coalesces overlapping ticks and uses historical mode without live alert admission', async () => {
  let finish!: (n: number) => void;
  const result = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const repository = {
    claim: vi
      .fn()
      .mockResolvedValue({ id: 1, address: '0xabc', leaseToken: 'lease' }),
    complete: vi.fn(),
    fail: vi.fn(),
  };
  const worker = new BackfillWorker(
    config(),
    repository as never,
    { run: () => result } as never,
    new BackgroundJobs(),
  );
  const tick = worker.tick();
  await Promise.resolve();
  await worker.tick();
  finish(12);
  await tick;
  expect(repository.claim).toHaveBeenCalledTimes(1);
  expect(repository.complete).toHaveBeenCalledWith(
    expect.objectContaining({ id: 1 }),
    12,
  );
  const sync = {
    backfillStep: vi
      .fn()
      .mockResolvedValueOnce({ status: 'pending', inserted: 7 })
      .mockResolvedValue({ status: 'complete', inserted: 5 }),
  };
  // Newest first, window by window, until the history's floor is reached.
  expect(await new BackfillService(sync as never).run('0xabc')).toBe(12);
  expect(sync.backfillStep).toHaveBeenCalledTimes(2);
  expect(sync.backfillStep).toHaveBeenCalledWith('0xabc');
});
it('a stopping worker claims nothing', async () => {
  const repository = { claim: vi.fn() };
  const jobs = new BackgroundJobs();
  jobs.stop();
  await new BackfillWorker(config(), repository as never, { run: vi.fn() } as never, jobs).tick();
  expect(repository.claim).not.toHaveBeenCalled();
});
it('starts the leaderboard import at boot and warms no process-local cache', () => {
  const ingest = { start: vi.fn() };
  const worker = new TradersWorker(ingest as never, {} as never, {} as never);
  worker.onApplicationBootstrap();
  expect(ingest.start).toHaveBeenCalledTimes(1);
  expect('warmTick' in worker).toBe(false);
});
