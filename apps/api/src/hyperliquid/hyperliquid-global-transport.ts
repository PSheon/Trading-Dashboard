import {AsyncLocalStorage} from 'node:async_hooks';
import {setTimeout as wait} from 'node:timers/promises';
import {sharedRestRetryAfterMs} from './hyperliquid-capacity-error.js';
import type {HyperliquidRestLane} from './hyperliquid-global-quota.js';
import {PostgresHyperliquidQuota,type BoundHyperliquidQuota} from './postgres-hyperliquid-quota.js';
import {assertOriginalLiveRiskSession,type LiveRiskDatabaseSession} from '../copy/live/postgres-live-risk-scope.js';
import {LiveBoundaryError} from '../copy/live/wallet-authorization.js';
const fail=(code:string):never=>{throw new LiveBoundaryError(code);};
const cheap=new Set(['l2Book','allMids','clearinghouseState','orderStatus','spotClearinghouseState','exchangeStatus']);
const ordinary=new Set(['meta','perpDexs','metaAndAssetCtxs','spotMeta','spotMetaAndAssetCtxs','userAbstraction','userDexAbstraction','delegatorSummary','portfolio','referral','frontendOpenOrders','openOrders','allPerpMetas','activeAssetData','userFees','extraAgents','maxBuilderFee']);
// Prepay the provider's bounded list cap. The global meter never refunds an
// unused surcharge; local RequestBudgeter adjustments remain scheduling only.
/** Longest an unlabelled request waits in all for shared REST capacity: within
 * a trader page's 12 s deadline, with room for the call itself. */
export const PAGE_CAPACITY_WAIT_MS=6_000;
/** Longest a snapshot or sweep of watched leaders waits in all for room in
 * the background lane (within the info client's 20 s request timeout). */
export const ESSENTIAL_CAPACITY_WAIT_MS=15_000;
/** Longest a trade-analytics read (a background job a page started, never
 * the page's own request) waits in all for room in the background lane. */
export const ANALYTICS_CAPACITY_WAIT_MS=40_000;
const lists=new Set(['recentTrades','userFillsByTime','userFills','userTwapSliceFills','userTwapSliceFillsByTime','userFunding','userNonFundingLedgerUpdates']);
/** An answered list call's settlement hook, by its response. */
const listSettlements=new WeakMap<Response,(units:number)=>void>();
/** A list call's real weight once its items are counted (the provider's 20 +
 * 1 per 20 items, at most the 120 prepaid): lowers the shared meter's charge
 * with this process's next request, so a short list (a TWAP history, an
 * address with few fills) no longer holds 120 of the window for a minute. */
export function settleListAnswer(response:Response,items:number):void {
 if(!Number.isSafeInteger(items)||items<0)return;
 listSettlements.get(response)?.(Math.min(120,20+Math.ceil(items/20)));
}
/** Fixed-origin actual dispatch. Original-session context is private and may
 * never be replaced with an unscoped SQL transaction while locks are held. */
