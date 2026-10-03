import { isDeepStrictEqual } from 'node:util';
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
import { ceilDecimalProduct } from './live-risk-rounding.js';
export interface BoundPostgresLiveRiskSource { readonly proofSource:LiveAccountRiskProofSource; forHold():Promise<LiveAccountRiskInput>; }
export interface LiveRiskSourceBinding { readonly accountId:string; readonly key:string; }
const same=(a:unknown,b:unknown)=>isDeepStrictEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)));
/** Unregistered concrete fixed-network proof producer. No caller arrays, paper
 * cash, cached permits, replacement SQL connections or financial provider I/O. */
export class PostgresLiveRiskSource {
  private readonly options:Readonly<LiveRiskProviderOptions>;
  constructor(private readonly observer:HyperliquidLiveAccountObserver,private readonly resolver:HyperliquidLiveMarketResolver,
    private readonly remote:HyperliquidLiveRiskProvider,private readonly reservations:PostgresLiveReservations,options:LiveRiskProviderOptions,private readonly now=Date.now) {
    requireProof(observer instanceof HyperliquidLiveAccountObserver&&resolver instanceof HyperliquidLiveMarketResolver&&remote instanceof HyperliquidLiveRiskProvider&&reservations instanceof PostgresLiveReservations,'live_risk_source_unavailable');
    this.options=freezeLiveReservation(structuredClone(options));
  }
  private fresh(at:number) {const now=this.now();requireProof(Number.isSafeInteger(at)&&Number.isSafeInteger(now)&&now>=at&&now-at<=5000,'live_risk_stale');}
  bind(session:LiveRiskDatabaseSession,raw:LiveRiskSourceBinding):BoundPostgresLiveRiskSource {
    assertOriginalLiveRiskSession(session);
    const binding=Object.freeze(structuredClone(raw));requireProof(binding&&typeof binding.accountId==='string'&&binding.accountId.length>0&&typeof binding.key==='string'&&binding.key.length>0,'live_risk_identity');
    const read=async(supplied?:Parameters<LiveAccountRiskProofSource['read']>[0]):Promise<LiveAccountRiskInput>=>{
      session.scope.assertFresh();const started=this.now(),input=supplied?structuredClone(supplied):undefined;
      const local=await session.read(db=>loadLiveRiskAuthority(session,db,binding,this.now()));this.fresh(started);
      if(input) requireProof(['sign','submit'].includes(input.phase)&&(input.phase==='sign'?local.record.state==='prepared':local.record.state==='submitting')&&same(input.record,local.record)&&executionKey(input.intent)===binding.key&&intentFingerprint(input.intent,buildOrderAction(input.intent))===local.record.fingerprint,'live_risk_record_mismatch');
      else requireProof(local.record.state==='prepared','live_risk_record_mismatch');
      const owned=input?await this.reservations.read(session,{accountId:binding.accountId,ownKey:binding.key}):undefined;
      await this.validateSizingAndGeneration(session,local);
      const marketWork=this.resolver.resolve(local.fill.coin),accountsWork=Promise.all(local.accounts.map(a=>this.observer.observe(a.address!)));
      void accountsWork.catch(()=>{});
      const market=await marketWork;await session.scope.assertHeld();requireProof(local.intent.market&&same(marketIdentityKey(market),marketIdentityKey(local.intent.market)),'live_risk_market');
      const targetWork=this.remote.observe(local.identity.accountAddress,market,this.options);void targetWork.catch(()=>{});
      const snapshots=await accountsWork;await session.scope.assertHeld();for(let i=0;i<snapshots.length;i++)this.validateSnapshot(snapshots[i]!,local.accounts[i]!.address!);
      const current=snapshots[local.accounts.findIndex(a=>a.id===binding.accountId)]!,target=await targetWork;await session.scope.assertHeld();
      const coins=[...new Set([...current.positions.map(p=>p.coin),...current.restingOrders.map(o=>o.coin),market.coin])];requireProof(coins.length<=16,'live_risk_market_coverage_unbounded');
      const others=await Promise.all(coins.filter(coin=>coin!==market.coin).map(async coin=>{const m=await this.resolver.resolve(coin);await session.scope.assertHeld();const p=await this.remote.observe(local.identity.accountAddress,m,this.options);await session.scope.assertHeld();return p;}));
      // Provider calls finish before the uncached second SQL read.
      const final=await session.read(db=>loadLiveRiskAuthority(session,db,binding,this.now()));requireProof(riskSourceDigest(local)===riskSourceDigest(final),'live_risk_local_changed');
      const localSource={checkedAt:started,sourceDigest:riskSourceDigest(local)},intent=freezeLiveReservation({...local.intent,market}),action=buildOrderAction(intent),checkedAt=this.now();
      const leverageProofs=[...target.leverageProofs,...others.flatMap(p=>p.leverageProofs)];
      const base={now:checkedAt,identity:local.identity,localSource,intent,action,market,accountSource:{accountId:binding.accountId,userId:local.identity.userId,strategyId:local.identity.strategyId,network:'testnet' as const,accountAddress:local.identity.accountAddress,checkedAt,sourceDigest:current.sourceDigest,quarantined:false,snapshot:current},policy:local.policy,strategy:{version:local.identity.strategyVersion,settings:local.settings,allocatedUsd:local.consent.budgetUsd},controls:local.controls,quote:target.quote,leverageProofs,fees:target.fees,signal:{kind:'fill' as const,leaderSide:local.fill.side,price:local.fill.px,at:local.fill.providerTime},userExposureProof:this.userExposure(local,snapshots,market.coin,Dec.max(Dec.from(target.quote.midPrice),Dec.from(target.quote.markPrice),Dec.from(intent.limitPrice)),started,owned?.own)};
      let reservations:LiveAccountRiskInput['reservations'];
      if(owned) reservations=owned;
      else {
        const candidate=planLiveReservation({...base,leverage:leverageProofs.find(p=>p.coin===market.coin)!,expiresAt:local.record.expiresAfter}),views=this.reservationViews(local),liabilities=views.filter(r=>r.accountId===binding.accountId&&r.key!==binding.key);
        requireProof(!views.some(r=>r.key===binding.key),'live_risk_hold_already_exists');
        reservations={accountId:binding.accountId,userId:local.identity.userId,network:'testnet',accountAddress:local.identity.accountAddress,checkedAt:started,sourceDigest:riskSourceDigest({candidate,liabilities,started}),complete:true,own:{...candidate,state:'held',exchangeOrderId:null},others:liabilities};
      }
      const proof=freezeLiveReservation({...base,reservations});session.scope.assertFresh();this.fresh(started);
      this.fresh(Math.min(...snapshots.flatMap(s=>[s.observedAt,s.completedAt,s.coverage.earliestProviderTime,...s.dexes.map(d=>d.providerTime)]),market.observedAt,target.earliestObservedAt,...others.map(p=>p.earliestObservedAt)));return proof;
    };
    return Object.freeze({forHold:()=>read(),proofSource:Object.freeze({read:async (input:Parameters<LiveAccountRiskProofSource['read']>[0])=>{const proof=await read(input);return Object.freeze({proof,assertHeld:()=>{session.scope.assertFresh();this.fresh(proof.localSource.checkedAt);}});}})});
  }
  private async validateSizingAndGeneration(_session:LiveRiskDatabaseSession,local:LiveRiskAuthority):Promise<void> {requireProof(local.baseline,'live_risk_baseline_unproven');throw new LiveBoundaryError('live_risk_generation_unproven');}
  private validateSnapshot(s:LiveAccountSnapshot,accountAddress:string) {
    requireProof(s.network==='testnet'&&s.accountAddress===accountAddress&&s.role==='user'&&s.accountMode==='standard'&&s.accountAbstraction==='disabled'&&s.coverage.complete&&s.coverage.balanceComplete&&s.coverage.orderComplete&&s.coverage.unobservedOrderDexes.length===0&&s.dexes.length===s.coverage.listedDexes.length&&new Set(s.dexes.map(d=>d.dex)).size===s.dexes.length&&s.coverage.listedDexes.every(d=>s.dexes.some(v=>v.dex===d)),'live_risk_user_coverage_unproven');
    for(const d of s.dexes)if(!d.supported)requireProof(['equity','rawUsd','marginUsed','withdrawable','exposureUsd','crossEquity','crossMarginUsed','crossExposureUsd','crossMaintenanceMarginUsed'].every(k=>Dec.from(d[k as keyof typeof d] as string).isZero)&&!s.positions.some(p=>p.dex===d.dex)&&!s.restingOrders.some(o=>o.dex===d.dex),'live_risk_user_coverage_unproven');
    this.fresh(Math.min(s.observedAt,s.completedAt,s.coverage.earliestProviderTime,...s.dexes.map(d=>d.providerTime)));
  }
  private reservationViews(local:LiveRiskAuthority,owned?:LiveRiskReservation):LiveRiskReservation[] {
    return local.liabilities.map(({reservation:r,journal:j,historicalGrant:g,historicalWallet:w})=>{
      const p=validateLiveReservationPayload(r.payload),record=j.record as unknown as typeof local.record;
      requireProof(g&&w&&g.id===p.authorizationId&&g.version>=p.authorizationVersion&&w.privyWalletId===p.walletId&&w.userId===p.userId&&w.strategyId===p.strategyId&&w.network===p.network&&w.accountAddress===p.accountAddress&&w.signerAddress===j.signerAddress&&w.privyOwnerId===record.authorization?.privyOwnerId&&g.validFrom.getTime()===record.authorization.validFrom&&g.expiresAt.getTime()===record.authorization.expiresAt&&g.scopes.every(scope=>record.authorization.scopes.includes(scope))&&g.scopes.length===record.authorization.scopes.length,'live_risk_liability_invalid');
      requireProof(r.network==='testnet'&&r.userId===local.identity.userId&&local.accounts.some(a=>a.id===r.accountId&&a.address===r.accountAddress&&a.strategyId===r.strategyId)&&['key','accountId','userId','strategyId','network','accountAddress','fingerprint','walletId','authorizationId','strategyVersion','policyVersion','authorizationVersion','notionalUsd','marginUsd','feeBufferUsd','sourceDigest'].every(k=>r[k as keyof typeof r]===p[k as keyof typeof p])&&r.cloid===p.intent.cloid&&r.coin===p.intent.market!.coin&&r.dex===p.intent.market!.dex&&r.asset===p.intent.asset&&r.createdAt.getTime()===p.createdAt&&r.expiresAt.getTime()===p.expiresAt&&j.key===p.key&&j.userId===p.userId&&j.strategyId===p.strategyId&&j.network===p.network&&j.accountAddress===p.accountAddress&&j.cloid===p.intent.cloid&&j.nonce===record.nonce&&j.state===record.state&&j.updatedAt.getTime()===record.updatedAt&&record.key===p.key&&record.fingerprint===p.fingerprint&&same(record.action,p.action)&&same(record.market,p.intent.market)&&record.authorization?.id===p.authorizationId&&record.authorization.version===p.authorizationVersion&&record.authorization.walletId===p.walletId&&record.authorization.userId===p.userId&&record.authorization.strategyId===p.strategyId&&record.authorization.network===p.network&&record.authorization.accountAddress===p.accountAddress&&record.authorization.signerAddress===j.signerAddress,'live_risk_liability_invalid');
      requireProof(r.state==='resting'&&r.attemptedAt&&r.exchangeOrderId||r.state==='held'&&r.attemptedAt===null&&r.exchangeOrderId===null&&(record.state==='prepared'||r.key===owned?.key&&owned.state==='held'&&owned.fingerprint===p.fingerprint&&record.state==='submitting'),'live_risk_liability_unknown');
      return freezeLiveReservation({...p,state:r.state as 'held'|'resting',exchangeOrderId:r.exchangeOrderId});
    });
  }
  private userExposure(local:LiveRiskAuthority,snapshots:LiveAccountSnapshot[],coin:string,riskPrice:Dec,checkedAt:number,owned?:LiveRiskReservation):LiveAccountRiskInput['userExposureProof'] {
    const liabilities=this.reservationViews(local,owned);let total=Dec.ZERO,specific=Dec.ZERO;
    for(let i=0;i<snapshots.length;i++) {
      const account=local.accounts[i]!,snapshot=snapshots[i]!;if(account.id===local.identity.accountId)continue;
      for(const p of snapshot.positions){const value=p.coin===coin?Dec.max(Dec.from(p.positionValue),ceilDecimalProduct([Dec.from(p.size).abs(),riskPrice])):Dec.from(p.positionValue);total=total.add(value);if(p.coin===coin)specific=specific.add(value);}
      for(const o of snapshot.restingOrders)if(!o.reduceOnly){total=total.add(o.notionalUsd);if(o.coin===coin)specific=specific.add(o.notionalUsd);}
      for(const r of liabilities.filter(r=>r.accountId===account.id&&!r.intent.reduceOnly)){if(snapshot.restingOrders.some(o=>o.oid===r.exchangeOrderId||o.cloid===r.intent.cloid))continue;requireProof(r.state==='held','live_risk_liability_unknown');total=total.add(r.notionalUsd);if(r.intent.market!.coin===coin)specific=specific.add(r.notionalUsd);}
    }
    return {userId:local.identity.userId,checkedAt,sourceDigest:riskSourceDigest({accounts:local.accounts,snapshots,liabilities,recent:local.recent,coin,checkedAt}),network:'testnet',coin,excludedAccountId:local.identity.accountId,excludedExecutionKey:local.binding.key,complete:true,otherAccountsExposureUsd:total.toString(),otherAccountsCoinExposureUsd:specific.toString(),ordersLastMinuteExcludingOwn:local.recent.length};
  }
}
