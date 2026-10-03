import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { followerReceiptKey, followerReceiptDigestV1, parseFollowerFill, parseFollowerFunding } from '../src/copy/live/actual-fill-accounting.js';

const expected = { network: 'testnet' as const, accountAddress: `0x${'22'.repeat(20)}`,
  coin: 'BTC', oid: '10', minTime: 100, maxTime: 200 };
const fill = { coin: 'BTC', oid: 10, tid: 123, time: 150, side: 'B', sz: '0.01', px: '65000',
  closedPnl: '5', fee: '0.1', builderFee: '0.03', feeToken: 'USDC' };

describe('actual follower receipt accounting', () => {
  it('keeps the immutable ledger version1 digest codec including nested objects and arrays', () => {
    const raw = { z: [{ b: 2, a: 1 }], a: 'x' };
    const bytes = '{"a":"x","z":[{"a":1,"b":2}]}';
    expect(followerReceiptDigestV1(raw)).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(followerReceiptDigestV1({ a: 'x', z: [{ a: 1, b: 2 }] })).toBe(followerReceiptDigestV1(raw));
  });
  it('debits total fee once and splits the included builder fee', () => {
    expect(parseFollowerFill(fill, expected)).toMatchObject({ key: `testnet:${expected.accountAddress}:123`,
      totalFee: '0.1', exchangeFee: '0.07', builderFee: '0.03', cashDelta: '4.9' });
  });
  it('credits signed maker rebates without fabricating a builder fee', () => {
    const { builderFee: _, ...rebate } = fill;
    expect(parseFollowerFill({ ...rebate, fee: '-0.02', closedPnl: '-1' }, expected))
      .toMatchObject({ exchangeFee: '-0.02', builderFee: '0', cashDelta: '-0.98' });
  });
  it.each([{ fee: undefined }, { feeToken: 'HYPE' }, { fee: '1e-2' }, { sz: '-1' }, { oid: 11 },
    { coin: 'ETH' }, { time: 201 }, { tid: 1.1 }, { closedPnl: null }, { builderFee: '-0.01' }, { side: ['B'] }])
    ('refuses malformed or mismatched receipts %j', (override) => {
      expect(() => parseFollowerFill({ ...fill, ...override }, expected)).toThrow();
    });
  it('uses actual signed funding and rejects missing amount', () => {
    const event = { time: 150, hash: `0x${'ab'.repeat(32)}`, delta: { type: 'funding', coin: 'BTC', usdc: '-0.37' } };
    expect(parseFollowerFunding(event, expected)).toMatchObject({ coin: 'BTC', amount: '-0.37', cashDelta: '-0.37' });
    expect(() => parseFollowerFunding({ ...event, delta: { coin: 'BTC' } }, expected)).toThrow();
    expect(() => parseFollowerFunding({ ...event, delta: { coin: 'BTC', usdc: '-0.37' } }, expected)).toThrow();
  });
  it('uses the same bounded opaque HIP3 coin identity for funding key generation and parsing', () => {
    const event = { time: 150, hash: `0x${'ab'.repeat(32)}`, delta: { type: 'funding', coin: 'i<3fl:BTC', usdc: '-0.37' } };
    expect(followerReceiptKey('funding', event, expected)).toBe(parseFollowerFunding(event, { ...expected, coin: event.delta.coin }).key);
    expect(() => followerReceiptKey('funding', { ...event, delta: { ...event.delta, coin: `${'x'.repeat(81)}:BTC` } }, expected)).toThrow();
  });
  it('preserves deployed opaque dex punctuation in perp receipts', () => {
    expect(parseFollowerFill({ ...fill, coin: 'i<3fl:BTC' }, { ...expected, coin: 'i<3fl:BTC' }).coin).toBe('i<3fl:BTC');
    expect(parseFollowerFunding({ time: 150, hash: `0x${'ab'.repeat(32)}`,
      delta: { type: 'funding', coin: 'i<3fl:BTC', usdc: '-0.37' } }, { ...expected, coin: 'i<3fl:BTC' }).coin).toBe('i<3fl:BTC');
  });
  it.each(['@12', 'USDC/USDE', 'bad name:BTC', 'dex:BTC:USD'])('refuses unsupported or ambiguous receipt coin %s', (coin) => {
    expect(() => parseFollowerFill({ ...fill, coin }, { ...expected, coin })).toThrow();
  });
});
