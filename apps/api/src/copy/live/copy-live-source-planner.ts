import { copyStrategySettingsSchema, HYPERLIQUID_NETWORKS, isHyperliquidNetwork, type CopyRiskLimits, type CopyStrategySettings, type HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { Dec } from '../../common/decimal/dec.js';
import { floorSize, followerSign, reduceWithCarry, roundPx, slippedPx } from '../copy-math.js';
import { decodeLiveCopyMandate, type MandateRow } from '../copy-live-mandate-evidence.js';
import { liveCopySettingsDigest } from '../copy-live-mandate-consent.js';
import { canonicalLiveSourceLegs, decodeLiveSourceFill, liveSourceDigest, liveSourceLegId, type CanonicalLiveSourceLeg, type LiveSourceFillEvidence } from './copy-live-source-evidence.js';
import type { LiveSourceReferenceV1, LiveSourceSizingBasisV1, LiveSourceSizingEnvelopeV1, PlannedLiveSourceOrder } from './copy-live-sizing-evidence.js';
import { assertMarketIdentity, marketIdentityKey } from './live-market-resolver.js';
import { mapLiveAccountView } from './live-account-view.js';
import { projectLiveGenerationPositions } from './copy-live-generation-projection.js';
import { followerReceiptDigestV1 } from './actual-fill-accounting.js';
import { freezeLiveReservation } from './live-risk-reservation.js';
import { address, LiveBoundaryError } from './wallet-authorization.js';
export interface LiveSourcePlanInput {
  readonly mandate: MandateRow; readonly settings: CopyStrategySettings; readonly fill: LiveSourceFillEvidence;
  readonly leg: CanonicalLiveSourceLeg; readonly sizingBasis: unknown; readonly now: number;
  readonly limits: Pick<CopyRiskLimits,'maxSignalAgeSeconds'|'maxSlippageBps'>;
  readonly currentExecutionKey: string;
  /** A merged adjustment's other legs, as persisted (copy_live_source_fills):
   * every member the basis lists besides the order's own, which the planner
   * verifies field by field. Required when the basis is merged. */
  readonly members?: readonly LiveSourceFillEvidence[];
}
/** Most leader legs one follower adjustment may merge, and the longest a
 * leg too small for the exchange may wait for more (never past the risk
 * policy's maxSignalAgeSeconds: every merged leg must still be a fresh
 * signal when its order is planned). */
export const MAX_MERGED_LEGS=64,MAX_ACCUMULATE_MS=15*60_000;
/** The other legs' ids a merged sizing basis lists (besides the order's own);
 * none for an undecodable basis (the planner refuses that one itself). */
export function mergedMemberIds(sizingBasis:unknown,ownFillId:string):string[]{
  let members:readonly {sourceFillId:string}[];
  try{members=decodeLiveSourceSizingEnvelope(sizingBasis).basis.merged?.members??[];}catch{return [];}
  return members.map(m=>m.sourceFillId).filter(id=>id!==ownFillId);
}
const hash=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().min(1).max(160),integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),version=integer.refine(v=>v>0),addr=z.string().regex(/^0x[0-9a-f]{40}$/);
const decimal=z.string().max(80).regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/).refine(v=>Dec.from(v).toString()===v);
const nonnegative=decimal.refine(v=>Dec.from(v).gte(0)),positive=decimal.refine(v=>Dec.from(v).isPositive);
const network=z.enum(HYPERLIQUID_NETWORKS);
const market=z.object({network,coin:id,dex:z.string(),asset:integer,universeIndex:integer,perpDexIndex:integer,sizeDecimals:integer,maxLeverage:version,observedAt:integer}).strict();
const snapshotIdentity={network,accountAddress:addr,equity:nonnegative,observedAt:integer,completedAt:integer,sourceDigest:hash,snapshotDigest:hash};
const basisSchema=z.object({version:z.literal(1),mandateId:id,mandateRevision:version,settingsDigest:hash,sourceFillId:id,sourceDigest:hash,network,accountAddress:addr,coin:id,
  leg:z.enum(['open','close']),direction:z.enum(['same','reverse']),sizingMode:z.enum(['ratio','fixed']),budgetUsd:positive,perTradeUsd:positive.nullable(),market,
  quote:z.object({midPrice:positive,slippageBps:nonnegative,observedAt:integer,completedAt:integer,sourceDigest:hash}).strict(),
  follower:z.object({...snapshotIdentity,positionSize:decimal,positionsDigest:hash}).strict(),leader:z.object(snapshotIdentity).strict().nullable(),
  generation:z.object({mandateId:id,baselineDigest:hash,receiptManifestDigest:hash,positionsDigest:hash,positionSize:decimal}).strict(),
  carry:z.object({amount:nonnegative,revision:version}).strict(),fixedTradeClaim:z.boolean(),settledDependency:z.object({legId:id,certificateDigest:hash}).strict().nullable(),
  sourceReference:z.object({network,leaderAddress:addr,leaderEquity:positive.nullable(),leaderEquityObservedAt:integer.nullable(),midPrice:positive,midObservedAt:integer,maxDeviationBps:nonnegative}).strict().optional(),
  merged:z.object({members:z.array(z.object({sourceFillId:id,sourceDigest:hash,providerTime:integer,sign:z.union([z.literal(1),z.literal(-1)]),size:positive,px:positive,
    fraction:positive.refine(v=>Dec.from(v).lte(1)).nullable()}).strict()).min(2).max(MAX_MERGED_LEGS)}).strict().optional(),}).strict();
