import { describe, expect, it, vi } from 'vitest';
import { HyperliquidLiveSourceClient } from '../src/copy/copy-live-source.client.js';
import { canonicalLiveSourceLegs, decodeLiveSourceFill, liveSourceDigest, parseLiveSourceFill } from '../src/copy/live/copy-live-source-evidence.js';
import { assertLiveSourcePrice, liveSourceDeviationBps, planLiveSourceOrder, SOURCE_EQUITY_MAX_AGE_MS, SOURCE_MID_MAX_AGE_MS, type LiveSourcePlanInput } from '../src/copy/live/copy-live-source-planner.js';
import type { LiveSourceSizingEnvelopeV1 } from '../src/copy/live/copy-live-sizing-evidence.js';
import { MainnetSourceReferenceReader } from '../src/copy/live/live-source-reference.js';
import { digest } from '../src/copy/copy-live-mandate-evidence.js';
import { Dec } from '../src/common/decimal/dec.js';
import { sourceSizingExample } from './copy-live-generation-test-utils.js';

const leader = `0x${'44'.repeat(20)}`;
const raw = { tid: 1, oid: 7, time: 1500, coin: 'BTC', side: 'B', px: '100', sz: '1', startPosition: '0' };

describe('mainnet leader fills as source evidence', () => {
  it('keeps the network in the identity, digest and stored mirror', () => {
    const context = { leaderAddress: leader, from: 1000, to: 2000, receivedAt: 2000, kind: 'fills' as const };
    const mainnet = parseLiveSourceFill(raw, { ...context, network: 'mainnet' }), testnet = parseLiveSourceFill(raw, { ...context, network: 'testnet' });
    expect(mainnet).toMatchObject({ id: `mainnet:${leader}:1`, streamId: `mainnet:${leader}`, network: 'mainnet', normalized: { network: 'mainnet' } });
    expect(mainnet.sourceDigest).not.toBe(testnet.sourceDigest);
    const row = { ...mainnet, normalized: { ...mainnet.normalized }, providerTime: new Date(mainnet.providerTime), receivedAt: new Date(mainnet.receivedAt) };
    expect(decodeLiveSourceFill(row)).toEqual(mainnet);
    // A row relabelled to the other network cannot be decoded as a signal.
    expect(() => decodeLiveSourceFill({ ...row, network: 'testnet' })).toThrow();
    expect(() => parseLiveSourceFill({ ...raw, network: 'testnet' }, { ...context, network: 'mainnet' })).toThrow();
  });
  it('reads only the official mainnet origin for a mainnet source client', async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => Response.json(JSON.parse(String(init?.body)).type === 'userFillsByTime' ? [raw] : []));
    const result = await new HyperliquidLiveSourceClient('mainnet', async () => undefined, fetcher as typeof fetch, () => 2100)
      .read({ leaderAddress: leader, from: 1000, to: 2000, maxRequests: 4 });
    expect(result).toMatchObject({ network: 'mainnet', complete: true });
    expect(result.fills[0]).toMatchObject({ network: 'mainnet', id: `mainnet:${leader}:1` });
    expect(new Set(fetcher.mock.calls.map(([url]) => url))).toEqual(new Set(['https://api.hyperliquid.xyz/info']));
    expect(() => new HyperliquidLiveSourceClient('devnet' as 'mainnet', async () => undefined)).toThrow();
  });
});

describe('testnet/mainnet price deviation', () => {
  it('measures basis points against the mainnet mid', () => {
    expect(liveSourceDeviationBps('95', '100').toString()).toBe('500');
    expect(liveSourceDeviationBps('10', '100').toString()).toBe('9000'); // ZEC on 10-04: −90 %
    expect(() => assertLiveSourcePrice('95', { midPrice: '100', maxDeviationBps: '500' })).not.toThrow();
    expect(() => assertLiveSourcePrice('94.99', { midPrice: '100', maxDeviationBps: '500' })).toThrow('live_source_price_deviation');
    expect(() => assertLiveSourcePrice('105.01', { midPrice: '100', maxDeviationBps: '500' })).toThrow('live_source_price_deviation');
  });
});

/** The planner fixture, re-pointed at a mainnet leader. */
function mainnetExample(mode: 'fixed' | 'ratio', mainnetMid = '100', overrides: Record<string, unknown> = {}): LiveSourcePlanInput {
  const e = structuredClone(sourceSizingExample(mode)) as LiveSourcePlanInput & { mandate: Record<string, unknown> };
  const intent = { ...(e.mandate.intent as Record<string, unknown>), sourceNetwork: 'mainnet' };
  Object.assign(e.mandate, { sourceNetwork: 'mainnet', intent, intentDigest: digest(intent) });
  const fill = parseLiveSourceFill({ tid: 1, oid: 7, time: e.now - 500, coin: 'BTC', side: 'B', px: '100', sz: '1', startPosition: '0' },
    { network: 'mainnet', leaderAddress: leader, from: e.now - 1000, to: e.now, receivedAt: e.now, kind: 'fills' });
  const envelope = e.sizingBasis as { basis: Record<string, unknown>; observations: Record<string, unknown> };
  Object.assign(envelope.basis, { sourceFillId: fill.id, sourceDigest: fill.sourceDigest, leader: null,
    sourceReference: { network: 'mainnet', leaderAddress: leader, leaderEquity: mode === 'ratio' ? '1000' : null, leaderEquityObservedAt: mode === 'ratio' ? e.now - 30000 : null,
      midPrice: mainnetMid, midObservedAt: e.now - 2000, maxDeviationBps: '500', ...overrides } });
  (envelope.observations as Record<string, unknown>).leader = null;
  return { ...e, fill, leg: canonicalLiveSourceLegs(fill)[0]! };
}

