import { DEFAULT_COPY_RISK_LIMITS, type LiveCopyMandateIntent } from '@trading-dashboard/shared/contracts';
import { digest, type MandateRow } from '../src/copy/copy-live-mandate-evidence.js';
import { liveCopySettingsDigest } from '../src/copy/copy-live-mandate-consent.js';
import type { LiveSourcePlanInput } from '../src/copy/live/copy-live-source-planner.js';
import type { LiveSourceSizingEnvelopeV1 } from '../src/copy/live/copy-live-sizing-evidence.js';
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
import type { LiveGenerationProjectionInput } from '../src/copy/live/copy-live-generation-projection.js';
export function settledGenerationExample(size='1'):LiveGenerationProjectionInput {
  const f=fixture(),base=f.now,now=base+100,iso=(t:number)=>new Date(t).toISOString();
  f.intent.size=size;Object.assign(f,{action:buildOrderAction(f.intent),reservations:{...f.reservations,own:reservation(f.intent)}});
  const identity={mandateId:'mandate',mandateRevision:2,accountId:'account',userId:1,strategyId:9,network:'testnet' as const,accountAddress:f.identity.accountAddress,
    authorizationId:'grant',settingsDigest:'b'.repeat(64),leaderAddress:`0x${'44'.repeat(20)}`,direction:'same' as const};
  const record={key:f.reservations.own.key,fingerprint:f.reservations.own.fingerprint,nonce:base,authorization:{id:'grant',version:4,userId:1,strategyId:9,walletId:'agent',privyOwnerId:'owner',
    accountAddress:address(f.identity.accountAddress),signerAddress:`0x${'33'.repeat(20)}` as `0x${string}`,network:'testnet' as const,scopes:['copy:trade' as const],validFrom:base-1,expiresAt:base+60000,revokedAt:null,exchangeApprovedAt:base-1},
    action:f.action,market:f.market,state:'unknown' as const,expiresAfter:base+60000,createdAt:base,updatedAt:base};
  const baseline=captureLivePositionBaseline({mandateId:'mandate',accountId:'account',strategyId:9,firstExecutionKey:record.key,network:'testnet',accountAddress:f.identity.accountAddress},f.accountSource.snapshot,base);
  const evidence=parseLiveOrderEvidence({record,market:f.market,raw:{status:'order',order:{status:'filled',statusTimestamp:base+10,order:{coin:'BTC',oid:10,cloid:f.intent.cloid,side:'B',reduceOnly:false,tif:'Gtc',origSz:size,sz:'0',limitPx:'100',timestamp:base,isTrigger:false,isPositionTpsl:false,children:[]}}},checkedAt:base+20,completedAt:base+25,now});
  const payload=planLiveReservation({now:base,identity:f.identity,localSource:f.localSource,intent:f.intent,action:f.action,market:f.market,quote:f.quote,leverage:f.leverageProofs[0]!,fees:f.fees,policy:f.policy,expiresAt:base+60000});
  const raw={coin:'BTC',oid:10,tid:123,side:'B',time:base+5,sz:size,px:'100',feeToken:'USDC',fee:'0.1',builderFee:'0.02',closedPnl:'0'},fill=parseFollowerFill(raw,{network:'testnet',accountAddress:f.identity.accountAddress});
  const ledger=[{receiptKey:fill.key,component:'exchange_fee',amount:'-0.08',token:'USDC'},{receiptKey:fill.key,component:'builder_fee',amount:'-0.02',token:'USDC'}];
  const receipt={key:fill.key,accountId:'account',network:'testnet' as const,accountAddress:f.identity.accountAddress,kind:'fill' as const,sourceId:fill.tid,coin:fill.coin,providerTime:fill.time,digest:followerReceiptDigestV1(raw),record:{...fill,raw},executionKey:record.key,attribution:'execution' as const,ledger};
  const source=structuredClone(f.accountSource);Object.assign(source,{checkedAt:base+60});Object.assign(source.snapshot,{observedAt:base+30,completedAt:base+50});Object.assign(source.snapshot.coverage,{earliestProviderTime:base+40});Object.assign(source.snapshot.dexes[0]!,{providerTime:base+40});
  const proofInput={now,accountId:'account',record,reservation:{payload,state:'unknown' as const,revision:2,attemptedAt:base,exchangeOrderId:null,releaseEvidenceDigest:null,updatedAt:base},evidence,acknowledgement:null,accountSource:source,receipts:{accountId:'account',checkedAt:base+70,completeForOrder:true as const,rows:[receipt]}};
  const decision=assessLiveReservationSettlement(proofInput);if(decision.kind!=='release')throw Error(`invalid settled fixture ${decision.reason}`);
  const certificate=decision.certificate,proof=captureLiveSettlementProof(proofInput,certificate);
  const leaderFill=parseLiveSourceFill({tid:1,oid:7,time:base-1,coin:'BTC',side:'B',px:'100',sz:'1',startPosition:'0'},{network:'testnet',leaderAddress:identity.leaderAddress,from:base-1,to:base-1,receivedAt:base,kind:'fills'}),legId=liveSourceLegId('mandate',leaderFill.id,'open');
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

export function sourceSizingExample(mode:'fixed'|'ratio'='fixed',direction:'same'|'reverse'='same'):LiveSourcePlanInput {
  const f=fixture(),now=f.now,settings={...f.strategy.settings,direction,copyStartMode:'delta' as const,sizingMode:mode,perTradeUsd:mode==='fixed'?10:null};
  const intent:LiveCopyMandateIntent={mandateId:'mandate',accountId:'account',userId:1,strategyId:9,strategyVersion:2,network:'testnet',sourceNetwork:'testnet',leaderAddress:`0x${'44'.repeat(20)}`,
    accountAddress:f.identity.accountAddress,accountRevision:1,ownerAddress:`0x${'11'.repeat(20)}`,ownerPrivyUserId:'did:owner',setupId:'setup',setupRevision:1,executionWalletId:'local-agent',agentWalletId:'agent',agentAddress:`0x${'33'.repeat(20)}`,
    authorizationId:'grant',authorizationVersion:4,policyId:'policy',policyFingerprint:'a'.repeat(64),workerQuorumId:'worker',settingsDigest:liveCopySettingsDigest(settings),budgetUsd:'100',builderAddress:null,builderMaxFeeTenthsOfBps:0,
    plannerVersion:1,nonce:now-60000,consentExpiresAt:now+240000,expiresAt:now+86400000};
  const mandate={...intent,id:intent.mandateId,idempotencyKey:'generation-operation-key',intent:{...intent},intentDigest:digest(intent),consentDigest:'b'.repeat(64),state:'active',revision:2,activationCursor:new Date(now-1000),
    consentExpiresAt:new Date(intent.consentExpiresAt),expiresAt:new Date(intent.expiresAt),createdAt:new Date(now-60000),updatedAt:new Date(now),consentKind:'mandate',liveSetupId:null} as MandateRow;
  const fill=parseLiveSourceFill({tid:1,oid:7,time:now-500,coin:'BTC',side:'B',px:'100',sz:'1',startPosition:'0'}, {network:'testnet',leaderAddress:intent.leaderAddress,from:now-1000,to:now,receivedAt:now,kind:'fills'}),leg=canonicalLiveSourceLegs(fill)[0]!;
  const follower=f.accountSource.snapshot,leader=mode==='ratio'?structuredClone({...follower,accountAddress:intent.leaderAddress,perpEquity:'1000',withdrawable:'1000',dexes:follower.dexes.map(d=>({...d,equity:'1000',rawUsd:'1000',crossEquity:'1000',withdrawable:'1000'}))}):null;
  const key=f.reservations.own.key,baseline=captureLivePositionBaseline({mandateId:'mandate',accountId:'account',strategyId:9,firstExecutionKey:key,network:'testnet',accountAddress:follower.accountAddress},follower,now);
  const sizingBasis:LiveSourceSizingEnvelopeV1={version:1,basis:{version:1,mandateId:'mandate',mandateRevision:2,settingsDigest:intent.settingsDigest,sourceFillId:fill.id,sourceDigest:fill.sourceDigest,network:'testnet',accountAddress:follower.accountAddress,
    coin:'BTC',leg:'open',direction,sizingMode:mode,budgetUsd:'100',perTradeUsd:mode==='fixed'?'10':null,market:f.market,quote:{midPrice:'100',slippageBps:'50',observedAt:now,completedAt:now,sourceDigest:f.quote.sourceDigest},
    follower:{network:'testnet',accountAddress:follower.accountAddress,equity:follower.perpEquity,positionSize:'0',observedAt:now,completedAt:now,sourceDigest:follower.sourceDigest,snapshotDigest:followerReceiptDigestV1(follower),positionsDigest:liveSourceDigest({})},
    leader:leader?{network:'testnet',accountAddress:leader.accountAddress,equity:leader.perpEquity,observedAt:now,completedAt:now,sourceDigest:leader.sourceDigest,snapshotDigest:followerReceiptDigestV1(leader)}:null,
    generation:{mandateId:'mandate',baselineDigest:baseline.baselineDigest,receiptManifestDigest:liveSourceDigest({receipts:[],ledger:[]}),positionsDigest:liveSourceDigest({}),positionSize:'0'},carry:{amount:'0',revision:1},fixedTradeClaim:mode==='fixed',settledDependency:null},
    observations:{follower,leader,quote:{network:'testnet',accountAddress:follower.accountAddress,coin:'BTC',dex:'',asset:0,market:f.market,earliestObservedAt:now,completedAt:now,sourceDigest:'a'.repeat(64),
      accountModeProof:{network:'testnet',accountAddress:follower.accountAddress,role:'user',accountAbstraction:'disabled',dexAbstraction:false,portfolioMargin:false,observedAt:now,completedAt:now,sourceDigest:'a'.repeat(64)},quote:f.quote,leverageProofs:f.leverageProofs,fees:{...f.fees,scope:'validator_perp',calculation:'documented_fee_formula'}},
      generationManifest:{version:1,accountId:'account',mandateId:'mandate',checkedAt:now,baseline,journals:[],receipts:[],ledger:[],scan:null,conflicts:[],accountState:null,carry:[{mandateId:'mandate',coin:'BTC',carry:'0',revision:1,updatedAt:new Date(now).toISOString()}]}}};
  return {mandate,settings,fill,leg,sizingBasis,now,limits:DEFAULT_COPY_RISK_LIMITS,currentExecutionKey:key};
}