function requireSizing(value:unknown):asserts value {if(!value)throw new LiveBoundaryError('live_source_sizing_unproven');}
const SCALE=10n**18n;
/** Leader-time order of merged legs: time, then trade id (the fill id's last part). */
export function compareMergedLegs(a:{providerTime:number;sourceFillId:string},b:{providerTime:number;sourceFillId:string}):number{
  if(a.providerTime!==b.providerTime)return a.providerTime-b.providerTime;
  const tid=(id:string)=>{const last=id.split(':').at(-1)??'';return /^[0-9]{1,20}$/.test(last)?BigInt(last):-1n;},x=tid(a.sourceFillId),y=tid(b.sourceFillId);
  return x<y?-1:x>y?1:a.sourceFillId<b.sourceFillId?-1:a.sourceFillId>b.sourceFillId?1:0;
}
/** 1 − Π(1 − f): the fraction of the follower position that a run of leader
 * reductions removes together, floored at 18 decimals (exact rationals; any
 * full close makes it 1). */
export function combinedCloseFraction(fractions:readonly string[]):Dec{
  if(fractions.some(f=>Dec.from(f).gte(Dec.ONE)))return Dec.ONE;
  let n=1n,d=1n;
  for(const f of fractions){const [whole,part='']=Dec.from(f).toString().split('.'),den=10n**BigInt(part.length),num=BigInt(whole+part);n*=den-num;d*=den;}
  const remaining=(n*SCALE)/d,removed=SCALE-remaining;
  return Dec.from(`${removed/SCALE}.${(removed%SCALE).toString().padStart(18,'0')}`);
}
function fresh(at:number,now:number){requireSizing(Number.isSafeInteger(at)&&at>=0&&at<=now&&now-at<=5000);}
function equal(a:unknown,b:unknown){requireSizing(isDeepStrictEqual(a,b));}
/** Source-network references may be older than the 5 s provider frames: a mid is the
 * shared mainnet mids read (3 s cache), leader capital the paper sizing's
 * 60 s cache. Both stay bounded and are never used past these ages. */
export const SOURCE_MID_MAX_AGE_MS=10_000,SOURCE_EQUITY_MAX_AGE_MS=120_000;
/** Basis points by which the execution network's mid differs from the source network's mid. */
export function liveSourceDeviationBps(executionMid:string,sourceMid:string):Dec{
  const reference=Dec.from(sourceMid);requireSizing(reference.isPositive&&Dec.from(executionMid).isPositive);
  return Dec.from(executionMid).sub(reference).abs().mul(10000).div(reference);
}
/** Throws `live_source_price_deviation` when execution-network prices sit too far
 * from the source network to mirror its leader faithfully (e.g. testnet ZEC −90 % on 10-04). */
