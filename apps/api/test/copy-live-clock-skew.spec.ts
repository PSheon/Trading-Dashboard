import { describe, expect, it, vi } from 'vitest';
import { CLOCK_SKEW_SAMPLES, ClockSkewMonitor, PROVIDER_CLOCK_SKEW_MS, providerTimeNotAfter } from '../src/copy/live/clock-skew.js';

describe('clock skew between our clock and Hyperliquid\'s (O9)', () => {
  it('a provider time up to the tolerance ahead of our clock is "not after now"; beyond it is not', () => {
    expect(PROVIDER_CLOCK_SKEW_MS).toBe(2000);
    expect(providerTimeNotAfter(1000, 1000)).toBe(true);
    expect(providerTimeNotAfter(3000, 1000)).toBe(true);
    expect(providerTimeNotAfter(3001, 1000)).toBe(false);
    expect(providerTimeNotAfter(Number.NaN, 1000)).toBe(false);
  });
  it('measures the median recent (ours − theirs) and warns once a minute above 1 s', () => {
    const log = vi.fn(), monitor = new ClockSkewMonitor(60_000, log);
    expect(monitor.status()).toEqual({ aheadMs: null, samples: 0, warning: false });
    monitor.observe(10_000, 10_300); monitor.observe(20_000, 20_150);
    expect(monitor.status()).toEqual({ aheadMs: 225, samples: 2, warning: false }); expect(log).not.toHaveBeenCalled();
    monitor.observe(30_000, 30_200);
    expect(monitor.aheadMs()).toBe(200);
    // Old samples leave the window: our clock now runs 1.5 s ahead.
    monitor.observe(90_000, 91_500); monitor.observe(95_000, 96_500);
    expect(monitor.status()).toEqual({ aheadMs: 1500, samples: 2, warning: true });
    expect(log).toHaveBeenCalledTimes(1); expect(log.mock.calls[0]![0]).toMatch(/^WARN clock skew: our clock runs ahead of Hyperliquid by about 1500 ms/);
    monitor.observe(100_000, 101_500); expect(log).toHaveBeenCalledTimes(1);
    // Behind: provider times ahead of ours.
    const behind = new ClockSkewMonitor(60_000, log); behind.observe(10_000, 8_500);
    expect(behind.status()).toMatchObject({ aheadMs: -1500, warning: true }); expect(log.mock.calls.at(-1)![0]).toContain('behind');
  });
  it('one odd sample does not move the estimate; it is the median of the last samples only (O9b)', () => {
    const log = vi.fn(), monitor = new ClockSkewMonitor(60_000, log);
    for (let i = 0; i < 6; i++) monitor.observe(1000 + i * 100, 1000 + i * 100 + 120);
    // A provider time stamped 5 s ahead (ours "behind" by 5 s), once.
    monitor.observe(1700 + 5000, 1700);
    expect(monitor.aheadMs()).toBe(120); expect(log).not.toHaveBeenCalled();
    // A stale answer (ours "ahead" by 9 s), once.
    monitor.observe(2000, 11_000);
    expect(monitor.aheadMs()).toBe(120);
    // Only the last CLOCK_SKEW_SAMPLES count: the old 120 ms samples leave.
    expect(CLOCK_SKEW_SAMPLES).toBe(15);
    for (let i = 0; i < 15; i++) monitor.observe(20_000 + i * 100, 20_000 + i * 100 + 800);
    expect(monitor.status()).toEqual({ aheadMs: 800, samples: 15, warning: false });
  });
  it('alerts (once a minute) when the estimate is beyond the 2 s tolerance (O9b)', () => {
    const log = vi.fn(), monitor = new ClockSkewMonitor(60_000, log);
    monitor.observe(10_000, 11_500); // 1.5 s: WARN
    expect(log).toHaveBeenCalledTimes(1); expect(log.mock.calls[0]![0]).toMatch(/^WARN clock skew/);
    monitor.observe(20_000, 22_600); // median of 1.5 s and 2.6 s: ALERT, despite the WARN 10 s ago
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]![0]).toMatch(/^ALERT clock skew: our clock runs ahead of Hyperliquid by about 2050 ms/);
    monitor.observe(21_000, 23_600); expect(log).toHaveBeenCalledTimes(2); expect(monitor.aheadMs()).toBe(2600);
    monitor.observe(30_000, 32_600); expect(log).toHaveBeenCalledTimes(2);
    monitor.observe(85_000, 87_600); expect(log).toHaveBeenCalledTimes(3); expect(log.mock.calls[2]![0]).toMatch(/^ALERT clock skew/);
    const behind = new ClockSkewMonitor(60_000, log); behind.observe(13_000, 10_000);
    expect(log.mock.calls.at(-1)![0]).toMatch(/^ALERT clock skew: our clock runs behind Hyperliquid by about 3000 ms/);
  });
});
