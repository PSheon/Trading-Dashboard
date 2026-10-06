import { isHyperliquidNetwork, type HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import type { copyLiveExecutions, copyLiveIntentProvenance, copyLiveSignalLegs, copyLiveSourceFills, copyLiveRiskReservations,
  copyLiveExecutionEvidence, copyFollowerReceipts, copyFollowerLedger, copyFollowerScans, copyFollowerReceiptConflicts,
  copyFollowerAccountState, copyLiveReductionCarry } from '@trading-dashboard/shared/database';
import { decodeLivePositionBaseline, type LivePositionBaseline } from './live-position-baseline.js';
import type { LiveAccountSnapshot } from './live-account-observer.js';
import { isDeepStrictEqual } from 'node:util';
import { Dec } from '../../common/decimal/dec.js';
import { followerSign } from '../copy-math.js';
import { mapLiveAccountView } from './live-account-view.js';
import { parseFollowerFill, parseFollowerFunding, followerReceiptDigestV1 } from './actual-fill-accounting.js';
import { canonicalLiveSourceLegs, decodeLiveSourceFill, liveSourceDigest, liveSourceLegId } from './copy-live-source-evidence.js';
import { captureLiveOrderIdentity } from './live-order-evidence.js';
import { buildOrderAction, executionKey, intentFingerprint, type LiveOrderIntent } from './live-order.js';
import { NEVER_PLACED, type LiveExecutionRecord } from './live-execution.js';
import { decodeLiveSettlementProof } from './live-settlement-proof.js';
import { decodeLiveUnattemptedRelease,assertLiveUnattemptedReleaseMirrors } from './live-unattempted-release.js';
import { freezeLiveReservation, validateLiveReservationPayload, type LiveReservationStored } from './live-risk-reservation.js';
import { address, LiveBoundaryError } from './wallet-authorization.js';
export interface LiveGenerationProjectionIdentity {
  readonly mandateId: string; readonly mandateRevision: number; readonly accountId: string; readonly userId: number;
  readonly strategyId: number; readonly network: HyperliquidNetwork; readonly accountAddress: string;
  readonly authorizationId: string; readonly settingsDigest: string; readonly leaderAddress: string;
  readonly direction: 'same' | 'reverse';
}
export interface LiveGenerationProjection {
  readonly mandateId: string; readonly baselineDigest: string; readonly receiptManifestDigest: string;
  readonly positionsDigest: string; readonly positions: Readonly<Record<string, string>>; readonly checkedAt: number;
}
export interface LiveGenerationProjectionInput {
  readonly identity: LiveGenerationProjectionIdentity; readonly manifest: unknown; readonly snapshot: LiveAccountSnapshot;
  readonly currentExecutionKey: string; readonly now: number;
  /** Supplied only after the same original-session private hold reader verifies
   * its lineage. Serialized caller values are never admission authority. */
  readonly ownSubmittingReservation?: LiveReservationStored;
}

/** SQL rows are canonically JSON-encoded before storing the provenance envelope. */
export type LiveGenerationSqlRow<T> = { readonly [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };
export type LiveGenerationProvenanceV1 = Omit<LiveGenerationSqlRow<typeof copyLiveIntentProvenance.$inferSelect>, 'sizingBasis'> & {
  readonly sizingBasisDigest: string;
  /** Original scoped SQL producer derives this only after decoding and replaying
   * the retained full sizing envelope. It is never an HTTP admission input. */
  readonly sizingCarryWitness?: Readonly<{amount:string;revision:number;updatedAt:string;admittedAt:string;sizingBasisDigest:string}>;
};
export interface LiveGenerationJournalV1 {
  readonly journal: LiveGenerationSqlRow<typeof copyLiveExecutions.$inferSelect>;
  readonly provenance: LiveGenerationProvenanceV1 | null;
  readonly leg: LiveGenerationSqlRow<typeof copyLiveSignalLegs.$inferSelect> | null;
  readonly fill: LiveGenerationSqlRow<typeof copyLiveSourceFills.$inferSelect> | null;
  readonly reservation: LiveGenerationSqlRow<typeof copyLiveRiskReservations.$inferSelect> | null;
  /** Root 0049 adds settlementProof/settlementProofDigest; no certificate-only fallback. */
  readonly evidence: (LiveGenerationSqlRow<typeof copyLiveExecutionEvidence.$inferSelect> & { readonly settlementProof?: unknown; readonly settlementProofDigest?: string | null }) | null;
}
export interface LiveGenerationManifestV1 {
  readonly version: 1;
  readonly accountId: string;
  readonly mandateId: string;
  readonly checkedAt: number;
  readonly baseline: LivePositionBaseline;
  readonly journals: readonly LiveGenerationJournalV1[];
  readonly receipts: readonly LiveGenerationSqlRow<typeof copyFollowerReceipts.$inferSelect>[];
  readonly ledger: readonly LiveGenerationSqlRow<typeof copyFollowerLedger.$inferSelect>[];
  readonly scan: LiveGenerationSqlRow<typeof copyFollowerScans.$inferSelect> | null;
  readonly conflicts: readonly LiveGenerationSqlRow<typeof copyFollowerReceiptConflicts.$inferSelect>[];
  readonly accountState: LiveGenerationSqlRow<typeof copyFollowerAccountState.$inferSelect> | null;
  readonly carry: readonly LiveGenerationSqlRow<typeof copyLiveReductionCarry.$inferSelect>[];
  /** Order keys of the owner's single-position closes on this account. */
  readonly manualCloses?: readonly string[];
}

function requireGeneration(value: unknown): asserts value { if (!value) throw new LiveBoundaryError('live_generation_unproven'); }
function millis(value: unknown): number {
  requireGeneration(typeof value === 'string' && Number.isSafeInteger(Date.parse(value)) && new Date(value).toISOString() === value); return Date.parse(value);
}
function same(value: unknown, expected: unknown) { requireGeneration(isDeepStrictEqual(value, expected)); }
function keys(rows: readonly {key:string}[]) { requireGeneration(new Set(rows.map(row=>row.key)).size===rows.length); }

/** Complete SQL manifests come from the original scoped producer, never HTTP.
 * Every historical terminal certificate is reconstructed at its original time.
 * This quantity projection grants neither current risk nor authority to sign. */
export function projectLiveGenerationPositions(raw: LiveGenerationProjectionInput): LiveGenerationProjection {
  try {
    const input=structuredClone(raw),{identity:id,snapshot,currentExecutionKey,now}=input, manifest=input.manifest as LiveGenerationManifestV1;
    requireGeneration(isHyperliquidNetwork(id.network)&&address(id.accountAddress)===id.accountAddress&&address(id.leaderAddress)===id.leaderAddress&&['same','reverse'].includes(id.direction)&&
      Number.isSafeInteger(id.mandateRevision)&&id.mandateRevision>0&&Number.isSafeInteger(now)&&now>0&&manifest?.version===1&&manifest.accountId===id.accountId&&manifest.mandateId===id.mandateId&&
      Number.isSafeInteger(manifest.checkedAt)&&manifest.checkedAt<=now&&now-manifest.checkedAt<=5000&&
      [manifest.journals,manifest.receipts,manifest.ledger,manifest.conflicts,manifest.carry].every(Array.isArray)&&manifest.journals.length<=5001&&manifest.receipts.length<=10000&&manifest.ledger.length<=30000&&manifest.conflicts.length===0&&manifest.carry.length<=1024&&
      (!manifest.accountState||manifest.accountState.accountId===id.accountId&&!manifest.accountState.quarantined));
    const view=mapLiveAccountView(id,snapshot,{blocked:false,reason:null},now,5000);
    requireGeneration(view.freshness==='fresh'&&view.coverage.complete&&view.coverage.balanceComplete&&view.coverage.orderComplete);
    const baseline=decodeLivePositionBaseline({mandateId:id.mandateId,accountId:id.accountId,strategyId:id.strategyId,network:id.network,accountAddress:id.accountAddress,firstExecutionKey:manifest.baseline.firstExecutionKey},manifest.baseline);
    requireGeneration(baseline.createdAt<=manifest.checkedAt&&baseline.createdAt<=now);
    keys(manifest.receipts);keys(manifest.journals.map(entry=>entry.journal));
    requireGeneration(new Set(manifest.ledger.map(row=>`${row.receiptKey}:${row.component}`)).size===manifest.ledger.length);
    requireGeneration(new Set(manifest.carry.map(row=>row.coin)).size===manifest.carry.length&&manifest.carry.every(row=>row.mandateId===id.mandateId&&Number.isSafeInteger(row.revision)&&row.revision>0&&millis(row.updatedAt)<=manifest.checkedAt));
    const projected:Record<string,string>={},certified=new Map<string,{side:'B'|'A';reduceOnly:boolean;coin:string}>();
    let firstFound=false;
    for(const entry of manifest.journals){
      const {journal:j,provenance:p,leg,fill:fillRow,reservation:r,evidence:e}=entry,record=j.record as unknown as LiveExecutionRecord;
      if(manifest.manualCloses?.includes(j.key)){
        // The owner's close of one position: a reduce-only IOC by the approved
        // agent on this account, never a source leg. Its fills reduce.
        requireGeneration(j.network===id.network&&j.accountAddress===id.accountAddress&&j.userId===id.userId&&j.strategyId===id.strategyId&&record.key===j.key&&
          record.authorization.network===id.network&&record.authorization.accountAddress===id.accountAddress&&record.authorization.signerAddress===j.signerAddress&&
          record.market&&record.action.orders[0].r===true&&record.action.orders[0].t.limit.tif==='Ioc'&&!p&&!leg&&!r&&record.createdAt>=baseline.createdAt);
        for(const row of manifest.receipts.filter(row=>row.executionKey===j.key))certified.set(row.key,{side:record.action.orders[0].b?'B':'A',reduceOnly:true,coin:record.market!.coin});
        continue;
      }
      requireGeneration(j.network===id.network&&j.accountAddress===id.accountAddress&&j.userId===id.userId&&j.strategyId===id.strategyId&&
        record.key===j.key&&record.nonce===j.nonce&&record.state===j.state&&record.updatedAt===millis(j.updatedAt)&&record.authorization.id===id.authorizationId&&record.authorization.userId===id.userId&&
        record.authorization.strategyId===id.strategyId&&record.authorization.network===id.network&&record.authorization.accountAddress===id.accountAddress&&record.authorization.signerAddress===j.signerAddress&&
        record.createdAt>=baseline.createdAt&&p&&leg&&fillRow&&record.market);
      captureLiveOrderIdentity(record,record.market!);
      const intent=p!.intent as unknown as LiveOrderIntent,action=buildOrderAction(intent);
      requireGeneration(p!.key===j.key&&p!.mandateId===id.mandateId&&p!.mandateRevision>0&&p!.mandateRevision<=id.mandateRevision&&p!.settingsDigest===id.settingsDigest&&p!.plannerVersion===1&&
        /^[a-f0-9]{64}$/.test(p!.sizingBasisDigest)&&p!.fingerprint===record.fingerprint&&executionKey(intent)===j.key&&intent.authorizationId===id.authorizationId&&intent.userId===id.userId&&intent.strategyId===id.strategyId&&
        intent.network===id.network&&intent.accountAddress===id.accountAddress&&intentFingerprint(intent,action)===record.fingerprint&&millis(p!.admittedAt)>=baseline.createdAt);
      same(action,record.action);
      const fill=decodeLiveSourceFill({...fillRow!,providerTime:new Date(fillRow!.providerTime),receivedAt:new Date(fillRow!.receivedAt)}),canonical=canonicalLiveSourceLegs(fill).find(l=>l.leg===leg!.leg);
      requireGeneration(fill.leaderAddress===id.leaderAddress&&p!.sourceDigest===fill.sourceDigest&&canonical&&leg!.mandateId===id.mandateId&&leg!.id===liveSourceLegId(id.mandateId,fill.id,leg!.leg)&&
        p!.legId===leg!.id&&leg!.sourceFillId===fill.id&&leg!.executionKey===j.key&&leg!.sign===canonical.sign&&leg!.size===canonical.size&&leg!.fraction===canonical.fraction&&leg!.tradeKey===canonical.tradeKey&&
        intent.reduceOnly===(canonical.leg==='close')&&intent.side===(followerSign(canonical.sign,id.direction)*(canonical.leg==='close'?-1:1)>0?'B':'A')&&intent.market?.coin===fill.coin);
      if(r)requireGeneration(r.key===j.key&&r.accountId===id.accountId&&r.userId===id.userId&&r.strategyId===id.strategyId&&r.network===id.network&&r.accountAddress===id.accountAddress&&
        r.fingerprint===record.fingerprint&&r.authorizationId===id.authorizationId&&r.cloid===j.cloid);
      if(r){
        const payload=validateLiveReservationPayload(r.payload);
        for(const field of ['key','accountId','userId','strategyId','network','accountAddress','fingerprint','walletId','authorizationId','strategyVersion','policyVersion','authorizationVersion','notionalUsd','marginUsd','feeBufferUsd','sourceDigest'] as const)same(r[field],payload[field]);
        requireGeneration(payload.createdAt===millis(r.createdAt)&&payload.expiresAt===millis(r.expiresAt)&&r.coin===intent.market!.coin&&r.dex===intent.market!.dex&&r.asset===intent.asset&&
          payload.walletId===record.authorization.walletId&&payload.authorizationVersion===record.authorization.version);
        same(payload.intent,intent);same(payload.action,record.action);
      }
      if(j.key===baseline.firstExecutionKey)firstFound=true;
      const ownReceipts=manifest.receipts.filter(row=>row.executionKey===j.key);
      if(record.unattemptedRelease){
        requireGeneration(r&&j.state==='rejected'&&record.errorCode==='unattempted_expired'&&leg!.state==='skipped'&&r.state==='released'&&r.releaseReason==='unattempted_expired'&&r.releaseEvidenceDigest&&ownReceipts.length===0&&e===null);
        const certificate=decodeLiveUnattemptedRelease(record.unattemptedRelease,r!.releaseEvidenceDigest!),old=certificate.original.identity;
        for(const field of ['mandateId','accountId','userId','strategyId','network','accountAddress','authorizationId','settingsDigest','leaderAddress','direction'] as const)same(old[field],id[field]);
        requireGeneration(old.mandateRevision<=id.mandateRevision&&certificate.checkedAt<=manifest.checkedAt&&certificate.checkedAt<=now&&
          !manifest.receipts.some(row=>row.record.cloid===j.cloid||row.record.raw&&typeof row.record.raw==='object'&&'cloid' in row.record.raw&&row.record.raw.cloid===j.cloid));
        const witness=p!.sizingCarryWitness;
        requireGeneration(witness&&Object.keys(witness).sort().join(',')==='admittedAt,amount,revision,sizingBasisDigest,updatedAt'&&witness.sizingBasisDigest===p!.sizingBasisDigest&&witness.admittedAt===p!.admittedAt&&
          witness.revision===certificate.original.carry.revision&&witness.amount===certificate.original.carry.carry&&witness.updatedAt===certificate.original.carry.updatedAt);
        const carry=manifest.carry.find(row=>row.coin===fill.coin);requireGeneration(carry);assertLiveUnattemptedReleaseMirrors(certificate,entry,carry!);
        continue;
      }
      if(record.errorCode===NEVER_PLACED){
        // An attempted order the exchange never placed: no fill, no carry
        // change, its liability released as expired_unplaced, its leg skipped.
        requireGeneration(r&&j.state==='rejected'&&r.state==='released'&&r.releaseReason==='expired_unplaced'&&r.exchangeOrderId===null&&r.releaseEvidenceDigest&&
          leg!.state==='skipped'&&ownReceipts.length===0&&(!e||e.exchangeOrderId===null&&!e.settlementCertificate));
        continue;
      }
      if(j.key===currentExecutionKey&&['prepared','submitting'].includes(j.state)){
        requireGeneration(leg!.state==='prepared'&&ownReceipts.length===0&&(!e||!e.exchangeOrderId&&!e.acknowledgement&&!e.statusObservation&&!e.settlementCertificate)&&
          (!r||r.state==='held'&&r.attemptedAt===null&&r.exchangeOrderId===null&&r.releaseEvidenceDigest===null));
        if(j.state==='submitting'){
          const held=input.ownSubmittingReservation;requireGeneration(held&&r&&held.state==='held'&&held.attemptedAt===null&&held.exchangeOrderId===null&&held.releaseEvidenceDigest===null&&held.revision===r.revision&&held.updatedAt===millis(r.updatedAt));
          same(held.payload,r.payload);requireGeneration(held!.payload.key===j.key&&held!.payload.fingerprint===record.fingerprint);
        }
        continue;
      }
      requireGeneration(r&&e&&r.state==='released'&&r.attemptedAt&&leg!.state==='settled'&&['filled','partial','cancelled','rejected'].includes(j.state)&&e.settlementProof&&e.settlementProofDigest);
      const proof=decodeLiveSettlementProof(e!.settlementProof,e!.settlementProofDigest!),cert=proof.certificate,past=proof.input;
      requireGeneration(cert.key===j.key&&cert.accountId===id.accountId&&cert.fingerprint===record.fingerprint&&cert.nonce===record.nonce&&cert.digest===e!.settlementDigest&&cert.digest===r!.releaseEvidenceDigest&&
        r!.revision===past.reservation.revision+1&&millis(r!.attemptedAt!)===past.reservation.attemptedAt&&cert.oid===r!.exchangeOrderId&&cert.oid===e!.exchangeOrderId&&past.accountId===id.accountId&&
        e!.accountId===id.accountId&&e!.userId===id.userId&&e!.strategyId===id.strategyId&&e!.network===id.network&&e!.accountAddress===id.accountAddress&&e!.fingerprint===record.fingerprint&&e!.nonce===record.nonce&&e!.cloid===j.cloid);
      same(e!.settlementCertificate,cert);same(e!.statusObservation,past.evidence);same(e!.statusDigest,past.evidence.sourceDigest);same(e!.acknowledgement,past.acknowledgement);same(e!.acknowledgementDigest,past.acknowledgement?.responseDigest??null);
      for(const field of ['key','fingerprint','authorization','action','market','nonce','expiresAfter','createdAt'] as const)same(record[field],past.record[field]);
      same(r!.payload,past.reservation.payload);
      same(ownReceipts.map(row=>({key:row.key,digest:row.digest})).sort((a,b)=>a.key.localeCompare(b.key)),cert.receipts.map(row=>({...row})).sort((a,b)=>a.key.localeCompare(b.key)));
      for(const old of past.receipts.rows){
        const row=ownReceipts.find(row=>row.key===old.key);requireGeneration(row);
        for(const field of ['key','accountId','network','accountAddress','kind','sourceId','coin','digest','executionKey','attribution','record'] as const)same(row[field],old[field]);
        same(millis(row.providerTime),old.providerTime);
        same(manifest.ledger.filter(l=>l.receiptKey===row.key).map(({receiptKey,component,token,amount})=>({receiptKey,component,token,amount})).sort((a,b)=>a.component.localeCompare(b.component)),
          old.ledger.map(l=>({...l})).sort((a,b)=>a.component.localeCompare(b.component)));
        certified.set(row.key,{side:intent.side,reduceOnly:intent.reduceOnly,coin:fill.coin});
      }
    }
    requireGeneration(firstFound||baseline.firstExecutionKey===currentExecutionKey&&manifest.journals.length===0&&manifest.receipts.length===0&&manifest.ledger.length===0);
    if(manifest.receipts.length)requireGeneration(manifest.scan&&manifest.scan.accountId===id.accountId&&manifest.scan.issue===null&&manifest.scan.through!==null&&manifest.scan.through>=Math.max(...manifest.receipts.map(row=>millis(row.providerTime))));
    if(manifest.receipts.length){const latest=Math.max(...manifest.receipts.map(row=>millis(row.providerTime)));requireGeneration(snapshot.coverage.earliestProviderTime>=latest&&snapshot.completedAt>=latest);}
    for(const row of [...manifest.receipts].sort((a,b)=>millis(a.providerTime)-millis(b.providerTime)||a.key.localeCompare(b.key))){
      requireGeneration(row.accountId===id.accountId&&row.network===id.network&&row.accountAddress===id.accountAddress&&millis(row.providerTime)>=baseline.createdAt&&row.digest===followerReceiptDigestV1(row.record.raw));
      const context={network:id.network,accountAddress:id.accountAddress,coin:row.coin},parsed=row.kind==='fill'?parseFollowerFill(row.record.raw,context):parseFollowerFunding(row.record.raw,context);
      requireGeneration(parsed.key===row.key&&parsed.time===millis(row.providerTime));
      for(const [field,value]of Object.entries(parsed))same(row.record[field],value);
      if(row.kind==='funding'){
        requireGeneration(row.attribution==='account'&&row.executionKey===null&&'hash'in parsed&&row.sourceId===parsed.hash);
        same(manifest.ledger.filter(l=>l.receiptKey===row.key).map(({receiptKey,component,token,amount})=>({receiptKey,component,token,amount})),Dec.from(parsed.cashDelta).isZero?[]:[{receiptKey:row.key,component:'funding',token:'USDC',amount:parsed.cashDelta}]);
        continue;
      }
      const cert=certified.get(row.key),fill=parsed as ReturnType<typeof parseFollowerFill>;requireGeneration(cert&&row.attribution==='execution'&&cert.coin===fill.coin&&cert.side===fill.side&&row.sourceId===fill.tid);
      const before=Dec.from(projected[fill.coin]??'0'),delta=Dec.from(fill.size).mul(fill.side==='B'?1:-1);
      if(cert.reduceOnly)requireGeneration(!before.isZero&&before.sign!==delta.sign&&delta.abs().lte(before.abs()));
      const after=before.add(delta);if(after.isZero)delete projected[fill.coin];else projected[fill.coin]=after.toString();
    }
    requireGeneration(manifest.ledger.every(row=>manifest.receipts.some(receipt=>receipt.key===row.receiptKey)));
    const actual=Object.fromEntries(snapshot.positions.filter(p=>!Dec.from(p.size).isZero).map(p=>[p.coin,Dec.from(p.size).toString()]));
    requireGeneration(Object.keys(actual).length===snapshot.positions.filter(p=>!Dec.from(p.size).isZero).length);same(projected,actual);
    return freezeLiveReservation({mandateId:id.mandateId,baselineDigest:baseline.baselineDigest,receiptManifestDigest:liveSourceDigest({receipts:manifest.receipts,ledger:manifest.ledger}),
      positionsDigest:liveSourceDigest(projected),positions:projected,checkedAt:manifest.checkedAt});
  }catch{throw new LiveBoundaryError('live_generation_unproven');}
}