export class HyperliquidGlobalTransport {
 readonly #original=new AsyncLocalStorage<LiveRiskDatabaseSession>();
 readonly #unscoped=Object.freeze({});
 private readonly options:Readonly<{egressKey?:string;ownerId:string}>;
 constructor(private readonly quota:PostgresHyperliquidQuota,options:{egressKey?:string;ownerId:string},private readonly rawFetch:typeof fetch=fetch,private readonly now=Date.now,
  private readonly sleep:(ms:number,signal?:AbortSignal|null)=>Promise<void>=(ms,signal)=>wait(ms,undefined,signal?{signal}:undefined)){
  if(!(quota instanceof PostgresHyperliquidQuota)||!options||typeof options.ownerId!=='string'||!/^[^\s\p{Cc}\p{Cf}]{1,128}$/u.test(options.ownerId))fail('hyperliquid_quota_invalid');
  if(options.egressKey!==undefined&&!/^[A-Za-z0-9:._-]{1,128}$/.test(options.egressKey))fail('hyperliquid_quota_invalid');
  this.options=Object.freeze({...options});
 }
 currentQuota():BoundHyperliquidQuota {
  const egressKey=this.options.egressKey;if(!egressKey)return fail('hyperliquid_quota_egress_unconfigured');
  const binding={egressKey,ownerId:this.options.ownerId},session=this.#original.getStore();
  return session?this.quota.bindOriginal(session,binding):this.quota.bindUnscoped(binding);
 }
 contextIdentity():object {const session=this.#original.getStore();if(session)assertOriginalLiveRiskSession(session);return session??this.#unscoped;}
 isOriginal():boolean {const session=this.#original.getStore();if(session)assertOriginalLiveRiskSession(session);return session!==undefined;}
 async runOriginal<T>(session:LiveRiskDatabaseSession,work:()=>Promise<T>):Promise<T>{
  assertOriginalLiveRiskSession(session);const prior=this.#original.getStore();if(prior&&prior!==session)fail('live_risk_serialization_lost');
  const result=await this.#original.run(session,work);assertOriginalLiveRiskSession(session);return result;
 }
 readonly fetchExplorer:typeof fetch=async(input,init)=>{
  const budget=this.currentQuota(),url=typeof input==='string'?input:input instanceof URL?input.toString():'';
  if(!['https://rpc.hyperliquid.xyz/explorer','https://rpc.hyperliquid-testnet.xyz/explorer'].includes(url)||!init||init.method!=='POST'||typeof init.body!=='string'||Buffer.byteLength(init.body)>1024)return fail('hyperliquid_quota_request_invalid');
  let body:unknown;try{body=JSON.parse(init.body);}catch{fail('hyperliquid_quota_request_invalid');}
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='hash,type'||(body as {type:unknown}).type!=='txDetails'||!/^0x[0-9a-f]{64}$/.test((body as {hash:string}).hash))fail('hyperliquid_quota_request_invalid');
  const captured:RequestInit={method:'POST',body:init.body,headers:new Headers(init.headers),redirect:'error',signal:init.signal};captured.signal?.throwIfAborted();
  const permit=await budget.acquireRest(40,this.now()+5000);return permit.dispatch(()=>{captured.signal?.throwIfAborted();return this.rawFetch(url,captured);});
 };
 /** Unlabelled info request (live copy work, wallet and operator calls): may
  * use the whole shared window; refused at once when it is full. */
 readonly fetchInfo:typeof fetch=(input,init)=>this.#info(input,init,undefined,false);
 /** A page's info request: the whole window too, and when it is full it
  * waits for the charges ahead of it to expire (at most
  * PAGE_CAPACITY_WAIT_MS in all, never past its own signal) instead of
  * answering the page "busy" at once. */
 readonly fetchPageInfo:typeof fetch=(input,init)=>this.#info(input,init,undefined,true);
 /** Background info request (`HyperliquidRestLane`): capped below the window
  * so pages and live work keep room; refused at once when it is full. */
 readonly fetchBackgroundInfo:typeof fetch=(input,init)=>this.#info(input,init,'background',false);
 /** Snapshots and sweeps of watched leaders: the background lane, but when
  * it is full they wait for the charges ahead of them to expire (at most
  * ESSENTIAL_CAPACITY_WAIT_MS) instead of failing at once, so the pool's
  * and history's loops, which fail and retry next minute, cannot keep the
  * watched leaders' fills and figures from advancing. */
 readonly fetchEssentialInfo:typeof fetch=(input,init)=>this.#info(input,init,'background',true,ESSENTIAL_CAPACITY_WAIT_MS);
 /** A trade-analytics read: the background lane, waiting (longer) for room.
  * A cold trader's history is up to 32 list calls; in the page lane they
  * could prepay the whole window and leave the next cold page's profile,
  * fills and activity no room (503), so they never take the room above
  * HYPERLIQUID_BACKGROUND_REST_CAP that pages keep. */
 readonly fetchAnalyticsInfo:typeof fetch=(input,init)=>this.#info(input,init,'background',true,ANALYTICS_CAPACITY_WAIT_MS);
 async #acquire(budget:BoundHyperliquidQuota,weight:number,lane:HyperliquidRestLane|undefined,waitForCapacity:boolean,signal:AbortSignal|null|undefined,maxWaitMs=PAGE_CAPACITY_WAIT_MS){
  const giveUpAt=this.now()+maxWaitMs;
  for(;;){
   try{return await (lane===undefined?budget.acquireRest(weight,this.now()+5000):budget.acquireRest(weight,this.now()+5000,lane));}
   catch(error){
    const wait=waitForCapacity?sharedRestRetryAfterMs(error):undefined;
    if(wait===undefined||this.now()+wait>giveUpAt)throw error;
    signal?.throwIfAborted();await this.sleep(wait,signal);signal?.throwIfAborted();
   }
  }
 }
 /** The url, type and provider weight of one info request, or a refusal. */
 #infoRequest(input:Parameters<typeof fetch>[0],init:Parameters<typeof fetch>[1]):{url:string;type:string;weight:number;body:string}{
  const url=typeof input==='string'?input:input instanceof URL?input.toString():'';
  if(!['https://api.hyperliquid.xyz/info','https://api.hyperliquid-testnet.xyz/info'].includes(url)||!init||init.method!=='POST'||typeof init.body!=='string'||Buffer.byteLength(init.body)>65536)return fail('hyperliquid_quota_request_invalid');
  let parsed:unknown;try{parsed=JSON.parse(init.body);}catch{fail('hyperliquid_quota_request_invalid');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||!Object.hasOwn(parsed,'type')||typeof (parsed as {type:unknown}).type!=='string')fail('hyperliquid_quota_request_invalid');
  const type=(parsed as {type:string}).type,weight=cheap.has(type)?2:type==='userRole'?60:ordinary.has(type)?20:lists.has(type)?120:type==='candleSnapshot'?104:0;
  if(!weight)fail('hyperliquid_quota_request_invalid');
  return {url,type,weight,body:init.body};
 }
 /**
  * Several unlabelled info reads charged to the shared meter as ONE charge
  * (their summed weight, one meter transaction) and sent together. When the
  * window is full it waits for room, at most `maxWaitMs` and never past
  * `signal`, before anything is sent. `onDispatch` runs right before the
  * reads go out, inside the permit: an evidence clock starts there, after
  * every wait, and its signal (if any) bounds the reads. Lists (settled
  * afterwards) are not accepted here.
  */
 async fetchInfoBatch(url:string,bodies:readonly Readonly<Record<string,unknown>>[],{maxWaitMs,signal,onDispatch}:{maxWaitMs:number;signal?:AbortSignal;onDispatch?:()=>AbortSignal|undefined}):Promise<Response[]>{
  const budget=this.currentQuota();
  if(!Array.isArray(bodies)||bodies.length<1||bodies.length>16||!Number.isSafeInteger(maxWaitMs)||maxWaitMs<0||maxWaitMs>ESSENTIAL_CAPACITY_WAIT_MS)return fail('hyperliquid_quota_request_invalid');
  const requests=bodies.map(body=>this.#infoRequest(url,{method:'POST',body:JSON.stringify(body)}));
  if(requests.some(r=>lists.has(r.type)))fail('hyperliquid_quota_request_invalid');
  const weight=requests.reduce((sum,r)=>sum+r.weight,0);
  signal?.throwIfAborted();const permit=await this.#acquire(budget,weight,undefined,maxWaitMs>0,signal,maxWaitMs);signal?.throwIfAborted();
  return permit.dispatch(()=>{
   signal?.throwIfAborted();const bound=onDispatch?.(),signals=[signal,bound].filter((s):s is AbortSignal=>s!==undefined);
   const shared=signals.length>1?AbortSignal.any(signals):signals[0];
   const work=requests.map(r=>this.rawFetch(r.url,{method:'POST',body:r.body,headers:new Headers({'Content-Type':'application/json'}),redirect:'error',signal:shared}));
   return Promise.all(work);
  });
 }
 async #info(input:Parameters<typeof fetch>[0],init:Parameters<typeof fetch>[1],lane:HyperliquidRestLane|undefined,waitForCapacity:boolean,maxWaitMs=PAGE_CAPACITY_WAIT_MS):Promise<Response>{
  // Configuration is checked before parsing or scheduling any outbound work.
  const budget=this.currentQuota(),{url,type,weight}=this.#infoRequest(input,init);
  if(!init)return fail('hyperliquid_quota_request_invalid');
  const captured:RequestInit={method:'POST',body:init.body,headers:new Headers(init.headers),redirect:'error',signal:init.signal};
  captured.signal?.throwIfAborted();const permit=await this.#acquire(budget,weight,lane,waitForCapacity,captured.signal,maxWaitMs);captured.signal?.throwIfAborted();
  const response=await permit.dispatch(()=>{captured.signal?.throwIfAborted();return this.rawFetch(url,captured);});
  if(lists.has(type)&&permit.settle&&response instanceof Response)listSettlements.set(response,permit.settle);
  return response;
 }
}
