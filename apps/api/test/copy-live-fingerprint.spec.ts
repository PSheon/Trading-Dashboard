import { expect, it } from 'vitest';
import { buildOrderAction, intentFingerprint, type HyperliquidOrderAction } from '../src/copy/live/live-order.js';
import { fixture } from './copy-live-risk-test-utils.js';

function reordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reordered(child)]));
  return value;
}
it.each([
  ['base', '126022dad909df0aff550eda6b568687f39d603626cff1a0e617176b79224452'],
  ['legacy', '93f7c23205275a5122d3e6e0c6a4dbf5ce3d96854441bfb1c9d86ba6d405301b'],
  ['builder', '3b0a28144bbc8df5feb1b5ce38b63f6d2f18dea02fcef7c8eb09511ce6b148fe'],
] as const)('preserves the existing valid %s digest across action object key ordering', (variant, digest) => {
  const { intent } = fixture();
  if (variant === 'legacy') delete intent.market;
  if (variant === 'builder') intent.builder = { address: `0x${'33'.repeat(20)}`, feeTenthsBps: 10, approvedMaxFeeTenthsBps: 100 };
  const canonical = buildOrderAction(intent), supplied = reordered(canonical) as HyperliquidOrderAction;
  expect(JSON.stringify(supplied)).not.toBe(JSON.stringify(canonical));
  const before = JSON.stringify(supplied);
  expect(intentFingerprint(intent, canonical)).toBe(digest);
  expect(intentFingerprint(intent, supplied)).toBe(digest);
  expect(JSON.stringify(supplied)).toBe(before);
});
it.each(['size', 'price', 'side', 'asset', 'reduceOnly', 'cloid', 'tif', 'grouping', 'extra', 'second-order', 'builder'] as const)
('refuses changed action %s rather than hashing it as approved intent', field => {
  const { intent } = fixture();
  intent.builder = { address: `0x${'33'.repeat(20)}`, feeTenthsBps: 10, approvedMaxFeeTenthsBps: 100 };
  const supplied = buildOrderAction(intent);
  if (field === 'size') supplied.orders[0].s = '2';
  if (field === 'price') supplied.orders[0].p = '101';
  if (field === 'side') supplied.orders[0].b = false;
  if (field === 'asset') supplied.orders[0].a = 1;
  if (field === 'reduceOnly') supplied.orders[0].r = true;
  if (field === 'cloid') supplied.orders[0].c = `0x${'cd'.repeat(16)}`;
  if (field === 'tif') supplied.orders[0].t.limit.tif = 'Ioc';
  if (field === 'grouping') Object.assign(supplied, { grouping: 'positionTpsl' });
  if (field === 'extra') Object.assign(supplied.orders[0], { unexpected: true });
  if (field === 'second-order') Object.assign(supplied, { orders: [supplied.orders[0], structuredClone(supplied.orders[0])] });
  if (field === 'builder') supplied.builder!.f++;
  expect(() => intentFingerprint(intent, supplied)).toThrow('live_risk_record_mismatch');
});
