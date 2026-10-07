import { describe, expect, it, vi } from 'vitest';
import { HyperliquidLiveSourceClient } from '../src/copy/copy-live-source.client.js';
const leader = `0x${'11'.repeat(20)}`;
const fill = (tid = 1, time = 1500) => ({ tid, oid: 7, time, coin: 'BTC', side: 'B', px: '100', sz: '1', startPosition: '0' });
const req = () => ({ leaderAddress: leader, from: 1000, to: 2000, maxRequests: 6 });
const acquire = () => vi.fn(async (_weight: number) => undefined);
function client(fetcher: typeof fetch, now: () => number = () => 2100, budget: (weight: number) => Promise<unknown> = acquire()) { return new HyperliquidLiveSourceClient('testnet', budget, fetcher, now); }
describe('bounded fixed-network source reads', () => {
  it('reserves both mandatory channels before the provider evidence clock starts', async () => {
    let now = 2100;
    const budget = vi.fn(async () => { now += 4000; });
    const fetcher = vi.fn(async () => Response.json([]));
    const result = await client(fetcher as typeof fetch, () => now, budget).read(req());
    expect(result).toMatchObject({ complete: true, fresh: true, observedAt: 6100, completedAt: 6100, requestsUsed: 2 });
    expect(budget.mock.calls).toEqual([[240]]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('propagates initial quota refusal without publishing incomplete source coverage', async () => {
    const budget = vi.fn(async () => { throw new Error('budget unavailable'); });
    const fetcher = vi.fn(async () => Response.json([fill()]));
    await expect(client(fetcher as typeof fetch, undefined, budget).read(req())).rejects.toThrow('budget unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('refunds only the prepaid channel that was never sent after a failed first response', async () => {
    const refund = vi.fn(), budget = acquire();
    const result = await new HyperliquidLiveSourceClient('testnet', budget, (async () => Response.json({}, { status: 500 })) as typeof fetch, () => 2100, refund).read(req());
    expect(result.complete).toBe(false);
    expect(budget.mock.calls).toEqual([[240]]);
    expect(refund.mock.calls).toEqual([[120]]);
  });
  it('reads both ordinary and TWAP sources at only the official testnet origin, without aggregation', async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); return Response.json(body.type === 'userFillsByTime' ? [fill()] : [{ twapId: 9, fill: fill(2) }]);
    }), budget = acquire();
    const result = await client(fetcher as typeof fetch, undefined, budget).read(req());
    expect(result).toMatchObject({ network: 'testnet', leaderAddress: leader, complete: true, fresh: true, historicalCompleteness: 'unproven', requestsUsed: 2, unresolved: [] });
    expect(result.fills.map(f => f.tradeKey)).toEqual(['oid:7', 'twap:9']); expect(budget.mock.calls).toEqual([[240]]);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe('https://api.hyperliquid-testnet.xyz/info'); expect(init).toMatchObject({ redirect: 'error' });
      const body = JSON.parse(String(init?.body)); expect(body).toMatchObject({ user: leader, startTime: 1000, endTime: 2000 });
      if (body.type === 'userFillsByTime') expect(body.aggregateByTime).toBe(false);
    }
  });
  it('captures request identity and bounds before shared-budget waits', async () => {
    let resume!: () => void; const pendingBudget = vi.fn(() => new Promise<void>(resolve => { resume = resolve; }));
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json([])), input = { ...req(), maxRequests: 1 }, reading = client(fetcher as typeof fetch, undefined, pendingBudget).read(input);
    await Promise.resolve(); input.leaderAddress = `0x${'33'.repeat(20)}`; input.to = 9000; resume();
    const result = await reading; expect(result.leaderAddress).toBe(leader); expect(result.to).toBe(2000);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ user: leader, endTime: 2000 });
    expect(result.complete).toBe(false); expect(result.unresolved).toHaveLength(1);
  });
  it('subdivides saturated time ranges without stepping across an unproven millisecond', async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body));
      if (b.type !== 'userFillsByTime') return Response.json([]);
      if (b.startTime === 1000 && b.endTime === 2000) return Response.json(Array.from({ length: 500 }, (_, i) => fill(i + 1, 1500)));
      return Response.json(b.startTime <= 1500 && b.endTime >= 1500 ? [fill()] : []);
    });
    const result = await client(fetcher as typeof fetch).read(req());
    expect(result.complete).toBe(true); expect(result.observations.some(o => o.saturated)).toBe(true);
    const bodies = fetcher.mock.calls.map(c => JSON.parse(String(c[1]?.body)));
    expect(bodies).toContainEqual({ type: 'userFillsByTime', user: leader, startTime: 1000, endTime: 1500, aggregateByTime: false });
    expect(bodies).toContainEqual({ type: 'userFillsByTime', user: leader, startTime: 1501, endTime: 2000, aggregateByTime: false });
  });
  it('keeps same-millisecond caps unresolved and never reports complete', async () => {
    const result = await client((async (_url, init) => Response.json(JSON.parse(String(init?.body)).type === 'userFillsByTime' ? Array.from({ length: 500 }, (_, i) => fill(i + 1)) : [])) as typeof fetch).read({ ...req(), from: 1500, to: 1500 });
    expect(result.complete).toBe(false); expect(result.unresolved.some(w => w.reason === 'same_ms_cap')).toBe(true);
  });
  it('rejects contradictory duplicate trade IDs rather than silently overwriting', async () => {
    const read = client((async () => Response.json([fill(), { ...fill(), px: '101' }])) as typeof fetch).read(req());
    await expect(read).rejects.toThrow();
  });
  it('does not label short or empty REST results as complete retained history', async () => {
    const result = await client((async () => Response.json([])) as typeof fetch).read(req());
    expect(result.complete).toBe(true); expect(result.historicalCompleteness).toBe('unproven'); expect(result.fills).toEqual([]);
  });
  it('starts fresh provider requests after an initial budget wait, with the original requested window', async () => {
    let now = 2100; const budget = vi.fn(async () => { now += 5001; }), fetcher = vi.fn(async () => Response.json([]));
    const result = await client(fetcher as typeof fetch, () => now, budget).read(req());
    expect(fetcher).toHaveBeenCalledTimes(2); expect(result).toMatchObject({ complete: true, fresh: true, observedAt: 7101, from: 1000, to: 2000 });
  });
  it('bounds and cancels a stalled response stream', async () => {
    const cancel = vi.fn(); const stream = new ReadableStream({ pull() {}, cancel });
    const result = await client((async () => new Response(stream)) as typeof fetch).read({ ...req(), maxRequests: 1 });
    expect(result.complete).toBe(false); expect(cancel).toHaveBeenCalledTimes(1);
  }, 7000);
  it('rejects malformed source rows or oversized decoded bodies', async () => {
    await expect(client((async () => Response.json([{ ...fill(), startPosition: undefined }])) as typeof fetch).read(req())).rejects.toThrow();
    const result = await client((async () => new Response(' '.repeat(2 * 1024 * 1024 + 1))) as typeof fetch).read(req());
    expect(result.complete).toBe(false);
  });
  it('correlates ordinary/TWAP overlap using the actual wrapper and preserves a proven fixed trade key',async()=>{
    const ordinary={...fill(),hash:`0x${'00'.repeat(32)}`,fee:'0.1',unknown:{value:'same'}};
    const result=await client((async(_url,init)=>Response.json(JSON.parse(String(init?.body)).type==='userFillsByTime'?[ordinary]:[{twapId:9,fill:ordinary}])) as typeof fetch).read(req());
    expect(result.complete).toBe(true);expect(result.fills).toHaveLength(1);expect(result.fills[0]).toMatchObject({tradeKey:'twap:9',normalized:{kind:'twap',twapId:'9'},raw:{twapId:9,fill:ordinary}});
  });
  it.each(['px','sz','oid','twapId','fee','unknown'] as const)('rejects contradictory cross-channel %s instead of ignoring raw evidence',async field=>{
    const ordinary={...fill(),hash:`0x${'00'.repeat(32)}`,twapId:9,fee:'0.1',unknown:{value:'same'}},changed={...ordinary,[field]:field==='unknown'?{value:'changed'}:field==='twapId'?10:field==='fee'?'0.2':field==='oid'?8:'2'};
    await expect(client((async(_url,init)=>Response.json(JSON.parse(String(init?.body)).type==='userFillsByTime'?[ordinary]:[{twapId:9,fill:changed}])) as typeof fetch).read(req())).rejects.toThrow();
  });
  it('keeps a zero-hash ordinary row without a proven TWAP identity unresolved and nonactionable',async()=>{
    const ordinary={...fill(),hash:`0x${'00'.repeat(32)}`};
    const result=await client((async(_url,init)=>Response.json(JSON.parse(String(init?.body)).type==='userFillsByTime'?[ordinary]:[])) as typeof fetch).read(req());
    expect(result.complete).toBe(false);expect(result.fills).toEqual([]);expect(result.unresolved.some(w=>w.reason==='twap_identity_unproven')).toBe(true);
  });
  it('gives back the weight an answer did not use (120 acquired, 20 + 1 per 20 rows spent)', async () => {
    const refund = vi.fn(), budget = acquire();
    const fetcher = (async (_url: unknown, init?: RequestInit) => Response.json(JSON.parse(String(init?.body)).type === 'userFillsByTime'
      ? Array.from({ length: 45 }, (_, i) => fill(i + 1, 1000 + i)) : [])) as typeof fetch;
    const result = await new HyperliquidLiveSourceClient('testnet', budget, fetcher, () => 2100, refund).read(req());
    expect(result.complete).toBe(true); expect(budget.mock.calls).toEqual([[240]]);
    expect(refund.mock.calls).toEqual([[120 - 23], [120 - 20]]);
  });
});