export function assertLiveSourcePrice(executionMid:string,reference:Pick<LiveSourceReferenceV1,'midPrice'|'maxDeviationBps'>):void{
  if(liveSourceDeviationBps(executionMid,reference.midPrice).gt(Dec.from(reference.maxDeviationBps)))throw new LiveBoundaryError('live_source_price_deviation');
}
/** Decode bounded JSON evidence without introducing an observation time. */
export function decodeLiveSourceSizingEnvelope(raw: unknown): LiveSourceSizingEnvelopeV1 {
  try{
    liveSourceDigest(raw);requireSizing(Buffer.byteLength(JSON.stringify(raw),'utf8')<=2*1024*1024);
    const envelope=structuredClone(raw) as LiveSourceSizingEnvelopeV1;
    requireSizing(envelope?.version===1&&Object.keys(envelope).sort().join(',')==='basis,observations,version'&&envelope.observations&&Object.keys(envelope.observations).sort().join(',')==='follower,generationManifest,leader,quote');
    const basis=basisSchema.parse(envelope.basis) as LiveSourceSizingBasisV1;assertMarketIdentity(basis.market);
    return freezeLiveReservation({...envelope,basis});
  }catch{throw new LiveBoundaryError('live_source_sizing_unproven');}
}
function snapshotMirror(snapshot:LiveSourceSizingEnvelopeV1['observations']['follower'],expected:LiveSourceSizingBasisV1['leader'],now:number,id:{accountId:string;strategyId:number},network:HyperliquidNetwork){
  requireSizing(expected&&expected.network===network);const view=mapLiveAccountView({accountId:id.accountId,strategyId:id.strategyId,network,accountAddress:expected.accountAddress},snapshot,{blocked:false,reason:null},now,5000);
  requireSizing(view.freshness==='fresh'&&view.coverage.complete&&view.coverage.balanceComplete&&view.coverage.orderComplete);
  equal({network:snapshot.network,accountAddress:snapshot.accountAddress,equity:snapshot.perpEquity,observedAt:snapshot.observedAt,completedAt:snapshot.completedAt,sourceDigest:snapshot.sourceDigest,snapshotDigest:followerReceiptDigestV1(snapshot)},expected);
}
/** Floor the exact rational once at the exchange lot. Intermediate 18dp
 * rounding must never round a ratio-sized opening above its allocation. */
