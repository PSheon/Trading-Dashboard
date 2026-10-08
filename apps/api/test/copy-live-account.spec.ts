import { describe, expect, it, vi } from 'vitest';
import { HyperliquidLiveAccountObserver, HyperliquidAllDexsAccountSource } from '../src/copy/live/live-account-observer.js';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {offlineGlobalTransport} from './hyperliquid-global-test-utils.js';
import type {HyperliquidSocketQuota} from '../src/hyperliquid/postgres-hyperliquid-quota.js';

const account = `0x${'22'.repeat(20)}`;
const now = 1_790_000_000_000;
const mainPosition = { type: 'oneWay', position: { coin: 'BTC', szi: '-0.01', entryPx: '65000',
  positionValue: '660', unrealizedPnl: '-10', marginUsed: '66', maxLeverage: 40,
  leverage: { type: 'cross', value: 10 }, cumFunding: { allTime: '-0.3', sinceOpen: '-0.1', sinceChange: '-0.1' } } };
const summary = { accountValue: '990', totalNtlPos: '660', totalRawUsd: '1000', totalMarginUsed: '66' };
function state(active = true) {
  const sums = active ? summary : { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' };
  return { marginSummary: { ...sums }, crossMarginSummary: { ...sums }, crossMaintenanceMarginUsed: active ? '8.25' : '0',
    withdrawable: active ? '924' : '0', time: now, assetPositions: active ? [structuredClone(mainPosition)] : [] };
}
const open = { coin: 'BTC', side: 'B', limitPx: '65000', sz: '0.004', origSz: '0.01', oid: 10,
  timestamp: now - 1000, reduceOnly: false, cloid: `0x${'ab'.repeat(16)}`, isTrigger: false, isPositionTpsl: false };
function setup(override?: (body: Record<string, unknown>, value: unknown) => unknown, includeAllOrders = true) {
  let clock = now;
  const reads: Record<string, unknown>[] = [];
  let listed: ({ name: string } | null)[] = [null, { name: 'xyz' }];
  const apply = (body: Record<string, unknown>, value: unknown) => override ? override(body, value) : value;
  const metadata = (dex = '') => apply({ type: 'meta', ...(dex ? { dex } : {}) }, {
    collateralToken: dex ? 9 : 7, universe: [{ name: dex ? `${dex}:TSLA` : 'BTC', szDecimals: dex ? 3 : 5, maxLeverage: 40 }] });
  const acquire = vi.fn(async (_weight: number) => {});
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    expect(url).toBe('https://api.hyperliquid-testnet.xyz/info');
    expect(options?.redirect).toBe('error');
    const body = JSON.parse(String(options?.body)); reads.push(body);
    if (body.user) expect(body.user).toBe(account);
    const main = !body.dex;
    let value: unknown;
    switch (body.type) {
      case 'userRole': value = { role: 'user' }; break;
      case 'userAbstraction': value = 'disabled'; break;
      case 'userDexAbstraction': value = false; break;
      case 'spotClearinghouseState': value = { portfolioMarginEnabled: false, balances: [] }; break;
      case 'spotMeta': value = { tokens: [{ index: 7, name: 'USDC', isCanonical: true }, { index: 9, name: 'USDE', isCanonical: true }] }; break;
      case 'perpDexs': value = [null, { name: 'xyz' }]; break;
      case 'meta': value = { collateralToken: main ? 7 : 9, universe: [{ name: main ? 'BTC' : 'xyz:TSLA', szDecimals: main ? 5 : 3, maxLeverage: 40 }] }; break;
      case 'allPerpMetas': value = listed.map((row, i) => i === 0 ? metadata() : row ? metadata(row.name) : null); break;
      case 'clearinghouseState': value = state(main); break;
      case 'frontendOpenOrders': value = main ? [structuredClone(open)] : []; break;
      default: throw new Error('unexpected info read');
    }
    const result = apply(body, value);
    if (body.type === 'perpDexs') listed = result as typeof listed;
    return new Response(JSON.stringify(result));
  });
  const aggregateRead = vi.fn(async (user: string, _timeout: number) => ({ network: 'testnet' as const,
    accountAddress: user, observedAt: clock, data: { user, clearinghouseStates: listed.flatMap((row, i) =>
      i === 0 || row ? [[i === 0 ? '' : row!.name, apply({ type: 'clearinghouseState', user,
        ...(row ? { dex: row.name } : {}) }, state(i === 0))]] : []) } }));
  const ordersRead = vi.fn(async (user: string, dexes: readonly string[], _timeout: number) => ({ network: 'testnet' as const,
    accountAddress: user, observedAt: clock, completedAt: clock, requestedDexes: [...dexes], venues: dexes.map((dex) => ({
      dex, user, observedAt: clock, receivedAt: clock, orders: apply({ type: 'frontendOpenOrders', user, ...(dex ? { dex } : {}) },
        dex ? [] : [structuredClone(open)]) as unknown[],
    })) }));
  const observer = new HyperliquidLiveAccountObserver('testnet', acquire, fetcher, () => clock, 5000,
    { read: aggregateRead, ...(includeAllOrders ? { readOrders: ordersRead } : {}) });
  return { observer, reads, acquire, fetcher, aggregateRead, ordersRead, setClock: (value: number) => { clock = value; } };
}

