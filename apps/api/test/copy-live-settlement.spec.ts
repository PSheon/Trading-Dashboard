import { describe, expect, it } from 'vitest';
import { assessLiveReservationSettlement, LIVE_FILL_SCAN_MARGIN_MS, type LiveReservationSettlementInput } from '../src/copy/live/live-reservation-settlement.js';
import { digestLiveEvidence, parseLiveOrderEvidence, parseLiveIocAcknowledgement } from '../src/copy/live/live-order-evidence.js';
import { parseFollowerFill, followerReceiptDigestV1 } from '../src/copy/live/actual-fill-accounting.js';
import { planLiveReservation } from '../src/copy/live/live-risk-reservation.js';
import { intentFingerprint } from '../src/copy/live/live-order.js';
import { fixture, now as base } from './copy-live-risk-test-utils.js';
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
function input(status = 'filled', size = '1'): Mutable<LiveReservationSettlementInput> {
  const f = fixture(), record = { key: f.reservations.own.key, fingerprint: f.reservations.own.fingerprint, nonce: base,
    authorization: { id: 'grant', version: 4, userId: 1, strategyId: 9, walletId: 'agent', privyOwnerId: 'agent-owner',
      accountAddress: f.intent.accountAddress, signerAddress: `0x${'33'.repeat(20)}` as `0x${string}`, network: 'testnet' as const,
      scopes: ['copy:trade' as const], validFrom: base - 1, expiresAt: base + 60000, revokedAt: null, exchangeApprovedAt: base - 1 },
    action: f.action, market: f.market, state: 'unknown' as const, expiresAfter: base + 60000, createdAt: base, updatedAt: base };
  const raw = { status: 'order', order: { status, statusTimestamp: base + 10, order: { coin: 'BTC', oid: 10, cloid: f.intent.cloid,
    side: 'B', reduceOnly: false, tif: 'Gtc', origSz: '1', sz: status === 'filled' ? '0' : '1', limitPx: '100', timestamp: base,
    isTrigger: false, isPositionTpsl: false, children: [] } } };
  const evidence = parseLiveOrderEvidence({ record, market: f.market, raw, checkedAt: base + 20, completedAt: base + 25, now: base + 100 });
  const payload = planLiveReservation({ now: base, identity: f.identity, localSource: f.localSource, intent: f.intent, action: f.action,
    market: f.market, quote: f.quote, leverage: f.leverageProofs[0]!, fees: f.fees, policy: f.policy, expiresAt: base + 60000 });
  const source = structuredClone(f.accountSource) as Mutable<typeof f.accountSource>; source.checkedAt = base + 60; source.snapshot.observedAt = base + 30;
  source.snapshot.completedAt = base + 50; source.snapshot.coverage.earliestProviderTime = base + 40; source.snapshot.dexes[0]!.providerTime = base + 40;
  const fillRaw = { coin: 'BTC', oid: 10, tid: 123, side: 'B', time: base + 5, sz: size, px: '100', feeToken: 'USDC', fee: '0.1', builderFee: '0.02', closedPnl: '0' };
  const fill = parseFollowerFill(fillRaw, { network: 'testnet', accountAddress: f.intent.accountAddress });
  const row = { key: fill.key, accountId: 'account', network: 'testnet' as const, accountAddress: f.intent.accountAddress, kind: 'fill' as const,
    sourceId: fill.tid, coin: fill.coin, providerTime: fill.time, digest: followerReceiptDigestV1(fillRaw), record: { ...fill, raw: fillRaw },
    executionKey: record.key, attribution: 'execution' as const,
    ledger: [{ receiptKey: fill.key, component: 'exchange_fee' as const, amount: '-0.08', token: 'USDC' as const },
      { receiptKey: fill.key, component: 'builder_fee' as const, amount: '-0.02', token: 'USDC' as const }] };
  const value: LiveReservationSettlementInput = { now: base + 100, accountId: 'account', record, reservation: { payload, state: 'unknown', revision: 2, attemptedAt: base,
    exchangeOrderId: null, releaseEvidenceDigest: null, updatedAt: base }, evidence, acknowledgement: null, accountSource: source,
    receipts: { accountId: 'account', checkedAt: base + 70, completeForOrder: true, rows: [row] } };
  return structuredClone(value) as Mutable<LiveReservationSettlementInput>;
}
function iocInput() {
  const f = input('canceled', '0.5'), intent = { ...f.reservation.payload.intent, timeInForce: 'Ioc' as const };
  const action = { ...f.record.action, orders: [{ ...f.record.action.orders[0], t: { limit: { tif: 'Ioc' as const } } }] } as typeof f.record.action;
  f.record.action = action; f.reservation.payload.intent = intent; f.reservation.payload.action = action;
  const fingerprint = intentFingerprint(intent, action); f.record.fingerprint = fingerprint; f.reservation.payload.fingerprint = fingerprint;
  const raw = structuredClone(f.evidence.raw) as { order: { order: { tif: string } } }; raw.order.order.tif = 'Ioc';
  f.evidence = structuredClone(parseLiveOrderEvidence({ record: f.record, market: f.record.market!, raw, checkedAt: base + 20, completedAt: base + 25, now: f.now })) as Mutable<typeof f.evidence>;
  f.acknowledgement = structuredClone(parseLiveIocAcknowledgement({ identity: f.evidence.identity, checkedAt: base + 10,
    raw: { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { oid: 10, totalSz: '0.5', avgPx: '100' } }] } } } })) as Mutable<NonNullable<typeof f.acknowledgement>>;
  return f;
}
describe('pure terminal reservation settlement', () => {
  it('settles a fully observed realistic multi-venue snapshot with opaque unsupported empty venues', () => {
    const f = input(), snapshot = f.accountSource.snapshot;
    for (let i = 1; i <= 267; i++) {
      const dex = i === 1 ? 'i<3fl' : `venue${i}`;
      snapshot.dexes.push({ ...snapshot.dexes[0]!, dex, perpDexIndex: i, supported: false, equity: '0', rawUsd: '0', marginUsed: '0', withdrawable: '0',
        exposureUsd: '0', crossEquity: '0', crossMarginUsed: '0', crossExposureUsd: '0', crossMaintenanceMarginUsed: '0' });
      snapshot.coverage.listedDexes.push(dex); snapshot.coverage.observedOrderDexes.push(dex);
    }
    expect(assessLiveReservationSettlement(f).kind).toBe('release');
    snapshot.dexes[1]!.rawUsd = '0.00000001';
    expect(assessLiveReservationSettlement(f).kind).not.toBe('release');
  });
  it('releases exact full order receipts without asserting historical completeness or fabricating cash', () => {
    const f = input(), result = assessLiveReservationSettlement(f);
    expect(result).toMatchObject({ kind: 'release', certificate: { key: f.record.key, filledSize: '1', oid: '10', reservationRevision: 2 } });
    if (result.kind === 'release') { expect(result.certificate.digest).toMatch(/^[0-9a-f]{64}$/); expect(Object.isFrozen(result.certificate)).toBe(true); }
    expect(result).not.toHaveProperty('cash');
  });
  it('tolerates exact replay receipts and preserves signed fee components once', () => {
    const f = input(); f.receipts.rows.push(structuredClone(f.receipts.rows[0]!));
    expect(assessLiveReservationSettlement(f)).toMatchObject({ kind: 'release' });
  });
  it('settles a cancelled IOC whose acknowledgement was lost from its booked fills once the fill scan is past the cancel', () => {
    const f = iocInput(); f.acknowledgement = null;
    // The scan has not reached the cancel (plus the indexing margin): still unproven.
    f.receipts.scannedThrough = base + 10 + LIVE_FILL_SCAN_MARGIN_MS - 1;
    expect(assessLiveReservationSettlement(f)).toEqual({ kind: 'pending', reason: 'live_settlement_quantity_unproven' });
    f.receipts.scannedThrough = base + 10 + LIVE_FILL_SCAN_MARGIN_MS;
    expect(assessLiveReservationSettlement(f)).toMatchObject({ kind: 'release', certificate: { filledSize: '0.5', acknowledgementDigest: null } });
    // No booked fill: an unfilled cancel settles at zero.
    f.receipts.rows = []; expect(assessLiveReservationSettlement(f)).toMatchObject({ kind: 'release', certificate: { filledSize: '0' } });
    // Booked fills above the order's size contradict it.
    const over = iocInput(); over.acknowledgement = null; over.receipts.scannedThrough = base + 1_000_000;
    over.receipts.rows[0]!.record.raw.sz = '1.5'; over.receipts.rows[0]!.record.size = '1.5'; over.receipts.rows[0]!.digest = followerReceiptDigestV1(over.receipts.rows[0]!.record.raw);
    expect(assessLiveReservationSettlement(over).kind).toBe('quarantine');
  });
  it.each(['missing fill', 'missing ledger', 'unproven cancellation', 'stale source', 'before terminal', 'incomplete coverage', 'resting oid', 'resting cloid'])('retains liabilities with %s', kind => {
    const f = input();
    if (kind === 'missing fill') f.receipts.rows = [];
    if (kind === 'missing ledger') f.receipts.rows[0]!.ledger.pop();
    if (kind === 'unproven cancellation') Object.assign(f, input('canceled'));
    if (kind === 'stale source') f.now += 5001;
    if (kind === 'before terminal') f.accountSource.snapshot.observedAt = base + 24;
    if (kind === 'incomplete coverage') f.accountSource.snapshot.coverage.complete = false;
    if (kind === 'resting oid' || kind === 'resting cloid') f.accountSource.snapshot.restingOrders.push({ coin: 'BTC', dex: '', asset: 0,
      oid: kind === 'resting oid' ? '10' : '99', cloid: kind === 'resting cloid' ? f.record.action.orders[0].c : null, side: 'B', limitPrice: '100',
      remainingSize: '1', originalSize: '1', notionalUsd: '100', reduceOnly: false, timestamp: base });
    expect(assessLiveReservationSettlement(f).kind).not.toBe('release');
  });
  it.each(['overfill', 'wrong side', 'wrong account', 'wrong digest', 'wrong fee', 'conflicting replay'])('quarantines contradictory %s receipts', kind => {
    const f = input(), row = f.receipts.rows[0]!;
    if (kind === 'overfill') Object.assign(f, input('filled', '1.01'));
    if (kind === 'wrong side') { row.record.raw.side = 'A'; row.digest = followerReceiptDigestV1(row.record.raw); }
    if (kind === 'wrong account') row.accountAddress = `0x${'44'.repeat(20)}`;
    if (kind === 'wrong digest') row.digest = 'b'.repeat(64);
    if (kind === 'wrong fee') row.ledger[0]!.amount = '-0.1';
    if (kind === 'conflicting replay') { const conflicting = structuredClone(row); conflicting.digest = 'b'.repeat(64); f.receipts.rows.push(conflicting); }
    expect(assessLiveReservationSettlement(f).kind).toBe('quarantine');
  });
  it('requires fresh explicit provider placement rejection for zero fills', () => {
    const f = input('iocCancelRejected'); f.receipts.rows = [];
    expect(assessLiveReservationSettlement(f)).toMatchObject({ kind: 'release', certificate: { filledSize: '0' } });
    f.evidence = { ...f.evidence, kind: 'missing' } as typeof f.evidence;
    expect(assessLiveReservationSettlement(f).kind).not.toBe('release');
  });
  it('rejects a caller-overwritten terminal filled quantity despite a matching receipt array', () => {
    const f = input('filled', '0.5'); if (f.evidence.kind === 'order') f.evidence.quantity.filledSize = '0.5';
    expect(assessLiveReservationSettlement(f).kind).not.toBe('release');
  });
  it('uses original immutable IOC acknowledgement for exact terminal partial quantity', () => {
      const f = iocInput();
      expect(assessLiveReservationSettlement(f)).toMatchObject({ kind: 'release', certificate: { filledSize: '0.5' } });
      f.acknowledgement = null; expect(assessLiveReservationSettlement(f).kind).not.toBe('release');
  });
  it.each(['owner', 'wallet'])('refuses an IOC acknowledgement rebound to another %s even with a recomputed digest', kind => {
    const f = iocInput(), a = f.acknowledgement!;
    if (kind === 'owner') a.identity.userId++;
    if (kind === 'wallet') a.identity.walletId = 'foreign-wallet';
    a.responseDigest = digestLiveEvidence({ identity: a.identity, checkedAt: a.checkedAt, raw: a.raw });
    expect(assessLiveReservationSettlement(f).kind).not.toBe('release');
  });
  it('refuses malformed asset coordinates in otherwise complete actual account exposure', () => {
    const f = input(); f.accountSource.snapshot.positions.push({ coin: 'BTC', dex: '', asset: 10000, sizeDecimals: 2, size: '1', entryPrice: '100',
      positionValue: '100', unrealizedPnl: '0', marginUsed: '10', leverage: 10, maxLeverage: 20, leverageType: 'cross', fundingSinceOpen: '0', fundingSinceChange: '0' });
    Object.assign(f.accountSource.snapshot.dexes[0]!, { marginUsed: '10', exposureUsd: '100', crossMarginUsed: '10', crossExposureUsd: '100' });
    f.accountSource.snapshot.totalMarginUsed = '10'; f.accountSource.snapshot.exposureUsd = '100';
    expect(assessLiveReservationSettlement(f).kind).not.toBe('release');
  });
});
