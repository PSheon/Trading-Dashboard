import { expect, it } from 'vitest';
import { assessLiveAccountRisk, type LiveAccountRiskInput } from '../src/copy/live/live-account-risk.js';
import { buildOrderAction, type LiveOrderIntent } from '../src/copy/live/live-order.js';
import { Dec } from '../src/common/decimal/dec.js';

import { now, account, reservation, fixture } from './copy-live-risk-test-utils.js';

// Fixtures are detached JSON proofs, as the concrete read adapters must supply.
function edit(f: LiveAccountRiskInput, change: (value: any) => void): LiveAccountRiskInput { const value = structuredClone(f); change(value); return value; }
function withPosition(f: LiveAccountRiskInput, size = '1', value = '100', margin = '10') {
  return edit(f, v => {
    const s = v.accountSource.snapshot;
    s.positions = [{ coin: 'BTC', dex: '', asset: 0, sizeDecimals: 2, size, entryPrice: '100', positionValue: value,
      unrealizedPnl: '0', marginUsed: margin, leverage: 10, leverageType: 'cross', maxLeverage: 20,
      fundingSinceOpen: '-0.01', fundingSinceChange: '-0.01' }];
    s.exposureUsd = value; s.totalMarginUsed = margin; s.withdrawable = '90';
    Object.assign(s.dexes[0], { exposureUsd: value, marginUsed: margin, crossExposureUsd: value, crossMarginUsed: margin, withdrawable: '90' });
  });
}
function withResting(f: LiveAccountRiskInput, reduceOnly = false, remaining = '1', cloid = `0x${'cd'.repeat(16)}`) {
  return edit(f, v => {
    v.accountSource.snapshot.restingOrders = [{ coin: 'BTC', dex: '', asset: 0, oid: '10', side: reduceOnly ? 'A' : 'B',
      limitPrice: '100', remainingSize: remaining, originalSize: '1', notionalUsd: Dec.from(remaining).mul(100).toString(),
      reduceOnly, timestamp: now - 1000, cloid }];
    v.accountSource.snapshot.restingExposureUsd = reduceOnly ? '0' : Dec.from(remaining).mul(100).toString();
    v.accountSource.snapshot.grossRestingExposureUsd = Dec.from(remaining).mul(100).toString();
  });
}
function updateIntent(f: LiveAccountRiskInput, change: Partial<LiveOrderIntent>) {
  return edit(f, v => { Object.assign(v.intent, change); v.action = buildOrderAction(v.intent); v.reservations.own = reservation(v.intent); });
}

