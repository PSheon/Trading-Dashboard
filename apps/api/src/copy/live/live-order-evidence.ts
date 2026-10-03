import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Dec } from '../../common/decimal/dec.js';
import type { LiveExecutionRecord } from './live-execution.js';
import { buildOrderAction, executionKey, intentFingerprint, type HyperliquidOrderAction, type LiveOrderIntent } from './live-order.js';
import { assertMarketIdentity, marketIdentityKey, type LiveMarketIdentity } from './live-market-resolver.js';
import { freezeLiveReservation } from './live-risk-reservation.js';
import { address, LiveBoundaryError } from './wallet-authorization.js';

export interface LiveOrderEvidenceIdentity {
  readonly network: 'testnet'; readonly accountAddress: string; readonly key: string; readonly fingerprint: string; readonly nonce: number;
  readonly userId: number; readonly strategyId: number; readonly walletId: string; readonly authorizationId: string;
  readonly authorizationVersion: number; readonly market: LiveMarketIdentity; readonly action: HyperliquidOrderAction;
}
interface EvidenceSource {
  readonly identity: LiveOrderEvidenceIdentity; readonly checkedAt: number; readonly completedAt: number;
  readonly sourceDigest: string; readonly raw: Readonly<Record<string, unknown>>;
}
export interface LiveFoundOrderEvidence extends EvidenceSource {
  readonly kind: 'order'; readonly classification: 'open'|'filled'|'cancelled'|'rejected'|'unproven';
  readonly oid: string; readonly cloid: string; readonly coin: string; readonly dex: string; readonly asset: number;
  readonly side: 'B'|'A'; readonly reduceOnly: boolean; readonly tif: 'Ioc'|'Gtc'|'Alo';
  readonly originalSize: string; readonly observedOrderSize: string; readonly limitPrice: string;
  readonly placedAt: number; readonly statusTimestamp: number; readonly providerStatus: string;
  readonly quantity: { readonly kind: 'full'|'placement_rejected'|'unproven'; readonly filledSize: string|null };
}
export type LiveOrderEvidence = LiveFoundOrderEvidence | (EvidenceSource & { readonly kind: 'missing' });
export interface LiveIocAcknowledgement {
  readonly identity: LiveOrderEvidenceIdentity; readonly oid: string; readonly totalSz: string; readonly checkedAt: number;
  readonly responseDigest: string; readonly raw: Readonly<Record<string, unknown>>;
}

const liveCanceledStatuses: ReadonlySet<string> = new Set(['canceled', 'marginCanceled', 'vaultWithdrawalCanceled', 'openInterestCapCanceled',
  'selfTradeCanceled', 'reduceOnlyCanceled', 'siblingFilledCanceled', 'delistedCanceled', 'liquidatedCanceled', 'scheduledCancel']);
const liveRejectedStatuses: ReadonlySet<string> = new Set(['rejected', 'tickRejected', 'minTradeNtlRejected', 'perpMarginRejected', 'reduceOnlyRejected',
  'badAloPxRejected', 'iocCancelRejected', 'badTriggerPxRejected', 'marketOrderNoLiquidityRejected',
  'positionIncreaseAtOpenInterestCapRejected', 'positionFlipAtOpenInterestCapRejected', 'tooAggressiveAtOpenInterestCapRejected',
  'openInterestIncreaseRejected', 'insufficientSpotBalanceRejected', 'oracleRejected', 'perpMaxPositionRejected']);
