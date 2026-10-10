import { isDeepStrictEqual } from 'node:util';
import { inArray } from 'drizzle-orm';
import { copyLiveSourceFills } from '@trading-dashboard/shared/database';
import type { LiveAccountRiskProofSource } from './account-risk-execution-gate.js';
import type { LiveAccountRiskInput, LiveRiskReservation } from './live-account-risk.js';
import { HyperliquidLiveAccountObserver, type LiveAccountSnapshot } from './live-account-observer.js';
import { HyperliquidLiveMarketResolver, marketIdentityKey } from './live-market-resolver.js';
import { HyperliquidLiveRiskProvider, type LiveRiskProviderOptions } from './live-risk-provider.js';
import { PostgresLiveReservations } from './postgres-live-reservations.js';
import { assertOriginalLiveRiskSession, type LiveRiskDatabaseSession } from './postgres-live-risk-scope.js';
import { LiveBoundaryError } from './wallet-authorization.js';
import { loadLiveRiskAuthority, riskSourceDigest, riskSourceRequire as requireProof, type LiveRiskAuthority } from './postgres-live-risk-authority.js';
import { buildOrderAction, executionKey, intentFingerprint } from './live-order.js';
import { freezeLiveReservation, planLiveReservation, validateLiveReservationPayload } from './live-risk-reservation.js';
import { Dec } from '../../common/decimal/dec.js';
import { calculateLiveExternalExposure } from './live-external-exposure.js';
import { loadLiveGenerationManifest } from './postgres-live-generation-manifest.js';
import { projectLiveGenerationPositions,type LiveGenerationManifestV1 } from './copy-live-generation-projection.js';
import { decodeLiveSourceSizingEnvelope,planLiveSourceOrder } from './copy-live-source-planner.js';
import type { LiveSourceSizingBasisV1 } from './copy-live-sizing-evidence.js';
import { canonicalLiveSourceLegs, type LiveSourceFillEvidence } from './copy-live-source-evidence.js';
import { loadMergedMembers } from './copy-live-merged-members.js';
import type { LiveReservationStored } from './live-risk-reservation.js';
import {LiveProviderReadEpoch} from './live-provider-read-epoch.js';
import { beginLiveExecutionTiming, type LiveExecutionTimingHook, type LiveTimingStage } from './live-execution-diagnostics.js';
type CollectedAuthority=LiveRiskAuthority&{generation:LiveGenerationManifestV1;members?:LiveSourceFillEvidence[]};
export interface BoundPostgresLiveRiskSource { readonly proofSource:LiveAccountRiskProofSource; forHold():Promise<LiveAccountRiskInput>; }
export interface LiveRiskSourceBinding { readonly accountId:string; readonly key:string; }
const same=(a:unknown,b:unknown)=>isDeepStrictEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)));
/** Unregistered concrete fixed-network proof producer. No caller arrays, paper
 * cash, cached permits, replacement SQL connections or financial provider I/O. */
