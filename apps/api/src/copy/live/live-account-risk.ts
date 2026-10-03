import { copyRiskLimitsSchema, copyStrategySettingsSchema, type CopyRiskLimits, type CopyStrategySettings } from '@trading-dashboard/shared/contracts';
import { isDeepStrictEqual } from 'node:util';
import { Dec, USD_DP } from '../../common/decimal/dec.js';
import type { LiveAccountSnapshot } from './live-account-observer.js';
import { assertMarketIdentity, LIVE_DEX_NAME, LIVE_PERP_COIN, marketIdentityKey, type LiveMarketIdentity } from './live-market-resolver.js';
import { buildOrderAction, executionKey, intentFingerprint, type HyperliquidOrderAction, type LiveOrderIntent } from './live-order.js';
import { effectiveLeverage, strategyExposureCap, symbolRefusal, type ControlFlags } from '../copy-risk.js';
import { address, LiveBoundaryError } from './wallet-authorization.js';

export interface LiveRiskIdentity {
  readonly accountId: string; readonly userId: number; readonly strategyId: number;
  readonly strategyVersion: number; readonly policyVersion: number; readonly authorizationVersion: number;
  readonly authorizationId: string; readonly walletId: string; readonly network: 'testnet';
  readonly accountAddress: string; readonly dedicated: true;
}
export interface LiveRiskLeverageProof {
  readonly network: 'testnet'; readonly accountAddress: string;
  readonly coin: string; readonly dex: string; readonly asset: number; readonly value: number;
  readonly type: 'cross' | 'isolated'; readonly observedAt: number; readonly sourceDigest: string;
  readonly maxLeverage: number;
}
export interface LiveRiskReservation {
  readonly accountId: string; readonly key: string; readonly fingerprint: string;
  readonly strategyVersion: number; readonly policyVersion: number; readonly authorizationVersion: number;
  readonly intent: LiveOrderIntent; readonly action: HyperliquidOrderAction;
  readonly state: 'held' | 'unknown' | 'resting'; readonly expiresAt: number;
  readonly notionalUsd: string; readonly marginUsd: string; readonly feeBufferUsd: string;
  readonly exchangeOrderId: string | null;
}
export interface LiveAccountRiskInput {
  readonly now: number; readonly identity: LiveRiskIdentity;
  /** Uncached local identity/policy/settings/control read completed under the gate's locks. */
  readonly localSource: { readonly checkedAt: number; readonly sourceDigest: string };
  readonly intent: LiveOrderIntent; readonly action: HyperliquidOrderAction; readonly market: LiveMarketIdentity;
  readonly accountSource: { readonly accountId: string; readonly userId: number; readonly strategyId: number;
    readonly network: 'testnet'; readonly accountAddress: string; readonly checkedAt: number;
    readonly sourceDigest: string; readonly quarantined: boolean; readonly snapshot: LiveAccountSnapshot };
  readonly policy: { readonly version: number; readonly limits: CopyRiskLimits };
  readonly strategy: { readonly version: number; readonly settings: CopyStrategySettings; readonly allocatedUsd: string };
  readonly controls: { readonly platform: ControlFlags; readonly user: ControlFlags; readonly strategy: ControlFlags };
  readonly quote: { readonly market: LiveMarketIdentity; readonly midPrice: string; readonly markPrice: string;
    readonly observedAt: number; readonly sourceDigest: string };
  readonly leverageProofs: readonly LiveRiskLeverageProof[];
  readonly fees: { readonly network: 'testnet'; readonly accountAddress: string; readonly dex: string; readonly observedAt: number;
    readonly sourceDigest: string; readonly makerFeeBps: string; readonly takerFeeBps: string;
    readonly extraRiskBufferBps: string; readonly restingOrderBuilderFeeCapTenthsBps: number };
  readonly signal: { readonly kind: 'fill' | 'adoption'; readonly leaderSide: 'B' | 'A';
    readonly price: string; readonly at: number } | null;
  /** All other user copy accounts, including their orders/reservations. Excludes this dedicated account. */
  readonly userExposureProof: { readonly userId: number; readonly checkedAt: number; readonly sourceDigest: string;
    readonly network: 'testnet'; readonly coin: string; readonly excludedAccountId: string; readonly excludedExecutionKey: string;
    readonly complete: true; readonly otherAccountsExposureUsd: string; readonly otherAccountsCoinExposureUsd: string;
    readonly ordersLastMinuteExcludingOwn: number };
  readonly reservations: { readonly accountId: string; readonly userId: number; readonly network: 'testnet';
    readonly accountAddress: string; readonly checkedAt: number; readonly sourceDigest: string; readonly complete: true;
    readonly own: LiveRiskReservation; readonly others: readonly LiveRiskReservation[] };
}
export type LiveAccountRiskAssessment = Readonly<{
  ok: true; key: string; fingerprint: string; coin: string; dex: string; notionalUsd: string;
  requiredMarginUsd: string; feeBufferUsd: string; availableCollateralUsd: string;
  projectedStrategyExposureUsd: string; projectedUserExposureUsd: string;
}> | Readonly<{ ok: false; reason: string }>;

