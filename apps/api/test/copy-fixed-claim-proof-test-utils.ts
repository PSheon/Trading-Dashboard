import { liveSourceExecutionCloid } from '../src/copy/live/postgres-live-preparation.js';
import { type LiveCopyMandateIntent } from '@trading-dashboard/shared/contracts';
import { digest, type MandateRow } from '../src/copy/copy-live-mandate-evidence.js';
import { liveCopySettingsDigest } from '../src/copy/copy-live-mandate-consent.js';
import { fixture, reservation } from './copy-live-risk-test-utils.js';
import { Dec } from '../src/common/decimal/dec.js';
import { buildOrderAction } from '../src/copy/live/live-order.js';
import { address } from '../src/copy/live/wallet-authorization.js';
import { captureLivePositionBaseline } from '../src/copy/live/live-position-baseline.js';
import { parseLiveOrderEvidence } from '../src/copy/live/live-order-evidence.js';
import { parseFollowerFill, followerReceiptDigestV1 } from '../src/copy/live/actual-fill-accounting.js';
import { parseLiveSourceFill, liveSourceDigest, liveSourceLegId, canonicalLiveSourceLegs } from '../src/copy/live/copy-live-source-evidence.js';
import { planLiveReservation } from '../src/copy/live/live-risk-reservation.js';
import { assessLiveReservationSettlement } from '../src/copy/live/live-reservation-settlement.js';
import { captureLiveSettlementProof } from '../src/copy/live/live-settlement-proof.js';
export function settledGenerationExample(size='1',twapId?:number) {
  const f=fixture(),base=f.now,now=base+100,iso=(t:number)=>new Date(t).toISOString();
  f.intent.size=size; f.intent.cloid=liveSourceExecutionCloid('mandate', parseLiveSourceFill({...(twapId===undefined?{}:{twapId}),tid:1,oid:7,time:base-1,coin:'BTC',side:'B',px:'100',sz:'1',startPosition:'0'},{network:'testnet',leaderAddress:`0x${'44'.repeat(20)}`,from:base-1,to:base-1,receivedAt:base,kind:'fills'}).id,'open');Object.assign(f,{action:buildOrderAction(f.intent),reservations:{...f.reservations,own:reservation(f.intent)}});
  const identity={mandateId:'mandate',mandateRevision:2,accountId:'account',userId:1,strategyId:9,network:'testnet' as const,accountAddress:f.identity.accountAddress,
    authorizationId:'grant',settingsDigest:'b'.repeat(64),leaderAddress:`0x${'44'.repeat(20)}`,direction:'same' as const};
  const record={key:f.reservations.own.key,fingerprint:f.reservations.own.fingerprint,nonce:base,authorization:{id:'grant',version:4,userId:1,strategyId:9,walletId:'agent',privyOwnerId:'quorum:agent-owner',
    accountAddress:address(f.identity.accountAddress),signerAddress:`0x${'33'.repeat(20)}` as `0x${string}`,network:'testnet' as const,scopes:['copy:trade' as const],validFrom:base-1,expiresAt:base+60000,revokedAt:null,exchangeApprovedAt:base-1},
    action:f.action,market:f.market,state:'unknown' as const,expiresAfter:base+60000,createdAt:base,updatedAt:base};
  const baseline=captureLivePositionBaseline({mandateId:'mandate',accountId:'account',strategyId:9,firstExecutionKey:record.key,network:'testnet',accountAddress:f.identity.accountAddress},f.accountSource.snapshot,base);
  const evidence=parseLiveOrderEvidence({record,market:f.market,raw:{status:'order',order:{status:'filled',statusTimestamp:base+10,order:{coin:'BTC',oid:10,cloid:f.intent.cloid,side:'B',reduceOnly:false,tif:'Gtc',origSz:size,sz:'0',limitPx:'100',timestamp:base,isTrigger:false,isPositionTpsl:false,children:[]}}},checkedAt:base+20,completedAt:base+25,now});
  const payload=planLiveReservation({now:base,identity:f.identity,localSource:f.localSource,intent:f.intent,action:f.action,market:f.market,quote:f.quote,leverage:f.leverageProofs[0]!,fees:f.fees,policy:f.policy,expiresAt:base+60000});
  const raw={cloid:f.intent.cloid,coin:'BTC',oid:10,tid:123,side:'B',time:base+5,sz:size,px:'100',feeToken:'USDC',fee:'0.1',builderFee:'0.02',closedPnl:'0'},fill=parseFollowerFill(raw,{network:'testnet',accountAddress:f.identity.accountAddress});
  const ledger=[{receiptKey:fill.key,component:'exchange_fee',amount:'-0.08',token:'USDC'},{receiptKey:fill.key,component:'builder_fee',amount:'-0.02',token:'USDC'}];
  const receipt={key:fill.key,accountId:'account',network:'testnet' as const,accountAddress:f.identity.accountAddress,kind:'fill' as const,sourceId:fill.tid,coin:fill.coin,providerTime:fill.time,digest:followerReceiptDigestV1(raw),record:{...fill,raw},executionKey:record.key,attribution:'execution' as const,ledger};
  const source=structuredClone(f.accountSource);Object.assign(source,{checkedAt:base+60});Object.assign(source.snapshot,{observedAt:base+30,completedAt:base+50});Object.assign(source.snapshot.coverage,{earliestProviderTime:base+40});Object.assign(source.snapshot.dexes[0]!,{providerTime:base+40});
  const proofInput={now,accountId:'account',record,reservation:{payload,state:'unknown' as const,revision:2,attemptedAt:base,exchangeOrderId:null,releaseEvidenceDigest:null,updatedAt:base},evidence,acknowledgement:null,accountSource:source,receipts:{accountId:'account',checkedAt:base+70,completeForOrder:true as const,rows:[receipt]}};
  const decision=assessLiveReservationSettlement(proofInput);if(decision.kind!=='release')throw Error(`invalid settled fixture ${decision.reason}`);
  const certificate=decision.certificate,proof=captureLiveSettlementProof(proofInput,certificate);
  const leaderFill=parseLiveSourceFill({...(twapId===undefined?{}:{twapId}),tid:1,oid:7,time:base-1,coin:'BTC',side:'B',px:'100',sz:'1',startPosition:'0'},{network:'testnet',leaderAddress:identity.leaderAddress,from:base-1,to:base-1,receivedAt:base,kind:'fills'}),legId=liveSourceLegId('mandate',leaderFill.id,'open');
  const notional=Dec.from(size).mul(100).toString(),margin=Dec.from(size).mul(10).toString(),current=structuredClone(f.accountSource.snapshot);Object.assign(current,{observedAt:base+30,completedAt:base+50,totalMarginUsed:margin,exposureUsd:notional,withdrawable:'90'});Object.assign(current.coverage,{earliestProviderTime:base+40});Object.assign(current.dexes[0]!,{providerTime:base+40,marginUsed:margin,exposureUsd:notional,withdrawable:'90',crossMarginUsed:margin,crossExposureUsd:notional});
  (current.positions as unknown[]).push({coin:'BTC',dex:'',asset:0,sizeDecimals:2,size,entryPrice:'100',positionValue:notional,unrealizedPnl:'0',marginUsed:margin,leverage:10,leverageType:'cross',maxLeverage:20,fundingSinceOpen:'0',fundingSinceChange:'0'});
  const entry={journal:{key:record.key,network:'testnet',accountAddress:identity.accountAddress,signerAddress:record.authorization.signerAddress,cloid:f.intent.cloid,nonce:base,userId:1,strategyId:9,state:'filled',record:{...record,state:'filled',updatedAt:now},updatedAt:iso(now)},
    provenance:{key:record.key,legId,mandateId:'mandate',mandateRevision:2,sourceDigest:leaderFill.sourceDigest,settingsDigest:identity.settingsDigest,plannerVersion:1,intent:f.intent,fingerprint:record.fingerprint,sizingBasisDigest:liveSourceDigest({historical:'original'}),admittedAt:iso(base)},
    leg:{id:legId,mandateId:'mandate',sourceFillId:leaderFill.id,leg:'open',tradeKey:leaderFill.tradeKey,fixedTradeClaim:false,sign:1,size:'1',fraction:null,dependsOnId:null,executionKey:record.key,state:'settled',revision:3,createdAt:iso(base),updatedAt:iso(now)},
    fill:{...leaderFill,providerTime:iso(leaderFill.providerTime),receivedAt:iso(leaderFill.receivedAt)},
    reservation:{...payload,cloid:f.intent.cloid,coin:'BTC',dex:'',asset:0,payload,state:'released',revision:3,attemptedAt:iso(base),exchangeOrderId:'10',releaseEvidenceDigest:certificate.digest,createdAt:iso(base),expiresAt:iso(base+60000),updatedAt:iso(now)},
    evidence:{key:record.key,accountId:'account',userId:1,strategyId:9,network:'testnet',accountAddress:identity.accountAddress,cloid:f.intent.cloid,fingerprint:record.fingerprint,nonce:base,revision:2,exchangeOrderId:'10',acknowledgement:null,acknowledgementDigest:null,statusObservation:evidence,statusDigest:evidence.sourceDigest,settlementCertificate:certificate,settlementDigest:certificate.digest,settlementProof:proof.proof,settlementProofDigest:proof.digest,createdAt:iso(base),updatedAt:iso(now)}};
  return {identity,snapshot:current,currentExecutionKey:record.key.replace('abab','cdcd'),now,manifest:{version:1,accountId:'account',mandateId:'mandate',checkedAt:now,baseline,journals:[entry],receipts:[{...receipt,providerTime:iso(fill.time),createdAt:iso(now)}],ledger:ledger.map(l=>({...l,createdAt:iso(now)})),carry:[{mandateId:'mandate',coin:'BTC',carry:'0',revision:1,updatedAt:iso(now)}],scan:{accountId:'account',through:base+5,issue:null},conflicts:[],accountState:null}};
}