describe('setup abort return evidence is separate from trading authority', () => {
  const flatFunded = (body: Record<string, unknown>, value: unknown): unknown => {
    if (body.type === 'userAbstraction') return 'default';
    if (body.type === 'frontendOpenOrders') return [];
    if (body.type === 'clearinghouseState') {
      const flat = state(false);
      if (!body.dex) { flat.marginSummary.accountValue = '100'; flat.marginSummary.totalRawUsd = '100';
        flat.crossMarginSummary.accountValue = '100'; flat.crossMarginSummary.totalRawUsd = '100'; flat.withdrawable = '100'; }
      return flat;
    }
    return value;
  };
  it.each([false, null])('observes a funded default account with dex abstraction %s only for a full-flat primary USDC return, never for trading or unsetup allocation', async dexAbstraction => {
    const s = setup((body, value) => body.type === 'userDexAbstraction' ? dexAbstraction : flatFunded(body, value));
    await expect(s.observer.observe(account)).rejects.toMatchObject({ code: 'live_account_unsupported_abstraction' });
    await expect(s.observer.observe(account, { unsetup: true })).rejects.toMatchObject({ code: 'live_account_unsupported_abstraction' });
    const proof = await s.observer.observeSetupAbortFlat(account);
    expect(proof).toMatchObject({ purpose: 'setup-abort-return', snapshot: { network: 'testnet', accountAddress: account, accountAbstraction: 'default',
      withdrawable: '100', positions: [], restingOrders: [], coverage: { complete: true, orderComplete: true, balanceComplete: true } } });
    expect(proof.snapshot).not.toHaveProperty('accountMode');
  });
  it('proves a never-funded missing account only when every venue and spot balance is zero', async () => {
    const s = setup((body, value) => body.type === 'userRole' ? { role: 'missing' } : body.type === 'userAbstraction' ? 'default' :
      body.type === 'clearinghouseState' ? state(false) : body.type === 'frontendOpenOrders' ? [] : value);
    await expect(s.observer.observe(account)).rejects.toBeDefined();
    expect(await s.observer.observeSetupAbortFlat(account)).toMatchObject({ purpose: 'setup-abort-return', snapshot: { role: 'missing', withdrawable: '0',
      positions: [], restingOrders: [], coverage: { complete: true, orderComplete: true } } });
  });
  it.each([false, null].flatMap(dexAbstraction => ['position', 'order', 'other_dex_balance', 'incomplete_orders', 'stale', 'spot_balance', 'portfolio_margin'].map(reason => ({ dexAbstraction, reason }))))('refuses $reason with dex abstraction $dexAbstraction rather than converting incomplete evidence into a refund proof', async ({ dexAbstraction, reason }) => {
    const s = setup((body, value) => {
      if (body.type === 'userDexAbstraction') return dexAbstraction;
      const flat = flatFunded(body, value);
      if (reason === 'position' && body.type === 'clearinghouseState' && !body.dex) return state(true);
      if (reason === 'order' && body.type === 'frontendOpenOrders' && !body.dex) return [open];
      if (reason === 'other_dex_balance' && body.type === 'clearinghouseState' && body.dex) return { ...state(false), withdrawable: '1', marginSummary: { ...state(false).marginSummary, accountValue: '1', totalRawUsd: '1' } };
      if (reason === 'stale' && body.type === 'clearinghouseState') return { ...(flat as object), time: now - 5_001 };
      if (reason === 'spot_balance' && body.type === 'spotClearinghouseState') return { balances: [{ coin: 'USDC', token: 7, total: '1', hold: '0' }] };
      if (reason === 'portfolio_margin' && body.type === 'spotClearinghouseState') return { balances: [], portfolioMarginEnabled: true };
      return flat;
    }, reason !== 'incomplete_orders');
    await expect(s.observer.observeSetupAbortFlat(account)).rejects.toBeDefined();
  });
  it.each([true, 'false', {}, undefined])('refuses unsupported dex abstraction %j for a funded default return', async dexAbstraction => {
    const s = setup((body, value) => body.type === 'userDexAbstraction' ? dexAbstraction : flatFunded(body, value));
    await expect(s.observer.observeSetupAbortFlat(account)).rejects.toBeDefined();
  });
});

