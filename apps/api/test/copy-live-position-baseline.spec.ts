import { expect, it } from 'vitest';
import { fixture, now, account } from './copy-live-risk-test-utils.js';
import { captureLivePositionBaseline, decodeLivePositionBaseline } from '../src/copy/live/live-position-baseline.js';

const identity = { mandateId: 'mandate', accountId: 'account', strategyId: 9, firstExecutionKey: `testnet:${account}:0x${'ab'.repeat(16)}`, network: 'testnet' as const, accountAddress: account };
const snapshot = () => structuredClone(fixture().accountSource.snapshot);
it('retains the original complete empty observation without inventing current freshness', () => {
  const s = snapshot(), baseline = captureLivePositionBaseline(identity, s, now);
  expect(baseline).toMatchObject({ ...identity, observedAt: now, completedAt: now, sourceDigest: s.sourceDigest, createdAt: now });
  expect(Object.isFrozen(baseline.snapshot.dexes[0])).toBe(true);
  expect(decodeLivePositionBaseline(identity, baseline)).toEqual(baseline);
  expect(baseline).not.toHaveProperty('checkedAt');
});
it.each(['account', 'network', 'coverage', 'positions', 'orders', 'margin', 'future', 'stale'] as const)('refuses an unproven initial %s', kind => {
  const s: any = snapshot();
  if (kind === 'account') s.accountAddress = `0x${'33'.repeat(20)}`;
  if (kind === 'network') s.network = 'mainnet';
  if (kind === 'coverage') s.coverage.orderComplete = false;
  if (kind === 'positions') s.positions = [{ coin: 'BTC' }];
  if (kind === 'orders') s.restingOrders = [{ coin: 'BTC' }];
  if (kind === 'margin') { s.totalMarginUsed = '1'; s.dexes[0].marginUsed = '1'; }
  if (kind === 'future') s.completedAt = now + 1;
  if (kind === 'stale') { s.observedAt = now - 5001; s.dexes[0].providerTime = now - 5001; s.coverage.earliestProviderTime = now - 5001; }
  expect(() => captureLivePositionBaseline(identity, s, now)).toThrow('live_risk_baseline_unproven');
});
it.each(['mandateId', 'firstExecutionKey', 'sourceDigest', 'snapshotDigest', 'observedAt', 'createdAt', 'snapshot'] as const)('refuses a mutated retained %s', key => {
  const value: any = structuredClone(captureLivePositionBaseline(identity, snapshot(), now));
  if (key === 'snapshot') value.snapshot.dexes[0].equity = '99';
  else if (typeof value[key] === 'number') value[key] += 1;
  else value[key] = 'substituted';
  expect(() => decodeLivePositionBaseline(identity, value)).toThrow('live_risk_baseline_unproven');
});
it('detaches the trusted observation and rejects noncanonical initial account identity', () => {
  const s: any = snapshot(), value = captureLivePositionBaseline(identity, s, now);
  s.dexes[0].equity = '999'; expect(value.snapshot.dexes[0].equity).toBe('100');
  expect(() => captureLivePositionBaseline({ ...identity, firstExecutionKey: 'foreign' }, snapshot(), now)).toThrow();
});