export function sourceSizingExample(mode:'fixed'|'ratio'='fixed',direction:'same'|'reverse'='same') {
  const f=fixture(),now=f.now,settings={...f.strategy.settings,direction,copyStartMode:'delta' as const,sizingMode:mode,perTradeUsd:mode==='fixed'?10:null};
  const intent:LiveCopyMandateIntent={mandateId:'mandate',accountId:'account',userId:1,strategyId:9,strategyVersion:2,network:'testnet',sourceNetwork:'testnet',leaderAddress:`0x${'44'.repeat(20)}`,
    accountAddress:f.identity.accountAddress,accountRevision:1,ownerAddress:`0x${'11'.repeat(20)}`,ownerPrivyUserId:'did:owner',setupId:'setup',setupRevision:1,executionWalletId:'local-agent',agentWalletId:'agent',agentAddress:`0x${'33'.repeat(20)}`,
    authorizationId:'grant',authorizationVersion:4,policyId:'policy',policyFingerprint:'a'.repeat(64),workerQuorumId:'worker',settingsDigest:liveCopySettingsDigest(settings),budgetUsd:'100',builderAddress:null,builderMaxFeeTenthsOfBps:0,
    plannerVersion:1,nonce:now-60000,consentExpiresAt:now+240000,expiresAt:now+86400000};
  const mandate={...intent,id:intent.mandateId,idempotencyKey:'generation-operation-key',intent:{...intent},intentDigest:digest(intent),consentDigest:'b'.repeat(64),state:'active',revision:2,activationCursor:new Date(now-1000),
    consentExpiresAt:new Date(intent.consentExpiresAt),expiresAt:new Date(intent.expiresAt),createdAt:new Date(now-60000),updatedAt:new Date(now),consentKind:'mandate',liveSetupId:null} as MandateRow;
  return {mandate,settings,now};
}

