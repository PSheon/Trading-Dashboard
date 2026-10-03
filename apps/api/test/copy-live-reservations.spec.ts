import { describe, expect, it } from 'vitest';
import { buildOrderAction } from '../src/copy/live/live-order.js';
import { planLiveReservation, validateLiveReservationPayload, type LiveReservationBoundsInput } from '../src/copy/live/live-risk-reservation.js';
import { assessLiveAccountRisk } from '../src/copy/live/live-account-risk.js';
import { fixture, now } from './copy-live-risk-test-utils.js';

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
function input(): Mutable<LiveReservationBoundsInput> {
  const f = fixture(); return { now: f.now, identity: f.identity, localSource: f.localSource, intent: f.intent,
    action: f.action, market: f.market, quote: f.quote, leverage: f.leverageProofs[0]!, fees: f.fees,
    policy: f.policy, expiresAt: now + 60000 };
}
describe('actual-price collateral reservation bounds', () => {
  it('validates persisted JSONB objects independently of object key ordering', () => {
    const payload = planLiveReservation(input());
    function reorder(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(reorder);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorder(child)]));
      return value;
    }
    expect(validateLiveReservationPayload(reorder(payload))).toEqual(payload);
  });
  it('creates immutable exact-order bounds compatible with the full authoritative risk assessor', () => {
    const supplied = input(), payload = planLiveReservation(supplied);
    expect(payload).toMatchObject({ accountId: 'account', userId: 1, strategyId: 9, network: 'testnet',
      notionalUsd: '100', marginUsd: '10', feeBufferUsd: '0.1', expiresAt: now + 60000 });
    expect(payload.sourceDigest).toMatch(/^[0-9a-f]{64}$/); expect(Object.isFrozen(payload.intent.market)).toBe(true);
    supplied.intent.size = '9'; expect(payload.intent.size).toBe('1');
    const full = fixture() as Mutable<ReturnType<typeof fixture>>; full.reservations.own = { ...payload, state: 'held', exchangeOrderId: null };
    expect(assessLiveAccountRisk(full)).toMatchObject({ ok: true, requiredMarginUsd: '10', feeBufferUsd: '0.1' });
    expect(payload).not.toHaveProperty('availableCollateralUsd'); expect(payload).not.toHaveProperty('cash');
  });
  it('reserves maximum actual mid, mark and limit price instead of trusting the cheapest observation', () => {
    const f = input(); f.quote.markPrice = '150'; expect(planLiveReservation(f)).toMatchObject({ notionalUsd: '150', marginUsd: '15', feeBufferUsd: '0.15' });
  });
  it('rounds margin upward and reserves a positive fee quantum rather than rounding away liability', () => {
    const f = input(); f.intent.size = '0.1'; f.action = buildOrderAction(f.intent); f.leverage.value = 3;
    f.fees.makerFeeBps = '0'; f.fees.takerFeeBps = '0.0000000001'; f.fees.extraRiskBufferBps = '0'; f.policy.limits.takerFeeBps = 0;
    expect(planLiveReservation(f)).toMatchObject({ notionalUsd: '10', marginUsd: '3.33333334', feeBufferUsd: '0.00000001' });
  });
  it('retains exact fractional remainders beyond Dec division precision before upward USD rounding', () => {
    const f = input(); f.quote.midPrice = '100.000000000000000001'; f.quote.markPrice = f.quote.midPrice;
    expect(planLiveReservation(f)).toMatchObject({ notionalUsd: '100.000000000000000001', marginUsd: '10.00000001', feeBufferUsd: '0.10000001' });
  });
  it('rounds the exact size-price product upward rather than erasing its sub-18dp remainder', () => {
    const f = input(); f.intent.size = '0.03'; f.action = buildOrderAction(f.intent); f.quote.midPrice = '100.000000000000000001'; f.quote.markPrice = f.quote.midPrice;
    expect(planLiveReservation(f)).toMatchObject({ notionalUsd: '3.000000000000000001', marginUsd: '0.30000001', feeBufferUsd: '0.00300001' });
  });
  it('keeps builder fee and explicit extra buffer even for signed maker rebates', () => {
    const f = input(); f.intent.builder = { address: `0x${'33'.repeat(20)}`, feeTenthsBps: 100, approvedMaxFeeTenthsBps: 100 }; f.action = buildOrderAction(f.intent);
    expect(planLiveReservation(f).feeBufferUsd).toBe('0.2');
  });
  it('removes opening margin for reduceOnly while retaining the actual fee liability', () => {
    const f = input(); f.intent.reduceOnly = true; f.action = buildOrderAction(f.intent);
    expect(planLiveReservation(f)).toMatchObject({ marginUsd: '0', feeBufferUsd: '0.1' });
  });
  it.each(['quote', 'market', 'leverage', 'fees', 'local'])('refuses stale or future %s evidence', kind => {
    for (const at of [now - 5001, now + 1]) {
      const f = input();
      if (kind === 'quote') f.quote.observedAt = at;
      if (kind === 'market') f.market.observedAt = at;
      if (kind === 'leverage') f.leverage.observedAt = at;
      if (kind === 'fees') f.fees.observedAt = at;
      if (kind === 'local') f.localSource.checkedAt = at;
      expect(() => planLiveReservation(f)).toThrow();
    }
  });
  it.each(['network', 'account', 'coin', 'dex', 'asset', 'configured-leverage', 'policy-version', 'strategy-version', 'grant-version', 'action', 'expiry', 'defaults', 'fee-digest'])('refuses malformed or unbound %s evidence', kind => {
    const f = input();
    if (kind === 'network') f.identity.network = 'mainnet' as 'testnet';
    if (kind === 'account') f.leverage.accountAddress = `0x${'44'.repeat(20)}`;
    if (kind === 'coin') f.leverage.coin = 'ETH';
    if (kind === 'dex') f.fees.dex = 'xyz';
    if (kind === 'asset') f.leverage.asset = 1;
    if (kind === 'configured-leverage') f.leverage.value = 0;
    if (kind === 'policy-version') f.policy.version++;
    if (kind === 'strategy-version') f.identity.strategyVersion = 0;
    if (kind === 'grant-version') f.identity.authorizationVersion = 0;
    if (kind === 'action') f.action.orders[0].s = '2';
    if (kind === 'expiry') f.expiresAt = now;
    if (kind === 'defaults') delete (f.policy.limits as Partial<typeof f.policy.limits>).takerFeeBps;
    if (kind === 'fee-digest') f.fees.sourceDigest = 'unproven';
    expect(() => planLiveReservation(f)).toThrow();
  });
  it.each(['-1', 'NaN', '1e3', ['100']])('rejects malformed actual price %j', price => {
    const f = input(); f.quote.midPrice = price as string; expect(() => planLiveReservation(f)).toThrow();
  });
  it('refuses unexpected signing material in persisted order intent rather than storing it', () => {
    const f = input(); Object.assign(f.intent, { userJwt: 'fixture-private-jwt', signature: 'fixture-private-signature' });
    expect(() => planLiveReservation(f)).toThrow('live_reservation_bounds_unproven');
  });
  it('refuses unexpected signing material in a historic persisted intent', () => {
    const payload = structuredClone(planLiveReservation(input())); Object.assign(payload.intent, { userJwt: 'fixture-private-jwt' });
    expect(() => validateLiveReservationPayload(payload)).toThrow('live_reservation_record_invalid');
  });
});
