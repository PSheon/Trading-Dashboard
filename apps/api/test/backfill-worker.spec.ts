import { expect, it, vi } from 'vitest';
import { BackfillWorker } from '../src/jobs/backfill-worker.service.js';
import { BackfillService } from '../src/watcher/backfill.service.js';
import { BackgroundJobs } from '../src/runtime/background-jobs.service.js';
import { TradersWorker } from '../src/traders/traders-worker.module.js';
import { AppConfig } from '../src/config/app-config.js';
import { testConfig } from './config-test-utils.js';
const config = (role: 'api' | 'worker' | 'combined') =>
  new AppConfig({
    ...testConfig().value,
    app: { ...testConfig().value.app, role },
  });
it('API role neither claims work nor directly executes a historical sync', async () => {
  const repository = { claim: vi.fn() };
  const sync = { sync: vi.fn() };
  const backfill = new BackfillService(config('api'), sync as never);
  await new BackfillWorker(
    config('api'),
    repository as never,
    backfill,
    new BackgroundJobs(),
  ).tick();
  await expect(backfill.run('0xabc')).rejects.toThrow('requires worker role');
  expect(repository.claim).not.toHaveBeenCalled();
  expect(sync.sync).not.toHaveBeenCalled();
});
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
    config('worker'),
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
  const sync = { sync: vi.fn().mockResolvedValue({ fetched: 12 }) };
  await new BackfillService(config('worker'), sync as never).run('0xabc');
  expect(sync.sync).toHaveBeenCalledWith('0xabc', 'backfill', 0);
});
it('does not warm a worker-local cache that API requests cannot use', () => {
  const ingest = { start: vi.fn() },
    traders = { startWarming: vi.fn(), onWarmSchedule: vi.fn() };
  const worker = new TradersWorker(
    config('worker'),
    ingest as never,
    traders as never,
    {} as never,
    {} as never,
  );
  worker.onApplicationBootstrap();
  worker.warmTick();
  expect(ingest.start).toHaveBeenCalledTimes(1);
  expect(traders.startWarming).not.toHaveBeenCalled();
  expect(traders.onWarmSchedule).not.toHaveBeenCalled();
  const combined = new TradersWorker(
    config('combined'),
    ingest as never,
    traders as never,
    {} as never,
    {} as never,
  );
  combined.onApplicationBootstrap();
  combined.warmTick();
  expect(traders.startWarming).toHaveBeenCalledTimes(1);
  expect(traders.onWarmSchedule).toHaveBeenCalledTimes(1);
});
