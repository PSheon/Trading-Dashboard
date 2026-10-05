import { describe, expect, it, vi } from 'vitest';
import { HyperliquidLiveMarketResolver } from '../src/copy/live/live-market-resolver.js';

function setup(universe = [{ name: 'xyz:TSLA', szDecimals: 3, maxLeverage: 10 }]) {
  let clock = 100;
  const reads: unknown[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    expect(url).toBe('https://api.hyperliquid-testnet.xyz/info');
    const body = JSON.parse(String(options?.body)); reads.push(body);
    const result = body.type === 'perpDexs' ? [null, { name: 'aaa' }, null, { name: 'xyz' }]
      : { universe: body.dex ? universe : [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }] };
    return new Response(JSON.stringify(result));
  });
  const resolver = new HyperliquidLiveMarketResolver('testnet', async () => {}, fetcher, () => clock);
  return { resolver, reads, setClock: (value: number) => { clock = value; }, fetcher };
}
describe('authoritative indexed live markets', () => {
  it('pays for its reads before its clock: a budget wait never ages the market evidence', async () => {
    let clock = 100;
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      return new Response(JSON.stringify(body.type === 'perpDexs' ? [null, { name: 'xyz' }] : { universe: body.dex ? [{ name: 'xyz:TSLA', szDecimals: 3, maxLeverage: 10 }] : [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }] }));
    });
    const acquire = vi.fn(async () => { clock += 6_000; });
    const resolver = new HyperliquidLiveMarketResolver('testnet', acquire, fetcher, () => clock);
    await expect(resolver.resolve('xyz:TSLA')).resolves.toMatchObject({ observedAt: 6_100 });
    expect(acquire.mock.calls).toEqual([[40]]);
  });
  it('bounds a budget read that never resolves', async () => {
    vi.useFakeTimers();
    try {
      const resolver = new HyperliquidLiveMarketResolver('testnet', () => new Promise(() => {}));
      let outcome = 'pending';
      void resolver.resolve('BTC').then(() => { outcome = 'accepted'; }, () => { outcome = 'blocked'; });
      // The reservation is taken before the 5 s clock and bounded on its own.
      await vi.advanceTimersByTimeAsync(10_001);
      expect(outcome).toBe('blocked');
    } finally { vi.useRealTimers(); }
  });
  it('preserves original null-bearing dex indices and maps both directions', async () => {
    const { resolver } = setup();
    expect(await resolver.resolve('xyz:TSLA')).toMatchObject({ asset: 130000, dex: 'xyz', perpDexIndex: 3, universeIndex: 0 });
    expect(await resolver.resolveAsset(130000)).toMatchObject({ coin: 'xyz:TSLA' });
    expect(await resolver.resolve('BTC')).toMatchObject({ asset: 0, dex: '', perpDexIndex: 0, sizeDecimals: 5 });
  });
  it('supports listed dex indices beyond one hundred without compacting null slots', async () => {
    const s = setup(), previous = s.fetcher.getMockImplementation()!;
    const dexes = Array.from({ length: 268 }, (_, i) => i === 0 || i === 120 ? null : { name: i === 267 ? 'xyz' : `dex${i}` });
    s.fetcher.mockImplementation(async (url, options) => JSON.parse(String(options?.body)).type === 'perpDexs'
      ? new Response(JSON.stringify(dexes)) : previous(url, options));
    expect(await s.resolver.resolve('xyz:TSLA')).toMatchObject({ asset: 2770000, perpDexIndex: 267 });
    expect(await s.resolver.resolveAsset(2770000)).toMatchObject({ coin: 'xyz:TSLA', perpDexIndex: 267 });
  });
  it('accepts exact provider-listed punctuation in deployed dex names', async () => {
    const s = setup([{ name: 'i<3fl:BTC', szDecimals: 3, maxLeverage: 10 }]);
    const previous = s.fetcher.getMockImplementation()!;
    s.fetcher.mockImplementation(async (url, options) => JSON.parse(String(options?.body)).type === 'perpDexs'
      ? new Response(JSON.stringify([null, { name: 'i<3fl' }])) : previous(url, options));
    expect(await s.resolver.resolve('i<3fl:BTC')).toMatchObject({ coin: 'i<3fl:BTC', dex: 'i<3fl', asset: 110000 });
  });
  it.each(['coin', 'asset'])('refuses duplicate listed dex coordinates when resolving by %s', async (kind) => {
    const s = setup(), previous = s.fetcher.getMockImplementation()!;
    s.fetcher.mockImplementation(async (url, options) => JSON.parse(String(options?.body)).type === 'perpDexs'
      ? new Response(JSON.stringify([null, { name: 'aaa' }, { name: 'aaa' }, { name: 'xyz' }])) : previous(url, options));
    await expect(kind === 'coin' ? s.resolver.resolve('xyz:TSLA') : s.resolver.resolveAsset(130000))
      .rejects.toThrow('live_market_duplicate_identity');
  });
  it.each(['coin', 'asset'])('refuses duplicate universe identities when resolving by %s', async (kind) => {
    const s = setup(), previous = s.fetcher.getMockImplementation()!;
    s.fetcher.mockImplementation(async (url, options) => JSON.parse(String(options?.body)).type === 'meta'
      ? new Response(JSON.stringify({ universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 },
        { name: 'ETH', szDecimals: 4, maxLeverage: 40 }, { name: 'ETH', szDecimals: 4, maxLeverage: 40 }] })) : previous(url, options));
    await expect(kind === 'coin' ? s.resolver.resolve('BTC') : s.resolver.resolveAsset(0))
      .rejects.toThrow('live_market_duplicate_identity');
  });
  it.each([10000, 100000, 120000, 130001, 999999999])('refuses spot, missing dex and unlisted assets %s', async (asset) => {
    await expect(setup().resolver.resolveAsset(asset)).rejects.toThrow();
  });
  it('refuses delisted markets and never returns stale evidence from slow reads', async () => {
    await expect(setup([{ name: 'xyz:TSLA', szDecimals: 3, maxLeverage: 10, isDelisted: true } as never]).resolver.resolve('xyz:TSLA')).rejects.toThrow();
    const s = setup();
    const original = s.fetcher.getMockImplementation()!;
    s.fetcher.mockImplementation(async (...args) => { const result = await original(...args); s.setClock(5201); return result; });
    await expect(s.resolver.resolve('BTC')).rejects.toThrow('market_evidence_expired');
  });
});
