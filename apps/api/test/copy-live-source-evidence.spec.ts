import { describe, expect, it } from 'vitest';
import type { copyLiveSourceFills } from '@trading-dashboard/shared/database';
import { parseLiveSourceFill, decodeLiveSourceFill, canonicalLiveSourceLegs, liveSourceLegId, reconcileLiveSourceFills, liveSourceDigest, liveSourceEvidenceDetail } from '../src/copy/live/copy-live-source-evidence.js';
import { HyperliquidLiveSourceClient } from '../src/copy/copy-live-source.client.js';
import { CopyLiveSourceRepository } from '../src/copy/copy-live-source.repository.js';
const leader = `0x${'11'.repeat(20)}`, context = { network: 'testnet' as const, leaderAddress: leader, from: 1000, to: 2000, receivedAt: 2100, kind: 'fills' as const };
const raw = () => ({ tid: 7, oid: 9, time: 1500, coin: 'BTC', px: '100.000', sz: '2.000', side: 'B', startPosition: '0', hash: `0x${'22'.repeat(32)}` });
const stored = (fill = parseLiveSourceFill(raw(), context)): typeof copyLiveSourceFills.$inferSelect => ({ ...fill, providerTime: new Date(fill.providerTime), receivedAt: new Date(fill.receivedAt), normalized: { ...fill.normalized } });
describe('immutable fixed-network source evidence', () => {
  it('normalizes exact public source identity and safely preserves uint64 IDs without float conversion', () => {
    const parsed = parseLiveSourceFill({ ...raw(), tid: '18446744073709551615', oid: '9007199254740993' }, context);
    expect(parsed).toMatchObject({ id: `testnet:${leader}:18446744073709551615`, streamId: `testnet:${leader}`, tid: '18446744073709551615', oid: '9007199254740993', px: '100', sz: '2', tradeKey: 'oid:9007199254740993', originVersion: 1 });
    expect(parsed.sourceDigest).toMatch(/^[0-9a-f]{64}$/); expect(decodeLiveSourceFill(stored(parsed))).toEqual(parsed);
  });
  it('binds actual TWAP wrapper identity to its order and shared fixed trade', () => {
    const parsed = parseLiveSourceFill({ twapId: '123', fill: raw() }, { ...context, kind: 'twap' });
    expect(parsed.normalized).toMatchObject({ twapId: '123', tradeKey: 'twap:123', oid: '9' });
    expect(decodeLiveSourceFill(stored(parsed))).toEqual(parsed);
  });
  it('captures detached raw values and canonical key order while preserving unknown semantic fields', () => {
    const source = { ...raw(), extra: { amount: '1' } }, parsed = parseLiveSourceFill(source, context);
    source.extra.amount = '2'; expect(parsed.raw.extra).toEqual({ amount: '1' });
    const reordered = Object.fromEntries(Object.entries({ ...raw(), extra: { amount: '1' } }).reverse());
    expect(parseLiveSourceFill(reordered, context).sourceDigest).toBe(parsed.sourceDigest);
    expect(parseLiveSourceFill(source, context).sourceDigest).not.toBe(parsed.sourceDigest);
  });
  it.each([{ tid: Number.MAX_SAFE_INTEGER + 1 }, { oid: '18446744073709551616' }, { tid: 0 }, { px: '0' }, { sz: '-1' }, { px: '1e3' }, { startPosition: undefined }, { startPosition: null }, { time: 999 }, { time: 2001 }, { side: 'S' }, { coin: '@107' }, { network: 'mainnet' }, { user: `0x${'33'.repeat(20)}` }])('refuses malformed or contradictory public source %j', change => {
    expect(() => parseLiveSourceFill({ ...raw(), ...change }, context)).toThrow();
  });
  it('accepts provider opaque dex identities without lossy normalization', () => {
    expect(parseLiveSourceFill({ ...raw(), coin: 'i<3fl:BTC' }, context).coin).toBe('i<3fl:BTC');
  });
  it('rejects mainnet/future/invalid-window context and contradictory TWAP evidence', () => {
    for (const change of [{ network: 'devnet' }, { from: 2001 }, { to: 2101 }, { receivedAt: 1499 }]) expect(() => parseLiveSourceFill(raw(), { ...context, ...change } as typeof context)).toThrow();
    expect(() => parseLiveSourceFill({ twapId: 12, fill: { ...raw(), twapId: 13 } }, { ...context, kind: 'twap' })).toThrow();
  });
  it.each(['sourceDigest', 'network', 'leaderAddress', 'tid', 'oid', 'coin', 'px', 'sz', 'side', 'startPosition', 'tradeKey', 'providerTime', 'normalized', 'raw'] as const)('rejects stored %s drift before execution planning', key => {
    const row = stored();
    const changes: Partial<typeof row> = { sourceDigest: 'f'.repeat(64), network: 'mainnet', leaderAddress: `0x${'33'.repeat(20)}`, tid: '8', oid: '10', coin: 'ETH', px: '101', sz: '3', side: 'A', startPosition: '1', tradeKey: 'oid:10', providerTime: new Date(1600), normalized: { ...row.normalized, px: '101' }, raw: { ...row.raw, px: '101' } };
    expect(() => decodeLiveSourceFill({ ...row, [key]: changes[key] })).toThrow();
  });
  it('correlates either arrival order while preserving the actual wrapper and all raw inner fields',()=>{
    const source={...raw(),hash:`0x${'00'.repeat(32)}`,unknown:{fee:'0.1'}},ordinary=parseLiveSourceFill(source,context),twap=parseLiveSourceFill({twapId:123,fill:source},{...context,kind:'twap'});
    expect(reconcileLiveSourceFills(ordinary,twap,'acquisition')).toEqual(twap);expect(reconcileLiveSourceFills(twap,ordinary,'acquisition')).toEqual(twap);
    expect(()=>reconcileLiveSourceFills(ordinary,twap,'stored')).toThrow();
  });
  it('rejects changed unknown inner fields and repeated-wrapper metadata',()=>{
    const source={...raw(),twapId:123,unknown:{fee:'0.1'}},ordinary=parseLiveSourceFill(source,context),twap=parseLiveSourceFill({twapId:123,fill:{...source,unknown:{fee:'0.2'}}},{...context,kind:'twap'});
    expect(()=>reconcileLiveSourceFills(ordinary,twap,'acquisition')).toThrow();
    const first=parseLiveSourceFill({twapId:123,fill:source,wrapperUnknown:'first'},{...context,kind:'twap'}),changed=parseLiveSourceFill({twapId:123,fill:source,wrapperUnknown:'changed'},{...context,kind:'twap'});
    expect(()=>reconcileLiveSourceFills(first,changed,'stored')).toThrow();
  });
});
describe('canonical actual source leg decomposition', () => {
  it('orders a genuine position flip as full close then opposite open', () => {
    const fill = parseLiveSourceFill({ ...raw(), side: 'A', startPosition: '1' }, context);
    expect(canonicalLiveSourceLegs(fill)).toEqual([{ leg: 'close', sign: 1, size: '1', fraction: '1', tradeKey: 'oid:9' }, { leg: 'open', sign: -1, size: '1', fraction: null, tradeKey: 'oid:9' }]);
    expect(liveSourceLegId('generation-1', fill.id, 'open')).toBe(liveSourceLegId('generation-1', fill.id, 'open'));
    expect(liveSourceLegId('generation-2', fill.id, 'open')).not.toBe(liveSourceLegId('generation-1', fill.id, 'open'));
    expect(liveSourceLegId('generation-1', fill.id, 'close')).not.toBe(liveSourceLegId('generation-1', fill.id, 'open'));
  });
  it('keeps the exact close fraction for partial reductions', () => {
    expect(canonicalLiveSourceLegs(parseLiveSourceFill({ ...raw(), side: 'A', startPosition: '5' }, context))).toEqual([{ leg: 'close', sign: 1, size: '2', fraction: '0.4', tradeKey: 'oid:9' }]);
  });
  it('refuses a changed normalized fill even if passed as an in-memory object', () => {
    const fill = parseLiveSourceFill(raw(), context); fill.normalized.startPosition = '7'; expect(() => canonicalLiveSourceLegs(fill)).toThrow();
  });
});

