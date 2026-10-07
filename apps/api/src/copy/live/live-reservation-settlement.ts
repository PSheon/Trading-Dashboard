import { isDeepStrictEqual } from 'node:util';
import type { HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import { Dec } from '../../common/decimal/dec.js';
import type { LiveExecutionRecord } from './live-execution.js';
import type { LiveAccountRiskInput } from './live-account-risk.js';
import { LIVE_DEX_NAME, LIVE_PERP_COIN, marketIdentityKey } from './live-market-resolver.js';
import { parseFollowerFill, followerReceiptDigestV1, type ParsedFollowerFill } from './actual-fill-accounting.js';
import { digestLiveEvidence, liveEvidenceDecimal, liveEvidenceOid, liveOrderIdentityBinding, parseLiveOrderEvidence, parseLiveIocAcknowledgement,
  type LiveOrderEvidence, type LiveIocAcknowledgement } from './live-order-evidence.js';
import { freezeLiveReservation, validateLiveReservationPayload, type LiveReservationStored } from './live-risk-reservation.js';
import { address } from './wallet-authorization.js';

export interface LiveSettlementLedgerComponent {
  readonly receiptKey: string; readonly component: string; readonly token: string; readonly amount: string;
}
export interface LiveSettlementReceipt {
  readonly key: string; readonly accountId: string; readonly network: HyperliquidNetwork; readonly accountAddress: string;
  readonly kind: 'fill'|'funding'; readonly sourceId: string; readonly coin: string; readonly providerTime: number; readonly digest: string;
  readonly executionKey: string|null; readonly attribution: 'execution'|'account';
  readonly record: ParsedFollowerFill & { readonly raw: Readonly<Record<string, unknown>> };
  readonly ledger: readonly LiveSettlementLedgerComponent[];
}
export interface LiveReservationSettlementInput {
  readonly now: number; readonly accountId: string; readonly record: LiveExecutionRecord; readonly reservation: LiveReservationStored;
  readonly evidence: LiveOrderEvidence; readonly acknowledgement: LiveIocAcknowledgement|null;
  /** Actual same-session SQL manifest, not caller/provider array authority.
   * Completeness is the bounded local order query, never global fill history. */
  readonly receipts: { readonly accountId: string; readonly checkedAt: number; readonly completeForOrder: true; readonly rows: readonly LiveSettlementReceipt[];
    /** The account's fill scan (userFillsByTime) has booked every fill up to
     * this time without an issue: with no IOC acknowledgement, the filled
     * quantity of a cancelled order is its booked fills once this passes the
     * cancel by LIVE_FILL_SCAN_MARGIN_MS. */
    readonly scannedThrough?: number };
  readonly accountSource: LiveAccountRiskInput['accountSource'];
}
export interface LiveReservationSettlementCertificate {
  readonly version: 1; readonly method: 'terminal_receipts'; readonly accountId: string; readonly key: string; readonly fingerprint: string;
  readonly nonce: number; readonly reservationRevision: number; readonly oid: string; readonly cloid: string;
  readonly providerStatus: string; readonly statusTimestamp: number; readonly filledSize: string;
  readonly terminalSourceDigest: string; readonly acknowledgementDigest: string|null; readonly accountSourceDigest: string;
  readonly receiptManifestDigest: string; readonly receipts: readonly { readonly key: string; readonly digest: string }[];
  readonly assessedAt: number; readonly oldestObservedAt: number; readonly validUntil: number; readonly digest: string;
}
export type LiveReservationSettlementDecision = Readonly<{ kind: 'pending'|'quarantine'; reason: string }> |
  Readonly<{ kind: 'release'; certificate: LiveReservationSettlementCertificate }>;
/** How far past a cancel the fill scan must reach before its booked fills
 * stand for an unacknowledged IOC's filled quantity (provider indexing lag). */
export const LIVE_FILL_SCAN_MARGIN_MS = 10_000;
class SettlementIssue extends Error { constructor(readonly kind: 'pending'|'quarantine', readonly reason: string) { super(reason); } }
function requireProof(value: unknown, reason: string, kind: 'pending'|'quarantine' = 'pending'): asserts value {
  if (!value) throw new SettlementIssue(kind, reason);
}
function integer(value: unknown, min = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= min; }
function fresh(at: number, now: number) { requireProof(integer(at) && at <= now && now - at <= 5000, 'live_settlement_stale'); }
function digest(value: unknown) { requireProof(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'live_settlement_source_unproven'); }
function decimal(value: unknown, signed = false): Dec {
  requireProof(typeof value === 'string' && value.length <= 80 && /^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value), 'live_settlement_account_invalid');
  const result = Dec.from(value); requireProof(signed || result.gte(0), 'live_settlement_account_invalid'); return result;
}
function unique(values: readonly (string|number)[]) { requireProof(new Set(values).size === values.length, 'live_settlement_account_invalid'); }

