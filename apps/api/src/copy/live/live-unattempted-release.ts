import {isDeepStrictEqual} from 'node:util';
import type {copyLiveReductionCarry} from '@trading-dashboard/shared/database';
import type {LiveGenerationJournalV1,LiveGenerationProjectionIdentity,LiveGenerationSqlRow} from './copy-live-generation-projection.js';
import type {LiveExecutionRecord} from './live-execution.js';
import {buildOrderAction,executionKey,intentFingerprint,type LiveOrderIntent} from './live-order.js';
import {captureLiveOrderIdentity} from './live-order-evidence.js';
import {canonicalLiveSourceLegs,decodeLiveSourceFill,liveSourceDigest,liveSourceLegId} from './copy-live-source-evidence.js';
import {validateLiveReservationPayload,freezeLiveReservation} from './live-risk-reservation.js';
import {Dec} from '../../common/decimal/dec.js';
import {followerSign} from '../copy-math.js';
import {LiveBoundaryError,address} from './wallet-authorization.js';
export type LiveUnattemptedCarry=LiveGenerationSqlRow<typeof copyLiveReductionCarry.$inferSelect>;
export interface LiveUnattemptedReleaseInput {
 readonly checkedAt:number;
 readonly original:Readonly<LiveGenerationJournalV1 & {identity:LiveGenerationProjectionIdentity;carry:LiveUnattemptedCarry}>;
}
/** Local expiry certificate only. This is not an exchange terminal status,
 * financial receipt, risk permit or authority to submit a replacement order. */
