import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { copyRiskLimitsSchema } from '@trading-dashboard/shared/contracts';
import { Dec, USD_DP } from '../../common/decimal/dec.js';
import type { LiveAccountRiskInput, LiveRiskIdentity, LiveRiskLeverageProof, LiveRiskReservation } from './live-account-risk.js';
import { buildOrderAction, executionKey, intentFingerprint, type HyperliquidOrderAction, type LiveOrderIntent } from './live-order.js';
import { assertMarketIdentity, marketIdentityKey, type LiveMarketIdentity } from './live-market-resolver.js';
import { address, LiveBoundaryError } from './wallet-authorization.js';
import { ceilDecimalProduct } from './live-risk-rounding.js';

export interface LiveReservationBoundsInput {
  readonly now: number; readonly identity: LiveRiskIdentity; readonly localSource: LiveAccountRiskInput['localSource'];
  readonly intent: LiveOrderIntent; readonly action: HyperliquidOrderAction; readonly market: LiveMarketIdentity;
  readonly quote: LiveAccountRiskInput['quote']; readonly leverage: LiveRiskLeverageProof;
  readonly fees: LiveAccountRiskInput['fees']; readonly policy: LiveAccountRiskInput['policy']; readonly expiresAt: number;
}
export interface LiveReservationPayload extends Omit<LiveRiskReservation, 'state' | 'exchangeOrderId'> {
  readonly userId: number; readonly strategyId: number; readonly network: 'testnet'; readonly accountAddress: string;
  readonly walletId: string; readonly authorizationId: string; readonly createdAt: number; readonly sourceDigest: string;
}
export type LiveReservationState = 'held' | 'unknown' | 'resting' | 'released' | 'quarantined';
export interface LiveReservationStored {
  readonly payload: LiveReservationPayload; readonly state: LiveReservationState; readonly revision: number;
  readonly exchangeOrderId: string | null; readonly attemptedAt: number | null;
  readonly releaseEvidenceDigest: string | null; readonly updatedAt: number;
}
function requireValue(condition: unknown): asserts condition { if (!condition) throw new LiveBoundaryError('live_reservation_bounds_unproven'); }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function identifier(value: unknown) { requireValue(typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\p{Cc}\p{Cf}]/u.test(value)); }
function digest(value: unknown) { requireValue(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)); }
function onlyKeys(value: object, allowed: readonly string[]) { requireValue(Object.keys(value).every(key => allowed.includes(key))); }
function intentKeys(intent: LiveOrderIntent) {
  onlyKeys(intent, ['authorizationId', 'userId', 'strategyId', 'walletId', 'network', 'accountAddress', 'reduceOnly', 'cloid', 'asset', 'side', 'size', 'limitPrice', 'sizeDecimals', 'timeInForce', 'market', 'builder']);
  if (intent.market) onlyKeys(intent.market, ['network', 'coin', 'dex', 'asset', 'universeIndex', 'perpDexIndex', 'sizeDecimals', 'maxLeverage', 'observedAt']);
  if (intent.builder) onlyKeys(intent.builder, ['address', 'feeTenthsBps', 'approvedMaxFeeTenthsBps']);
}
function fresh(at: number, now: number) { requireValue(integer(at) && at <= now && now - at <= 5000); }
function money(value: unknown, signed = false) {
  requireValue(typeof value === 'string' && value.length <= 80 && /^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value));
  const result = Dec.from(value); requireValue(signed || result.gte(0)); return result;
}
export function freezeLiveReservation<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeLiveReservation(child); Object.freeze(value); } return value;
}
const quantum = Dec.from(`0.${'0'.repeat(USD_DP - 1)}1`);

/** Produces conservative pending-order budget only. It does not prove funded
 * collateral, reserve a DB row, verify consent, or grant an execution permit.
 * Full authoritative assessment and original-scope persistence remain required. */
