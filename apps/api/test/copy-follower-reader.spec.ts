import { describe, expect, it, vi } from 'vitest';
import { HyperliquidFollowerReceiptReader } from '../src/copy/live/follower-receipt-reader.js';

const account = `0x${'22'.repeat(20)}`, now = 1_790_000_000_000;
const from = now - 1000, to = now - 1;
function fill(tid = 1, time = from, extra = {}) {
  return { tid, oid: 10, coin: 'BTC', side: 'B', time, px: '65000', sz: '0.001', fee: '0.01',
    closedPnl: '1', feeToken: 'USDC', hash: `0x${'aa'.repeat(32)}`, ...extra };
}
function funding(time = from, extra = {}) {
  return { time, hash: `0x${'bb'.repeat(32)}`, delta: { type: 'funding', coin: 'BTC', usdc: '-0.3',
    szi: '-0.01', fundingRate: '0.01', nSamples: null }, ...extra };
}
function setup(reply: (body: Record<string, any>) => unknown = (body) => body.type === 'userFunding' ? [funding()] : [fill()]) {
  let clock = now;
  const acquire = vi.fn(async (_weight: number) => {}), bodies: Record<string, any>[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    expect(url).toBe('https://api.hyperliquid-testnet.xyz/info'); expect(options?.redirect).toBe('error');
    const body = JSON.parse(String(options?.body)); bodies.push(body);
    expect(body.user).toBe(account);
    return new Response(JSON.stringify(reply(body)));
  });
  const reader = new HyperliquidFollowerReceiptReader('testnet', acquire, fetcher, () => clock);
  return { reader, acquire, fetcher, bodies, setClock: (at: number) => { clock = at; } };
}
const input = { accountAddress: account, from, to, maxRequests: 16 };