/** Pure release assessment only. The future DAL must obtain each input from
 * actual trusted reads and persist the certificate with a fenced CAS update.
 * This function never books cash, mutates a reservation or grants trading. */
export function assessLiveReservationSettlement(raw: LiveReservationSettlementInput): LiveReservationSettlementDecision {
  try {
    const input = structuredClone(raw), { now, record, reservation, evidence, accountSource: source, receipts } = input;
    requireProof(integer(now, 1), 'live_settlement_invalid');
    const p = validateLiveReservationPayload(reservation.payload), id = evidence.identity;
    requireProof(input.accountId === p.accountId && p.userId === record.authorization.userId && p.strategyId === record.authorization.strategyId &&
      p.walletId === record.authorization.walletId && p.authorizationId === record.authorization.id && p.authorizationVersion === record.authorization.version &&
      p.network === record.authorization.network && p.accountAddress === address(record.authorization.accountAddress) && p.key === record.key && p.fingerprint === record.fingerprint &&
      isDeepStrictEqual(p.action, record.action) && isDeepStrictEqual(marketIdentityKey(p.intent.market!), marketIdentityKey(id.market)), 'live_settlement_identity_mismatch', 'quarantine');
    requireProof(integer(reservation.revision, 1) && ['unknown', 'resting'].includes(reservation.state) && integer(reservation.attemptedAt, 1) &&
      reservation.attemptedAt >= p.createdAt && reservation.releaseEvidenceDigest === null, 'live_settlement_attempt_unproven');
    requireProof(['submitting', 'unknown', 'resting', 'filled', 'partial', 'cancelled', 'rejected'].includes(record.state), 'live_settlement_journal_unproven');
    const parsed = parseLiveOrderEvidence({ record, market: id.market, raw: evidence.raw, checkedAt: evidence.checkedAt, completedAt: evidence.completedAt, now });
    requireProof(isDeepStrictEqual(parsed, evidence), 'live_settlement_terminal_changed', 'quarantine');
    requireProof(evidence.kind === 'order' && ['filled', 'cancelled', 'rejected'].includes(evidence.classification), 'live_settlement_terminal_unproven');
    requireProof(reservation.exchangeOrderId === null || liveEvidenceOid(reservation.exchangeOrderId) === evidence.oid, 'live_settlement_oid_conflict', 'quarantine');
    let quantity = evidence.quantity.filledSize === null ? null : liveEvidenceDecimal(evidence.quantity.filledSize), acknowledgementDigest: string|null = null;
    if (input.acknowledgement) {
      const a = input.acknowledgement, actual = parseLiveIocAcknowledgement({ identity: a.identity, raw: a.raw, checkedAt: a.checkedAt });
      requireProof(isDeepStrictEqual(actual, a) && isDeepStrictEqual(liveOrderIdentityBinding(a.identity), liveOrderIdentityBinding(id)) &&
        a.oid === evidence.oid && a.checkedAt >= record.createdAt && a.checkedAt <= evidence.completedAt, 'live_settlement_ack_conflict', 'quarantine');
      const ackQuantity = liveEvidenceDecimal(a.totalSz);
      requireProof(quantity === null || quantity.eq(ackQuantity), 'live_settlement_ack_conflict', 'quarantine');
      quantity = ackQuantity; acknowledgementDigest = a.responseDigest;
    }
    // A cancelled IOC whose acknowledgement was lost (orderStatus reads only
    // "canceled"): its booked fills are the quantity once the account's fill
    // scan is complete past the cancel (every fill of the order is earlier).
    const scanned = receipts.scannedThrough, fromFills = quantity === null && evidence.classification === 'cancelled' &&
      integer(scanned, 1) && scanned >= evidence.statusTimestamp + LIVE_FILL_SCAN_MARGIN_MS;
    requireProof(quantity !== null || fromFills, 'live_settlement_quantity_unproven');
    requireProof(receipts.accountId === p.accountId && receipts.completeForOrder === true && Array.isArray(receipts.rows) && receipts.rows.length <= 10000,
      'live_settlement_receipt_coverage_unproven'); fresh(receipts.checkedAt, now);
    let total = Dec.ZERO, lastFillTime = evidence.placedAt;
    const seen = new Map<string, { row: LiveSettlementReceipt; fill: ParsedFollowerFill }>();
    for (const row of receipts.rows) {
      requireProof(row.accountId === p.accountId && row.network === p.network && row.accountAddress === p.accountAddress && row.kind === 'fill' &&
        row.executionKey === p.key && row.attribution === 'execution', 'live_settlement_receipt_identity_conflict', 'quarantine');
      const prior = seen.get(row.key);
      if (prior) { requireProof(isDeepStrictEqual(prior.row, row), 'live_settlement_receipt_conflict', 'quarantine'); continue; }
      let fill: ParsedFollowerFill;
      try { fill = parseFollowerFill(row.record.raw, { network: p.network, accountAddress: p.accountAddress, coin: evidence.coin, oid: evidence.oid,
        minTime: evidence.placedAt, maxTime: evidence.statusTimestamp }); } catch { throw new SettlementIssue('quarantine', 'live_settlement_receipt_identity_conflict'); }
      requireProof(followerReceiptDigestV1(row.record.raw) === row.digest && row.key === fill.key && row.sourceId === fill.tid && row.coin === fill.coin &&
        row.providerTime === fill.time && fill.side === evidence.side && isDeepStrictEqual(row.record, { ...fill, raw: row.record.raw }), 'live_settlement_receipt_conflict', 'quarantine');
      requireProof(Array.isArray(row.ledger) && row.ledger.length <= 3, 'live_settlement_ledger_conflict', 'quarantine');
      const expected = new Map([['realized_pnl', Dec.from(fill.closedPnl)], ['exchange_fee', Dec.from(fill.exchangeFee).neg()], ['builder_fee', Dec.from(fill.builderFee).neg()]]);
      const present = new Set<string>();
      for (const component of row.ledger) {
        requireProof(component.receiptKey === row.key && component.token === 'USDC' && expected.has(component.component) && !present.has(component.component), 'live_settlement_ledger_conflict', 'quarantine');
        let amount: Dec; try { amount = decimal(component.amount, true); } catch { throw new SettlementIssue('quarantine', 'live_settlement_ledger_conflict'); }
        requireProof(amount.eq(expected.get(component.component)!), 'live_settlement_ledger_conflict', 'quarantine'); present.add(component.component);
      }
      requireProof([...expected].every(([kind, amount]) => amount.isZero || present.has(kind)), 'live_settlement_ledger_incomplete');
      total = total.add(fill.size); lastFillTime = Math.max(lastFillTime, fill.time); seen.set(row.key, { row, fill });
    }
    if (quantity === null) { requireProof(total.lte(liveEvidenceDecimal(evidence.originalSize)), 'live_settlement_fill_overflow', 'quarantine'); quantity = total; }
    requireProof(total.lte(quantity), 'live_settlement_fill_overflow', 'quarantine');
    requireProof(total.eq(quantity), 'live_settlement_receipts_incomplete');

    const snapshot = source.snapshot, coverage = snapshot.coverage;
    requireProof(source.accountId === p.accountId && source.userId === p.userId && source.strategyId === p.strategyId && source.network === p.network &&
      source.accountAddress === p.accountAddress && snapshot.network === p.network && snapshot.accountAddress === p.accountAddress, 'live_settlement_account_identity_conflict', 'quarantine');
    requireProof(source.quarantined === false && snapshot.role === 'user' && snapshot.accountMode === 'standard' && snapshot.accountAbstraction === 'disabled' &&
      snapshot.collateralCoin === 'USDC' && integer(snapshot.collateralToken), 'live_settlement_account_unproven');
    digest(source.sourceDigest); requireProof(source.sourceDigest === snapshot.sourceDigest, 'live_settlement_source_unproven');
    for (const at of [source.checkedAt, snapshot.observedAt, snapshot.completedAt, coverage.earliestProviderTime]) fresh(at, now);
    requireProof(snapshot.observedAt >= evidence.completedAt && snapshot.completedAt >= snapshot.observedAt && source.checkedAt >= snapshot.completedAt,
      'live_settlement_account_before_terminal');
    requireProof(coverage.complete === true && coverage.balanceComplete === true && coverage.orderComplete === true && coverage.unobservedOrderDexes.length === 0 &&
      snapshot.dexes.length > 0 && snapshot.dexes.length <= 1000 && snapshot.positions.length <= 10000 && snapshot.restingOrders.length <= 5000 &&
      coverage.listedDexes.length === snapshot.dexes.length && coverage.observedOrderDexes.length === snapshot.dexes.length,
      'live_settlement_account_coverage_unproven');
    unique(snapshot.dexes.map(d => d.dex)); unique(snapshot.dexes.map(d => d.perpDexIndex)); unique(coverage.listedDexes); unique(coverage.observedOrderDexes);
    requireProof(coverage.listedDexes.every(d => snapshot.dexes.some(v => v.dex === d)) && coverage.observedOrderDexes.every(d => coverage.listedDexes.includes(d)) &&
      coverage.earliestProviderTime === Math.min(...snapshot.dexes.map(d => d.providerTime)), 'live_settlement_account_coverage_unproven');
    requireProof(coverage.earliestProviderTime > Math.max(evidence.statusTimestamp, lastFillTime), 'live_settlement_account_before_terminal');
    unique(snapshot.positions.map(p => p.coin)); unique(snapshot.restingOrders.map(o => o.oid)); unique(snapshot.restingOrders.filter(o => o.cloid !== null).map(o => o.cloid!));
    const venue = (coin: string, dex: string, asset: number) => {
      requireProof(typeof coin === 'string' && LIVE_PERP_COIN.test(coin) && coin.length <= 80 && integer(asset) && (coin.includes(':') ? coin.split(':')[0] : '') === dex,
        'live_settlement_account_invalid');
      const found = snapshot.dexes.find(d => d.dex === dex); requireProof(found, 'live_settlement_account_coverage_unproven');
      requireProof(dex === '' ? asset < 10000 : asset >= 100000 + found.perpDexIndex * 10000 && asset < 100000 + (found.perpDexIndex + 1) * 10000,
        'live_settlement_account_invalid');
      requireProof(coin !== evidence.coin || asset === evidence.asset && dex === evidence.dex, 'live_settlement_account_invalid'); return found;
    };
    for (const position of snapshot.positions) {
      venue(position.coin, position.dex, position.asset);
      requireProof(!decimal(position.size, true).isZero && integer(position.sizeDecimals) && position.sizeDecimals <= 6 && integer(position.leverage, 1) &&
        integer(position.maxLeverage, 1) && position.leverage <= position.maxLeverage && ['cross', 'isolated'].includes(position.leverageType), 'live_settlement_account_invalid');
      for (const amount of [position.entryPrice, position.positionValue, position.marginUsed]) decimal(amount);
      for (const amount of [position.unrealizedPnl, position.fundingSinceOpen, position.fundingSinceChange]) decimal(amount, true);
    }
    for (const order of snapshot.restingOrders) {
      venue(order.coin, order.dex, order.asset); liveEvidenceOid(order.oid);
      requireProof((order.side === 'B' || order.side === 'A') && typeof order.reduceOnly === 'boolean' && integer(order.timestamp) && order.timestamp <= now &&
        (order.cloid === null || /^0x[0-9a-f]{32}$/.test(order.cloid)) && decimal(order.remainingSize).isPositive && decimal(order.originalSize).gte(order.remainingSize) &&
        decimal(order.limitPrice).isPositive && decimal(order.notionalUsd).gte(decimal(order.remainingSize).mul(order.limitPrice)), 'live_settlement_account_invalid');
      requireProof(order.oid !== evidence.oid && order.cloid !== evidence.cloid, 'live_settlement_order_still_present');
    }
    let equity = Dec.ZERO, margin = Dec.ZERO, withdrawable = Dec.ZERO, exposure = Dec.ZERO;
    for (const dex of snapshot.dexes) {
      requireProof((dex.dex === '' || LIVE_DEX_NAME.test(dex.dex)) && integer(dex.perpDexIndex) && dex.perpDexIndex < 1000 && typeof dex.supported === 'boolean' && typeof dex.collateralCoin === 'string' &&
        dex.collateralCoin.length > 0 && dex.collateralCoin.length <= 80 && integer(dex.collateralToken) &&
        (!dex.supported || dex.collateralCoin === 'USDC' && dex.collateralToken === snapshot.collateralToken) && (dex.dex === '' ? dex.perpDexIndex === 0 : dex.perpDexIndex > 0), 'live_settlement_account_unproven'); fresh(dex.providerTime, now);
      decimal(dex.rawUsd, true); decimal(dex.crossMaintenanceMarginUsed);
      const positions = snapshot.positions.filter(p => p.dex === dex.dex), cross = positions.filter(p => p.leverageType === 'cross');
      requireProof(Dec.sum(positions.map(p => decimal(p.positionValue))).eq(dex.exposureUsd) && Dec.sum(positions.map(p => decimal(p.marginUsed))).eq(dex.marginUsed) &&
        Dec.sum(cross.map(p => decimal(p.positionValue))).eq(dex.crossExposureUsd) && Dec.sum(cross.map(p => decimal(p.marginUsed))).eq(dex.crossMarginUsed), 'live_settlement_account_invalid');
      requireProof(decimal(dex.withdrawable).lte(dex.equity) && decimal(dex.marginUsed).lte(dex.equity) && decimal(dex.crossMarginUsed).lte(dex.marginUsed), 'live_settlement_account_invalid');
      requireProof(decimal(dex.crossEquity).lte(dex.equity) && decimal(dex.crossMaintenanceMarginUsed).lte(dex.crossMarginUsed), 'live_settlement_account_invalid');
      requireProof(dex.supported || [dex.equity, dex.rawUsd, dex.marginUsed, dex.withdrawable, dex.exposureUsd, dex.crossEquity, dex.crossExposureUsd, dex.crossMarginUsed, dex.crossMaintenanceMarginUsed].every(value => decimal(value, true).isZero) && positions.length === 0 && !snapshot.restingOrders.some(order => order.dex === dex.dex), 'live_settlement_account_unproven');
      requireProof(dex.dex !== evidence.dex || dex.supported, 'live_settlement_account_unproven');
      equity = equity.add(decimal(dex.equity)); margin = margin.add(decimal(dex.marginUsed)); withdrawable = withdrawable.add(decimal(dex.withdrawable)); exposure = exposure.add(decimal(dex.exposureUsd));
    }
    requireProof(equity.eq(snapshot.perpEquity) && margin.eq(snapshot.totalMarginUsed) && withdrawable.eq(snapshot.withdrawable) && exposure.eq(snapshot.exposureUsd), 'live_settlement_account_invalid');
    requireProof(Dec.sum(snapshot.restingOrders.filter(o => !o.reduceOnly).map(o => decimal(o.notionalUsd))).eq(snapshot.restingExposureUsd) &&
      Dec.sum(snapshot.restingOrders.map(o => decimal(o.notionalUsd))).eq(snapshot.grossRestingExposureUsd), 'live_settlement_account_invalid');
    const manifest = [...seen.values()].sort((a, b) => a.row.key.localeCompare(b.row.key)).map(({ row }) => row);
    const oldestObservedAt = Math.min(evidence.checkedAt, id.market.observedAt, receipts.checkedAt, source.checkedAt, snapshot.observedAt, snapshot.completedAt,
      coverage.earliestProviderTime, ...snapshot.dexes.map(d => d.providerTime)); fresh(oldestObservedAt, now);
    const certificate = { version: 1 as const, method: 'terminal_receipts' as const, accountId: p.accountId, key: p.key, fingerprint: p.fingerprint, nonce: record.nonce,
      reservationRevision: reservation.revision, oid: evidence.oid, cloid: evidence.cloid, providerStatus: evidence.providerStatus, statusTimestamp: evidence.statusTimestamp,
      filledSize: total.toString(), terminalSourceDigest: evidence.sourceDigest, acknowledgementDigest, accountSourceDigest: source.sourceDigest,
      receiptManifestDigest: digestLiveEvidence(manifest), receipts: manifest.map(row => ({ key: row.key, digest: row.digest })), assessedAt: now,
      oldestObservedAt, validUntil: oldestObservedAt + 5000 };
    return freezeLiveReservation({ kind: 'release' as const, certificate: { ...certificate, digest: digestLiveEvidence({ certificate, evidence, acknowledgement: input.acknowledgement, source, manifest }) } });
  } catch (error) {
    if (error instanceof SettlementIssue) return Object.freeze({ kind: error.kind, reason: error.reason });
    return Object.freeze({ kind: 'pending', reason: 'live_settlement_evidence_invalid' });
  }
}