describe('sizing a mainnet leader open on testnet', () => {
  it.each(['fixed', 'ratio'] as const)('plans %s sizing from the leader capital on mainnet and the testnet mid', mode => {
    expect(planLiveSourceOrder(mainnetExample(mode))).toMatchObject({ order: { coin: 'BTC', side: 'B', size: mode === 'fixed' ? '0.09' : '0.1', limitPrice: '100.5' } });
  });
  it('converts the leader notional to testnet coins at the testnet mid', () => {
    // Leader capital 2000 halves the ratio: 1 BTC × 100 × 100 / (2000 × 100).
    expect(planLiveSourceOrder(mainnetExample('ratio', '100', { leaderEquity: '2000' })).order.size).toBe('0.05');
  });
  it('refuses a testnet mid outside the threshold with its own reason', () => {
    expect(() => planLiveSourceOrder(mainnetExample('ratio', '110'))).toThrow('live_source_price_deviation');
  });
  it.each([
    ['missing reference', { __delete: true }],
    ['stale mid', { midObservedAt: -SOURCE_MID_MAX_AGE_MS - 1 }],
    ['stale capital', { leaderEquityObservedAt: -SOURCE_EQUITY_MAX_AGE_MS - 1 }],
    ['other leader', { leaderAddress: `0x${'55'.repeat(20)}` }],
    ['missing capital for ratio', { leaderEquity: null, leaderEquityObservedAt: null }],
  ])('refuses %s', (_name, change) => {
    const e = mainnetExample('ratio'), b = (e.sizingBasis as LiveSourceSizingEnvelopeV1).basis as unknown as Record<string, Record<string, unknown>>;
    if ('__delete' in change) delete b.sourceReference;
    else for (const [key, value] of Object.entries(change)) b.sourceReference![key] = typeof value === 'number' && key.endsWith('ObservedAt') ? e.now + value : value;
    expect(() => planLiveSourceOrder(e)).toThrow('live_source_sizing_unproven');
  });
  it('refuses a mainnet reference on a testnet-source plan', () => {
    const e = structuredClone(sourceSizingExample('fixed'));
    ((e.sizingBasis as LiveSourceSizingEnvelopeV1).basis as unknown as Record<string, unknown>).sourceReference =
      { network: 'mainnet', leaderAddress: leader, leaderEquity: null, leaderEquityObservedAt: null, midPrice: '100', midObservedAt: e.now, maxDeviationBps: '500' };
    expect(() => planLiveSourceOrder(e)).toThrow('live_source_sizing_unproven');
  });
});

describe('mainnet reference reader', () => {
  const market = (mid: Dec | undefined, equity: { state: 'known'; value: Dec } | { state: 'failed' }) => ({
    midPrices: vi.fn(async () => ({ at: new Date(1000), px: new Map(mid ? [['BTC', mid]] : []), missingDexes: new Set<string>() })),
    leaderEquity: vi.fn(async () => equity), equityCache: new Map([[leader, { at: 900, value: 1 }]]),
  });
  it('returns the shared mainnet mid and the leader capital with their observation times', async () => {
    const reader = new MainnetSourceReferenceReader(market(Dec.from('101.5'), { state: 'known', value: Dec.from('2500') }) as never);
    expect(await reader.read(leader, 'BTC', true)).toEqual({ midPrice: '101.5', midObservedAt: 1000, leaderEquity: '2500', leaderEquityObservedAt: 900 });
    expect(await reader.read(leader, 'BTC', false)).toEqual({ midPrice: '101.5', midObservedAt: 1000, leaderEquity: null, leaderEquityObservedAt: null });
  });
  it('refuses missing prices or capital instead of using zero', async () => {
    await expect(new MainnetSourceReferenceReader(market(undefined, { state: 'known', value: Dec.from('1') }) as never).read(leader, 'BTC', false)).rejects.toThrow('live_source_reference_unavailable');
    await expect(new MainnetSourceReferenceReader(market(Dec.from('1'), { state: 'failed' }) as never).read(leader, 'BTC', true)).rejects.toThrow('live_source_reference_unavailable');
  });
});

describe('evidence digests', () => {
  it('digest a generation-deep structure (a settled order nests about twenty levels) but refuse unbounded nesting', () => {
    const nest = (depth: number): unknown => depth === 0 ? 'leaf' : { next: nest(depth - 1) };
    expect(liveSourceDigest(nest(30))).toMatch(/^[0-9a-f]{64}$/);
    expect(() => liveSourceDigest(nest(70))).toThrow('invalid_live_source_evidence');
  });
});