export function planLiveReservation(raw: LiveReservationBoundsInput): Readonly<LiveReservationPayload> {
  try {
    const input = structuredClone(raw), { now, identity: id, intent, action, market, quote, leverage, fees, policy } = input;
    intentKeys(intent);
    requireValue(integer(now) && integer(input.expiresAt) && input.expiresAt > now && input.expiresAt <= now + 60000);
    requireValue(id.network === 'testnet' && id.dedicated === true && intent.network === 'testnet' &&
      integer(id.userId) && integer(id.strategyId) && integer(id.strategyVersion) && integer(id.policyVersion) && integer(id.authorizationVersion));
    for (const key of ['accountId', 'walletId', 'authorizationId'] as const) identifier(id[key]);
    const accountAddress = address(id.accountAddress);
    requireValue(address(intent.accountAddress) === accountAddress && intent.userId === id.userId && intent.strategyId === id.strategyId &&
      intent.walletId === id.walletId && intent.authorizationId === id.authorizationId && policy.version === id.policyVersion);
    fresh(input.localSource.checkedAt, now); digest(input.localSource.sourceDigest);
    for (const key of Object.keys(copyRiskLimitsSchema.innerType().shape)) requireValue(Object.hasOwn(policy.limits, key));
    const limits = copyRiskLimitsSchema.parse(policy.limits);
    requireValue(intent.market); assertMarketIdentity(market); assertMarketIdentity(intent.market); assertMarketIdentity(quote.market);
    requireValue(market.network === 'testnet' && market.asset === intent.asset && market.sizeDecimals === intent.sizeDecimals &&
      isDeepStrictEqual(marketIdentityKey(market), marketIdentityKey(intent.market)) && isDeepStrictEqual(marketIdentityKey(market), marketIdentityKey(quote.market)));
    for (const at of [market.observedAt, intent.market.observedAt, quote.market.observedAt, quote.observedAt, leverage.observedAt, fees.observedAt]) fresh(at, now);
    for (const value of [quote.sourceDigest, leverage.sourceDigest, fees.sourceDigest]) digest(value);
    requireValue(isDeepStrictEqual(buildOrderAction(intent), action));
    requireValue(leverage.network === 'testnet' && address(leverage.accountAddress) === accountAddress && leverage.coin === market.coin &&
      leverage.dex === market.dex && leverage.asset === market.asset && integer(leverage.value) && integer(leverage.maxLeverage) &&
      leverage.value <= leverage.maxLeverage && leverage.maxLeverage === market.maxLeverage && ['cross', 'isolated'].includes(leverage.type));
    requireValue(fees.network === 'testnet' && address(fees.accountAddress) === accountAddress && fees.dex === market.dex &&
      Number.isSafeInteger(fees.restingOrderBuilderFeeCapTenthsBps) && fees.restingOrderBuilderFeeCapTenthsBps >= 0 && fees.restingOrderBuilderFeeCapTenthsBps <= 100);
    const mid = money(quote.midPrice), mark = money(quote.markPrice), limit = money(intent.limitPrice), size = money(intent.size);
    requireValue(mid.isPositive && mark.isPositive && limit.isPositive && size.isPositive);
    const notional = ceilDecimalProduct([size, Dec.max(mid, mark, limit)]);
    const margin = intent.reduceOnly ? Dec.ZERO : ceilDecimalProduct([notional], [leverage.value], USD_DP);
    const rate = Dec.max(Dec.ZERO, money(fees.makerFeeBps, true), money(fees.takerFeeBps, true), Dec.from(limits.takerFeeBps))
      .add(money(fees.extraRiskBufferBps)).add(Dec.from(intent.builder?.feeTenthsBps ?? 0).div(10));
    const fee = rate.isPositive ? Dec.max(quantum, ceilDecimalProduct([notional, rate], [10000], USD_DP)) : Dec.ZERO;
    const payload: LiveReservationPayload = { accountId: id.accountId, key: executionKey(intent), fingerprint: intentFingerprint(intent, action),
      userId: id.userId, strategyId: id.strategyId, network: 'testnet', accountAddress, walletId: id.walletId, authorizationId: id.authorizationId,
      strategyVersion: id.strategyVersion, policyVersion: id.policyVersion, authorizationVersion: id.authorizationVersion,
      intent, action, expiresAt: input.expiresAt, notionalUsd: notional.toString(), marginUsd: margin.toString(), feeBufferUsd: fee.toString(),
      createdAt: now, sourceDigest: createHash('sha256').update(JSON.stringify(input)).digest('hex') };
    for (const value of [payload.notionalUsd, payload.marginUsd, payload.feeBufferUsd]) money(value);
    return freezeLiveReservation(payload);
  } catch { throw new LiveBoundaryError('live_reservation_bounds_unproven'); }
}

/** Historic immutable budget validation; freshness belongs to current sources.
 * Stored digests bind provenance, not authority or a release certificate. */
export function validateLiveReservationPayload(raw: unknown): Readonly<LiveReservationPayload> {
  try {
    requireValue(raw && typeof raw === 'object' && !Array.isArray(raw));
    requireValue(JSON.stringify(raw).length <= 16384);
    const p = structuredClone(raw) as LiveReservationPayload;
    intentKeys(p.intent);
    onlyKeys(p, ['accountId', 'key', 'fingerprint', 'userId', 'strategyId', 'network', 'accountAddress', 'walletId', 'authorizationId', 'strategyVersion', 'policyVersion',
      'authorizationVersion', 'intent', 'action', 'expiresAt', 'notionalUsd', 'marginUsd', 'feeBufferUsd', 'createdAt', 'sourceDigest']);
    for (const key of ['accountId', 'walletId', 'authorizationId'] as const) identifier(p[key]);
    requireValue(p.network === 'testnet' && p.intent.network === 'testnet' && address(p.accountAddress) === p.accountAddress &&
      address(p.intent.accountAddress) === p.accountAddress && integer(p.userId) && integer(p.strategyId) && integer(p.strategyVersion) && integer(p.policyVersion) && integer(p.authorizationVersion) &&
      p.intent.userId === p.userId && p.intent.strategyId === p.strategyId && p.intent.walletId === p.walletId && p.intent.authorizationId === p.authorizationId);
    requireValue(integer(p.createdAt) && integer(p.expiresAt) && p.expiresAt > p.createdAt && p.expiresAt <= p.createdAt + 60000);
    digest(p.sourceDigest); digest(p.fingerprint); requireValue(p.intent.market);
    const canonicalAction = buildOrderAction(p.intent);
    requireValue(p.key === executionKey(p.intent) && p.fingerprint === intentFingerprint(p.intent, canonicalAction) && isDeepStrictEqual(canonicalAction, p.action));
    requireValue(money(p.notionalUsd).gte(money(p.intent.size).mul(money(p.intent.limitPrice))));
    for (const value of [p.marginUsd, p.feeBufferUsd]) requireValue(money(value).eq(money(value).floor(USD_DP)));
    return freezeLiveReservation(p);
  } catch { throw new LiveBoundaryError('live_reservation_record_invalid'); }
}