function requireProof(value: unknown, reason: string): asserts value {
  if (!value) throw new LiveBoundaryError(reason);
}
function money(value: unknown, signed = false): Dec {
  requireProof(typeof value === 'string' && value.length <= 80 && /^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value), 'live_risk_evidence_invalid');
  const result = Dec.from(value);
  requireProof(signed || result.gte(0), 'live_risk_evidence_invalid'); return result;
}
function integer(value: unknown, min = 1): boolean { return Number.isSafeInteger(value) && (value as number) >= min; }
function digest(value: unknown): void { requireProof(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'live_risk_source'); }
function fresh(at: unknown, now: number): void {
  requireProof(integer(at, 0) && (at as number) <= now && now - (at as number) <= 5000, 'live_risk_stale');
}
function unique(values: readonly (string | number)[], reason: string): void {
  requireProof(new Set(values).size === values.length, reason);
}
function sameMarket(a: LiveMarketIdentity, b: LiveMarketIdentity): void {
  try { requireProof(isDeepStrictEqual(marketIdentityKey(a), marketIdentityKey(b)), 'live_risk_market'); }
  catch { throw new LiveBoundaryError('live_risk_market'); }
}
const monetaryQuantum = Dec.from(`0.${'0'.repeat(USD_DP - 1)}1`);
function reserve(value: Dec): Dec {
  const down = value.floor(USD_DP); return down.eq(value) ? down : down.add(monetaryQuantum);
}
function feeReserve(notional: Dec, bps: Dec): Dec {
  if (!notional.isPositive || !bps.isPositive) return Dec.ZERO;
  return Dec.max(monetaryQuantum, reserve(notional.mul(bps).div(10000)));
}

/** Pure assessment only. These proofs must come from authoritative adapters under
 * account/user serialization; public fields and hashes are bindings, not credentials. */