it('assesses exactly once with signed maker fees kept distinct from a conservative buffer', () => {
  const f = fixture(), before = JSON.stringify(f), result = assessLiveAccountRisk(f);
  expect(result).toEqual({ ok: true, key: `testnet:${account}:0x${'ab'.repeat(16)}`, fingerprint: f.reservations.own.fingerprint,
    coin: 'BTC', dex: '', notionalUsd: '100', requiredMarginUsd: '10', feeBufferUsd: '0.1', availableCollateralUsd: '100',
    projectedStrategyExposureUsd: '100', projectedUserExposureUsd: '100' });
  expect(Object.isFrozen(result)).toBe(true); expect(JSON.stringify(f)).toBe(before); expect(f.fees.makerFeeBps).toBe('-1');
});
it('does not count its own reservation twice against exposure or collateral', () => {
  const f = edit(fixture(), v => { v.strategy.settings.maxTotalExposureUsd = 150; v.reservations.own.marginUsd = '99'; });
  expect(assessLiveAccountRisk(f)).toMatchObject({ ok: true, projectedStrategyExposureUsd: '100', availableCollateralUsd: '100' });
});
it.each([
  ['quarantined', (v: any) => { v.accountSource.quarantined = true; }, 'live_risk_quarantined'],
  ['incomplete', (v: any) => { v.accountSource.snapshot.coverage.complete = false; }, 'live_risk_coverage_incomplete'],
  ['missing venue', (v: any) => { v.accountSource.snapshot.coverage.listedDexes.push('xyz'); }, 'live_risk_coverage_incomplete'],
  ['unknown orders', (v: any) => { v.accountSource.snapshot.coverage.unobservedOrderDexes.push('xyz'); }, 'live_risk_coverage_incomplete'],
  ['user role', (v: any) => { v.accountSource.snapshot.role = 'agent'; }, 'live_risk_account_mode'],
  ['unified', (v: any) => { v.accountSource.snapshot.accountMode = 'unified'; }, 'live_risk_account_mode'],
  ['abstraction', (v: any) => { v.accountSource.snapshot.accountAbstraction = 'unifiedAccount'; }, 'live_risk_account_mode'],
  ['shared account', (v: any) => { v.identity.dedicated = false; }, 'live_risk_identity'],
  ['owner', (v: any) => { v.accountSource.userId = 2; }, 'live_risk_identity'],
  ['strategy', (v: any) => { v.intent.strategyId = 10; }, 'live_risk_identity'],
  ['account', (v: any) => { v.accountSource.accountAddress = `0x${'33'.repeat(20)}`; }, 'live_risk_identity'],
  ['mainnet', (v: any) => { v.intent.network = 'mainnet'; }, 'live_risk_identity'],
  ['policy version', (v: any) => { v.policy.version++; }, 'live_risk_version'],
  ['strategy version', (v: any) => { v.strategy.version++; }, 'live_risk_version'],
  ['grant version', (v: any) => { v.reservations.own.authorizationVersion++; }, 'live_risk_version'],
  ['source digest', (v: any) => { v.accountSource.sourceDigest = 'b'.repeat(64); }, 'live_risk_source'],
  ['action changed', (v: any) => { v.action.orders[0].s = '2'; }, 'live_risk_action'],
  ['asset changed', (v: any) => { v.market.asset = 1; }, 'live_risk_market'],
  ['quote changed', (v: any) => { v.quote.market = { ...v.quote.market, coin: 'ETH' }; }, 'live_risk_market'],
  ['leverage missing', (v: any) => { v.leverageProofs = []; }, 'live_risk_leverage'],
  ['leverage exceeds cap', (v: any) => { v.leverageProofs[0].value = 20; }, 'live_risk_leverage'],
  ['source stale', (v: any) => { v.accountSource.checkedAt = now - 5001; }, 'live_risk_stale'],
  ['balance stale', (v: any) => { v.accountSource.snapshot.dexes[0].providerTime = now - 5001; v.accountSource.snapshot.coverage.earliestProviderTime = now - 5001; }, 'live_risk_stale'],
  ['quote future', (v: any) => { v.quote.observedAt = now + 1; }, 'live_risk_stale'],
  ['fees stale', (v: any) => { v.fees.observedAt = now - 5001; }, 'live_risk_stale'],
  ['reservation stale', (v: any) => { v.reservations.checkedAt = now - 5001; }, 'live_risk_stale'],
  ['user totals stale', (v: any) => { v.userExposureProof.checkedAt = now - 5001; }, 'live_risk_stale'],
  ['fees missing', (v: any) => { delete v.fees.takerFeeBps; }, 'live_risk_evidence_invalid'],
  ['no zero default', (v: any) => { delete v.userExposureProof.otherAccountsExposureUsd; }, 'live_risk_evidence_invalid'],
  ['policy defaults forbidden', (v: any) => { delete v.policy.limits.maxLeverage; }, 'live_risk_evidence_invalid'],
] as const)('fails closed on %s', (_name, change, reason) => {
  const result = assessLiveAccountRisk(edit(fixture(), change)); expect(result).toEqual({ ok: false, reason }); expect(Object.isFrozen(result)).toBe(true);
});
it.each([
  ['key', (v: any) => { v.reservations.own.key = 'other'; }, 'live_risk_reservation'],
  ['fingerprint', (v: any) => { v.reservations.own.fingerprint = 'b'.repeat(64); }, 'live_risk_reservation'],
  ['expired', (v: any) => { v.reservations.own.expiresAt = now; }, 'live_risk_reservation'],
  ['unknown', (v: any) => { v.reservations.own.state = 'unknown'; }, 'live_risk_reservation'],
  ['low notional', (v: any) => { v.reservations.own.notionalUsd = '99'; }, 'live_risk_reservation_bound'],
  ['low margin', (v: any) => { v.reservations.own.marginUsd = '9.99'; }, 'live_risk_reservation_bound'],
  ['low fee', (v: any) => { v.reservations.own.feeBufferUsd = '0.09'; }, 'live_risk_reservation_bound'],
  ['incomplete', (v: any) => { v.reservations.complete = false; }, 'live_risk_reservation'],
] as const)('rejects own reservation %s', (_name, change, reason) => expect(assessLiveAccountRisk(edit(fixture(), change))).toEqual({ ok: false, reason }));
it('counts actual exposure and remaining opening orders before new risk', () => {
  const f = withResting(withPosition(fixture()), false, '0.4');
  expect(assessLiveAccountRisk(f)).toMatchObject({ ok: true, projectedStrategyExposureUsd: '240', availableCollateralUsd: '85.92' });
  expect(assessLiveAccountRisk(edit(f, v => { v.strategy.settings.maxTotalExposureUsd = 239; }))).toEqual({ ok: false, reason: 'max_strategy_exposure' });
});
it('reserves the legal builder fee maximum for an external resting order whose builder terms are unknown', () => {
  const f = withResting(fixture());
  const limited = edit(f, v => {
    v.accountSource.snapshot.withdrawable = '20.21';
    v.accountSource.snapshot.dexes[0].withdrawable = '20.21';
    v.fees.restingOrderBuilderFeeCapTenthsBps = 0;
  });
  expect(assessLiveAccountRisk(limited)).toEqual({ ok: false, reason: 'available_collateral' });
});
it('deduplicates a matching resting reservation using actual remaining quantities', () => {
  const f = withResting(fixture(), false, '0.4');
  const other = reservation({ ...f.intent, cloid: `0x${'cd'.repeat(16)}` });
  const input = edit(f, v => { v.reservations.others = [{ ...other, state: 'resting', exchangeOrderId: '10' }]; });
  expect(assessLiveAccountRisk(input)).toMatchObject({ ok: true, projectedStrategyExposureUsd: '140', availableCollateralUsd: '95.92' });
  expect(assessLiveAccountRisk(edit(input, v => { v.reservations.others[0].intent.side = 'A'; }))).toEqual({ ok: false, reason: 'live_risk_reservation' });
});
it('counts unobserved pending orders and conservatively retains expired unknown reservations', () => {
  const f = fixture(), other = reservation({ ...f.intent, cloid: `0x${'cd'.repeat(16)}` });
  const input = edit(f, v => { v.reservations.others = [{ ...other, state: 'unknown', expiresAt: now - 1 }]; });
  expect(assessLiveAccountRisk(input)).toMatchObject({ ok: true, projectedStrategyExposureUsd: '200', availableCollateralUsd: '89.9' });
});
it('refuses already observed own orders and duplicate pending keys', () => {
  expect(assessLiveAccountRisk(withResting(fixture(), false, '1', fixture().intent.cloid))).toEqual({ ok: false, reason: 'live_risk_order_already_observed' });
  const f = fixture(), other = reservation({ ...f.intent, cloid: `0x${'cd'.repeat(16)}` });
  expect(assessLiveAccountRisk(edit(f, v => { v.reservations.others = [other, other]; }))).toEqual({ ok: false, reason: 'live_risk_reservation' });
});
it('checks global user and coin exposure with explicit other-account totals', () => {
  expect(assessLiveAccountRisk(edit(fixture(), v => { v.userExposureProof.otherAccountsExposureUsd = '249901'; }))).toEqual({ ok: false, reason: 'max_user_exposure' });
  expect(assessLiveAccountRisk(edit(fixture(), v => { v.userExposureProof.otherAccountsExposureUsd = '100001'; v.userExposureProof.otherAccountsCoinExposureUsd = '99901'; }))).toEqual({ ok: false, reason: 'max_coin_exposure' });
});
it.each(['platform', 'user', 'strategy'] as const)('enforces %s pause and reduce-only controls for new risk', (scope) => {
  expect(assessLiveAccountRisk(edit(fixture(), v => { v.controls[scope].pauseNewRisk = true; }))).toEqual({ ok: false, reason: `${scope}_paused` });
  expect(assessLiveAccountRisk(edit(fixture(), v => { v.controls[scope].reduceOnly = true; }))).toEqual({ ok: false, reason: `${scope}_reduce_only` });
});
it('enforces configured signal age, frequency, slippage and fixed direction', () => {
  expect(assessLiveAccountRisk(edit(fixture(), v => { v.signal.at -= 121000; }))).toEqual({ ok: false, reason: 'stale_signal' });
  expect(assessLiveAccountRisk(edit(fixture(), v => { v.userExposureProof.ordersLastMinuteExcludingOwn = 30; }))).toEqual({ ok: false, reason: 'frequency' });
  expect(assessLiveAccountRisk(edit(fixture(), v => { v.signal.price = '99'; }))).toEqual({ ok: false, reason: 'price_moved' });
  expect(assessLiveAccountRisk(edit(fixture(), v => { v.strategy.settings.direction = 'reverse'; }))).toEqual({ ok: false, reason: 'direction_mismatch' });
  const reverse = edit(fixture(), v => { v.strategy.settings.direction = 'reverse'; v.signal.leaderSide = 'A'; });
  expect(assessLiveAccountRisk(reverse)).toMatchObject({ ok: true });
});
it('uses current price evidence without resizing or clamping the approved wire order', () => {
  const f = edit(fixture(), v => { v.quote.markPrice = '110'; });
  expect(assessLiveAccountRisk(f)).toEqual({ ok: false, reason: 'live_risk_reservation_bound' });
  expect(assessLiveAccountRisk(edit(f, v => { v.reservations.own.notionalUsd = '110'; v.reservations.own.marginUsd = '11'; v.reservations.own.feeBufferUsd = '0.11'; })))
    .toMatchObject({ ok: true, notionalUsd: '110', requiredMarginUsd: '11' });
});
it('requires funds for exact new margin plus explicit fee and builder buffers', () => {
  const f = edit(fixture(), v => { v.accountSource.snapshot.dexes[0].withdrawable = '10.09'; v.accountSource.snapshot.withdrawable = '10.09'; });
  expect(assessLiveAccountRisk(f)).toEqual({ ok: false, reason: 'available_collateral' });
  const builder = updateIntent(fixture(), { builder: { address: `0x${'44'.repeat(20)}`, feeTenthsBps: 100, approvedMaxFeeTenthsBps: 100 } });
  expect(assessLiveAccountRisk(builder)).toEqual({ ok: false, reason: 'live_risk_reservation_bound' });
  expect(assessLiveAccountRisk(edit(builder, v => { v.reservations.own.feeBufferUsd = '0.2'; }))).toMatchObject({ ok: true, feeBufferUsd: '0.2' });
});
it('does not borrow collateral from another dex and enforces HIP3 policy', () => {
  const f = fixture();
  const market = { ...f.market, coin: 'xyz:TSLA', dex: 'xyz', perpDexIndex: 1, asset: 110000 };
  const input = edit(updateIntent(f, { market, asset: 110000 }), v => {
    v.market = market; v.quote.market = market; v.fees.dex = market.dex; v.userExposureProof.coin = market.coin;
    v.leverageProofs[0] = { ...v.leverageProofs[0], coin: market.coin, dex: market.dex, asset: market.asset };
    v.policy.limits.allowHip3 = true;
    const s = v.accountSource.snapshot; s.dexes.push({ ...s.dexes[0], dex: 'xyz', perpDexIndex: 1, equity: '0', rawUsd: '0', withdrawable: '0', crossEquity: '0' });
    s.coverage.listedDexes.push('xyz'); s.coverage.observedOrderDexes.push('xyz');
  });
  expect(assessLiveAccountRisk(input)).toEqual({ ok: false, reason: 'available_collateral' });
  expect(assessLiveAccountRisk(edit(input, v => { v.policy.limits.allowHip3 = false; }))).toEqual({ ok: false, reason: 'symbol_not_allowed' });
  expect(assessLiveAccountRisk(edit(f, v => { v.policy.limits.blockedCoins = ['btc']; }))).toEqual({ ok: false, reason: 'symbol_blocked' });
});
it('enforces the exchange $10 minimum even when the configurable minimum is lower', () => {
  const f = updateIntent(fixture(), { size: '0.09' });
  expect(assessLiveAccountRisk(edit(f, v => { v.policy.limits.minOrderNotionalUsd = 0; }))).toEqual({ ok: false, reason: 'below_min_notional' });
});
it('reduces only actual opposing size, including dust, without pretending pending reductions already filled', () => {
  const f = edit(updateIntent(withPosition(fixture()), { reduceOnly: true, side: 'A', size: '0.09' }), v => {
    v.signal = null; v.reservations.own.marginUsd = '0'; v.policy.limits.blockedCoins = ['BTC']; v.controls.platform.pauseNewRisk = true;
  });
  expect(assessLiveAccountRisk(f)).toMatchObject({ ok: true, requiredMarginUsd: '0', projectedStrategyExposureUsd: '100' });
  expect(assessLiveAccountRisk(updateIntent(f, { size: '1.01' }))).toEqual({ ok: false, reason: 'reduce_size_exceeded' });
  expect(assessLiveAccountRisk(updateIntent(f, { side: 'B' }))).toEqual({ ok: false, reason: 'reduce_direction_mismatch' });
  const partial = withResting(updateIntent(f, { size: '0.7' }), true, '0.4');
  expect(assessLiveAccountRisk(partial)).toEqual({ ok: false, reason: 'reduce_size_exceeded' });
  expect(assessLiveAccountRisk(updateIntent(partial, { size: '0.6' }))).toMatchObject({ ok: true, projectedStrategyExposureUsd: '100' });
});
it('reserves unobserved reductions once and rejects an unflagged opposing order', () => {
  const base = withPosition(fixture());
  expect(assessLiveAccountRisk(updateIntent(base, { side: 'A' }))).toEqual({ ok: false, reason: 'reduce_only_required' });
  const f = edit(updateIntent(base, { reduceOnly: true, side: 'A', size: '0.7' }), v => { v.signal = null; });
  const other = reservation({ ...f.intent, size: '0.4', cloid: `0x${'cd'.repeat(16)}` });
  expect(assessLiveAccountRisk(edit(f, v => { v.reservations.others = [other]; }))).toEqual({ ok: false, reason: 'reduce_size_exceeded' });
});
it('rejects understated or contradictory actual exposure before using it', () => {
  expect(assessLiveAccountRisk(edit(withPosition(fixture()), v => { v.accountSource.snapshot.exposureUsd = '0'; }))).toEqual({ ok: false, reason: 'live_risk_account_totals' });
  expect(assessLiveAccountRisk(edit(withResting(fixture()), v => { v.accountSource.snapshot.restingExposureUsd = '0'; }))).toEqual({ ok: false, reason: 'live_risk_account_totals' });
});
it.each([
  ['local state stale', (v: any) => { v.localSource.checkedAt = now - 5001; }, 'live_risk_stale'],
  ['local proof missing', (v: any) => { delete v.localSource; }, 'live_risk_evidence_invalid'],
  ['configured leverage on another account', (v: any) => { v.leverageProofs[0].accountAddress = `0x${'33'.repeat(20)}`; }, 'live_risk_identity'],
  ['exchange leverage maximum missing', (v: any) => { delete v.leverageProofs[0].maxLeverage; }, 'live_risk_leverage'],
  ['configured leverage above exchange limit', (v: any) => { v.leverageProofs[0].maxLeverage = 5; }, 'live_risk_leverage'],
  ['fixed sizing ceiling', (v: any) => { v.strategy.settings.sizingMode = 'fixed'; v.strategy.settings.perTradeUsd = 50; }, 'fixed_trade_size'],
  ['missing fixed sizing', (v: any) => { v.strategy.settings.sizingMode = 'fixed'; }, 'fixed_trade_size'],
] as const)('requires explicit current evidence: %s', (_name, change, reason) => expect(assessLiveAccountRisk(edit(fixture(), change))).toEqual({ ok: false, reason }));
it('requires exact venue totals rather than inventing a tolerance', () => {
  const f = edit(withPosition(fixture()), v => { v.accountSource.snapshot.dexes[0].exposureUsd = '99.995'; v.accountSource.snapshot.exposureUsd = '99.995'; });
  expect(assessLiveAccountRisk(f)).toEqual({ ok: false, reason: 'live_risk_account_totals' });
});
it('rejects conflicting coin identity attached to the same authoritative asset', () => {
  const f = edit(withPosition(fixture()), v => { v.accountSource.snapshot.positions[0].coin = 'ETH'; });
  expect(assessLiveAccountRisk(f)).toEqual({ ok: false, reason: 'live_risk_market' });
});
it('rounds conservative margin and fee reserves upward rather than losing monetary dust', () => {
  const f = edit(fixture(), v => {
    v.intent.size = '0.1'; v.leverageProofs[0].value = 3; v.action = buildOrderAction(v.intent); v.reservations.own = reservation(v.intent);
    v.reservations.own.marginUsd = '3.33333334';
  });
  expect(assessLiveAccountRisk(f)).toMatchObject({ ok: true, requiredMarginUsd: '3.33333334' });
  expect(assessLiveAccountRisk(edit(f, v => { v.reservations.own.marginUsd = '3.33333333'; }))).toEqual({ ok: false, reason: 'live_risk_reservation_bound' });
  const dust = edit(updateIntent(withPosition(fixture()), { reduceOnly: true, side: 'A', size: '0.01' }), v => {
    v.fees.makerFeeBps = '-1'; v.fees.takerFeeBps = '0'; v.fees.extraRiskBufferBps = '0.00001'; v.policy.limits.takerFeeBps = 0;
  });
  expect(assessLiveAccountRisk(dust)).toMatchObject({ ok: true, feeBufferUsd: '0.00000001' });
});
it.each([
  ['coin', (v: any) => { v.userExposureProof.coin = 'ETH'; }],
  ['network', (v: any) => { v.userExposureProof.network = 'mainnet'; }],
  ['excluded account', (v: any) => { v.userExposureProof.excludedAccountId = 'other'; }],
  ['frequency key', (v: any) => { v.userExposureProof.excludedExecutionKey = 'other'; }],
] as const)('binds global exposure/frequency proof to the exact %s', (_name, change) =>
  expect(assessLiveAccountRisk(edit(fixture(), change))).toEqual({ ok: false, reason: 'live_risk_identity' }));