export function example(twapId?:number){
 const generation=settledGenerationExample('1',twapId), sizing=sourceSizingExample('fixed'),m=sizing.mandate as any;
 sizing.settings.perTradeUsd=100;m.intent.settingsDigest=liveCopySettingsDigest(sizing.settings);m.settingsDigest=m.intent.settingsDigest;m.intentDigest=digest(m.intent);
 generation.identity.settingsDigest=m.settingsDigest;
 generation.manifest.journals[0].provenance!.settingsDigest=m.settingsDigest;
 const fill=parseLiveSourceFill({...(twapId===undefined?{}:{twapId}),tid:2,oid:twapId===undefined?7:8,time:sizing.now,coin:'BTC',side:'B',px:'100',sz:'0.5',startPosition:'1'},{network:'testnet',leaderAddress:m.leaderAddress,from:sizing.now,to:sizing.now,receivedAt:sizing.now,kind:'fills'});
 const original=generation.manifest.journals[0];original.leg!.fixedTradeClaim=true;(original.reservation as any).releaseReason='verified_settlement';
 const result=structuredClone({originalDispatch:{id:'original',mandateId:m.id,userId:m.userId,strategyId:m.strategyId,accountId:m.accountId,sourceFillId:original.fill!.id,coin:'BTC',leg:'open',state:'settled',executionKey:original.journal.key},mandate:m,settings:sizing.settings, candidate:{id:'duplicate',mandateId:m.id,userId:m.userId,strategyId:m.strategyId,accountId:m.accountId,sourceFillId:fill.id,coin:fill.coin,leaderTime:fill.providerTime,state:'refused',reason:'fixed_trade_already_claimed',leg:'open',executionKey:null},fill,generation,sdk:{network:m.network,accountAddress:m.accountAddress,fills:[structuredClone(original.evidence!.settlementProof!.input.receipts.rows[0].record.raw)]}});
 return {...result,authorizationBinding:binding(result)};
}

