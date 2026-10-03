import { expect, it } from 'vitest';
import { assessLiveReservationSettlement, type LiveReservationSettlementInput } from '../src/copy/live/live-reservation-settlement.js';
import { digestLiveEvidence, parseLiveOrderEvidence, parseLiveIocAcknowledgement } from '../src/copy/live/live-order-evidence.js';
import { parseFollowerFill, followerReceiptDigestV1 } from '../src/copy/live/actual-fill-accounting.js';
import { planLiveReservation } from '../src/copy/live/live-risk-reservation.js';
import { intentFingerprint } from '../src/copy/live/live-order.js';
import { fixture, now as base } from './copy-live-risk-test-utils.js';
import { captureLiveSettlementProof, decodeLiveSettlementProof } from '../src/copy/live/live-settlement-proof.js';
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
it('captures an immutable JSONB-replayable original settlement proof',()=>{
  const original=input(),decision=assessLiveReservationSettlement(original);expect(decision.kind).toBe('release');if(decision.kind!=='release')throw Error();
  const result=captureLiveSettlementProof(original,decision.certificate);
  expect(result.digest).toMatch(/^[0-9a-f]{64}$/);expect(Object.isFrozen(result.proof.input.accountSource.snapshot.dexes[0])).toBe(true);
  const persisted=JSON.parse(JSON.stringify(result.proof));expect(decodeLiveSettlementProof(persisted,result.digest)).toEqual(result.proof);
  original.accountSource.snapshot.dexes[0]!.equity='999';expect(result.proof.input.accountSource.snapshot.dexes[0]!.equity).toBe('100');
});
it('replays at the captured original time without pretending historical evidence is currently fresh',()=>{
  const original=iocInput(),decision=assessLiveReservationSettlement(original);if(decision.kind!=='release')throw Error();
  const result=captureLiveSettlementProof(original,decision.certificate),saved=JSON.parse(JSON.stringify(result.proof));
  expect(decodeLiveSettlementProof(saved,result.digest).input.now).toBe(base+100);
  expect(assessLiveReservationSettlement({...original,now:base+86400000}).kind).not.toBe('release');
});
it.each(['source','ledger','receipt','oid','nonce','originalTime','certificate','mirror','extra'] as const)('rejects changed retained %s even when someone rehashes the envelope',kind=>{
  const original=input(),decision=assessLiveReservationSettlement(original);if(decision.kind!=='release')throw Error();
  const result=captureLiveSettlementProof(original,decision.certificate),saved:any=structuredClone(result.proof);
  if(kind==='source')saved.input.accountSource.snapshot.dexes[0].equity='999';
  if(kind==='ledger')saved.input.receipts.rows[0].ledger[0].amount='-0.1';
  if(kind==='receipt')saved.input.receipts.rows[0].record.raw.px='101';
  if(kind==='oid')saved.input.evidence.oid='11';
  if(kind==='nonce')saved.input.record.nonce++;
  if(kind==='originalTime')saved.input.now++;
  if(kind==='certificate')saved.certificate.filledSize='0.5';
  if(kind==='extra')saved.authority=true;
  const claimed=kind==='mirror'?'f'.repeat(64):digestLiveEvidence(saved);
  expect(()=>decodeLiveSettlementProof(saved,claimed)).toThrow('live_settlement_proof_invalid');
});
it('refuses to capture a pending liability or a different claimed certificate',()=>{
  const original=input(),decision=assessLiveReservationSettlement(original);if(decision.kind!=='release')throw Error();
  original.receipts.rows=[];expect(()=>captureLiveSettlementProof(original,decision.certificate)).toThrow('live_settlement_proof_invalid');
  expect(()=>captureLiveSettlementProof(input(),{...decision.certificate,digest:'f'.repeat(64)})).toThrow('live_settlement_proof_invalid');
});
it('rejects non-JSON scalars and over-bound unknown raw provider bytes',()=>{
  const original=input(),decision=assessLiveReservationSettlement(original);if(decision.kind!=='release')throw Error();
  const result=captureLiveSettlementProof(original,decision.certificate);
  for(const extra of [NaN,Infinity,undefined,new Date(base)]){
    const changed:any=structuredClone(result.proof);changed.input.evidence.raw.extra=extra;
    expect(()=>decodeLiveSettlementProof(changed,result.digest)).toThrow('live_settlement_proof_invalid');
  }
  const changed:any=structuredClone(result.proof);changed.input.evidence.raw.extra='x'.repeat(16*1024*1024);
  expect(()=>decodeLiveSettlementProof(changed,result.digest)).toThrow('live_settlement_proof_invalid');
});

it('retains a realistic full268-venue original account observation through JSONB field reordering',()=>{
  const original=input(),s=original.accountSource.snapshot;
  for(let i=1;i<=267;i++){
    const dex=i===1?'i<3fl':`venue${i}`;
    s.dexes.push({...s.dexes[0]!,dex,perpDexIndex:i,supported:false,equity:'0',rawUsd:'0',marginUsed:'0',withdrawable:'0',exposureUsd:'0',crossEquity:'0',crossMarginUsed:'0',crossExposureUsd:'0',crossMaintenanceMarginUsed:'0'});
    s.coverage.listedDexes.push(dex);s.coverage.observedOrderDexes.push(dex);
  }
  const decision=assessLiveReservationSettlement(original);if(decision.kind!=='release')throw Error();
  const result=captureLiveSettlementProof(original,decision.certificate);
  const persisted:any=JSON.parse(JSON.stringify(result.proof));persisted.input.accountSource={snapshot:persisted.input.accountSource.snapshot,...persisted.input.accountSource};
  expect(decodeLiveSettlementProof(persisted,result.digest).input.accountSource.snapshot.dexes).toHaveLength(268);
});
