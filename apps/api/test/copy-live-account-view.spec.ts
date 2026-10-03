import { expect, it } from 'vitest';
import { mapLiveAccountView } from '../src/copy/live/live-account-view.js';
import { fixture, now, account } from './copy-live-risk-test-utils.js';
import { copyFollowerSnapshotSchema } from '@trading-dashboard/shared/contracts';

const identity = { accountId: 'account', strategyId: 9, network: 'testnet' as const, accountAddress: account };
const quarantine = { blocked: false, reason: null };
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const snapshot = () => fixture().accountSource.snapshot as Mutable<ReturnType<typeof fixture>['accountSource']['snapshot']>;

it('maps observed perpetual values without inventing deposits, period profit or ROI', () => {
  const view = mapLiveAccountView(identity, snapshot(), quarantine, now, 5000);
  expect(view).toMatchObject({ mode: 'actual', network: 'testnet', accountId: 'account', strategyId: 9, status: 'observed', freshness: 'fresh',
    asOf: { observedAt: now, completedAt: now, earliestProviderTime: now, checkedAt: now, freshUntil: now + 5000 },
    metrics: { perpEquity: '100', marginUsed: '0', withdrawable: '100', exposureUsd: '0', restingExposureUsd: '0', grossRestingExposureUsd: '0', unrealizedPnl: '0', roi: null, periodPnl: null, netDeposits: null },
    positions: [], restingOrders: [], coverage: { complete: true } });
  expect(view).not.toHaveProperty('paper'); expect(view).not.toHaveProperty('allocated');
});
it('marks last observations stale using the oldest local/provider evidence rather than response time', () => {
  const s = snapshot(); s.observedAt = now - 100; s.dexes[0].providerTime = now - 200; s.coverage.earliestProviderTime = now - 200;
  const view = mapLiveAccountView(identity, s, quarantine, now + 4801, 5000);
  expect(view.freshness).toBe('stale'); expect(view.asOf.freshUntil).toBe(now + 4800); expect(view.asOf.observedAt).toBe(now - 100);
});
it('keeps exact signed tiny position PnL and remaining reduce-only order quantity without adding it to positions', () => {
  const s = snapshot();
  s.positions = [{ coin: 'BTC', dex: '', asset: 0, sizeDecimals: 2, size: '-1', entryPrice: '100', positionValue: '100', unrealizedPnl: '-0.000000000000000001',
    marginUsed: '10', leverage: 10, leverageType: 'cross', maxLeverage: 20, fundingSinceOpen: '0.00000001', fundingSinceChange: '-1' }];
  s.restingOrders = [{ coin: 'BTC', dex: '', asset: 0, oid: '7', side: 'B', limitPrice: '100', remainingSize: '0.25', originalSize: '1', notionalUsd: '25', reduceOnly: true, timestamp: now, cloid: null }];
  s.totalMarginUsed = '10'; s.exposureUsd = '100'; s.grossRestingExposureUsd = '25';
  Object.assign(s.dexes[0], { marginUsed: '10', exposureUsd: '100', crossMarginUsed: '10', crossExposureUsd: '100' });
  const view = mapLiveAccountView(identity, s, { blocked: true, reason: 'follower_unattributed_trade' }, now, 5000);
  expect(view.metrics.unrealizedPnl).toBe('-0.000000000000000001'); expect(view.restingOrders[0]).toMatchObject({ remainingSize: '0.25', originalSize: '1', reduceOnly: true });
  expect(view.metrics.restingExposureUsd).toBe('0'); expect(view.quarantine.blocked).toBe(true); expect(view.positions[0].size).toBe('-1');
});
it('detaches and deeply freezes every projected structure without leaking producer-only fields', () => {
  const s = snapshot(), before = structuredClone(s); Reflect.set(s, 'raw', { secret: 'private-proof' });
  const view = mapLiveAccountView(identity, s, quarantine, now, 5000);
  s.dexes[0].equity = '9'; expect(view.dexes[0].equity).toBe('100');
  expect(Object.isFrozen(view)).toBe(true); expect(Object.isFrozen(view.dexes[0])).toBe(true); expect(Object.isFrozen(view.coverage.listedDexes)).toBe(true);
  expect(JSON.stringify(view)).not.toContain('private-proof'); expect(before.dexes[0].equity).toBe('100');
});
it.each([
  ['account mismatch', (s: any) => { s.accountAddress = `0x${'33'.repeat(20)}`; }],
  ['mainnet substitution', (s: any) => { s.network = 'mainnet'; }],
  ['unsupported mode', (s: any) => { s.accountAbstraction = 'default'; }],
  ['unknown role', (s: any) => { s.role = 'agent'; }],
  ['incomplete coverage', (s: any) => { s.coverage.complete = false; s.coverage.orderComplete = false; }],
  ['missing venue', (s: any) => { s.coverage.listedDexes.push('missing'); }],
  ['future evidence', (s: any) => { s.completedAt = now + 1; }],
  ['invalid amount', (s: any) => { s.perpEquity = 'NaN'; }],
  ['inconsistent aggregate', (s: any) => { s.perpEquity = '101'; }],
  ['wrong collateral', (s: any) => { s.dexes[0].collateralCoin = 'USDT'; }],
  ['duplicate venue', (s: any) => { s.dexes.push({ ...s.dexes[0] }); }],
] as const)('refuses %s rather than substituting paper or zero', (_name, change) => {
  const s = snapshot(); change(s); expect(() => mapLiveAccountView(identity, s, quarantine, now, 5000)).toThrow('follower_snapshot_invalid');
});
it.each([0, 5001, NaN])('refuses an invalid configured freshness bound %s', age => expect(() => mapLiveAccountView(identity, snapshot(), quarantine, now, age)).toThrow());
it('preserves actual opaque HIP3 venue/index identity and refuses a substituted asset', () => {
  const s = snapshot(), dex = 'i<3fl', coin = `${dex}:TEST-X`;
  s.dexes.push({ ...s.dexes[0], dex, perpDexIndex: 267, equity: '0', rawUsd: '0', withdrawable: '0' }); s.coverage.listedDexes.push(dex); s.coverage.observedOrderDexes.push(dex);
  s.restingOrders = [{ coin, dex, asset: 2770002, oid: '9', side: 'B', limitPrice: '100', remainingSize: '0.25', originalSize: '1', notionalUsd: '25', reduceOnly: false, timestamp: now, cloid: null }];
  s.restingExposureUsd = '25'; s.grossRestingExposureUsd = '25';
  expect(mapLiveAccountView(identity, s, quarantine, now, 5000).restingOrders[0]).toMatchObject({ coin, dex, asset: 2770002, remainingSize: '0.25' });
  s.restingOrders[0].asset = 0; expect(() => mapLiveAccountView(identity, s, quarantine, now, 5000)).toThrow('follower_snapshot_invalid');
});
it('refuses a failed acquisition tagged fresh and accepts only explicit stale reporting', () => {
  const view = mapLiveAccountView(identity, snapshot(), quarantine, now, 5000);
  expect(() => copyFollowerSnapshotSchema.parse({ ...view, lastReadIssue: 'source_unavailable' })).toThrow();
  expect(copyFollowerSnapshotSchema.parse({ ...view, freshness: 'stale', lastReadIssue: 'source_unavailable' }).metrics.roi).toBeNull();
});
