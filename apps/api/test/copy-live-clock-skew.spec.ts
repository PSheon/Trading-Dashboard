import { describe, expect, it, vi } from 'vitest';
import { ClockSkewMonitor, PROVIDER_CLOCK_SKEW_MS, providerTimeNotAfter } from '../src/copy/live/clock-skew.js';

describe('clock skew between our clock and Hyperliquid\'s (O9)', () => {
  it('a provider time up to the tolerance ahead of our clock is "not after now"; beyond it is not', () => {
    expect(PROVIDER_CLOCK_SKEW_MS).toBe(2000);
    expect(providerTimeNotAfter(1000, 1000)).toBe(true);
    expect(providerTimeNotAfter(3000, 1000)).toBe(true);
    expect(providerTimeNotAfter(3001, 1000)).toBe(false);
    expect(providerTimeNotAfter(Number.NaN, 1000)).toBe(false);
  });
  it('measures the smallest recent (ours − theirs) and warns once a minute above 1 s', () => {
    const log = vi.fn(), monitor = new ClockSkewMonitor(60_000, log);
    expect(monitor.status()).toEqual({ aheadMs: null, samples: 0, warning: false });
    monitor.observe(10_000, 10_300); monitor.observe(20_000, 20_150);
    expect(monitor.status()).toEqual({ aheadMs: 150, samples: 2, warning: false }); expect(log).not.toHaveBeenCalled();
    monitor.observe(30_000, 31_600); monitor.observe(40_000, 41_500);
    // Within the window the smallest sample still rules (latency only adds).
    expect(monitor.aheadMs()).toBe(150);
    // Old samples leave the window: our clock now runs 1.5 s ahead.
    monitor.observe(90_000, 91_500);
    expect(monitor.status()).toEqual({ aheadMs: 1500, samples: 3, warning: true });
    expect(log).toHaveBeenCalledTimes(1); expect(log.mock.calls[0]![0]).toContain('ahead of Hyperliquid by about 1500 ms');
    monitor.observe(100_000, 101_500); expect(log).toHaveBeenCalledTimes(1);
    // Behind: provider times ahead of ours.
    const behind = new ClockSkewMonitor(60_000, log); behind.observe(10_000, 8_500);
    expect(behind.status()).toMatchObject({ aheadMs: -1500, warning: true }); expect(log.mock.calls.at(-1)![0]).toContain('behind');
  });
});
