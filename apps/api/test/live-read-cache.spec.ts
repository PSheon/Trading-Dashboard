import { describe, expect, it, vi } from 'vitest';
import { LiveReadCache } from '../src/copy/live/live-read-cache.js';
import { evidenceFinalCheck, evidenceFirstWave, liveEvidencePrepaidWeight, liveEvidenceWarmWeight, liveEvidenceWeight, liveInfoWeights, LiveSharedReads } from '../src/copy/live/live-shared-reads.js';

/**
 * The cross-order read cache (2026-10-12): an order's evidence read 589 weight,
 * 200 of each account's 204 for facts that never or rarely change. Only an
 * order-safe value is kept; what changes is read by every order.
 */
const user = `0x${'11'.repeat(20)}`, leader = `0x${'22'.repeat(20)}`;
const value = (body: { type: string; user?: string }): unknown => {
  switch (body.type) {
    case 'userRole': return { role: 'user' };
    case 'userAbstraction': return body.user === leader ? 'default' : 'disabled';
    case 'userDexAbstraction': return body.user === leader ? null : false;
    case 'spotClearinghouseState': return { balances: [] };
    case 'perpDexs': return [null];
    default: return { type: body.type };
  }
};
function epoch(cache: LiveReadCache, clock: { now: number }) {
  const sent: string[] = [];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { type: string; user?: string };
    sent.push(body.type);
    return Response.json(value(body));
  }) as unknown as typeof fetch;
  const paid: number[] = [];
  const shared = new LiveSharedReads('testnet', fetcher, undefined, () => clock.now, 5000, async (weight: number) => { paid.push(weight); }, cache);
  return { shared, sent, paid };
}
async function order(cache: LiveReadCache, clock: { now: number }, users: string[]) {
  const e = epoch(cache, clock), first = evidenceFirstWave(users, users[0]!, 'BTC'), final = evidenceFinalCheck(users);
  e.shared.pin([...first, ...final]);
  await e.shared.pay(e.shared.weightOf(first) + e.shared.checkWeightOf(final));
  await e.shared.wave(first);
  for (const body of first) await e.shared.get(body);
  await e.shared.unchanged(final, 'live_account_observation_changed');
  return e;
}

describe('the cross-order evidence read cache', () => {
  it('a second order reads only what changes: 589 weight cold, 44 warm for one account and its leader', async () => {
    const cache = new LiveReadCache(() => clock.now), clock = { now: 1_000_000 };
    const cold = await order(cache, clock, [user]);
    expect(cold.paid.reduce((a, b) => a + b, 0)).toBe(liveEvidencePrepaidWeight(1));
    clock.now += 10_000;
    const warm = await order(cache, clock, [user]);
    expect(warm.sent.sort()).toEqual(['activeAssetData', 'metaAndAssetCtxs', 'spotClearinghouseState', 'spotClearinghouseState']);
    expect(warm.paid.reduce((a, b) => a + b, 0)).toBe(liveEvidenceWarmWeight(1));
    expect(liveEvidenceWarmWeight(1)).toBe(44);
  });
  it('never keeps a value an order may not go on: a default-mode account is read anew by every order', async () => {
    const cache = new LiveReadCache(() => clock.now), clock = { now: 1_000_000 };
    await order(cache, clock, [user, leader]);
    clock.now += 10_000;
    const warm = await order(cache, clock, [user, leader]);
    // The leader's abstraction (default) and dex abstraction (null): read again, twice (first wave and final check).
    expect(warm.sent.filter(t => t === 'userAbstraction')).toHaveLength(2);
    expect(warm.sent.filter(t => t === 'userDexAbstraction')).toHaveLength(2);
    expect(warm.sent.filter(t => t === 'userRole')).toHaveLength(0);
  });
  it('forgets each kept value after its time: modes and fees after 5 min, metadata after 60 s, a role after 30 min', async () => {
    const cache = new LiveReadCache(() => clock.now), clock = { now: 1_000_000 };
    await order(cache, clock, [user]);
    clock.now += 61_000;
    expect((await order(cache, clock, [user])).sent).toEqual(expect.arrayContaining(['perpDexs', 'spotMeta', 'allPerpMetas', 'meta']));
    clock.now += 5 * 60_000;
    const later = await order(cache, clock, [user]);
    expect(later.sent).toEqual(expect.arrayContaining(['userAbstraction', 'userDexAbstraction', 'userFees']));
    expect(later.sent).not.toContain('userRole');
    clock.now += 30 * 60_000;
    expect((await order(cache, clock, [user])).sent).toContain('userRole');
  });
  it('forget(user) drops that account\'s kept modes and fees, not another\'s', () => {
    const cache = new LiveReadCache(() => 0), other = `0x${'33'.repeat(20)}`;
    for (const u of [user, other]) { cache.put({ type: 'userAbstraction', user: u }, 'disabled'); cache.put({ type: 'userFees', user: u }, { fee: 1 }); }
    cache.forget(user.toUpperCase().replace('0X', '0x'));
    expect(cache.get({ type: 'userAbstraction', user })).toBeUndefined();
    expect(cache.get({ type: 'userAbstraction', user: other })).toBe('disabled');
    expect(liveInfoWeights([{ type: 'userRole', user }])).toBe(60);
  });
});

describe('a standalone account observation (snapshots, closes, settlements)', () => {
  it('pays and reads only what the cross-order cache does not hold: 284 cold, 4 warm for a standard account', async () => {
    const { observerRestWeight } = await import('../src/copy/live/live-account-observer.js');
    const cache = new LiveReadCache(() => 0);
    expect(observerRestWeight(user, cache)).toBe(284);
    for (const [body, v] of [[{ type: 'userRole', user }, { role: 'user' }], [{ type: 'userAbstraction', user }, 'disabled'], [{ type: 'userDexAbstraction', user }, false],
      [{ type: 'perpDexs' }, [null]], [{ type: 'spotMeta' }, {}], [{ type: 'allPerpMetas' }, []]] as const) cache.put(body, v);
    expect(observerRestWeight(user, cache)).toBe(4);
    // A default-mode account keeps paying for its modes.
    expect(observerRestWeight(leader, cache)).toBe(4 + 2 * (60 + 20 + 20));
  });
});

describe('a copied leader in the evidence (ratio from its own network)', () => {
  it('reads only its spot state, cold or warm: its role and modes are never read', () => {
    const cache = new LiveReadCache(() => 0);
    expect(evidenceFirstWave([user], user, 'BTC', [leader]).filter(b => (b as { user?: string }).user === leader)).toEqual([{ type: 'spotClearinghouseState', user: leader }]);
    expect(evidenceFinalCheck([user], [leader]).filter(b => (b as { user?: string }).user === leader)).toEqual([{ type: 'spotClearinghouseState', user: leader }]);
    expect(liveEvidenceWeight([user], 0, cache, [leader])).toBe(liveEvidencePrepaidWeight(1) + 4);
    for (const [body, v] of [[{ type: 'userRole', user }, { role: 'user' }], [{ type: 'userAbstraction', user }, 'disabled'], [{ type: 'userDexAbstraction', user }, false],
      [{ type: 'perpDexs' }, [null]], [{ type: 'spotMeta' }, {}], [{ type: 'allPerpMetas' }, []], [{ type: 'meta' }, {}], [{ type: 'userFees', user }, {}]] as const) cache.put(body, v);
    expect(liveEvidenceWeight([user], 0, cache, [leader])).toBe(48);
  });
});
