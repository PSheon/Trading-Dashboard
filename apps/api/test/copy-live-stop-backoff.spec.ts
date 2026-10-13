import { afterEach, expect, it, vi } from 'vitest';
import { CopyLiveStopper, type StopperDependencies } from '../src/copy/live-worker/copy-live-stopper.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';
import { HyperliquidRestCapacityError } from '../src/hyperliquid/hyperliquid-capacity-error.js';

/**
 * Gate 2026-10-13 11:16 UTC (7th run): the stop after the refused order
 * logged `stop 386ca44e… kept for the next pass:
 * live_account_observation_unavailable` many times a second: every pass
 * stepped it again, each step opening the account's sockets into a connect
 * window the shared meter had just refused. A failed step now waits as a
 * copy leg's retry does (live/error-class.ts liveRetryDelayMs).
 */
afterEach(() => { vi.restoreAllMocks(); });
/** What the account observer throws when the meter refused its socket connect underneath. */
const refused = (retryMs: number) => Object.assign(new LiveBoundaryError('live_account_observation_unavailable'), { cause: new HyperliquidRestCapacityError(retryMs) });

function stopper() {
  let clock = 1_800_000_000_000;
  const issue = vi.fn(async () => undefined);
  const repository = { expirePendingRevokes: async () => [], open: async () => [{ id: 's1' }], issue };
  const stop = new CopyLiveStopper({ repository, closer: {}, canceller: null, swept: async () => false, log: () => undefined } as unknown as StopperDependencies, () => clock);
  return { stop, issue, advance: (ms: number) => { clock += ms; } };
}

it("a stop whose observation the meter refused is stepped again when the meter said, not on every pass", async () => {
  const { stop, issue, advance } = stopper();
  const step = vi.spyOn(stop, 'step').mockRejectedValue(refused(4_000));
  // Passes every 250 ms for 4 s: one step, not sixteen.
  for (let i = 0; i < 16; i++) { await stop.tick(); advance(250); }
  expect(step).toHaveBeenCalledTimes(1);
  expect(issue).toHaveBeenCalledWith({ id: 's1' }, 'live_account_observation_unavailable');
  advance(300); await stop.tick();
  expect(step).toHaveBeenCalledTimes(2);
});

it('a busy lock a second later, a failed read 10 s later, anything else 3 s later; a step that went through clears it', async () => {
  const { stop, advance } = stopper();
  const step = vi.spyOn(stop, 'step').mockRejectedValueOnce(new LiveBoundaryError('live_risk_busy'))
    .mockRejectedValueOnce(Object.assign(new LiveBoundaryError('live_account_observation_unavailable'), { cause: new TypeError('fetch failed') }))
    .mockRejectedValueOnce(new TypeError('boom')).mockResolvedValue(undefined);
  await stop.tick(); advance(999); await stop.tick();
  expect(step).toHaveBeenCalledTimes(1);
  advance(1); await stop.tick();
  expect(step).toHaveBeenCalledTimes(2);
  advance(9_999); await stop.tick();
  expect(step).toHaveBeenCalledTimes(2);
  advance(1); await stop.tick();
  expect(step).toHaveBeenCalledTimes(3);
  advance(3_000); await stop.tick();
  expect(step).toHaveBeenCalledTimes(4);
  // Through: the next pass steps it again at once.
  await stop.tick();
  expect(step).toHaveBeenCalledTimes(5);
});