describe('authoritative dedicated standard account observations', () => {
  it('observes more than 32 listed dexes in bounded aggregate reads and exposes unknown unsupported orders', async () => {
    const s = setup((body, value) => body.type === 'perpDexs' ? [null, ...Array.from({ length: 267 }, (_, i) => ({ name: `dex${i + 1}` }))] : value, false);
    const snapshot = await s.observer.observe(account);
    expect(snapshot.dexes).toHaveLength(268);
    expect(snapshot.coverage).toMatchObject({ balanceComplete: true, orderComplete: false, complete: false });
    expect(snapshot.coverage.unobservedOrderDexes).toHaveLength(267);
    expect(s.fetcher.mock.calls.length).toBeLessThan(20);
  });
  it('uses actual perp balances and signed positions, without subtracting a pending reduction', async () => {
    const s = setup();
    const snapshot = await s.observer.observe(account);
    expect(snapshot).toMatchObject({ network: 'testnet', accountAddress: account, role: 'user', accountMode: 'standard',
      accountAbstraction: 'disabled', perpEquity: '990', totalMarginUsed: '66', withdrawable: '924',
      restingExposureUsd: '260', exposureUsd: '660' });
    expect(snapshot.positions[0]).toMatchObject({ coin: 'BTC', size: '-0.01', marginUsed: '66', entryPrice: '65000' });
    expect(snapshot.restingOrders[0]).toMatchObject({ remainingSize: '0.004', notionalUsd: '260', reduceOnly: false });
    expect(snapshot.dexes.map((d) => d.dex)).toEqual(['', 'xyz']);
    expect(snapshot.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(snapshot.positions[0])).toBe(true);
    expect(s.reads.filter((b) => b.type === 'clearinghouseState')).toEqual([]);
    expect(s.aggregateRead).toHaveBeenCalledTimes(1);
    // Exactly the REST weight of the reads it sent (the account modes and dex
    // list twice, spotMeta, allPerpMetas: 284), in one reservation before the
    // clock; the all-venue state and orders come over the socket.
    const restWeight = s.reads.reduce((sum, body) => sum + (body.type === 'userRole' ? 60 : body.type === 'spotClearinghouseState' ? 2 : 20), 0);
    expect(s.acquire.mock.calls).toEqual([[restWeight]]); expect(restWeight).toBe(284);
  });
  it.each(['unifiedAccount', 'portfolioMargin', 'dexAbstraction', 'default', null])('refuses unresolved or unsupported abstraction %s', async (mode) => {
    await expect(setup((body, value) => body.type === 'userAbstraction' ? mode : value).observer.observe(account))
      .rejects.toThrow('live_account_unsupported_abstraction');
  });
  it.each(['agent', 'vault', 'missing', 'subAccount'])('refuses unsupported account role %s', async (role) => {
    await expect(setup((body, value) => body.type === 'userRole' ? { role } : value).observer.observe(account))
      .rejects.toThrow('live_account_unsupported_role');
  });
  describe('another copy\'s account still in setup (unsetup)', () => {
    /** A fresh account: no role yet or the exchange's default abstraction, nothing on it. */
    const fresh = (patch: Record<string, unknown>) => (body: Record<string, unknown>, value: unknown) =>
      String(body.type) in patch ? patch[String(body.type)] : body.type === 'clearinghouseState' ? state(false) : body.type === 'frontendOpenOrders' ? [] : value;
    it.each([[{ userRole: { role: 'missing' }, userAbstraction: 'default', userDexAbstraction: null }, 'missing', 'default'],
      [{ userAbstraction: 'default', userDexAbstraction: null }, 'user', 'default']] as const)('is observed as zero exposure: %j', async (patch, role, abstraction) => {
      const snapshot = await setup(fresh(patch)).observer.observe(account, { unsetup: true });
      expect(snapshot).toMatchObject({ role, accountAbstraction: abstraction, perpEquity: '0', exposureUsd: '0', positions: [], restingOrders: [] });
      // Never for the account that orders.
      await expect(setup(fresh(patch)).observer.observe(account)).rejects.toThrow(role === 'missing' ? 'live_account_unsupported_role' : 'live_account_unsupported_abstraction');
    });
    it('still refuses one holding anything: a position, an order or a balance', async () => {
      const patch = { userRole: { role: 'missing' }, userAbstraction: 'default', userDexAbstraction: null };
      await expect(setup((body, value) => String(body.type) in patch ? patch[body.type as keyof typeof patch] : value).observer.observe(account, { unsetup: true }))
        .rejects.toThrow('live_account_unsupported_role');
      await expect(setup((body, value) => body.type === 'frontendOpenOrders' ? (body.dex ? [] : [structuredClone(open)]) : fresh(patch)(body, value)).observer.observe(account, { unsetup: true }))
        .rejects.toThrow('live_account_unsupported_role');
      await expect(setup((body, value) => body.type === 'spotClearinghouseState' ? { balances: [{ coin: 'USDC', token: 7, total: '5', hold: '0' }] } : fresh({ userAbstraction: 'default', userDexAbstraction: null })(body, value))
        .observer.observe(account, { unsetup: true })).rejects.toThrow('live_account_unsupported_abstraction');
    });
    it.each(['unifiedAccount', 'portfolioMargin'])('still refuses the unsupported abstraction %s', async mode => {
      await expect(setup(fresh({ userAbstraction: mode, userDexAbstraction: null })).observer.observe(account, { unsetup: true })).rejects.toThrow('live_account_unsupported_abstraction');
    });
  });
  it('refuses portfolio margin even when the abstraction endpoint says disabled', async () => {
    await expect(setup((body, value) => body.type === 'spotClearinghouseState'
      ? { balances: [], portfolioMarginEnabled: true } : value).observer.observe(account)).rejects.toThrow();
  });
  it.each([{ accountValue: '-1' }, { totalMarginUsed: '-1' }, { totalRawUsd: '1e3' }, { accountValue: null }])
    ('refuses malformed account balances %j', async (patch) => {
      await expect(setup((body, value) => body.type === 'clearinghouseState' && !body.dex
        ? { ...value as object, marginSummary: { ...summary, ...patch } } : value).observer.observe(account)).rejects.toThrow();
    });
  it('refuses a negative position margin instead of inferring used collateral', async () => {
    await expect(setup((body, value) => body.type === 'clearinghouseState' && !body.dex
      ? { ...state(), assetPositions: [{ ...mainPosition, position: { ...mainPosition.position, marginUsed: '-66' } }] } : value)
      .observer.observe(account)).rejects.toThrow();
  });
  it('refuses summaries that understate actual position exposure or used margin', async () => {
    const zero = { accountValue: '990', totalRawUsd: '1000', totalNtlPos: '0', totalMarginUsed: '0' };
    for (const patch of [{ marginSummary: zero, crossMarginSummary: zero }, { crossMarginSummary: zero }]) {
      await expect(setup((body, value) => body.type === 'clearinghouseState' && !body.dex
        ? { ...value as object, ...patch } : value).observer.observe(account)).rejects.toThrow('live_account_inconsistent_balances');
    }
  });
  it('refuses unseen coin/dex identities and duplicate positions/orders', async () => {
    for (const patch of [
      { assetPositions: [{ ...mainPosition, position: { ...mainPosition.position, coin: 'xyz:TSLA' } }] },
      { assetPositions: [mainPosition, mainPosition] },
    ]) await expect(setup((body, value) => body.type === 'clearinghouseState' && !body.dex ? { ...state(), ...patch } : value)
      .observer.observe(account)).rejects.toThrow();
    await expect(setup((body, value) => body.type === 'frontendOpenOrders' && !body.dex ? [open, open] : value)
      .observer.observe(account)).rejects.toThrow();
  });
  it('does not silently omit non-USDC collateral or unsupported dex exposure', async () => {
    await expect(setup((body, value) => body.type === 'clearinghouseState' && body.dex
      ? { ...state(false), withdrawable: '1', marginSummary: { accountValue: '1', totalRawUsd: '1', totalNtlPos: '0', totalMarginUsed: '0' } } : value)
      .observer.observe(account)).rejects.toThrow('live_account_unsupported_collateral');
    await expect(setup((body, value) => body.type === 'meta' && body.dex
      ? { ...value as object, collateralToken: 7 } : body.type === 'frontendOpenOrders' && body.dex
        ? [{ ...open, coin: 'xyz:TSLA', oid: 11 }] : value).observer.observe(account)).rejects.toThrow('live_account_unsupported_dex_exposure');
  });
  it('observes a supported USDC HIP-3 dex with its original asset index and separate collateral', async () => {
    const s = setup((body, value) => body.type === 'meta' && body.dex ? { ...value as object, collateralToken: 7 }
      : body.type === 'clearinghouseState' && body.dex ? { ...state(false),
        marginSummary: { accountValue: '100', totalRawUsd: '100', totalNtlPos: '0', totalMarginUsed: '0' }, withdrawable: '100' } : value);
    const snapshot = await s.observer.observe(account, { supportedDexes: ['xyz'] });
    expect(snapshot.perpEquity).toBe('1090');
    expect(snapshot.dexes[1]).toMatchObject({ dex: 'xyz', perpDexIndex: 1, equity: '100', collateralToken: 7, collateralCoin: 'USDC' });
  });
  it('refuses expired provider timestamps and observation that aged during remote reads', async () => {
    await expect(setup((body, value) => body.type === 'clearinghouseState' ? { ...value as object, time: now - 5001 } : value)
      .observer.observe(account)).rejects.toThrow('live_account_evidence_expired');
    const s = setup((body, value) => { if (body.type === 'frontendOpenOrders') s.setClock(now + 5001); return value; });
    await expect(s.observer.observe(account)).rejects.toThrow('live_account_evidence_expired');
  });
  it('redacts provider errors and bounds a budget that never resolves', async () => {
    const s = setup(); s.fetcher.mockRejectedValue(new Error('provider_secret_token'));
    await expect(s.observer.observe(account)).rejects.toThrow('live_account_observation_unavailable');
    vi.useFakeTimers();
    try {
      const observer = new HyperliquidLiveAccountObserver('testnet', () => new Promise(() => {}));
      let status = 'pending';
      void observer.observe(account).then(() => { status = 'accepted'; }, () => { status = 'blocked'; });
      // The reservation is taken before the 5 s clock and bounded on its own.
      await vi.advanceTimersByTimeAsync(10_001);
      expect(status).toBe('blocked');
    } finally { vi.useRealTimers(); }
  });
  it('does not count spot collateral as perp equity or pending reductions as closed positions', async () => {
    const s = setup((body, value) => body.type === 'spotClearinghouseState'
      ? { balances: [{ coin: 'USDC', token: 7, total: '100000', hold: '1000' }], portfolioMarginEnabled: false }
      : body.type === 'frontendOpenOrders' && !body.dex ? [{ ...open, reduceOnly: true }] : value);
    const snapshot = await s.observer.observe(account);
    expect(snapshot.perpEquity).toBe('990'); expect(snapshot.exposureUsd).toBe('660');
    expect(snapshot.restingExposureUsd).toBe('0'); expect(snapshot.grossRestingExposureUsd).toBe('260');
  });
  it('refuses newly listed dexes or changed account modes during observation', async () => {
    for (const target of ['perpDexs', 'userAbstraction']) {
      let seen = 0;
      const s = setup((body, value) => body.type === target && ++seen === 2
        ? target === 'perpDexs' ? [null, { name: 'xyz' }, { name: 'new' }] : 'unifiedAccount' : value);
      await expect(s.observer.observe(account)).rejects.toThrow();
    }
  });
  it('refuses provider ownership mismatches, duplicated token identities and unbounded orders', async () => {
    const cases: [(body: Record<string, unknown>, value: unknown) => unknown][] = [
      [(body, value) => body.type === 'clearinghouseState' ? { ...value as object, user: `0x${'33'.repeat(20)}` } : value],
      [(body, value) => body.type === 'clearinghouseState' ? { ...value as object, network: 'mainnet' } : value],
      [(body, value) => body.type === 'spotMeta' ? { tokens: [{ index: 7, name: 'USDC', isCanonical: true },
        { index: 7, name: 'USDE', isCanonical: true }] } : value],
      [(body, value) => body.type === 'frontendOpenOrders' && !body.dex ? Array.from({ length: 5001 }, (_, i) => ({ ...open, oid: i })) : value],
    ];
    for (const [override] of cases) await expect(setup(override).observer.observe(account)).rejects.toThrow();
  });
  it('preserves null-bearing HIP-3 indices when observing supported positions', async () => {
    const s = setup((body, value) => body.type === 'perpDexs' ? [null, null, { name: 'xyz' }]
      : body.type === 'meta' && body.dex ? { ...value as object, collateralToken: 7 }
      : body.type === 'clearinghouseState' && body.dex ? { ...state(), assetPositions: [{ ...mainPosition,
        position: { ...mainPosition.position, coin: 'xyz:TSLA' } }] } : value);
    const snapshot = await s.observer.observe(account, { supportedDexes: ['xyz'] });
    expect(snapshot.positions[1]).toMatchObject({ coin: 'xyz:TSLA', asset: 120000, dex: 'xyz', size: '-0.01' });
    expect(snapshot.dexes[1].perpDexIndex).toBe(2);
  });
  it('refuses missing aggregate venues, wrong aggregate source account and stale snapshot evidence', async () => {
    for (const patch of [
      { accountAddress: `0x${'33'.repeat(20)}` }, { network: 'mainnet' }, { observedAt: now - 5001 },
      { data: { user: account, clearinghouseStates: [['', state()]] } },
      { data: { user: account, clearinghouseStates: [['', state()], ['', state(false)]] } },
    ]) {
      const s = setup(), previous = s.aggregateRead.getMockImplementation()!;
      s.aggregateRead.mockImplementation(async (...args) => ({ ...await previous(...args), ...patch }) as Awaited<ReturnType<typeof previous>>);
      await expect(s.observer.observe(account)).rejects.toThrow();
    }
  });
  it('reports complete order coverage only when every listed venue is explicitly read', async () => {
    const s = setup((body, value) => body.type === 'meta' && body.dex ? { ...value as object, collateralToken: 7 } : value);
    const snapshot = await s.observer.observe(account, { supportedDexes: ['xyz'] });
    expect(snapshot.coverage).toMatchObject({ balanceComplete: true, orderComplete: true, complete: true,
      observedOrderDexes: ['', 'xyz'], unobservedOrderDexes: [] });
  });
  it('achieves full account coverage across 268 venues with bounded aggregate sources', async () => {
    const s = setup((body, value) => body.type === 'perpDexs'
      ? [null, ...Array.from({ length: 267 }, (_, i) => ({ name: i === 11 ? 'i<3fl' : `dex${i + 1}` }))] : value);
    const snapshot = await s.observer.observe(account);
    expect(snapshot.coverage).toMatchObject({ complete: true, balanceComplete: true, orderComplete: true, unobservedOrderDexes: [] });
    expect(s.ordersRead.mock.calls[0]![1]).toHaveLength(268);
    expect(snapshot.dexes[12]).toMatchObject({ dex: 'i<3fl', perpDexIndex: 12 });
    expect(s.fetcher.mock.calls).toHaveLength(12);
  });
  it('supports more than31 exact listed trading dexes including opaque provider names', async () => {
    const names = Array.from({ length: 40 }, (_, i) => i === 11 ? 'i<3fl' : `dex${i}`);
    const s = setup((body, value) => body.type === 'perpDexs' ? [null, ...names.map((name) => ({ name }))]
      : body.type === 'meta' ? { ...value as object, collateralToken: 7 } : value);
    const snapshot = await s.observer.observe(account, { supportedDexes: names });
    expect(snapshot.dexes.filter((d) => d.supported)).toHaveLength(41);
    expect(snapshot.coverage.complete).toBe(true);
    await expect(s.observer.observe(account, { supportedDexes: [...names, 'unlisted'] })).rejects.toThrow('live_account_unobserved_dex');
    await expect(s.observer.observe(account, { supportedDexes: [...names, ''] })).rejects.toThrow();
    await expect(s.observer.observe(account, { supportedDexes: [...names, names[0]!] })).rejects.toThrow('live_account_duplicate_evidence');
  });
  it('overlaps metadata and combined snapshots while retaining the final mode read within five seconds', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    try {
      const s = setup((body, value) => body.type === 'perpDexs'
        ? [null, ...Array.from({ length: 267 }, (_, i) => ({ name: i === 11 ? 'i<3fl' : `dex${i}` }))] : value);
      const originalFetch = s.fetcher.getMockImplementation()!;
      const delayed = <T>(work: () => Promise<T>, delay: number) => new Promise<T>((resolve, reject) => {
        setTimeout(() => { s.setClock(Date.now()); void work().then(resolve, reject); }, delay);
      });
      const counts = new Map<string, number>();
      const finalStarts: number[] = [];
      s.fetcher.mockImplementation((...args) => {
        const type = JSON.parse(String(args[1]?.body)).type;
        const pass = (counts.get(type) ?? 0) + 1; counts.set(type, pass);
        if (pass === 2) finalStarts.push(Date.now());
        return delayed(() => originalFetch(...args), pass === 2 ? 500 : 1000);
      });
      const oldAggregate = s.aggregateRead.getMockImplementation()!, oldOrders = s.ordersRead.getMockImplementation()!;
      const source = {
        read: (user: string, timeout: number) => delayed(() => oldAggregate(user, timeout), 2000),
        readOrders: (user: string, dexes: readonly string[], timeout: number) => delayed(() => oldOrders(user, dexes, timeout), 2000),
        readAccount: (user: string, dexes: readonly string[], timeout: number) => delayed(async () => ({
          state: await oldAggregate(user, timeout), orders: await oldOrders(user, dexes, timeout),
        }), 2000),
      };
      const observer = new HyperliquidLiveAccountObserver('testnet', s.acquire, s.fetcher, Date.now, 5000, source);
      let outcome = 'pending';
      const pending = observer.observe(account).then((proof) => { outcome = 'complete'; return proof; }, (error) => { outcome = 'denied'; throw error; });
      void pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(3500);
      expect(outcome).toBe('complete');
      expect(await pending).toMatchObject({ observedAt: now, completedAt: now + 3500, coverage: { complete: true } });
      expect((await pending).dexes).toHaveLength(268);
      expect(counts.get('userRole')).toBe(2);
      expect(counts.get('userAbstraction')).toBe(2);
      expect(finalStarts.every((at) => at >= now + 3000)).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('refuses whole observation expiry while the mandatory final reads are still pending', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    try {
      const s = setup(), original = s.fetcher.getMockImplementation()!;
      const counts = new Map<string, number>();
      s.fetcher.mockImplementation((...args) => {
        const type = JSON.parse(String(args[1]?.body)).type;
        const pass = (counts.get(type) ?? 0) + 1; counts.set(type, pass);
        if (pass === 1) return original(...args);
        return new Promise((resolve, reject) => setTimeout(() => {
          s.setClock(Date.now()); void original(...args).then(resolve, reject);
        }, 6000));
      });
      const source = { read: s.aggregateRead, readOrders: s.ordersRead,
        readAccount: async (user: string, dexes: readonly string[], timeout: number) => ({
          state: await s.aggregateRead(user, timeout), orders: await s.ordersRead(user, dexes, timeout),
        }) };
      const observer = new HyperliquidLiveAccountObserver('testnet', s.acquire, s.fetcher, Date.now, 5000, source);
      const denied = expect(observer.observe(account)).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(5001); await denied;
      expect(counts.get('userRole')).toBe(2);
      // Flush the explicitly delayed fixture reads; no pending test work escapes.
      await vi.advanceTimersByTimeAsync(1000);
    } finally { vi.useRealTimers(); }
  });
  it('refuses wrong, stale, duplicated or missing full order-source evidence', async () => {
    for (const mutate of [
      (proof: any) => ({ ...proof, accountAddress: `0x${'33'.repeat(20)}` }),
      (proof: any) => ({ ...proof, observedAt: now - 5001 }),
      (proof: any) => ({ ...proof, venues: proof.venues.slice(0, 1) }),
      (proof: any) => ({ ...proof, venues: [proof.venues[0], proof.venues[0]] }),
      (proof: any) => ({ ...proof, venues: proof.venues.map((v: any) => ({ ...v, user: `0x${'33'.repeat(20)}` })) }),
      (proof: any) => ({ ...proof, venues: proof.venues.map((v: any) => ({ ...v, receivedAt: now + 1 })) }),
    ]) {
      const s = setup(), previous = s.ordersRead.getMockImplementation()!;
      s.ordersRead.mockImplementation(async (...args) => mutate(await previous(...args)));
      await expect(s.observer.observe(account)).rejects.toThrow();
    }
  });
  it.each([{ coin: '@1' }, { isTrigger: true }, { isPositionTpsl: true }])('refuses unsupported spot or trigger order %j', async (patch) => {
    await expect(setup((body, value) => body.type === 'frontendOpenOrders' && !body.dex
      ? [{ ...open, ...patch }] : value).observer.observe(account)).rejects.toThrow();
  });
});

class OfflineSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  readonly send = vi.fn((_body: string) => {});
  readonly terminate = vi.fn(() => { this.readyState = WebSocket.CLOSED; this.emit('close'); });
}
function orderSource(reply?: (socket: OfflineSocket, request: any) => void) {
  const socket = new OfflineSocket(); socket.readyState = WebSocket.OPEN;
  let clock = now, inflight = 0, maximum = 0;
  socket.send.mockImplementation((body) => {
    const request = JSON.parse(body); inflight++; maximum = Math.max(maximum, inflight);
    queueMicrotask(() => {
      inflight--;
      if (reply) reply(socket, request);
      else {
        socket.emit('message', Buffer.from(JSON.stringify({ channel: 'subscriptionResponse', data: request })));
        if (request.method === 'subscribe') socket.emit('message', Buffer.from(JSON.stringify({
          channel: 'openOrders', data: { user: account, dex: request.subscription.dex, orders: [] } })));
      }
    });
  });
  const source = new HyperliquidAllDexsAccountSource(() => clock, () => socket as unknown as WebSocket);
  return { source, socket, maxInflight: () => maximum, setClock: (at: number) => { clock = at; } };
}
describe('official all-dex snapshot transport (offline)', () => {
  it('multiplexes balances with 268 order venues on one socket using at most90 pending commands', async () => {
    const s = orderSource((socket, request) => {
      socket.emit('message', Buffer.from(JSON.stringify({ channel: 'subscriptionResponse', data: request })));
      if (request.method === 'subscribe') socket.emit('message', Buffer.from(JSON.stringify({
        channel: request.subscription.type,
        data: request.subscription.type === 'allDexsClearinghouseState'
          ? { user: account, clearinghouseStates: [['', state()]] }
          : { user: account, dex: request.subscription.dex, orders: [] },
      })));
    });
    expect(s.source.readAccount).toBeTypeOf('function');
    const dexes = ['', ...Array.from({ length: 267 }, (_, i) => `dex${i + 1}`)];
    const proof = await s.source.readAccount(account, dexes, 5000);
    expect(proof.state).toMatchObject({ accountAddress: account, observedAt: now });
    expect(proof.orders.venues.map((v) => v.dex)).toEqual(dexes);
    expect(s.maxInflight()).toBeLessThanOrEqual(90);
    expect(s.socket.send).toHaveBeenCalledTimes(538); s.source.close();
  });
  it('never returns combined coverage or opens a next batch before aggregate cleanup acknowledgement', async () => {
    let stateCleanup: unknown;
    const s = orderSource((socket, request) => {
      if (request.subscription.type === 'allDexsClearinghouseState' && request.method === 'unsubscribe') {
        stateCleanup = request; return;
      }
      socket.emit('message', Buffer.from(JSON.stringify({ channel: 'subscriptionResponse', data: request })));
      if (request.method === 'subscribe') socket.emit('message', Buffer.from(JSON.stringify({ channel: request.subscription.type,
        data: request.subscription.type === 'allDexsClearinghouseState'
          ? { user: account, clearinghouseStates: [['', state()]] } : { user: account, dex: request.subscription.dex, orders: [] } })));
    });
    expect(s.source.readAccount).toBeTypeOf('function');
    let completed = false;
    const pending = s.source.readAccount(account, ['', ...Array.from({ length: 90 }, (_, i) => `dex${i}`)], 5000)
      .then((proof) => { completed = true; return proof; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    expect(s.socket.send.mock.calls.filter(([body]) => JSON.parse(body).method === 'subscribe')).toHaveLength(90);
    s.socket.emit('message', Buffer.from(JSON.stringify({ channel: 'subscriptionResponse', data: stateCleanup })));
    expect((await pending).orders.venues).toHaveLength(91); s.source.close();
  });
  it.each(['missing', 'cross_account', 'duplicate', 'malformed'])('refuses combined aggregate %s acknowledgements', async (failure) => {
    const s = orderSource((socket, request) => {
      const aggregate = request.subscription.type === 'allDexsClearinghouseState';
      const ack = structuredClone(request);
      if (aggregate && failure === 'cross_account') ack.subscription.user = `0x${'33'.repeat(20)}`;
      if (aggregate && failure === 'malformed') ack.method = 'post';
      const emitAck = () => socket.emit('message', Buffer.from(JSON.stringify({ channel: 'subscriptionResponse', data: ack })));
      if (!aggregate || failure !== 'missing') emitAck();
      if (aggregate && failure === 'duplicate') emitAck();
      if (request.method === 'subscribe') socket.emit('message', Buffer.from(JSON.stringify({ channel: request.subscription.type,
        data: aggregate ? { user: account, clearinghouseStates: [['', state()]] } : { user: account, dex: request.subscription.dex, orders: [] } })));
    });
    await expect(s.source.readAccount(account, [''], 5000)).rejects.toThrow('live_account_order_ack');
    expect(s.socket.terminate).toHaveBeenCalledTimes(1); s.source.close();
  });
  it('retains the socket mutex and rejects incomplete combined cleanup at the unchanged deadline', async () => {
    vi.useFakeTimers();
    try {
      const s = orderSource((socket, request) => {
        if (request.method === 'unsubscribe' && request.subscription.type === 'allDexsClearinghouseState') return;
        socket.emit('message', Buffer.from(JSON.stringify({ channel: 'subscriptionResponse', data: request })));
        if (request.method === 'subscribe') socket.emit('message', Buffer.from(JSON.stringify({ channel: request.subscription.type,
          data: request.subscription.type === 'allDexsClearinghouseState'
            ? { user: account, clearinghouseStates: [['', state()]] } : { user: account, dex: request.subscription.dex, orders: [] } })));
      });
      const denied = expect(s.source.readAccount(account, [''], 5000)).rejects.toThrow('live_account_orders_deadline_exceeded');
      await expect(s.source.read(account, 5000)).rejects.toThrow('live_account_aggregate_unavailable');
      await vi.advanceTimersByTimeAsync(5001); await denied;
      expect(s.socket.terminate).toHaveBeenCalledTimes(1); s.source.close();
    } finally { vi.useRealTimers(); }
  });
  it('waits for delayed aggregate cleanup before immediately reusing the socket', async () => {
    const socket = new OfflineSocket(); socket.readyState = WebSocket.OPEN;
    const source = new HyperliquidAllDexsAccountSource(() => now, () => socket as unknown as WebSocket);
    const emit = (payload: unknown) => socket.emit('message', Buffer.from(JSON.stringify(payload)));
    socket.send.mockImplementation((body) => {
      const request = JSON.parse(body);
      if (request.method === 'subscribe') queueMicrotask(() => {
        emit({ channel: 'subscriptionResponse', data: request });
        emit({ channel: 'allDexsClearinghouseState', data: { user: account, clearinghouseStates: [['', state()]] } });
      });
    });
    for (let i = 0; i < 2; i++) {
      let completed = false;
      const pending = source.read(account, 5000).then((proof) => { completed = true; return proof; });
      await new Promise((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
      emit({ channel: 'subscriptionResponse', data: { method: 'unsubscribe', subscription: { type: 'allDexsClearinghouseState', user: account } } });
      await pending;
    }
    source.close();
  });
  it('bounds aggregate decoded frame counts before the deadline', async () => {
    const socket = new OfflineSocket(); socket.readyState = WebSocket.OPEN;
    const source = new HyperliquidAllDexsAccountSource(() => now, () => socket as unknown as WebSocket);
    const pending = source.read(account, 5000);
    for (let i = 0; i < 4001; i++) socket.emit('message', Buffer.from('{}'));
    await expect(pending).rejects.toThrow('live_account_unbounded_evidence'); source.close();
  });
  it('reads 268 exact venues in batches of at most90 commands and waits for all cleanup acknowledgements', async () => {
    const s = orderSource(), dexes = ['', ...Array.from({ length: 267 }, (_, i) => i === 11 ? 'i<3fl' : `dex${i + 1}`)];
    const proof = await s.source.readOrders(account, dexes, 5000);
    expect(proof.venues.map((v) => v.dex)).toEqual(dexes);
    expect(proof.venues.every((v) => v.user === account && v.receivedAt === now)).toBe(true);
    expect(s.maxInflight()).toBeLessThanOrEqual(90);
    expect(s.socket.send).toHaveBeenCalledTimes(536);
    expect(s.socket.terminate).not.toHaveBeenCalled(); s.source.close();
  });
  it('reserves whole scans before sending and enforces minimum spacing and rolling message bounds', async () => {
    const s = orderSource(), dexes = ['', ...Array.from({ length: 267 }, (_, i) => `dex${i + 1}`)];
    await s.source.readOrders(account, dexes, 5000);
    await expect(s.source.readOrders(account, dexes, 5000)).rejects.toThrow('live_account_orders_throttled');
    expect(s.socket.send).toHaveBeenCalledTimes(536);
    s.setClock(now + 1000); await s.source.readOrders(account, dexes, 5000);
    s.setClock(now + 2000); await s.source.readOrders(account, dexes, 5000);
    s.setClock(now + 3000); await expect(s.source.readOrders(account, dexes, 5000)).rejects.toThrow('live_account_ws_message_budget');
    expect(s.socket.send).toHaveBeenCalledTimes(1608);
    s.setClock(now + 60_001); await s.source.readOrders(account, dexes, 5000); s.source.close();
  });
  it.each(['missing', 'duplicate', 'cross_account', 'wrong_dex', 'malformed'])('refuses %s order acknowledgements and invalidates connection', async (mode) => {
    const s = orderSource((socket, request) => {
      if (request.method !== 'subscribe') return;
      const ack = { ...request, subscription: { ...request.subscription } };
      if (mode === 'cross_account') ack.subscription.user = `0x${'33'.repeat(20)}`;
      if (mode === 'wrong_dex') ack.subscription.dex = 'unknown';
      if (mode === 'malformed') ack.method = 'post';
      if (mode !== 'missing') socket.emit('message', Buffer.from(JSON.stringify({ channel: 'subscriptionResponse', data: ack })));
      if (mode === 'duplicate') socket.emit('message', Buffer.from(JSON.stringify({ channel: 'subscriptionResponse', data: ack })));
      socket.emit('message', Buffer.from(JSON.stringify({ channel: 'openOrders', data: { user: account, dex: '', orders: [] } })));
    });
    await expect(s.source.readOrders(account, [''], 5000)).rejects.toThrow('live_account_order_ack');
    expect(s.socket.terminate).toHaveBeenCalledTimes(1); s.source.close();
  });
  it('refuses disconnects and cross-account snapshots even after valid acknowledgements', async () => {
    for (const disconnect of [true, false]) {
      const s = orderSource((socket, request) => {
        socket.emit('message', Buffer.from(JSON.stringify({ channel: 'subscriptionResponse', data: request })));
        if (disconnect) socket.emit('close');
        else socket.emit('message', Buffer.from(JSON.stringify({ channel: 'openOrders',
          data: { user: `0x${'33'.repeat(20)}`, dex: '', orders: [] } })));
      });
      await expect(s.source.readOrders(account, [''], 5000)).rejects.toThrow();
      expect(s.socket.terminate).toHaveBeenCalledTimes(1); s.source.close();
    }
  });
  it('refuses partial snapshots or unacknowledged cleanup at the overall deadline', async () => {
    vi.useFakeTimers();
    try {
      for (const omit of ['snapshot', 'cleanup']) {
        const s = orderSource((socket, request) => {
          if (request.method === 'unsubscribe') return;
          socket.emit('message', Buffer.from(JSON.stringify({ channel: 'subscriptionResponse', data: request })));
          if (omit === 'cleanup') socket.emit('message', Buffer.from(JSON.stringify({ channel: 'openOrders',
            data: { user: account, dex: '', orders: [] } })));
        });
        const failure = expect(s.source.readOrders(account, [''], 5000)).rejects.toThrow('live_account_orders_deadline_exceeded');
        await vi.advanceTimersByTimeAsync(5001); await failure;
        expect(s.socket.terminate).toHaveBeenCalledTimes(1); s.source.close();
      }
    } finally { vi.useRealTimers(); }
  });
  it('refuses an aggregate snapshot without its exact fresh subscription acknowledgement', async () => {
    const socket = new OfflineSocket(); socket.readyState = WebSocket.OPEN;
    const source = new HyperliquidAllDexsAccountSource(() => now, () => socket as unknown as WebSocket);
    const pending = source.read(account, 5000);
    socket.emit('message', Buffer.from(JSON.stringify({ channel: 'allDexsClearinghouseState',
      data: { user: account, clearinghouseStates: [['', state()]] } })));
    await expect(pending).rejects.toThrow('live_account_order_ack_missing'); source.close();
  });
  it('binds fixed testnet/account and reuses a single bounded read-only connection', async () => {
    const socket = new OfflineSocket();
    const create = vi.fn((url: string, options: WebSocket.ClientOptions) => {
      expect(url).toBe('wss://api.hyperliquid-testnet.xyz/ws');
      expect(options).toMatchObject({ maxPayload: 8 * 1024 * 1024, followRedirects: false, autoPong: false });
      return socket as unknown as WebSocket;
    });
    const source = new HyperliquidAllDexsAccountSource(() => now, create);
    socket.send.mockImplementation((body) => {
      queueMicrotask(() => {
        socket.emit('message', Buffer.from(JSON.stringify({ channel: 'subscriptionResponse', data: JSON.parse(body) })));
        if (JSON.parse(body).method === 'subscribe') socket.emit('message', Buffer.from(JSON.stringify({ channel: 'allDexsClearinghouseState',
          data: { user: account, clearinghouseStates: [['', state()]] } })));
      });
    });
    const pending = source.read(account, 5000);
    socket.readyState = WebSocket.OPEN; socket.emit('open');
    expect(await pending).toMatchObject({ network: 'testnet', accountAddress: account, observedAt: now });
    await source.read(account, 5000);
    expect(create).toHaveBeenCalledTimes(1);
    expect(socket.send.mock.calls.map(([body]) => JSON.parse(body))).toEqual(Array.from({ length: 2 }, () => [
      { method: 'subscribe', subscription: { type: 'allDexsClearinghouseState', user: account } },
      { method: 'unsubscribe', subscription: { type: 'allDexsClearinghouseState', user: account } },
    ]).flat());
    source.close(); expect(socket.terminate).toHaveBeenCalledTimes(1);
  });
  it('refuses mismatched account messages and bounds a connection without a snapshot', async () => {
    const socket = new OfflineSocket(); socket.readyState = WebSocket.OPEN;
    const source = new HyperliquidAllDexsAccountSource(() => now, () => socket as unknown as WebSocket);
    const pending = source.read(account, 5000);
    socket.emit('message', Buffer.from(JSON.stringify({ channel: 'subscriptionResponse', data: {
      method: 'subscribe', subscription: { type: 'allDexsClearinghouseState', user: account } } })));
    socket.emit('message', Buffer.from(JSON.stringify({ channel: 'allDexsClearinghouseState',
      data: { user: `0x${'33'.repeat(20)}`, clearinghouseStates: [] } })));
    await expect(pending).rejects.toThrow('live_account_source_mismatch');
    vi.useFakeTimers();
    try {
      const failure = expect(source.read(account, 5000)).rejects.toThrow('live_account_aggregate_unavailable');
      await vi.advanceTimersByTimeAsync(5001); await failure;
      expect(socket.terminate.mock.calls.length).toBeGreaterThanOrEqual(1);
    } finally { source.close(); vi.useRealTimers(); }
  });
  it('rejects unexpected native ping without sending an unmetered automatic pong',async()=>{
    const socket=new OfflineSocket();socket.readyState=WebSocket.OPEN;
    const source=new HyperliquidAllDexsAccountSource(()=>now,(_url,options)=>{expect(options.autoPong).toBe(false);return socket as unknown as WebSocket;});
    const pending=source.read(account,5000);socket.emit('ping',Buffer.from('probe'));
    await expect(pending).rejects.toThrow('live_account_aggregate_unavailable');expect(socket.send).toHaveBeenCalledTimes(1);source.close();
  });

  it('renews and sends a metered ping for idle unscoped reuse, then stops background work at shutdown',async()=>{
    vi.useFakeTimers();try{
      const global=offlineGlobalTransport(vi.fn()),socket=new OfflineSocket();socket.readyState=WebSocket.OPEN;
      const quota:HyperliquidSocketQuota={cancelBeforeConnect:vi.fn(async()=>{}),attach:vi.fn(),subscribe:vi.fn<HyperliquidSocketQuota['subscribe']>(async subs=>{
        const expected=subs.flatMap(sub=>[{method:'subscribe',subscription:sub.subscription},{method:'unsubscribe',subscription:sub.subscription}]);
        return {dispatch:(body,work)=>{const i=expected.findIndex(c=>JSON.stringify(c)===JSON.stringify(body));if(i<0)throw Error();return work(expected.splice(i,1)[0]!);}};
      }),unsubscribe:vi.fn(),renew:vi.fn(async()=>{}),ping:vi.fn<HyperliquidSocketQuota['ping']>(async()=>({assertFresh:()=>{},dispatch:work=>work()})),uncertain:vi.fn(async()=>{}),whenIdle:vi.fn(async()=>{}),close:vi.fn(async()=>{socket.readyState=WebSocket.CLOSED;socket.emit('close',1000);})};
      vi.spyOn(global.transport,'currentQuota').mockReturnValue({acquireRest:vi.fn(),reserveSocket:vi.fn(async()=>({connect:{assertFresh:()=>{},dispatch:<T>(work:()=>T):T=>work()},connection:quota}))});
      socket.send.mockImplementation(body=>{const command=JSON.parse(body);if(command.method==='ping')return;queueMicrotask(()=>{
        socket.emit('message',Buffer.from(JSON.stringify({channel:'subscriptionResponse',data:command})));if(command.method==='subscribe')socket.emit('message',Buffer.from(JSON.stringify({channel:'allDexsClearinghouseState',data:{user:account,clearinghouseStates:[]}})));
      });});
      const source=new HyperliquidAllDexsAccountSource(Date.now,()=>socket as unknown as WebSocket,'testnet',global.transport);
      await source.read(account,5000);await vi.advanceTimersByTimeAsync(20001);
      expect(quota.renew).toHaveBeenCalledOnce();expect(quota.ping).toHaveBeenCalledOnce();expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({method:'ping'});
      await source.close();await vi.advanceTimersByTimeAsync(20001);expect(quota.ping).toHaveBeenCalledOnce();
    }finally{vi.useRealTimers();}
  });

});
