import { expect, it, vi } from 'vitest';
import { beginLiveExecutionTiming, type LiveExecutionTiming } from '../src/copy/live/live-execution-diagnostics.js';

it('records successive elapsed costs without resetting the original financial clock', () => {
  let clock = 1000;
  const events: Readonly<LiveExecutionTiming>[] = [];
  const mark = beginLiveExecutionTiming('testnet', 'submit', () => clock, event => { events.push(event); });
  clock += 90;
  mark('risk_local_read');
  clock += 230;
  mark('risk_provider_epoch');
  expect(events).toEqual([
    { network: 'testnet', phase: 'submit', stage: 'risk_local_read', elapsedMs: 90, totalMs: 90, clockValid: true },
    { network: 'testnet', phase: 'submit', stage: 'risk_provider_epoch', elapsedMs: 230, totalMs: 320, clockValid: true },
  ]);
  expect(clock).toBe(1320);
  expect(events.every(Object.isFrozen)).toBe(true);
});

it('does not consult the clock or execute work when no observer is configured', () => {
  const clock = vi.fn(() => { throw Error('clock unavailable'); });
  beginLiveExecutionTiming('testnet', 'sign', clock)('executor_sign');
  expect(clock).not.toHaveBeenCalled();
});

it('cannot throw into execution when the observer or observation clock fails', () => {
  const mark = beginLiveExecutionTiming('testnet', 'hold', () => 1000, () => { throw Error('private token'); });
  expect(() => mark('risk_local_read')).not.toThrow();
  expect(() => beginLiveExecutionTiming('testnet', 'hold', () => { throw Error('clock'); }, () => {})('risk_local_read')).not.toThrow();
});

it('absorbs an asynchronous observer rejection and never includes provider or authorization data', async () => {
  const event = vi.fn(async (_event: Readonly<LiveExecutionTiming>) => { throw Error('private-provider-token'); });
  beginLiveExecutionTiming('testnet', 'hold', () => 1000, event)('risk_generation_projection');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(event).toHaveBeenCalledOnce();
  expect(Object.keys(event.mock.calls[0]![0])).toEqual(['network', 'phase', 'stage', 'elapsedMs', 'totalMs', 'clockValid']);
  expect(JSON.stringify(event.mock.calls)).not.toContain('private-provider-token');
});

it.each([NaN, Infinity, -1, 999])('marks invalid or backward observation clocks as zero cost: %s', clock => {
  let now = 1000;
  const events: Readonly<LiveExecutionTiming>[] = [];
  const mark = beginLiveExecutionTiming('testnet', 'sign', () => now, event => { events.push(event); });
  now = clock;
  mark('executor_sign');
  expect(events[0]?.elapsedMs).toBe(0);
  expect(events[0]?.totalMs).toBe(0);
  expect(events[0]?.clockValid).toBe(false);
});