export class PostgresLiveRiskSource {
  private readonly epoch:LiveProviderReadEpoch;
  constructor(observer:HyperliquidLiveAccountObserver,resolver:HyperliquidLiveMarketResolver,
    remote:HyperliquidLiveRiskProvider,private readonly reservations:PostgresLiveReservations,options:LiveRiskProviderOptions,private readonly now=Date.now,epoch?:LiveProviderReadEpoch,private readonly onTiming?:LiveExecutionTimingHook) {
    requireProof(observer instanceof HyperliquidLiveAccountObserver&&resolver instanceof HyperliquidLiveMarketResolver&&remote instanceof HyperliquidLiveRiskProvider&&reservations instanceof PostgresLiveReservations,'live_risk_source_unavailable');
    requireProof(epoch===undefined||epoch instanceof LiveProviderReadEpoch,'live_risk_source_unavailable');
    this.epoch=epoch??new LiveProviderReadEpoch(observer,resolver,remote,options,now);
  }
  private fresh(at:number) {const now=this.now();requireProof(Number.isSafeInteger(at)&&Number.isSafeInteger(now)&&now>=at&&now-at<=5000,'live_risk_stale');}
  bind(session:LiveRiskDatabaseSession,raw:LiveRiskSourceBinding):BoundPostgresLiveRiskSource {
    assertOriginalLiveRiskSession(session);
    const binding=Object.freeze(structuredClone(raw));requireProof(binding&&typeof binding.accountId==='string'&&binding.accountId.length>0&&typeof binding.key==='string'&&binding.key.length>0,'live_risk_identity');
    const read=async(supplied?:Parameters<LiveAccountRiskProofSource['read']>[0]):Promise<LiveAccountRiskInput>=>{
      const mark=beginLiveExecutionTiming(session.scope.identity.network,supplied?.phase??'hold',this.now,this.onTiming);
      let stage:LiveTimingStage='risk_local_read';
      try {
      session.scope.assertFresh();const started=this.now(),input=supplied?structuredClone(supplied):undefined;
      const local=await this.load(session,binding,started);this.fresh(started);mark(stage);stage='risk_sizing_validation';
      if(input) requireProof(['sign','submit'].includes(input.phase)&&(input.phase==='sign'?local.record.state==='prepared':local.record.state==='submitting')&&same(input.record,local.record)&&executionKey(input.intent)===binding.key&&intentFingerprint(input.intent,buildOrderAction(input.intent))===local.record.fingerprint,'live_risk_record_mismatch');
      else requireProof(local.record.state==='prepared','live_risk_record_mismatch');
      const owned=input?await this.reservations.read(session,{accountId:binding.accountId,ownKey:binding.key}):undefined;
      const sizing=this.validateSizing(local);mark(stage);stage='risk_provider_epoch';
      const reusedProviderEpoch=this.epoch.hasCompleted(session);
      const frames=await this.epoch.collect(session,{accountId:binding.accountId,mandateId:local.row.mandate.id,key:binding.key,coin:local.fill.coin});await session.scope.assertHeld();
      requireProof(frames.authorityDigest===riskSourceDigest(local.preparation),'live_risk_local_changed');this.fresh(frames.oldest);
      mark(stage);stage='risk_final_local_read';
      const {market,snapshots,target,others}=frames;
      requireProof(local.intent.market&&same(marketIdentityKey(market),marketIdentityKey(local.intent.market)),'live_risk_market');
      requireProof(snapshots.length===local.accounts.length,'live_risk_user_coverage_unproven');for(let i=0;i<snapshots.length;i++)this.validateSnapshot(snapshots[i]!,local.accounts[i]!.address!,local.identity.network,local.accounts[i]!.id!==binding.accountId);
      const current=snapshots[local.accounts.findIndex(a=>a.id===binding.accountId)]!;
      // New provider calls require an uncached second full SQL read. A settled
      // epoch issues no provider calls: the full current authority above and
      // collect's fresh preparation digest check already follow its original
      // observations under the same held locks. Never cache SQL authority.
      const localDigest=riskSourceDigest(local);
      if(!reusedProviderEpoch){const final=await this.load(session,binding,started);requireProof(localDigest===riskSourceDigest(final),'live_risk_local_changed');}
      mark(stage);stage='risk_generation_projection';
      this.validateGeneration(local,current,sizing.envelope.basis,owned?.own);mark(stage);stage='risk_proof_build';
      const localSource={checkedAt:Math.min(started,sizing.oldest,frames.oldest,market.observedAt,target.earliestObservedAt,...others.map(p=>p.earliestObservedAt),
        ...snapshots.flatMap(s=>[s.observedAt,s.completedAt,s.coverage.earliestProviderTime,...s.dexes.map(d=>d.providerTime)])),sourceDigest:localDigest},
        intent=freezeLiveReservation({...local.intent,market}),action=buildOrderAction(intent),checkedAt=this.now();
      const leverageProofs=[...target.leverageProofs,...others.flatMap(p=>p.leverageProofs)];
      const base={now:checkedAt,identity:local.identity,localSource,intent,action,market,accountSource:{accountId:binding.accountId,userId:local.identity.userId,strategyId:local.identity.strategyId,network:local.identity.network,accountAddress:local.identity.accountAddress,checkedAt,sourceDigest:current.sourceDigest,quarantined:false,snapshot:current},policy:local.policy,strategy:{version:local.identity.strategyVersion,settings:local.settings,allocatedUsd:local.consent.budgetUsd,...(sizing.envelope.basis.fixedMaxUsd!==undefined&&sizing.envelope.basis.exchangeMinimum?{fixedMaxUsd:sizing.envelope.basis.fixedMaxUsd}:{})},controls:local.controls,quote:target.quote,leverageProofs,fees:target.fees,signal:{kind:'fill' as const,leaderSide:local.fill.side,price:local.fill.px,at:local.fill.providerTime},userExposureProof:this.userExposure(local,snapshots,market.coin,Dec.max(Dec.from(target.quote.midPrice),Dec.from(target.quote.markPrice),Dec.from(intent.limitPrice)),started,owned?.own)};
      let reservations:LiveAccountRiskInput['reservations'];
      if(owned) reservations=owned;
      else {
        const candidate=planLiveReservation({...base,intent:local.intent,leverage:leverageProofs.find(p=>p.coin===market.coin)!,expiresAt:local.record.expiresAfter}),views=this.reservationViews(local),liabilities=views.filter(r=>r.accountId===binding.accountId&&r.key!==binding.key);
        requireProof(!views.some(r=>r.key===binding.key),'live_risk_hold_already_exists');
        reservations={accountId:binding.accountId,userId:local.identity.userId,network:local.identity.network,accountAddress:local.identity.accountAddress,checkedAt:started,sourceDigest:riskSourceDigest({candidate,liabilities,started}),complete:true,own:{...candidate,state:'held',exchangeOrderId:null},others:liabilities};
      }
      const proof=freezeLiveReservation({...base,reservations});session.scope.assertFresh();this.fresh(localSource.checkedAt);
      this.fresh(Math.min(...snapshots.flatMap(s=>[s.observedAt,s.completedAt,s.coverage.earliestProviderTime,...s.dexes.map(d=>d.providerTime)]),market.observedAt,target.earliestObservedAt,...others.map(p=>p.earliestObservedAt)));mark(stage);return proof;
      } catch(error) {mark(stage);throw error;}
    };
    return Object.freeze({forHold:()=>read(),proofSource:Object.freeze({read:async (input:Parameters<LiveAccountRiskProofSource['read']>[0])=>{const proof=await read(input);return Object.freeze({proof,assertHeld:()=>{session.scope.assertFresh();this.fresh(proof.localSource.checkedAt);}});}})});
  }
  private async load(session:LiveRiskDatabaseSession,binding:LiveRiskSourceBinding,observedAt:number):Promise<CollectedAuthority> {
    return session.read(async db=>{const local=await loadLiveRiskAuthority(session,db,binding,this.now());
      requireProof(local.baseline,'live_risk_baseline_unproven');
      const generation=await loadLiveGenerationManifest(session,db,local.preparation,{currentExecutionKey:binding.key,now:observedAt});
      const members=await loadMergedMembers(local.provenance.sizingBasis,local.fill.id,async ids=>{const rows=await db.select().from(copyLiveSourceFills).where(inArray(copyLiveSourceFills.id,ids));await session.scope.assertHeld();return rows;});
      return {...local,generation,...(members?{members}:{})};});
  }
  private validateSizing(local:CollectedAuthority) {
    try {
      const envelope=decodeLiveSourceSizingEnvelope(local.provenance.sizingBasis),leg=canonicalLiveSourceLegs(local.fill).find(l=>l.leg===local.row.leg.leg)!;
      const planned=planLiveSourceOrder({mandate:local.row.mandate,settings:local.settings,fill:local.fill,leg,sizingBasis:envelope,now:local.record.createdAt,limits:local.policy.limits,currentExecutionKey:local.binding.key,...(local.members?{members:local.members}:{})});
      const i=local.intent;
      requireProof(same(planned.order,{coin:i.market!.coin,asset:i.asset,side:i.side,size:i.size,limitPrice:i.limitPrice,sizeDecimals:i.sizeDecimals,reduceOnly:i.reduceOnly,timeInForce:i.timeInForce})&&
        planned.legId===local.row.leg.id&&planned.fixedTradeClaim===local.row.leg.fixedTradeClaim&&planned.dependsOnLegId===local.row.leg.dependsOnId&&
        envelope.basis.generation.baselineDigest===local.baseline!.baselineDigest,'live_risk_generation_unproven');
      const snapshotTimes=(s:LiveAccountSnapshot)=>[s.observedAt,s.completedAt,s.coverage.earliestProviderTime,...s.dexes.map(d=>d.providerTime)];
      const o=envelope.observations,oldest=Math.min(local.provenance.admittedAt.getTime(),envelope.basis.market.observedAt,envelope.basis.quote.observedAt,o.quote.earliestObservedAt,
        o.generationManifest.checkedAt,...snapshotTimes(o.follower),...(o.leader?snapshotTimes(o.leader):[]));this.fresh(oldest);
      return {envelope,oldest};
    }catch(error){if(error instanceof LiveBoundaryError&&error.code==='live_risk_stale')throw error;throw new LiveBoundaryError('live_risk_generation_unproven');}
  }
  private validateGeneration(local:CollectedAuthority,snapshot:LiveAccountSnapshot,basis:LiveSourceSizingBasisV1,owned?:LiveRiskReservation) {
    let held:LiveReservationStored|undefined;
    if(local.record.state==='submitting'){
      const row=local.liabilities.find(entry=>entry.reservation.key===local.binding.key)?.reservation;
      requireProof(owned&&owned.state==='held'&&owned.key===local.binding.key&&owned.fingerprint===local.record.fingerprint&&row&&row.state==='held'&&row.attemptedAt===null&&row.exchangeOrderId===null,'live_risk_generation_unproven');
      held={payload:validateLiveReservationPayload(row.payload),state:row.state,revision:row.revision,attemptedAt:null,exchangeOrderId:null,releaseEvidenceDigest:row.releaseEvidenceDigest,updatedAt:row.updatedAt.getTime()};
    }
    const projection=projectLiveGenerationPositions({identity:{mandateId:local.row.mandate.id,mandateRevision:local.row.mandate.revision,accountId:local.identity.accountId,userId:local.identity.userId,
      strategyId:local.identity.strategyId,network:local.identity.network,accountAddress:local.identity.accountAddress,authorizationId:local.identity.authorizationId,settingsDigest:local.consent.settingsDigest,
      leaderAddress:local.consent.leaderAddress,direction:local.settings.direction},manifest:local.generation,snapshot,currentExecutionKey:local.binding.key,now:this.now(),...(held?{ownSubmittingReservation:held}:{})});
    const carry=local.generation.carry.find(c=>c.coin===local.fill.coin);
    requireProof(projection.baselineDigest===basis.generation.baselineDigest&&projection.positionsDigest===basis.generation.positionsDigest&&projection.receiptManifestDigest===basis.generation.receiptManifestDigest&&
      (projection.positions[local.fill.coin]??'0')===basis.generation.positionSize&&carry&&carry.revision===basis.carry.revision&&carry.carry===basis.carry.amount,'live_risk_generation_unproven');
  }
  private validateSnapshot(s:LiveAccountSnapshot,accountAddress:string,network:LiveAccountSnapshot['network'],other=false) {
    // Another copy's account not yet funded or set up: zero exposure only.
    const unsetup=s.role!=='user'||s.accountAbstraction!=='disabled';
    requireProof(!unsetup||other&&['user','missing'].includes(s.role)&&['disabled','default'].includes(s.accountAbstraction)&&s.positions.length===0&&s.restingOrders.length===0&&
      s.dexes.every(d=>['equity','rawUsd','marginUsed','withdrawable','exposureUsd','crossEquity','crossMarginUsed','crossExposureUsd','crossMaintenanceMarginUsed'].every(k=>Dec.from(d[k as keyof typeof d] as string).isZero)),'live_risk_user_coverage_unproven');
    requireProof(s.network===network&&s.accountAddress===accountAddress&&s.accountMode==='standard'&&s.coverage.complete&&s.coverage.balanceComplete&&s.coverage.orderComplete&&s.coverage.unobservedOrderDexes.length===0&&s.dexes.length===s.coverage.listedDexes.length&&new Set(s.dexes.map(d=>d.dex)).size===s.dexes.length&&s.coverage.listedDexes.every(d=>s.dexes.some(v=>v.dex===d)),'live_risk_user_coverage_unproven');
    for(const d of s.dexes)if(!d.supported)requireProof(['equity','rawUsd','marginUsed','withdrawable','exposureUsd','crossEquity','crossMarginUsed','crossExposureUsd','crossMaintenanceMarginUsed'].every(k=>Dec.from(d[k as keyof typeof d] as string).isZero)&&!s.positions.some(p=>p.dex===d.dex)&&!s.restingOrders.some(o=>o.dex===d.dex),'live_risk_user_coverage_unproven');
    this.fresh(Math.min(s.observedAt,s.completedAt,s.coverage.earliestProviderTime,...s.dexes.map(d=>d.providerTime)));
  }
  private reservationViews(local:LiveRiskAuthority,owned?:LiveRiskReservation):LiveRiskReservation[] {
    return local.liabilities.map(({reservation:r,journal:j,historicalGrant:g,historicalWallet:w})=>{
      const p=validateLiveReservationPayload(r.payload),record=j.record as unknown as typeof local.record;
      requireProof(g&&w&&g.id===p.authorizationId&&g.version>=p.authorizationVersion&&w.privyWalletId===p.walletId&&w.userId===p.userId&&w.strategyId===p.strategyId&&w.network===p.network&&w.accountAddress===p.accountAddress&&w.signerAddress===j.signerAddress&&w.privyOwnerId===record.authorization?.privyOwnerId&&g.validFrom.getTime()===record.authorization.validFrom&&g.expiresAt.getTime()===record.authorization.expiresAt&&g.scopes.every(scope=>record.authorization.scopes.includes(scope))&&g.scopes.length===record.authorization.scopes.length,'live_risk_liability_invalid');
      requireProof(r.network===local.identity.network&&r.userId===local.identity.userId&&local.accounts.some(a=>a.id===r.accountId&&a.address===r.accountAddress&&a.strategyId===r.strategyId)&&['key','accountId','userId','strategyId','network','accountAddress','fingerprint','walletId','authorizationId','strategyVersion','policyVersion','authorizationVersion','notionalUsd','marginUsd','feeBufferUsd','sourceDigest'].every(k=>r[k as keyof typeof r]===p[k as keyof typeof p])&&r.cloid===p.intent.cloid&&r.coin===p.intent.market!.coin&&r.dex===p.intent.market!.dex&&r.asset===p.intent.asset&&r.createdAt.getTime()===p.createdAt&&r.expiresAt.getTime()===p.expiresAt&&j.key===p.key&&j.userId===p.userId&&j.strategyId===p.strategyId&&j.network===p.network&&j.accountAddress===p.accountAddress&&j.cloid===p.intent.cloid&&j.nonce===record.nonce&&j.state===record.state&&j.updatedAt.getTime()===record.updatedAt&&record.key===p.key&&record.fingerprint===p.fingerprint&&same(record.action,p.action)&&same(record.market,p.intent.market)&&record.authorization?.id===p.authorizationId&&record.authorization.version===p.authorizationVersion&&record.authorization.walletId===p.walletId&&record.authorization.userId===p.userId&&record.authorization.strategyId===p.strategyId&&record.authorization.network===p.network&&record.authorization.accountAddress===p.accountAddress&&record.authorization.signerAddress===j.signerAddress,'live_risk_liability_invalid');
      // Another account's order in flight (held past its journal's prepare,
      // or attempted with no answer yet) is a bounded liability at its
      // maximum notional (live-external-exposure.ts), never a refusal: two
      // copies of one owner no longer block each other while one is sending.
      if(r.accountId!==local.identity.accountId&&(r.state==='unknown'&&r.attemptedAt||r.state==='held'&&r.attemptedAt===null&&r.exchangeOrderId===null&&record.state!=='prepared'))
        return freezeLiveReservation({...p,state:'unknown' as const,exchangeOrderId:r.exchangeOrderId});
      requireProof(r.state==='resting'&&r.attemptedAt&&r.exchangeOrderId||r.state==='held'&&r.attemptedAt===null&&r.exchangeOrderId===null&&(record.state==='prepared'||r.key===owned?.key&&owned.state==='held'&&owned.fingerprint===p.fingerprint&&record.state==='submitting'),'live_risk_liability_unknown');
      return freezeLiveReservation({...p,state:r.state as 'held'|'resting',exchangeOrderId:r.exchangeOrderId});
    });
  }
  private userExposure(local:LiveRiskAuthority,snapshots:readonly LiveAccountSnapshot[],coin:string,riskPrice:Dec,checkedAt:number,owned?:LiveRiskReservation):LiveAccountRiskInput['userExposureProof'] {
    const liabilities=this.reservationViews(local,owned);let total=Dec.ZERO,specific=Dec.ZERO;
    for(let i=0;i<snapshots.length;i++) {
      const account=local.accounts[i]!,snapshot=snapshots[i]!;if(account.id===local.identity.accountId)continue;
      const exposure=calculateLiveExternalExposure({now:this.now(),accountId:account.id,accountAddress:account.address!,coin,riskPrice:riskPrice.toString(),snapshot,reservations:liabilities.filter(r=>r.accountId===account.id)});
      total=total.add(exposure.exposureUsd);specific=specific.add(exposure.coinExposureUsd);
    }
    return {userId:local.identity.userId,checkedAt,sourceDigest:riskSourceDigest({accounts:local.accounts,snapshots,liabilities,recent:local.recent,coin,checkedAt}),network:local.identity.network,coin,excludedAccountId:local.identity.accountId,excludedExecutionKey:local.binding.key,complete:true,otherAccountsExposureUsd:total.toString(),otherAccountsCoinExposureUsd:specific.toString(),ordersLastMinuteExcludingOwn:local.recent.length};
  }
}