export interface LiveUnattemptedReleaseCertificate extends LiveUnattemptedReleaseInput {
 readonly version:1;readonly kind:'unattempted_expired';readonly digest:string;
}
const fail=():never=>{throw new LiveBoundaryError('live_unattempted_release_unproven');};
function check(value:unknown):asserts value{if(!value)fail();}
function same(a:unknown,b:unknown){check(isDeepStrictEqual(a,b));}
function time(v:unknown):number{check(typeof v==='string'&&Number.isSafeInteger(Date.parse(v))&&new Date(v).toISOString()===v);return Date.parse(v);}
function json(v:unknown,depth=0):void{
 check(depth<=16);if(v===null||typeof v==='string'||typeof v==='boolean')return;
 if(typeof v==='number'){check(Number.isFinite(v));return;}
 check(v&&typeof v==='object'&&(Array.isArray(v)||Object.getPrototypeOf(v)===Object.prototype)&&Object.getOwnPropertySymbols(v).length===0);
 check(Object.keys(v).length===Object.getOwnPropertyNames(v).length-(Array.isArray(v)?1:0));
 if(Array.isArray(v))check(Object.keys(v).length===v.length);
 for(const key of Object.keys(v)){const d=Object.getOwnPropertyDescriptor(v,key)!;check(Object.hasOwn(d,'value'));json(d.value,depth+1);}
}
function validate(raw:LiveUnattemptedReleaseInput):LiveUnattemptedReleaseInput{
 json(raw);check(Buffer.byteLength(JSON.stringify(raw),'utf8')<=128*1024);const input=structuredClone(raw),{checkedAt,original:entry}=input,{identity:id,carry}=entry;
 check(Object.keys(input).sort().join(',')==='checkedAt,original'&&Object.keys(input.original).sort().join(',')==='carry,evidence,fill,identity,journal,leg,provenance,reservation');
 const {journal:j,provenance:p,leg,fill:row,reservation:r,evidence:e}=entry,record=j.record as unknown as LiveExecutionRecord;
 check(Object.keys(record).every(key=>['key','fingerprint','authorization','action','market','nonce','expiresAfter','state','createdAt','updatedAt','errorCode'].includes(key)));
 check(Number.isSafeInteger(checkedAt)&&checkedAt>0&&id.network==='testnet'&&address(id.accountAddress)===id.accountAddress&&address(id.leaderAddress)===id.leaderAddress&&
  Number.isSafeInteger(id.userId)&&id.userId>0&&Number.isSafeInteger(id.strategyId)&&id.strategyId>0&&Number.isSafeInteger(id.mandateRevision)&&id.mandateRevision>0&&['same','reverse'].includes(id.direction));
 check(j.network===id.network&&j.accountAddress===id.accountAddress&&j.userId===id.userId&&j.strategyId===id.strategyId&&j.state==='prepared'&&record.state==='prepared'&&
  record.key===j.key&&record.nonce===j.nonce&&record.updatedAt===time(j.updatedAt)&&Number.isSafeInteger(record.createdAt)&&record.createdAt>0&&record.updatedAt===record.createdAt&&
  Number.isSafeInteger(record.nonce)&&record.nonce>=record.createdAt&&record.nonce<=record.createdAt+86400000&&Number.isSafeInteger(record.expiresAfter)&&record.expiresAfter>record.createdAt&&record.expiresAfter<=record.createdAt+60000&&checkedAt>record.expiresAfter&&
  !Object.hasOwn(record,'outcome')&&!Object.hasOwn(record,'unattemptedRelease')&&record.market&&record.authorization.id===id.authorizationId&&record.authorization.userId===id.userId&&record.authorization.strategyId===id.strategyId&&
  record.authorization.network===id.network&&record.authorization.accountAddress===id.accountAddress&&record.authorization.signerAddress===j.signerAddress&&p&&leg&&row&&r&&e===null);
 captureLiveOrderIdentity(record,record.market!);
 const intent=p!.intent as unknown as LiveOrderIntent,action=buildOrderAction(intent);
 check(p!.key===j.key&&p!.mandateId===id.mandateId&&p!.mandateRevision===id.mandateRevision&&p!.settingsDigest===id.settingsDigest&&p!.plannerVersion===1&&/^[a-f0-9]{64}$/.test(p!.sizingBasisDigest)&&
  p!.fingerprint===record.fingerprint&&time(p!.admittedAt)===record.createdAt&&executionKey(intent)===j.key&&intentFingerprint(intent,action)===record.fingerprint&&intent.userId===id.userId&&intent.strategyId===id.strategyId&&
  intent.network===id.network&&intent.accountAddress===id.accountAddress&&intent.authorizationId===id.authorizationId&&intent.walletId===record.authorization.walletId&&intent.cloid===j.cloid);
 same(action,record.action);same(intent.market,record.market);
 const fill=decodeLiveSourceFill({...row!,providerTime:new Date(row!.providerTime),receivedAt:new Date(row!.receivedAt)}),canonical=canonicalLiveSourceLegs(fill).find(l=>l.leg===leg!.leg);
 check(canonical&&fill.network===id.network&&fill.leaderAddress===id.leaderAddress&&p!.sourceDigest===fill.sourceDigest&&leg!.mandateId===id.mandateId&&leg!.id===liveSourceLegId(id.mandateId,fill.id,leg!.leg)&&p!.legId===leg!.id&&
  leg!.sourceFillId===fill.id&&leg!.executionKey===j.key&&leg!.state==='prepared'&&Number.isSafeInteger(leg!.revision)&&leg!.revision>0&&time(leg!.createdAt)<=time(leg!.updatedAt)&&time(leg!.updatedAt)<=checkedAt&&
  leg!.sign===canonical.sign&&leg!.size===canonical.size&&leg!.fraction===canonical.fraction&&leg!.tradeKey===canonical.tradeKey&&intent.market?.coin===fill.coin&&intent.reduceOnly===(canonical.leg==='close')&&
  intent.side===(followerSign(canonical.sign,id.direction)*(canonical.leg==='close'?-1:1)>0?'B':'A'));
 const payload=validateLiveReservationPayload(r!.payload);
 for(const field of ['key','accountId','userId','strategyId','network','accountAddress','fingerprint','walletId','authorizationId','strategyVersion','policyVersion','authorizationVersion','notionalUsd','marginUsd','feeBufferUsd','sourceDigest'] as const)same(r![field],payload[field]);
 check(r!.accountId===id.accountId&&r!.state==='held'&&r!.attemptedAt===null&&r!.exchangeOrderId===null&&r!.releaseReason===null&&r!.releaseEvidenceDigest===null&&Number.isSafeInteger(r!.revision)&&r!.revision>0&&
  r!.cloid===j.cloid&&r!.coin===fill.coin&&r!.dex===intent.market!.dex&&r!.asset===intent.asset&&payload.createdAt===time(r!.createdAt)&&payload.createdAt>=record.createdAt&&payload.expiresAt===record.expiresAfter&&time(r!.expiresAt)===record.expiresAfter&&
  time(r!.updatedAt)>=payload.createdAt&&time(r!.updatedAt)<=checkedAt&&payload.walletId===record.authorization.walletId&&payload.authorizationVersion===record.authorization.version);
 same(payload.intent,intent);same(payload.action,record.action);
 check(carry.mandateId===id.mandateId&&carry.coin===fill.coin&&Number.isSafeInteger(carry.revision)&&carry.revision>0&&Dec.from(carry.carry).gte(0)&&Dec.from(carry.carry).toString()===carry.carry&&time(carry.updatedAt)<=checkedAt);
 return input;
}
export function captureLiveUnattemptedRelease(raw:LiveUnattemptedReleaseInput):Readonly<LiveUnattemptedReleaseCertificate>{
 try{const input=validate(raw),proof={version:1 as const,kind:'unattempted_expired' as const,...input};return freezeLiveReservation({...proof,digest:liveSourceDigest(proof)});}catch{return fail();}
}
export function decodeLiveUnattemptedRelease(raw:unknown,claimedDigest:string):Readonly<LiveUnattemptedReleaseCertificate>{
 try{json(raw);check(Buffer.byteLength(JSON.stringify(raw),'utf8')<=128*1024);const c=structuredClone(raw) as LiveUnattemptedReleaseCertificate;check(Object.keys(c).sort().join(',')==='checkedAt,digest,kind,original,version'&&c.version===1&&c.kind==='unattempted_expired');
  const replay=captureLiveUnattemptedRelease({checkedAt:c.checkedAt,original:c.original});same(c,replay);same(c.digest,claimedDigest);return replay;
 }catch{return fail();}
}
/** Exact SQL mirrors make an independently recomputed local zero-effect
 * certificate usable in a generation projection. Carry is never rewound. */