export function assessLiveAccountRisk(input: LiveAccountRiskInput): LiveAccountRiskAssessment {
  try { return Object.freeze(assess(structuredClone(input))); }
  catch (error) { return Object.freeze({ ok: false, reason: error instanceof LiveBoundaryError ? error.code : 'live_risk_evidence_invalid' }); }
}
function assess(input: LiveAccountRiskInput): LiveAccountRiskAssessment {
  const { now, identity: id, intent, action, market, accountSource: source, policy, strategy, reservations, fees } = input;
  requireProof(integer(now, 0), 'live_risk_stale');
  fresh(input.localSource.checkedAt, now); digest(input.localSource.sourceDigest);
  requireProof(id.dedicated === true && id.network === 'testnet' && intent.network === 'testnet' && source.network === 'testnet' &&
    integer(id.userId) && integer(id.strategyId) && typeof id.accountId === 'string' && id.accountId.length > 0 &&
    typeof id.walletId === 'string' && id.walletId.length > 0 && typeof id.authorizationId === 'string' && id.authorizationId.length > 0 &&
    intent.userId === id.userId && intent.strategyId === id.strategyId && intent.walletId === id.walletId &&
    intent.authorizationId === id.authorizationId && source.accountId === id.accountId && source.userId === id.userId && source.strategyId === id.strategyId &&
    address(intent.accountAddress) === address(id.accountAddress) && address(source.accountAddress) === address(id.accountAddress), 'live_risk_identity');
  requireProof(source.quarantined === false, source.quarantined === true ? 'live_risk_quarantined' : 'live_risk_evidence_invalid');
  requireProof(integer(id.strategyVersion) && integer(id.policyVersion) && integer(id.authorizationVersion) &&
    strategy.version === id.strategyVersion && policy.version === id.policyVersion &&
    reservations.own.strategyVersion === id.strategyVersion && reservations.own.policyVersion === id.policyVersion &&
    reservations.own.authorizationVersion === id.authorizationVersion, 'live_risk_version');
  // Shared schemas contain API defaults. A final financial gate requires every stored field explicitly.
  for (const key of Object.keys(copyRiskLimitsSchema.innerType().shape)) requireProof(Object.hasOwn(policy.limits, key), 'live_risk_evidence_invalid');
  const limits = copyRiskLimitsSchema.parse(policy.limits), settings = copyStrategySettingsSchema.parse(strategy.settings);
  const allocated = money(strategy.allocatedUsd);
  for (const scope of ['platform', 'user', 'strategy'] as const) {
    const control = input.controls[scope];
    requireProof(typeof control.pauseNewRisk === 'boolean' && typeof control.reduceOnly === 'boolean', 'live_risk_evidence_invalid');
  }
  const snapshot = source.snapshot;
  requireProof(snapshot.network === 'testnet' && address(snapshot.accountAddress) === address(id.accountAddress), 'live_risk_identity');
  requireProof(snapshot.role === 'user' && snapshot.accountMode === 'standard' && snapshot.accountAbstraction === 'disabled', 'live_risk_account_mode');
  digest(source.sourceDigest); digest(snapshot.sourceDigest);
  requireProof(source.sourceDigest === snapshot.sourceDigest, 'live_risk_source');
  fresh(source.checkedAt, now); fresh(snapshot.observedAt, now); fresh(snapshot.completedAt, now);
  requireProof(snapshot.completedAt >= snapshot.observedAt && source.checkedAt >= snapshot.completedAt, 'live_risk_source');
  const coverage = snapshot.coverage;
  requireProof(coverage.complete === true && coverage.balanceComplete === true && coverage.orderComplete === true &&
    coverage.unobservedOrderDexes.length === 0 && snapshot.dexes.length > 0 && snapshot.dexes.length <= 1000 &&
    coverage.listedDexes.length === snapshot.dexes.length && coverage.observedOrderDexes.length === snapshot.dexes.length &&
    coverage.listedDexes.every(d => snapshot.dexes.some(v => v.dex === d)) &&
    coverage.observedOrderDexes.every(d => coverage.listedDexes.includes(d)), 'live_risk_coverage_incomplete');
  unique(coverage.listedDexes, 'live_risk_coverage_incomplete'); unique(coverage.observedOrderDexes, 'live_risk_coverage_incomplete');
  unique(snapshot.dexes.map(d => d.dex), 'live_risk_coverage_incomplete'); unique(snapshot.dexes.map(d => d.perpDexIndex), 'live_risk_coverage_incomplete');
  fresh(coverage.earliestProviderTime, now);
  requireProof(coverage.earliestProviderTime === Math.min(...snapshot.dexes.map(d => d.providerTime)), 'live_risk_source');
  requireProof(snapshot.collateralCoin === 'USDC' && integer(snapshot.collateralToken, 0) && snapshot.positions.length <= 10000 && snapshot.restingOrders.length <= 5000,
    'live_risk_evidence_invalid');
  try { assertMarketIdentity(market); requireProof(intent.market, 'live_risk_market'); sameMarket(market, intent.market); }
  catch { throw new LiveBoundaryError('live_risk_market'); }
  requireProof(market.network === 'testnet' && market.asset === intent.asset && market.sizeDecimals === intent.sizeDecimals, 'live_risk_market');
  fresh(market.observedAt, now); fresh(intent.market.observedAt, now);
  let built: HyperliquidOrderAction;
  try { built = buildOrderAction(intent); } catch { throw new LiveBoundaryError('live_risk_action'); }
  requireProof(isDeepStrictEqual(built, action), 'live_risk_action');
  sameMarket(market, input.quote.market); fresh(input.quote.market.observedAt, now); fresh(input.quote.observedAt, now); digest(input.quote.sourceDigest);
  const mid = money(input.quote.midPrice), mark = money(input.quote.markPrice), size = money(intent.size), px = money(intent.limitPrice);
  requireProof(mid.isPositive && mark.isPositive, 'live_risk_evidence_invalid');
  const riskPrice = Dec.max(mid, mark, px), notional = size.mul(riskPrice), key = executionKey(intent), fingerprint = intentFingerprint(intent, action);
  const dexByName = new Map(snapshot.dexes.map(d => [d.dex, d]));
  const dex = dexByName.get(market.dex);
  requireProof(dex && dex.perpDexIndex === market.perpDexIndex && dex.supported === true && dex.collateralCoin === 'USDC' &&
    dex.collateralToken === snapshot.collateralToken, 'live_risk_market');

  const positions = snapshot.positions, orders = snapshot.restingOrders;
  unique(positions.map(p => p.asset), 'live_risk_account_totals'); unique(positions.map(p => p.coin), 'live_risk_account_totals');
  unique(orders.map(o => o.oid), 'live_risk_account_totals'); unique(orders.flatMap(o => o.cloid ? [o.cloid] : []), 'live_risk_account_totals');
  const positionByCoin = new Map(positions.map(p => [p.coin, p]));
  const orderById = new Map(orders.map(o => [o.oid, o]));
  const orderByCloid = new Map(orders.flatMap(o => o.cloid ? [[o.cloid, o] as const] : []));
  const assetCoordinates = new Map([[market.asset, { coin: market.coin, dex: market.dex }]]);
  const coinCoordinates = new Map([[market.coin, market.asset]]);
  function observedIdentity(coin: string, venue: string, asset: number) {
    const row = dexByName.get(venue);
    requireProof(row && typeof coin === 'string' && LIVE_PERP_COIN.test(coin) && coin.length <= 80 && integer(asset, 0) &&
      (venue === '' ? !coin.includes(':') && asset < 10000 && row.perpDexIndex === 0
          : coin.startsWith(`${venue}:`) && row.perpDexIndex > 0 && asset >= 100000 + row.perpDexIndex * 10000 && asset < 110000 + row.perpDexIndex * 10000), 'live_risk_market');
    const known = assetCoordinates.get(asset), knownAsset = coinCoordinates.get(coin);
    requireProof((!known || known.coin === coin && known.dex === venue) && (knownAsset === undefined || knownAsset === asset), 'live_risk_market');
    assetCoordinates.set(asset, { coin, dex: venue }); coinCoordinates.set(coin, asset);
  }
  for (const p of positions) {
    observedIdentity(p.coin, p.dex, p.asset);
    const quantity = money(p.size, true), value = money(p.positionValue), margin = money(p.marginUsed);
    requireProof(integer(p.sizeDecimals, 0) && p.sizeDecimals <= 6 && quantity.eq(quantity.floor(p.sizeDecimals)) &&
      integer(p.leverage) && integer(p.maxLeverage) && p.leverage <= p.maxLeverage && ['cross', 'isolated'].includes(p.leverageType) &&
      (quantity.isZero ? value.isZero && margin.isZero : value.isPositive && money(p.entryPrice).isPositive), 'live_risk_account_totals');
    money(p.unrealizedPnl, true); money(p.fundingSinceOpen, true); money(p.fundingSinceChange, true);
  }
  for (const o of orders) {
    observedIdentity(o.coin, o.dex, o.asset);
    const remaining = money(o.remainingSize), original = money(o.originalSize), price = money(o.limitPrice);
    requireProof(remaining.isPositive && original.gte(remaining) && price.isPositive && remaining.mul(price).eq(money(o.notionalUsd)) &&
      ['B', 'A'].includes(o.side) && typeof o.reduceOnly === 'boolean' && typeof o.oid === 'string' && /^\d+$/.test(o.oid) &&
      (o.cloid === null || /^0x[0-9a-f]{32}$/.test(o.cloid)), 'live_risk_account_totals');
    requireProof(integer(o.timestamp, 0) && o.timestamp <= now, 'live_risk_account_totals');
  }
  const totalPosition = Dec.sum(positions.map(p => money(p.positionValue))), totalMargin = Dec.sum(positions.map(p => money(p.marginUsed)));
  for (const d of snapshot.dexes) {
    fresh(d.providerTime, now);
    requireProof(integer(d.perpDexIndex, 0) && d.perpDexIndex < 1000 && (d.dex === '' ? d.perpDexIndex === 0 : LIVE_DEX_NAME.test(d.dex) && d.perpDexIndex > 0) &&
      typeof d.supported === 'boolean' && integer(d.collateralToken, 0) && typeof d.collateralCoin === 'string' &&
      (!d.supported || d.collateralCoin === 'USDC' && d.collateralToken === snapshot.collateralToken), 'live_risk_market');
    for (const field of ['equity', 'marginUsed', 'withdrawable', 'exposureUsd', 'crossEquity', 'crossMarginUsed', 'crossExposureUsd', 'crossMaintenanceMarginUsed'] as const) money(d[field]);
    money(d.rawUsd, true);
    const local = positions.filter(p => p.dex === d.dex), cross = local.filter(p => p.leverageType === 'cross');
    const localValue = Dec.sum(local.map(p => money(p.positionValue))), localMargin = Dec.sum(local.map(p => money(p.marginUsed)));
    requireProof(money(d.exposureUsd).eq(localValue) && money(d.marginUsed).eq(localMargin) &&
      money(d.crossExposureUsd).eq(Dec.sum(cross.map(p => money(p.positionValue)))) &&
      money(d.crossMarginUsed).eq(Dec.sum(cross.map(p => money(p.marginUsed)))) &&
      money(d.withdrawable).lte(money(d.equity)) && money(d.crossEquity).lte(money(d.equity)) &&
      money(d.crossMaintenanceMarginUsed).lte(money(d.crossMarginUsed)), 'live_risk_account_totals');
    requireProof(d.supported || (localValue.isZero && localMargin.isZero && money(d.equity).isZero && money(d.rawUsd, true).isZero &&
      money(d.crossEquity).isZero && money(d.withdrawable).isZero && !orders.some(o => o.dex === d.dex)), 'live_risk_market');
  }
  requireProof(money(snapshot.exposureUsd).eq(Dec.sum(snapshot.dexes.map(d => money(d.exposureUsd)))) &&
    money(snapshot.totalMarginUsed).eq(Dec.sum(snapshot.dexes.map(d => money(d.marginUsed)))) &&
    money(snapshot.perpEquity).eq(Dec.sum(snapshot.dexes.map(d => money(d.equity)))) &&
    money(snapshot.withdrawable).eq(Dec.sum(snapshot.dexes.map(d => money(d.withdrawable)))) &&
    money(snapshot.exposureUsd).eq(totalPosition) && money(snapshot.totalMarginUsed).eq(totalMargin) &&
    money(snapshot.restingExposureUsd).eq(Dec.sum(orders.filter(o => !o.reduceOnly).map(o => money(o.notionalUsd)))) &&
    money(snapshot.grossRestingExposureUsd).eq(Dec.sum(orders.map(o => money(o.notionalUsd)))), 'live_risk_account_totals');
  requireProof(!orders.some(o => o.cloid === intent.cloid), 'live_risk_order_already_observed');

  requireProof(fees.network === 'testnet' && address(fees.accountAddress) === address(id.accountAddress) && fees.dex === market.dex, 'live_risk_identity');
  fresh(fees.observedAt, now); digest(fees.sourceDigest);
  const feeBps = Dec.max(Dec.ZERO, money(fees.makerFeeBps, true), money(fees.takerFeeBps, true), Dec.from(limits.takerFeeBps))
    .add(money(fees.extraRiskBufferBps));
  requireProof(integer(fees.restingOrderBuilderFeeCapTenthsBps, 0) && fees.restingOrderBuilderFeeCapTenthsBps <= 100, 'live_risk_evidence_invalid');
  const orderFee = feeReserve(notional, feeBps.add(Dec.from(intent.builder?.feeTenthsBps ?? 0).div(10)));
  // Open-order snapshots omit their builder identity/terms. A caller's lower
  // cap cannot prove an external order's fee; reserve the exchange's legal
  // perpetual builder maximum (100 tenths-bps) for every resting opening order.
  const restingFeeRate = feeBps.add(Dec.from(100).div(10));
  unique(input.leverageProofs.map(p => p.coin), 'live_risk_leverage');
  const leverageByCoin = new Map(input.leverageProofs.map(p => [p.coin, p]));
  for (const p of input.leverageProofs) {
    requireProof(p.network === 'testnet' && address(p.accountAddress) === address(id.accountAddress), 'live_risk_identity');
    fresh(p.observedAt, now); digest(p.sourceDigest); observedIdentity(p.coin, p.dex, p.asset);
    requireProof(integer(p.value) && integer(p.maxLeverage) && p.value <= p.maxLeverage && ['cross', 'isolated'].includes(p.type), 'live_risk_leverage');
    const position = positionByCoin.get(p.coin);
    requireProof(!position || position.asset === p.asset && position.dex === p.dex && position.leverage === p.value && position.leverageType === p.type, 'live_risk_leverage');
  }
  const leverageCap = effectiveLeverage(limits, settings, market.maxLeverage);
  function leverage(coin: string, asset: number, venue: string): number {
    const proof = leverageByCoin.get(coin);
    requireProof(proof && proof.asset === asset && proof.dex === venue && (intent.reduceOnly || proof.value <= effectiveLeverage(limits, settings, proof.maxLeverage)) &&
      (coin !== market.coin || proof.maxLeverage === market.maxLeverage), 'live_risk_leverage'); return proof.value;
  }
  const currentLeverage = leverage(market.coin, market.asset, market.dex);
  const requiredMargin = intent.reduceOnly ? Dec.ZERO : reserve(notional.div(currentLeverage));
  requireProof(reservations.complete === true && reservations.accountId === id.accountId && reservations.userId === id.userId &&
    reservations.network === 'testnet' && address(reservations.accountAddress) === address(id.accountAddress) && reservations.others.length <= 5000, 'live_risk_reservation');
  fresh(reservations.checkedAt, now); digest(reservations.sourceDigest);
  function validReservation(row: LiveRiskReservation, own: boolean) {
    const r = row.intent;
    requireProof(row.accountId === id.accountId && r.network === 'testnet' && address(r.accountAddress) === address(id.accountAddress) &&
      r.userId === id.userId && r.strategyId === id.strategyId && r.walletId === id.walletId && r.authorizationId === id.authorizationId &&
      r.market && integer(row.strategyVersion) && integer(row.policyVersion) && integer(row.authorizationVersion) &&
      integer(row.expiresAt, 0) && ['held', 'unknown', 'resting'].includes(row.state) &&
      (row.exchangeOrderId === null || typeof row.exchangeOrderId === 'string' && /^\d+$/.test(row.exchangeOrderId)), 'live_risk_reservation');
    try { requireProof(row.key === executionKey(r) && row.fingerprint === intentFingerprint(r, row.action) &&
      isDeepStrictEqual(buildOrderAction(r), row.action), 'live_risk_reservation'); } catch { throw new LiveBoundaryError('live_risk_reservation'); }
    observedIdentity(r.market.coin, r.market.dex, r.asset);
    requireProof(money(row.notionalUsd).gte(money(r.size).mul(money(r.limitPrice))), 'live_risk_reservation_bound');
    money(row.marginUsd); money(row.feeBufferUsd);
    requireProof(row.state !== 'held' || row.expiresAt > now, 'live_risk_reservation');
    if (own) requireProof(row.key === key && row.fingerprint === fingerprint && row.state === 'held' && row.exchangeOrderId === null &&
      isDeepStrictEqual(row.action, action), 'live_risk_reservation');
  }
  validReservation(reservations.own, true);
  requireProof(money(reservations.own.notionalUsd).gte(notional) && money(reservations.own.marginUsd).gte(requiredMargin) &&
    money(reservations.own.feeBufferUsd).gte(orderFee), 'live_risk_reservation_bound');
  unique([reservations.own.key, ...reservations.others.map(r => r.key)], 'live_risk_reservation');
  let pendingExposure = Dec.ZERO, pendingCoin = Dec.ZERO, pendingMargin = Dec.ZERO, pendingFees = Dec.ZERO;
  let pendingReduce = Dec.ZERO;
  for (const row of reservations.others) {
    validReservation(row, false);
    const r = row.intent, m = r.market!;
    const matched = [...new Set([orderByCloid.get(r.cloid), row.exchangeOrderId === null ? undefined : orderById.get(row.exchangeOrderId)])]
      .filter(o => o !== undefined);
    requireProof(matched.length <= 1, 'live_risk_reservation');
    if (matched.length) {
      const o = matched[0]!;
      requireProof(o.coin === m.coin && o.dex === m.dex && o.asset === r.asset && o.side === r.side && o.reduceOnly === r.reduceOnly &&
        money(o.originalSize).eq(money(r.size)) && money(o.limitPrice).eq(money(r.limitPrice)) &&
        (o.cloid === null || o.cloid === r.cloid) && (row.exchangeOrderId === null || row.exchangeOrderId === o.oid), 'live_risk_reservation');
      continue; // Actual remaining quantities below already represent this liability.
    }
    if (r.reduceOnly) { if (m.coin === market.coin) pendingReduce = pendingReduce.add(money(r.size)); continue; }
    const value = Dec.max(money(row.notionalUsd), money(r.size).mul(m.coin === market.coin ? riskPrice : money(r.limitPrice)));
    pendingExposure = pendingExposure.add(value); if (m.coin === market.coin) pendingCoin = pendingCoin.add(value);
    if (m.dex === market.dex) {
      pendingMargin = pendingMargin.add(Dec.max(money(row.marginUsd), reserve(value.div(leverage(m.coin, r.asset, m.dex)))));
      pendingFees = pendingFees.add(Dec.max(money(row.feeBufferUsd), feeReserve(value, feeBps.add(Dec.from(r.builder?.feeTenthsBps ?? 0).div(10)))));
    }
  }
  let restingMargin = Dec.ZERO, restingFees = Dec.ZERO, openingExposure = Dec.ZERO, openingCoin = Dec.ZERO;
  for (const o of orders) {
    if (o.reduceOnly) { if (o.coin === market.coin) pendingReduce = pendingReduce.add(money(o.remainingSize)); continue; }
    const value = o.coin === market.coin ? money(o.remainingSize).mul(Dec.max(riskPrice, money(o.limitPrice))) : money(o.notionalUsd);
    openingExposure = openingExposure.add(value); if (o.coin === market.coin) openingCoin = openingCoin.add(value);
    if (o.dex === market.dex) {
      restingMargin = restingMargin.add(reserve(value.div(leverage(o.coin, o.asset, o.dex))));
      restingFees = restingFees.add(feeReserve(value, restingFeeRate));
    }
  }
  const actual = positionByCoin.get(market.coin);
  requireProof(!actual || actual.asset === market.asset && actual.dex === market.dex && actual.sizeDecimals === market.sizeDecimals, 'live_risk_market');
  const actualSize = actual ? money(actual.size, true) : Dec.ZERO;
  if (intent.reduceOnly) {
    requireProof(!actualSize.isZero && (intent.side === 'A' ? actualSize.isPositive : actualSize.isNegative), 'reduce_direction_mismatch');
    requireProof(size.lte(actualSize.abs().sub(pendingReduce)), 'reduce_size_exceeded');
  } else {
    requireProof(actualSize.isZero || (intent.side === 'B' ? actualSize.isPositive : actualSize.isNegative), 'reduce_only_required');
    for (const scope of ['platform', 'user', 'strategy'] as const) {
      requireProof(!input.controls[scope].pauseNewRisk, `${scope}_paused`); requireProof(!input.controls[scope].reduceOnly, `${scope}_reduce_only`);
    }
    const refusal = symbolRefusal(limits, market.coin); requireProof(!refusal, refusal ?? 'symbol_blocked');
    const signal = input.signal;
    requireProof(signal && ['fill', 'adoption'].includes(signal.kind) && ['B', 'A'].includes(signal.leaderSide) && integer(signal.at, 0) && signal.at <= now, 'live_risk_signal');
    requireProof(signal.kind !== 'adoption' || settings.copyStartMode === 'adopt', 'live_risk_signal');
    requireProof(intent.side === (settings.direction === 'same' ? signal.leaderSide : signal.leaderSide === 'B' ? 'A' : 'B'), 'direction_mismatch');
    requireProof(signal.kind === 'adoption' || now - signal.at <= limits.maxSignalAgeSeconds * 1000, 'stale_signal');
    const signalPrice = money(signal.price); requireProof(signalPrice.isPositive, 'live_risk_signal');
    requireProof(mid.sub(signalPrice).abs().div(signalPrice).mul(10000).lte(limits.maxSlippageBps) &&
      px.sub(mid).abs().div(mid).mul(10000).lte(limits.maxSlippageBps), 'price_moved');
    requireProof(size.mul(px).gte(Dec.max(Dec.from(10), Dec.from(limits.minOrderNotionalUsd))), 'below_min_notional');
    requireProof(notional.lte(limits.maxOrderNotionalUsd), 'max_order');
    requireProof(settings.sizingMode !== 'fixed' || settings.perTradeUsd !== null && size.mul(px).lte(settings.perTradeUsd), 'fixed_trade_size');
    requireProof(positions.every(p => p.leverage <= Math.min(limits.maxLeverage, settings.maxLeverage ?? limits.maxLeverage, p.maxLeverage)), 'live_risk_leverage');
  }
  const user = input.userExposureProof;
  requireProof(user.userId === id.userId && user.complete === true && user.network === 'testnet' && user.coin === market.coin &&
    user.excludedAccountId === id.accountId && user.excludedExecutionKey === key && integer(user.ordersLastMinuteExcludingOwn, 0), 'live_risk_identity');
  fresh(user.checkedAt, now); digest(user.sourceDigest);
  const external = money(user.otherAccountsExposureUsd), externalCoin = money(user.otherAccountsCoinExposureUsd);
  requireProof(externalCoin.lte(external), 'live_risk_account_totals');
  const existing = Dec.sum(positions.map(p => p.coin === market.coin ? Dec.max(money(p.positionValue), money(p.size, true).abs().mul(riskPrice)) : money(p.positionValue)));
  const currentCoin = actual ? Dec.max(money(actual.positionValue), actualSize.abs().mul(riskPrice)) : Dec.ZERO;
  const projected = existing.add(openingExposure).add(pendingExposure).add(intent.reduceOnly ? 0 : notional);
  const userProjected = external.add(projected), coinProjected = externalCoin.add(currentCoin).add(openingCoin).add(pendingCoin).add(intent.reduceOnly ? 0 : notional);
  if (!intent.reduceOnly) {
    requireProof(input.signal?.kind === 'adoption' || user.ordersLastMinuteExcludingOwn < limits.maxOrdersPerMinute, 'frequency');
    requireProof(projected.lte(Dec.min(strategyExposureCap(settings, allocated), money(snapshot.perpEquity).mul(leverageCap))), 'max_strategy_exposure');
    requireProof(userProjected.lte(limits.maxUserExposureUsd), 'max_user_exposure'); requireProof(coinProjected.lte(limits.maxCoinExposureUsd), 'max_coin_exposure');
  }
  const available = Dec.min(money(dex.withdrawable), Dec.max(Dec.ZERO, money(dex.equity).sub(money(dex.marginUsed))))
    .sub(restingMargin).sub(restingFees).sub(pendingMargin).sub(pendingFees);
  requireProof(available.gte(requiredMargin.add(orderFee)), 'available_collateral');
  return { ok: true, key, fingerprint, coin: market.coin, dex: market.dex, notionalUsd: notional.toString(),
    requiredMarginUsd: requiredMargin.toString(), feeBufferUsd: orderFee.toString(), availableCollateralUsd: available.toString(),
    projectedStrategyExposureUsd: projected.toString(), projectedUserExposureUsd: userProjected.toString() };
}
