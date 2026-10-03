import { describe, expect, it } from 'vitest';
import type { copyLiveSourceFills } from '@trading-dashboard/shared/database';
import { parseLiveSourceFill, decodeLiveSourceFill, canonicalLiveSourceLegs, liveSourceLegId } from '../src/copy/live/copy-live-source-evidence.js';
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
    for (const change of [{ network: 'mainnet' }, { from: 2001 }, { to: 2101 }, { receivedAt: 1499 }]) expect(() => parseLiveSourceFill(raw(), { ...context, ...change } as typeof context)).toThrow();
    expect(() => parseLiveSourceFill({ twapId: 12, fill: { ...raw(), twapId: 13 } }, { ...context, kind: 'twap' })).toThrow();
  });
  it.each(['sourceDigest', 'network', 'leaderAddress', 'tid', 'oid', 'coin', 'px', 'sz', 'side', 'startPosition', 'tradeKey', 'providerTime', 'normalized', 'raw'] as const)('rejects stored %s drift before execution planning', key => {
    const row = stored();
    const changes: Partial<typeof row> = { sourceDigest: 'f'.repeat(64), network: 'mainnet', leaderAddress: `0x${'33'.repeat(20)}`, tid: '8', oid: '10', coin: 'ETH', px: '101', sz: '3', side: 'A', startPosition: '1', tradeKey: 'oid:10', providerTime: new Date(1600), normalized: { ...row.normalized, px: '101' }, raw: { ...row.raw, px: '101' } };
    expect(() => decodeLiveSourceFill({ ...row, [key]: changes[key] })).toThrow();
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