function rationalSize(factors:readonly string[],divisors:readonly string[],dp:number):Dec{
  let n=10n**BigInt(dp),d=1n;
  const parts=(text:string)=>{const [whole,fraction='']=text.split('.');return {n:BigInt(whole+fraction),d:10n**BigInt(fraction.length)};};
  for(const factor of factors){const x=parts(factor);n*=x.n;d*=x.d;}
  for(const divisor of divisors){const x=parts(divisor);requireSizing(x.n>0);n*=x.d;d*=x.n;}
  const units=n/d,text=units.toString().padStart(dp+1,'0');return Dec.from(dp?`${text.slice(0,-dp)}.${text.slice(-dp)}`:text);
}
function conservativeLimit(mid:Dec,side:'B'|'A',slippage:string,szDecimals:number):Dec{
  const bound=slippedPx(mid,side,slippage);let price=roundPx(bound,szDecimals);
  if(side==='B'?price.gt(bound):price.lt(bound)){
    const [whole,fraction='']=price.toString().split('.'),magnitude=whole==='0'?-(fraction.search(/[1-9]/)+1):whole!.length-1;
    const dp=Math.max(0,Math.min(6-szDecimals,4-magnitude)),tick=Dec.from(dp?`0.${'0'.repeat(dp-1)}1`:'1');
    price=side==='B'?price.sub(tick):price.add(tick);
  }
  requireSizing(price.isPositive&&(side==='B'?price.lte(bound):price.gte(bound)));return price;
}
export function planLiveSourceOrder(raw: LiveSourcePlanInput): PlannedLiveSourceOrder {
  try{
    const input=structuredClone(raw),{mandate:m,now,limits,currentExecutionKey}=input,consent=decodeLiveCopyMandate(m),settings=copyStrategySettingsSchema.strict().parse(input.settings),envelope=decodeLiveSourceSizingEnvelope(input.sizingBasis),b=envelope.basis,o=envelope.observations;
    requireSizing(Number.isSafeInteger(now)&&now>0&&m.state==='active'&&m.consentDigest&&m.activationCursor&&m.expiresAt.getTime()>now&&isHyperliquidNetwork(consent.network)&&isHyperliquidNetwork(consent.sourceNetwork)&&
      settings.copyStartMode==='delta'&&consent.settingsDigest===liveCopySettingsDigest(settings)&&Number.isSafeInteger(limits.maxSignalAgeSeconds)&&limits.maxSignalAgeSeconds>0&&limits.maxSignalAgeSeconds<=86400&&
      Number.isFinite(limits.maxSlippageBps)&&limits.maxSlippageBps>=0&&limits.maxSlippageBps<=10000&&Dec.from(b.quote.slippageBps).lte(limits.maxSlippageBps)&&
      currentExecutionKey.startsWith(`${consent.network}:${consent.accountAddress}:`)&&/^0x[a-f0-9]{32}$/.test(currentExecutionKey.slice(`${consent.network}:${consent.accountAddress}:`.length)));
    const fill=decodeLiveSourceFill({...input.fill,normalized:{...input.fill.normalized},providerTime:new Date(input.fill.providerTime),receivedAt:new Date(input.fill.receivedAt)}),leg=canonicalLiveSourceLegs(fill).find(l=>l.leg===input.leg.leg);equal(leg,input.leg);requireSizing(leg);
    requireSizing(fill.network===consent.sourceNetwork&&fill.leaderAddress===consent.leaderAddress&&fill.providerTime>m.activationCursor!.getTime()&&fill.providerTime<=now&&now-fill.providerTime<=limits.maxSignalAgeSeconds*1000&&fill.receivedAt<=now&&
      b.mandateId===m.id&&b.mandateRevision===m.revision&&b.network===consent.network&&b.market.network===consent.network&&b.settingsDigest===consent.settingsDigest&&b.sourceFillId===fill.id&&b.sourceDigest===fill.sourceDigest&&b.accountAddress===consent.accountAddress&&
      b.coin===fill.coin&&b.leg===leg.leg&&b.direction===settings.direction&&b.sizingMode===settings.sizingMode&&b.budgetUsd===consent.budgetUsd&&b.perTradeUsd===(settings.perTradeUsd===null?null:Dec.from(settings.perTradeUsd).toString())&&
      b.market.coin===fill.coin&&b.follower.accountAddress===consent.accountAddress&&address(b.accountAddress)===b.accountAddress);
    for(const at of [b.market.observedAt,b.quote.observedAt,b.quote.completedAt,b.follower.observedAt,b.follower.completedAt])fresh(at,now);
    const {positionSize:_position,positionsDigest:_positions,...followerIdentity}=b.follower;snapshotMirror(o.follower,followerIdentity,now,consent,consent.network);
    const target=o.follower.positions.find(p=>p.coin===fill.coin);equal(b.follower.positionSize,target?.size??'0');
    const q=o.quote;requireSizing(q.network===consent.network&&q.accountAddress===consent.accountAddress&&q.coin===fill.coin&&q.asset===b.market.asset&&q.dex===b.market.dex);
    assertMarketIdentity(q.market);assertMarketIdentity(q.quote.market);equal(marketIdentityKey(q.market),marketIdentityKey(b.market));equal(marketIdentityKey(q.quote.market),marketIdentityKey(b.market));
    equal(b.quote,{midPrice:q.quote.midPrice,slippageBps:b.quote.slippageBps,observedAt:q.quote.observedAt,completedAt:q.completedAt,sourceDigest:q.quote.sourceDigest});
    requireSizing(b.quote.observedAt<=b.quote.completedAt&&q.earliestObservedAt<=q.quote.observedAt);fresh(q.earliestObservedAt,now);fresh(q.completedAt,now);
    const projection=projectLiveGenerationPositions({identity:{mandateId:m.id,mandateRevision:m.revision,accountId:consent.accountId,userId:consent.userId,strategyId:consent.strategyId,network:consent.network,accountAddress:consent.accountAddress,
      authorizationId:consent.authorizationId,settingsDigest:consent.settingsDigest,leaderAddress:consent.leaderAddress,direction:settings.direction},manifest:o.generationManifest,snapshot:o.follower,currentExecutionKey,now});
    equal(b.generation,{mandateId:m.id,baselineDigest:projection.baselineDigest,receiptManifestDigest:projection.receiptManifestDigest,positionsDigest:projection.positionsDigest,positionSize:projection.positions[fill.coin]??'0'});
    equal(b.follower.positionsDigest,projection.positionsDigest);equal(b.follower.positionSize,b.generation.positionSize);
    const carry=o.generationManifest.carry.filter(row=>row.mandateId===m.id&&row.coin===fill.coin);requireSizing(carry.length===1);equal(b.carry,{amount:carry[0]!.carry,revision:carry[0]!.revision});
    requireSizing(b.fixedTradeClaim===(leg.leg==='open'&&settings.sizingMode==='fixed'));
    const reference=b.sourceReference??null;
    // A reference (the source network's mid and leader capital) exists exactly
    // for an open whose leader trades on another network than this copy.
    requireSizing(consent.sourceNetwork!==consent.network&&leg.leg==='open'?reference!==null:reference===null);
    if(reference){
      requireSizing(reference.network===consent.sourceNetwork&&reference.leaderAddress===consent.leaderAddress&&reference.midObservedAt<=now&&now-reference.midObservedAt<=SOURCE_MID_MAX_AGE_MS&&
        (settings.sizingMode==='ratio')===(reference.leaderEquity!==null)&&(reference.leaderEquity===null)===(reference.leaderEquityObservedAt===null)&&
        (reference.leaderEquityObservedAt===null||reference.leaderEquityObservedAt<=now&&now-reference.leaderEquityObservedAt<=SOURCE_EQUITY_MAX_AGE_MS));
      assertLiveSourcePrice(b.quote.midPrice,reference);
    }
    // A merged adjustment: every leg is listed once, in leader-time order, the
    // order's own (the newest: its signal age is the order's) last and
    // exactly as its fill says; all share the coin's side and kind, are after
    // the cursor and at most MAX_ACCUMULATE_MS old.
    const merged=b.merged?.members??null,m_cursor=m.activationCursor!.getTime();
    if(merged){
      requireSizing(settings.sizingMode==='ratio'&&new Set(merged.map(m=>m.sourceFillId)).size===merged.length&&
        merged.every((m,i)=>i===0||compareMergedLegs(merged[i-1]!,m)<0)&&
        merged.every(m=>m.sign===leg.sign&&(m.fraction===null)===(leg.leg==='open')&&m.providerTime>m_cursor&&m.providerTime<=fill.providerTime&&now-m.providerTime<=limits.maxSignalAgeSeconds*1000)&&
        merged.at(-1)!.sourceFillId===fill.id);
      // Every leg is the persisted fill it names: its digest, time, price and
      // canonical leg (kind, side, size, fraction), on this copy's source
      // stream and coin. Only plain legs merge (a flip is its own orders).
      const persisted=new Map((input.members??[]).map(f=>{const d=decodeLiveSourceFill({...f,normalized:{...f.normalized},providerTime:new Date(f.providerTime),receivedAt:new Date(f.receivedAt)});return [d.id,d] as const;}));
      requireSizing(persisted.size===merged.length-1&&(input.members??[]).length===persisted.size);
      for(const member of merged){
        const source=member.sourceFillId===fill.id?fill:persisted.get(member.sourceFillId);requireSizing(source);
        const legs=canonicalLiveSourceLegs(source),own=legs.find(l=>l.leg===leg.leg);
        requireSizing(own&&source.sourceDigest===member.sourceDigest&&source.providerTime===member.providerTime&&source.px===member.px&&own.sign===member.sign&&own.size===member.size&&
          own.fraction===member.fraction&&source.network===consent.sourceNetwork&&source.leaderAddress===consent.leaderAddress&&source.streamId===fill.streamId&&source.coin===fill.coin&&
          (source.id===fill.id||legs.length===1));
      }
    }else requireSizing(!input.members?.length);
    let leaderEquity:string|null=null;
    if(leg.leg==='open'&&settings.sizingMode==='ratio'&&reference){
      requireSizing(b.leader===null&&o.leader===null);leaderEquity=reference.leaderEquity;
    }else if(leg.leg==='open'&&settings.sizingMode==='ratio'){
      requireSizing(b.leader&&o.leader&&b.leader.accountAddress===consent.leaderAddress);snapshotMirror(o.leader!,b.leader,now,{accountId:'leader',strategyId:consent.strategyId},consent.network);requireSizing(Dec.from(b.leader!.equity).isPositive);
      leaderEquity=b.leader!.equity;
    }else requireSizing(b.leader===null&&o.leader===null);
    const sign=followerSign(leg.sign,settings.direction),position=Dec.from(b.generation.positionSize),mid=Dec.from(b.quote.midPrice),side=leg.leg==='close'?(sign>0?'A':'B'):(sign>0?'B':'A');
    const price=conservativeLimit(mid,side,b.quote.slippageBps,b.market.sizeDecimals);
    let size:Dec,nextCarry=Dec.from(b.carry.amount),dependsOnLegId:string|null=null;
    if(leg.leg==='close'){
      requireSizing(position.sign===sign&&position.abs().gte(nextCarry)&&leg.fraction);
      const fraction=merged?combinedCloseFraction(merged.map(m=>m.fraction!)):Dec.from(leg.fraction!);
      const reduction=reduceWithCarry(position.abs(),fraction,nextCarry,b.market.sizeDecimals);size=floorSize(reduction.size,b.market.sizeDecimals);nextCarry=reduction.carry;
      requireSizing(b.settledDependency===null);
    }else{
      const close=canonicalLiveSourceLegs(fill).find(l=>l.leg==='close');
      if(close){dependsOnLegId=liveSourceLegId(m.id,fill.id,'close');requireSizing(position.isZero&&b.settledDependency?.legId===dependsOnLegId);
        const dependency=o.generationManifest.journals.find(j=>j.leg?.id===dependsOnLegId);requireSizing(dependency?.evidence?.settlementDigest===b.settledDependency?.certificateDigest&&dependency.leg?.state==='settled');
      }else requireSizing(b.settledDependency===null);
      requireSizing(position.isZero||position.sign===sign);
      // Budget buys at their maximum admitted execution price. A lower sell
      // limit must not enlarge the quantity above the owner's mid-price budget.
      // Floor at the exchange lot; minimum-notional admission remains separate
      // and must never round up or silently exceed the signed owner budget.
      if(settings.sizingMode==='fixed')size=rationalSize([b.perTradeUsd!],[Dec.max(mid,price).toString()],b.market.sizeDecimals);
      // Leader notional (source-network fill price) scaled by capital, then
      // converted to the follower's coins at the EXECUTION network's mid. A merged
      // adjustment sums its legs' leader notional (exact decimal products).
      else{requireSizing(leaderEquity);const notional=merged?Dec.sum(merged.map(m=>Dec.from(m.size).mul(m.px))).toString():null;
        size=rationalSize([...(notional?[notional]:[leg.size,fill.px]),Dec.min(Dec.from(b.follower.equity),Dec.from(b.budgetUsd)).toString()],[leaderEquity,b.quote.midPrice],b.market.sizeDecimals);}
    }
    requireSizing(size.isPositive);
    return freezeLiveReservation({plannerVersion:1,legId:liveSourceLegId(m.id,fill.id,leg.leg),sourceDigest:fill.sourceDigest,settingsDigest:consent.settingsDigest,sizingBasis:envelope,
      order:{coin:fill.coin,asset:b.market.asset,side,size:size.toString(),limitPrice:price.toString(),sizeDecimals:b.market.sizeDecimals,reduceOnly:leg.leg==='close',timeInForce:'Ioc'},nextCarry:nextCarry.toString(),fixedTradeClaim:b.fixedTradeClaim,dependsOnLegId});
  }catch(error){
    // A price refusal keeps its own reason; every other doubt is unproven sizing.
    if(error instanceof LiveBoundaryError&&error.code==='live_source_price_deviation')throw error;
    throw new LiveBoundaryError('live_source_sizing_unproven');
  }
}
export const recomputeLiveSourceSizing = planLiveSourceOrder;