describe('bounded account follower receipt reads (offline)', () => {
  it('reads raw unaggregated fills and actual signed funding with fresh fixed source identity', async () => {
    const s = setup(), result = await s.reader.read(input);
    expect(s.bodies).toEqual([{ type: 'userFillsByTime', user: account, startTime: from, endTime: to, aggregateByTime: false },
      { type: 'userFunding', user: account, startTime: from, endTime: to }]);
    expect(result).toMatchObject({ network: 'testnet', accountAddress: account, from, to, fresh: true,
      historicalCompleteness: 'unproven', requestsUsed: 2 });
    expect(result.fills[0]).toMatchObject({ raw: fill(), parsed: { tid: '1', cashDelta: '0.99', totalFee: '0.01' } });
    expect(result.funding[0]).toMatchObject({ raw: funding(), parsed: { cashDelta: '-0.3' } });
    expect(result.observations.map((o) => [o.kind, o.saturated, o.retained])).toEqual([['fills', false, true], ['funding', false, true]]);
    expect(result.unresolvedWindows).toEqual([]);
    expect(result.completenessReasons).toContain('latest_10000_fills_limit');
    expect(Object.isFrozen(result.fills[0].raw)).toBe(true);
    expect(Object.isFrozen(result.funding[0].raw.delta)).toBe(true);
    expect(s.acquire.mock.calls).toEqual([[120], [120]]);
  });
  it('splits possibly capped responses into exact non-overlapping inclusive windows', async () => {
    const records = Array.from({ length: 501 }, (_, i) => fill(i + 1, from + i));
    const s = setup((body) => body.type === 'userFunding' ? []
      : records.filter((r) => r.time >= body.startTime && r.time <= body.endTime));
    const result = await s.reader.read({ ...input, to: from + 500 });
    expect(result.fills).toHaveLength(501); expect(result.unresolvedWindows).toEqual([]);
    expect(s.bodies.filter((b) => b.type === 'userFillsByTime').map((b) => [b.startTime, b.endTime]))
      .toEqual([[from, from + 500], [from, from + 250], [from + 251, from + 500]]);
    expect(result.observations[0]).toMatchObject({ count: 501, saturated: true });
    expect(result.historicalCompleteness).toBe('unproven');
  });
  it('never advances past a full same-ms fill page', async () => {
    const records = Array.from({ length: 2000 }, (_, i) => fill(i + 1, from));
    const s = setup((body) => body.type === 'userFunding' ? [] : records);
    const result = await s.reader.read({ ...input, to: from });
    expect(result.fills).toHaveLength(2000);
    expect(result.unresolvedWindows).toEqual([{ kind: 'fills', from, to: from, depth: 0, reason: 'same_ms_cap' }]);
    expect(s.bodies.filter((b) => b.type === 'userFillsByTime')).toHaveLength(1);
  });
  it('recovers records truncated at 2000 using interval splits without claiming retained history', async () => {
    const begin = now - 5000, end = begin + 2048;
    const records = Array.from({ length: 2049 }, (_, i) => fill(i + 1, begin + i));
    const s = setup((b) => b.type === 'userFunding' ? []
      : records.filter((r) => r.time >= b.startTime && r.time <= b.endTime).slice(0, 2000));
    const result = await s.reader.read({ ...input, from: begin, to: end, maxRequests: 32 });
    expect(result.fills).toHaveLength(2049); expect(result.unresolvedWindows).toEqual([]);
    expect(result.fills.at(-1)?.parsed.tid).toBe('2049');
    expect(result.observations[0].saturationReasons).toContain('response_cap');
    expect(result.historicalCompleteness).toBe('unproven');
  });
  it('retains saturated funding same-ms windows too', async () => {
    const records = Array.from({ length: 500 }, (_, i) => funding(from, { hash: `0x${i.toString(16).padStart(64, '0')}` }));
    const result = await setup((b) => b.type === 'userFunding' ? records : []).reader.read({ ...input, to: from });
    expect(result.funding).toHaveLength(500);
    expect(result.unresolvedWindows).toEqual([{ kind: 'funding', from, to: from, depth: 0, reason: 'same_ms_cap' }]);
  });
  it('retains whole saturated intervals when split depth is exhausted', async () => {
    const records = Array.from({ length: 500 }, (_, i) => fill(i + 1, from + i));
    const s = setup((b) => b.type === 'userFunding' ? [] : records);
    const result = await s.reader.read({ ...input, maxDepth: 0 });
    expect(result.unresolvedWindows).toEqual([{ kind: 'fills', from, to, depth: 0, reason: 'depth_limit' }]);
    expect(s.fetcher).toHaveBeenCalledTimes(2);
  });
  it('leaves unrequested windows resumable at the exact local request budget', async () => {
    const s = setup();
    const result = await s.reader.read({ ...input, maxRequests: 1 });
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(result.unresolvedWindows).toEqual([{ kind: 'funding', from, to, depth: 0, reason: 'request_budget' }]);
    const resumed = await s.reader.read({ ...input, resumeWindows: result.unresolvedWindows });
    expect(resumed.fills).toEqual([]); expect(resumed.funding).toHaveLength(1);
    expect(s.bodies).toHaveLength(2);
  });
  it('accepts reordered decimal-equivalent duplicate receipts but conflicts on changed financial or raw identity', async () => {
    const equivalent = { ...fill(), tid: '1', oid: '10', px: '65000.0', fee: '0.010', builderFee: '0.0' };
    const result = await setup((b) => b.type === 'userFunding' ? [] : [fill(), equivalent]).reader.read(input);
    expect(result.fills).toHaveLength(1);
    for (const changed of [fill(1, from, { fee: '2' }), fill(1, from, { hash: `0x${'cc'.repeat(32)}` })]) {
      await expect(setup((b) => b.type === 'userFunding' ? [] : [fill(), changed]).reader.read(input))
        .rejects.toThrow('follower_receipt_conflict');
    }
  });
  it('tolerates exact funding repeats and refuses conflicting actual amount for the same receipt', async () => {
    const s = setup((b) => b.type === 'userFunding' ? [funding(), funding()] : []);
    expect((await s.reader.read(input)).funding).toHaveLength(1);
    await expect(setup((b) => b.type === 'userFunding' ? [funding(), funding(from, {
      delta: { ...funding().delta, usdc: '99' } })] : []).reader.read(input)).rejects.toThrow('follower_receipt_conflict');
  });
  it('quarantines a conflicting receipt rediscovered in a child interval', async () => {
    const records = Array.from({ length: 501 }, (_, i) => fill(i + 1, from + i));
    const s = setup((b) => b.type === 'userFunding' ? [] : records
      .filter((r) => r.time >= b.startTime && r.time <= b.endTime)
      .map((r) => r.tid === 1 && b.endTime < to ? { ...r, fee: '2' } : r));
    await expect(s.reader.read(input)).rejects.toThrow('follower_receipt_conflict');
  });
  it.each([{ user: `0x${'33'.repeat(20)}` }, { network: 'mainnet' }, { time: from - 1 }, { time: to + 1 }, { side: ['B'] }])
    ('quarantines mismatched or malformed source evidence %j', async (patch) => {
      await expect(setup((b) => b.type === 'userFunding' ? [] : [fill(1, from, patch)]).reader.read(input)).rejects.toThrow();
    });
  it('does not mistake an empty historical array for proven history', async () => {
    const result = await setup(() => []).reader.read({ ...input, from: 0 });
    expect(result.historicalCompleteness).toBe('unproven');
    expect(result.completenessReasons).toEqual(['latest_10000_fills_limit', 'provider_history_unproven']);
    expect(result.observations.every((o) => o.count === 0 && !o.saturated)).toBe(true);
  });
  it('does not certify data omitted because the retained-receipt bound was reached', async () => {
    const s = setup((b) => b.type === 'userFunding' ? [] : [fill(), fill(2)]);
    const result = await s.reader.read({ ...input, maxReceipts: 1 });
    expect(result.fills).toEqual([]);
    expect(result.observations[0]).toMatchObject({ retained: false });
    expect(result.unresolvedWindows[0]).toMatchObject({ kind: 'fills', from, to, reason: 'receipt_budget' });
  });
  it('keeps stale observations unresolved rather than issuing fresh coverage', async () => {
    const s = setup(() => { s.setClock(now + 5001); return []; });
    const result = await s.reader.read(input);
    expect(result.fresh).toBe(false);
    expect(result.unresolvedWindows.every((w) => w.reason === 'evidence_expired')).toBe(true);
    expect(result.observations).toEqual([]);
  });
  it('redacts upstream failures and bounds a budget that never resolves', async () => {
    const s = setup(); s.fetcher.mockRejectedValue(new Error('provider_secret'));
    const result = await s.reader.read(input);
    expect(result.unresolvedWindows[0].reason).toBe('read_unavailable');
    expect(JSON.stringify(result)).not.toContain('provider_secret');
    vi.useFakeTimers();
    try {
      const reader = new HyperliquidFollowerReceiptReader('testnet', () => new Promise(() => {}), s.fetcher, () => now);
      const pending = reader.read(input);
      await vi.advanceTimersByTimeAsync(5001);
      expect((await pending).unresolvedWindows[0].reason).toBe('read_timeout');
    } finally { vi.useRealTimers(); }
  });
  it('refuses future ranges and invalid bounds before dispatch', async () => {
    const s = setup();
    for (const patch of [{ from: to + 1 }, { to: now + 1 }, { maxRequests: 0 }, { maxRequests: 65 },
      { maxDepth: 54 }, { from: -1 }, { maxReceipts: 10001 },
      { resumeWindows: [{ kind: 'fills' as const, from: 0, to, depth: 0 }] }])
      await expect(s.reader.read({ ...input, ...patch })).rejects.toThrow();
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('gives back the weight an answer did not use (120 acquired per read, 20 + 1 per 20 rows spent)', async () => {
    const refund = vi.fn(), acquire = vi.fn(async (_weight: number) => {});
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      return new Response(JSON.stringify(body.type === 'userFunding' ? [funding()] : Array.from({ length: 30 }, (_, i) => fill(i + 1, from + i))));
    });
    await new HyperliquidFollowerReceiptReader('testnet', acquire, fetcher, () => now, refund).read({ ...input, maxRequests: 2 });
    expect(acquire.mock.calls).toEqual([[120], [120]]);
    expect(refund.mock.calls.map(([w]) => w).sort((a, b) => a - b)).toEqual([120 - 22, 120 - 21]);
  });
});