// Gate run 9 (2026-10-14): `invalid_live_source_evidence` alone said nothing
// about which check refused a read. Every refusal now names it.
describe('a refused source read says which check failed', () => {
  const refusal = async (run: () => unknown) => {
    try { await run(); } catch (error) { return { code: (error as { code?: string }).code, detail: (error as { detail?: unknown }).detail, line: liveSourceEvidenceDetail(error) }; }
    throw new Error('not refused');
  };
  const read = () => new HyperliquidLiveSourceClient('testnet', async () => undefined, (async (_url: unknown, init?: RequestInit) =>
    Response.json(JSON.parse(String(init?.body)).type === 'userFillsByTime' ? [raw()] : [])) as typeof fetch, () => 2100)
    .read({ leaderAddress: leader, from: 1000, to: 2000, maxRequests: 8 });
  const resign = <T extends { sourceDigest: string }>(result: T): T => { const { sourceDigest: _, ...body } = result; return { ...result, sourceDigest: liveSourceDigest(body) }; };
  const apply = (result: Awaited<ReturnType<typeof read>>) => new CopyLiveSourceRepository({} as never).apply({} as never, 1, result, 2100);
  it('names a fill received outside the read, with the times compared', async () => {
    const result = await read(), fill = parseLiveSourceFill(raw(), { ...context, receivedAt: 2101 });
    const out = await refusal(() => apply(resign({ ...result, fills: [fill] })));
    expect(out).toMatchObject({ code: 'invalid_live_source_evidence', detail: { check: 'fill_received_at', tid: '7', receivedAt: 2101, observedAt: 2100, completedAt: 2100 } });
    expect(JSON.parse(out.line)).toEqual(out.detail);
  });
  it('names a request count that no observation accounts for', async () => {
    const out = await refusal(async () => apply(resign({ ...await read(), requestsUsed: 5 })));
    expect(out.detail).toEqual({ check: 'requests_used', requestsUsed: 5, observations: 2 });
  });
  it('names a provider time outside the window it was read in, and never echoes provider text', async () => {
    const out = await refusal(() => parseLiveSourceFill({ ...raw(), time: 2001 }, context));
    expect(out.detail).toEqual({ check: 'fill_time', tid: '7', time: 2001, from: 1000, to: 2000 });
    const schema = await refusal(() => parseLiveSourceFill({ ...raw(), coin: 'not a coin <script>' }, context));
    expect(schema.detail).toMatchObject({ check: 'fill_parse', field: 'coin' });
    expect(schema.line).not.toContain('script');
  });
});