it('does not round a known positive fee buffer down to zero at Dec precision', () => {
  const dust = edit(updateIntent(withPosition(fixture()), { reduceOnly: true, side: 'A', size: '0.01' }), v => {
    v.fees.makerFeeBps = '-1'; v.fees.takerFeeBps = '0'; v.fees.extraRiskBufferBps = '0.000000000000000001'; v.policy.limits.takerFeeBps = 0;
  });
  expect(assessLiveAccountRisk(dust)).toMatchObject({ ok: true, feeBufferUsd: '0.00000001' });
});
it('supports provider-listed opaque HIP3 identity without ignoring blocked-coin policy', () => {
  const f = fixture(), market = { ...f.market, coin: 'i<3fl:TEST', dex: 'i<3fl', perpDexIndex: 267, asset: 2770000 };
  const input = edit(updateIntent(f, { market, asset: market.asset }), v => {
    v.market = market; v.quote.market = market; v.fees.dex = market.dex; v.userExposureProof.coin = market.coin;
    v.leverageProofs[0] = { ...v.leverageProofs[0], coin: market.coin, dex: market.dex, asset: market.asset };
    v.policy.limits.allowHip3 = true;
    const s = v.accountSource.snapshot; s.dexes.push({ ...s.dexes[0], dex: market.dex, perpDexIndex: 267 });
    s.perpEquity = '200'; s.withdrawable = '200'; s.coverage.listedDexes.push(market.dex); s.coverage.observedOrderDexes.push(market.dex);
  });
  expect(assessLiveAccountRisk(input)).toMatchObject({ ok: true, coin: 'i<3fl:TEST', dex: 'i<3fl' });
  expect(assessLiveAccountRisk(edit(input, v => { v.policy.limits.blockedCoins = ['i<3fl:TEST']; }))).toEqual({ ok: false, reason: 'symbol_blocked' });
});
it('supports short-side reductions and refuses a reduction on a flat actual account', () => {
  const f = updateIntent(withPosition(fixture(), '-1'), { reduceOnly: true, side: 'B', size: '0.5' });
  expect(assessLiveAccountRisk(f)).toMatchObject({ ok: true, requiredMarginUsd: '0', projectedStrategyExposureUsd: '100' });
  expect(assessLiveAccountRisk(updateIntent(fixture(), { reduceOnly: true, side: 'A' }))).toEqual({ ok: false, reason: 'reduce_direction_mismatch' });
});
it.each(['walletId', 'authorizationId'] as const)('rejects an empty %s even when all malformed proof identities agree', (field) => {
  const f = edit(fixture(), v => { v.identity[field] = ''; v.intent[field] = ''; v.reservations.own = reservation(v.intent); });
  expect(assessLiveAccountRisk(f)).toEqual({ ok: false, reason: 'live_risk_identity' });
});
it('allows a safe reduction after leverage policy tightens without authorizing new leveraged risk', () => {
  const f = edit(updateIntent(withPosition(fixture(), '1', '100', '5'), { reduceOnly: true, side: 'A' }), v => {
    v.accountSource.snapshot.positions[0].leverage = 20; v.leverageProofs[0].value = 20;
  });
  expect(assessLiveAccountRisk(f)).toMatchObject({ ok: true, requiredMarginUsd: '0' });
  expect(assessLiveAccountRisk(updateIntent(f, { reduceOnly: false, side: 'B' }))).toEqual({ ok: false, reason: 'live_risk_leverage' });
});
