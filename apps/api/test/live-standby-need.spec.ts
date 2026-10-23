import { describe, expect, it } from 'vitest';
import type { LiveMandateWork } from '../src/copy/live-worker/copy-live-worker.repository.js';
import { liveStandbyNeed } from '../src/copy/live-worker/live-standby-need.js';
import { LiveReadCache } from '../src/copy/live/live-read-cache.js';
import { assertLiveEvidenceCapacity, evidenceFinalCheck, evidenceFirstWave } from '../src/copy/live/live-shared-reads.js';
import { observerRestWeight } from '../src/copy/live/live-account-observer.js';
import { LIVE_SETTLEMENT_WEIGHT } from '../src/config/constants/weights.js';

// Design §8 I-14: the live standby (c8e8f7d7) kept the startup bound free
// (the heaviest evidence the bucket must hold: 793 with two accounts and the
// leader) while any copy ran, so background had ~400 of the window with one
// account copying. It now keeps what the running copies' heaviest order
// actually needs: ~385 for one account cold, ~65 (+4 for a ratio leader on
// the same network) once the read cache holds the account's modes. Plus
// that order's settlement (Stage mainnet 2026-10-18: the order's evidence
// spent the standby's room and its settlement's 266 waited 26.7 s): its
// fill scan, market and orderStatus (282) and the account's observation.
const A1 = '0x' + '1'.repeat(40), A2 = '0x' + '2'.repeat(40), LEADER = '0x' + 'a'.repeat(40);
const STARTUP_BOUND = assertLiveEvidenceCapacity({ capacity: 900, maxStrategiesPerUser: 2, network: 'testnet', budgetPerMin: 300 }).weight;
function mandate(over: Partial<LiveMandateWork> = {}): LiveMandateWork {
  return { mandateId: 'm1', userId: 7, strategyId: 1, accountId: 'acct-1', accountAddress: A1, sourceNetwork: 'mainnet', leaderAddress: LEADER, cursor: new Date(0),
    expiresAt: new Date(8.64e15), strategyStatus: 'active', activated: true, activatedAt: new Date(0), sizingMode: 'fixed', budgetUsd: null, ...over };
}
/** A cache holding what an order on `user` keeps across orders (its modes, fees and the markets). */
function warm(...users: string[]): LiveReadCache {
  const cache = new LiveReadCache();
  const value = (type: string) => type === 'userRole' ? { role: 'user' } : type === 'userAbstraction' ? 'disabled' : type === 'userDexAbstraction' ? false : {};
  for (const user of users) for (const body of [...evidenceFirstWave([user], user, 'BTC'), ...evidenceFinalCheck([user])]) cache.put(body, value(String(body.type)));
  return cache;
}

/** The settlement of an order on `user` (LIVE_SETTLEMENT_WEIGHT and its observation less what `cache` holds). */
const settlement = (cache: LiveReadCache, user = A1) => LIVE_SETTLEMENT_WEIGHT + observerRestWeight(user, cache);

describe('the live standby holds the running copies\' actual need (liveStandbyNeed)', () => {
  it('one account, cold: 385 (its evidence 364 + the boundary 21), not the startup bound 793, and its settlement', () => {
    expect(STARTUP_BOUND).toBe(793);
    expect(LIVE_SETTLEMENT_WEIGHT).toBe(282);
    expect(liveStandbyNeed([mandate()], 'testnet', STARTUP_BOUND, new LiveReadCache())).toBe(385 + settlement(new LiveReadCache()));
  });

  it('one account, the cache warm: 65; a ratio copy of a leader on the same network reads its spot state too: 69 (each with its settlement)', () => {
    expect(liveStandbyNeed([mandate()], 'testnet', STARTUP_BOUND, warm(A1))).toBe(65 + settlement(warm(A1)));
    expect(liveStandbyNeed([mandate({ sourceNetwork: 'testnet', sizingMode: 'ratio' })], 'testnet', STARTUP_BOUND, warm(A1))).toBe(69 + settlement(warm(A1)));
    // The cached address is the one the runtime reads (lower case).
    expect(liveStandbyNeed([mandate({ accountAddress: A1.toUpperCase().replace('0X', '0x') })], 'testnet', STARTUP_BOUND, warm(A1))).toBe(65 + settlement(warm(A1)));
  });

  it('the heaviest of the running copies; an owner\'s other accounts count as uncached; its order never above the startup bound', () => {
    const two = [mandate(), mandate({ mandateId: 'm2', accountId: 'acct-2', accountAddress: A2 })];
    const need = liveStandbyNeed(two, 'testnet', STARTUP_BOUND, warm(A1, A2));
    expect(need).toBeGreaterThan(65 + settlement(warm(A1, A2)));
    expect(need).toBe(65 + 204 + settlement(warm(A1, A2)));
    expect(liveStandbyNeed(two, 'testnet', 500, new LiveReadCache())).toBe(500 + settlement(new LiveReadCache()));
    // Another owner's account does not add to this one's order.
    expect(liveStandbyNeed([mandate(), mandate({ mandateId: 'm3', userId: 8, accountId: 'acct-3', accountAddress: A2 })], 'testnet', STARTUP_BOUND, warm(A1, A2))).toBe(65 + settlement(warm(A1, A2)));
  });

  it('a generation that does not mirror its leader yet holds nothing', () => {
    expect(liveStandbyNeed([mandate({ activated: false })], 'testnet', STARTUP_BOUND, new LiveReadCache())).toBe(0);
    expect(liveStandbyNeed([mandate({ strategyStatus: 'stopped' })], 'testnet', STARTUP_BOUND, new LiveReadCache())).toBe(0);
  });
});