function check(value: unknown): asserts value { if (!value) throw new LiveBoundaryError('live_order_evidence_invalid'); }
function object(value: unknown): Record<string, unknown> { check(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>; }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
export function canonicalLiveEvidence(value: unknown, depth = 0): string {
  check(depth <= 16);
  if (Array.isArray(value)) return `[${value.map(v => canonicalLiveEvidence(v, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalLiveEvidence(child, depth + 1)}`).join(',')}}`;
  const text = JSON.stringify(value); check(text !== undefined); return text;
}
export function digestLiveEvidence(value: unknown): string { return createHash('sha256').update(canonicalLiveEvidence(value)).digest('hex'); }
export function liveEvidenceDecimal(value: unknown): Dec {
  check(typeof value === 'string' && value.length <= 80 && /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)); return Dec.from(value);
}
export function liveEvidenceOid(value: unknown): string {
  if (typeof value === 'number') { check(integer(value)); return String(value); }
  check(typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n); return value;
}
/** Canonical immutable lineage; metadata observation times may differ between
 * the original acknowledgement and the fresh terminal read. */
export function liveOrderIdentityBinding(identity: LiveOrderEvidenceIdentity) {
  const id = structuredClone(identity), order = id.action?.orders?.[0];
  check(id.network === 'testnet' && order && id.action.orders.length === 1 && integer(id.nonce) && integer(id.userId) && integer(id.strategyId) && integer(id.authorizationVersion));
  assertMarketIdentity(id.market); check(id.market.network === 'testnet' && id.market.asset === order.a && typeof order.b === 'boolean' && address(id.accountAddress) === id.accountAddress && !/^0x0{40}$/.test(id.accountAddress));
  for (const value of [id.walletId, id.authorizationId]) check(typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\p{Cc}\p{Cf}]/u.test(value));
  const intent: LiveOrderIntent = { userId: id.userId, strategyId: id.strategyId, walletId: id.walletId, authorizationId: id.authorizationId,
    network: 'testnet', accountAddress: address(id.accountAddress), reduceOnly: order.r, cloid: order.c, asset: order.a, side: order.b ? 'B' : 'A', size: order.s,
    limitPrice: order.p, sizeDecimals: id.market.sizeDecimals, timeInForce: order.t?.limit?.tif, market: id.market,
    ...(id.action.builder ? { builder: { address: id.action.builder.b, feeTenthsBps: id.action.builder.f, approvedMaxFeeTenthsBps: id.action.builder.f } } : {}) };
  const action = buildOrderAction(intent); check(isDeepStrictEqual(action, id.action) && id.key === executionKey(intent) && id.fingerprint === intentFingerprint(intent, action));
  return { network: id.network, accountAddress: id.accountAddress, key: id.key, fingerprint: id.fingerprint, nonce: id.nonce, userId: id.userId,
    strategyId: id.strategyId, walletId: id.walletId, authorizationId: id.authorizationId, authorizationVersion: id.authorizationVersion, market: marketIdentityKey(id.market), action };
}
export function captureLiveOrderIdentity(record: LiveExecutionRecord, market: LiveMarketIdentity): Readonly<LiveOrderEvidenceIdentity> {
  check(record && record.authorization && record.action?.orders?.length === 1); assertMarketIdentity(market);
  const auth = record.authorization, order = record.action.orders[0];
  check(auth.network === 'testnet' && market.network === 'testnet' && market.asset === order.a &&
    integer(auth.userId) && integer(auth.strategyId) && integer(auth.version) && integer(record.nonce) && integer(record.createdAt) && record.nonce >= record.createdAt);
  for (const id of [auth.id, auth.walletId]) check(typeof id === 'string' && id.length > 0 && id.length <= 128 && !/[\s\p{Cc}\p{Cf}]/u.test(id));
  check(!record.market || isDeepStrictEqual(marketIdentityKey(record.market), marketIdentityKey(market)));
  const accountAddress = address(auth.accountAddress); check(!/^0x0{40}$/.test(accountAddress));
  const intent: LiveOrderIntent = { userId: auth.userId, strategyId: auth.strategyId, walletId: auth.walletId, authorizationId: auth.id,
    network: 'testnet', accountAddress, reduceOnly: order.r, cloid: order.c, asset: order.a, side: order.b ? 'B' : 'A', size: order.s,
    limitPrice: order.p, sizeDecimals: market.sizeDecimals, timeInForce: order.t?.limit?.tif, market,
    ...(record.action.builder ? { builder: { address: record.action.builder.b, feeTenthsBps: record.action.builder.f, approvedMaxFeeTenthsBps: record.action.builder.f } } : {}) };
  const action = buildOrderAction(intent); check(typeof order.b === 'boolean' && isDeepStrictEqual(action, record.action));
  check(record.key === executionKey(intent) && record.fingerprint === intentFingerprint(intent, action));
  return freezeLiveReservation(structuredClone({ network: 'testnet' as const, accountAddress, key: record.key, fingerprint: record.fingerprint,
    nonce: record.nonce, userId: auth.userId, strategyId: auth.strategyId, walletId: auth.walletId, authorizationId: auth.id,
    authorizationVersion: auth.version, market, action }));
}

/** Pure parser for a trusted fixed-network read. It is not repository authority. */
export function parseLiveOrderEvidence(input: { record: LiveExecutionRecord; market: LiveMarketIdentity; raw: unknown; checkedAt: number; completedAt: number; now: number }): Readonly<LiveOrderEvidence> {
  try {
    const { record, market, checkedAt, completedAt, now } = structuredClone(input), raw = object(structuredClone(input.raw));
    check(integer(now) && integer(checkedAt) && checkedAt <= completedAt && completedAt <= now && now - checkedAt <= 5000 &&
      integer(market.observedAt) && market.observedAt <= now && now - market.observedAt <= 5000);
    check(Buffer.byteLength(JSON.stringify(raw)) <= 256 * 1024);
    const identity = captureLiveOrderIdentity(record, market);
    const sourceIdentity = (value: Record<string, unknown>) => check((value.user === undefined || typeof value.user === 'string' && address(value.user) === identity.accountAddress) &&
      (value.network === undefined || value.network === 'testnet'));
    sourceIdentity(raw);
    const source = { identity, checkedAt, completedAt, sourceDigest: digestLiveEvidence({ identity, checkedAt, completedAt, raw }), raw };
    if (raw.status === 'unknownOid') return freezeLiveReservation({ ...source, kind: 'missing' as const });
    check(raw.status === 'order'); const status = object(raw.order), order = object(status.order); sourceIdentity(status); sourceIdentity(order);
    const expected = identity.action.orders[0], oid = liveEvidenceOid(order.oid), original = liveEvidenceDecimal(order.origSz), observed = liveEvidenceDecimal(order.sz);
    check(order.coin === market.coin && order.cloid === expected.c && order.side === (expected.b ? 'B' : 'A') && order.reduceOnly === expected.r &&
      order.tif === expected.t.limit.tif && liveEvidenceDecimal(order.limitPx).eq(expected.p) && original.eq(expected.s) && observed.lte(original) &&
      order.isTrigger === false && order.isPositionTpsl === false && Array.isArray(order.children) && order.children.length === 0);
    check(!record.outcome?.exchangeOrderId || liveEvidenceOid(record.outcome.exchangeOrderId) === oid);
    check(integer(order.timestamp) && integer(status.statusTimestamp) && order.timestamp >= record.createdAt &&
      order.timestamp <= status.statusTimestamp && status.statusTimestamp <= now && typeof status.status === 'string' && status.status.length <= 64);
    const providerStatus = status.status, classification = providerStatus === 'open' ? 'open' : providerStatus === 'filled' ? 'filled' :
      liveCanceledStatuses.has(providerStatus) ? 'cancelled' : liveRejectedStatuses.has(providerStatus) ? 'rejected' : 'unproven';
    const quantity = classification === 'filled' ? { kind: 'full' as const, filledSize: original.toString() } :
      classification === 'rejected' ? { kind: 'placement_rejected' as const, filledSize: '0' } : { kind: 'unproven' as const, filledSize: null };
    return freezeLiveReservation({ ...source, kind: 'order' as const, classification, oid, cloid: expected.c, coin: market.coin, dex: market.dex, asset: market.asset,
      side: expected.b ? 'B' as const : 'A' as const, reduceOnly: expected.r, tif: expected.t.limit.tif, originalSize: original.toString(), observedOrderSize: observed.toString(),
      limitPrice: liveEvidenceDecimal(order.limitPx).toString(), placedAt: order.timestamp, statusTimestamp: status.statusTimestamp, providerStatus, quantity });
  } catch { throw new LiveBoundaryError('live_order_evidence_invalid'); }
}

/** Immutable original IOC response; caller must load it from a trusted durable
 * actual submission path. A plain incoming acknowledgement is not authority. */
export function parseLiveIocAcknowledgement(input: { identity: LiveOrderEvidenceIdentity; raw: unknown; checkedAt: number }): Readonly<LiveIocAcknowledgement> {
  try {
    const { identity, checkedAt } = structuredClone(input), raw = object(structuredClone(input.raw));
    liveOrderIdentityBinding(identity);
    check(integer(checkedAt) && identity.network === 'testnet' && identity.action.orders[0].t.limit.tif === 'Ioc' && Buffer.byteLength(JSON.stringify(raw)) <= 256 * 1024);
    check(raw.status === 'ok'); const response = object(raw.response); check(response.type === 'order');
    const statuses = object(response.data).statuses; check(Array.isArray(statuses) && statuses.length === 1);
    const result = object(statuses[0]); check(Object.keys(result).length === 1 && result.filled);
    const filled = object(result.filled), oid = liveEvidenceOid(filled.oid), totalSz = liveEvidenceDecimal(filled.totalSz);
    check(totalSz.lte(identity.action.orders[0].s) && liveEvidenceDecimal(filled.avgPx).isPositive);
    return freezeLiveReservation({ identity, oid, totalSz: totalSz.toString(), checkedAt, raw, responseDigest: digestLiveEvidence({ identity, checkedAt, raw }) });
  } catch { throw new LiveBoundaryError('live_order_evidence_invalid'); }
}