export function harnessInput(x=example()){
 const e=x.generation.manifest.journals[0],raw=e.fill!.raw as any;
 const original={...x.originalDispatch,tid:String(raw.tid),reason:'',executionState:'filled',cloid:e.journal.cloid,orderSize:'1',limitPx:'100',reduceOnly:false};
 const duplicate={...x.candidate,tid:x.fill.tid,cloid:'',executionState:'',limitPx:'',orderSize:''};
 return {leaderFills:[raw,x.fill.raw],dispatches:[original,duplicate],followerFills:x.sdk.fills,leaderPositions:new Map([['BTC',1.5]]),followerPositions:new Map([['BTC',1]]),followerLeverage:new Map([['BTC',10]]),szDecimals:new Map([['BTC',2]]),rules:{sizing:{perTradeUsd:100},maxLeverage:10},fixedClaimEvidence:new Map([[x.candidate.id,x]])};
}

export function binding(x:any){const c=x.mandate.intent;return{
 account:{id:c.accountId,userId:c.userId,strategyId:c.strategyId,network:c.network,address:c.accountAddress,privyUserId:c.ownerPrivyUserId,privyWalletId:'account-wallet',ownerQuorumId:'quorum:agent-owner'},
 setup:{id:c.setupId,revision:c.setupRevision,userId:c.userId,strategyId:c.strategyId,network:c.network,accountId:c.accountId,accountAddress:c.accountAddress,accountWalletId:'account-wallet',accountOwnerQuorumId:'quorum:agent-owner',agentWalletId:c.agentWalletId,agentAddress:c.agentAddress,agentOwnerQuorumId:'quorum:agent-owner',authorizationId:c.authorizationId,policyId:c.policyId,policyFingerprint:c.policyFingerprint,workerQuorumId:c.workerQuorumId},
 wallet:{id:c.executionWalletId,userId:c.userId,strategyId:c.strategyId,network:c.network,accountAddress:c.accountAddress,privyWalletId:c.agentWalletId,signerAddress:c.agentAddress,privyOwnerId:'quorum:agent-owner',retiredAt:'2026-10-09T00:00:00Z'}}}

import { decodeLiveCopyMandate } from '../src/copy/copy-live-mandate-evidence.js';
import { decodeLiveSourceFill } from '../src/copy/live/copy-live-source-evidence.js';
import { executionKey,intentFingerprint } from '../src/copy/live/live-order.js';
import { decodeLiveSettlementProof } from '../src/copy/live/live-settlement-proof.js';
import { createFixedClaimValidator } from '../../../scripts/copy-harness/fixed-claim-proof.mjs';
export const proofTools={decodeLiveCopyMandate,liveCopySettingsDigest,canonicalLiveSourceLegs,decodeLiveSourceFill,liveSourceLegId,liveSourceDigest,buildOrderAction,executionKey,intentFingerprint,decodeLiveSettlementProof,liveSourceExecutionCloid,parseFollowerFill,followerReceiptDigestV1};
export const validateFixedClaimRefusal=createFixedClaimValidator(proofTools);