export function assertLiveUnattemptedReleaseMirrors(c:LiveUnattemptedReleaseCertificate,entry:LiveGenerationJournalV1,carry:LiveUnattemptedCarry):void{
 const old=c.original,at=new Date(c.checkedAt).toISOString(),record=old.journal.record as unknown as LiveExecutionRecord;
 same(entry.journal,{...old.journal,state:'rejected',updatedAt:at,record:{...record,state:'rejected',updatedAt:c.checkedAt,errorCode:'unattempted_expired',unattemptedRelease:c}});
 // The SQL producer's optional compact witness is separately checked against
 // the retained envelope before projection; it is not part of the saved proof.
 const {sizingCarryWitness:_witness,...provenance}=entry.provenance!;
 same(provenance,old.provenance);same(entry.fill,old.fill);same(entry.evidence,null);
 same(entry.leg,{...old.leg,state:'skipped',revision:old.leg!.revision+1,updatedAt:at});
 same(entry.reservation,{...old.reservation,state:'released',releaseReason:'unattempted_expired',releaseEvidenceDigest:c.digest,revision:old.reservation!.revision+1,updatedAt:at});
 check(carry&&carry.mandateId===c.original.carry.mandateId&&carry.coin===c.original.carry.coin&&carry.revision>=c.original.carry.revision&&time(carry.updatedAt)>=time(c.original.carry.updatedAt));
 if(carry.revision===c.original.carry.revision)same(carry,c.original.carry);
}
