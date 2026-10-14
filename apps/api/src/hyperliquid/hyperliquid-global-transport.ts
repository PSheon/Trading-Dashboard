import {AsyncLocalStorage} from 'node:async_hooks';
import {setTimeout as wait} from 'node:timers/promises';
import {HyperliquidRestCapacityError,REST_CHARGE_LIFETIME_MS,sharedRestRetryAfterMs} from './hyperliquid-capacity-error.js';
import {HYPERLIQUID_LIVE_DEMAND_HOLD_MS,HYPERLIQUID_MAX_LIVE_DEMAND,type HyperliquidMeterComposition,type HyperliquidRestLane} from './hyperliquid-global-quota.js';
import {PostgresHyperliquidQuota,newLiveLaneToken,runInBackgroundLane,runInLiveLane,runInSetupLane,setupLaneToken,type BoundHyperliquidQuota,type HyperliquidMeterSnapshot,type HyperliquidSendPermit} from './postgres-hyperliquid-quota.js';
import {assertOriginalLiveRiskSession,type LiveRiskDatabaseSession} from '../copy/live/postgres-live-risk-scope.js';
import {LiveBoundaryError} from '../copy/live/wallet-authorization.js';
import {infoListSurcharge,infoPrepaidWeight,infoWeight} from './info-weights.js';
import {liveSpan,timedLiveSpan} from '../copy/live/live-execution-diagnostics.js';
import {foreignUsage as processForeignUsage,isWsRateLimit,restWindowUse,wsWindowUse,type ForeignUsageCounter} from './foreign-usage.js';
const fail=(code:string):never=>{throw new LiveBoundaryError(code);};
// The requests this process may send (any other is refused, never guessed);
// their weights come from the one table (info-weights.ts).
const cheap=new Set(['l2Book','allMids','clearinghouseState','orderStatus','spotClearinghouseState','exchangeStatus']);
const ordinary=new Set(['userRole','meta','perpDexs','metaAndAssetCtxs','spotMeta','spotMetaAndAssetCtxs','userAbstraction','userDexAbstraction','delegatorSummary','portfolio','referral','frontendOpenOrders','openOrders','allPerpMetas','activeAssetData','userFees','extraAgents','maxBuilderFee']);
// Prepay the provider's bounded list cap. The global meter never refunds an
// unused surcharge; local RequestBudgeter adjustments remain scheduling only.
/** A live order still waiting for room records its demand again this
 * often, well inside its HYPERLIQUID_LIVE_DEMAND_HOLD_MS. */
export const LIVE_DEMAND_RENEW_MS=HYPERLIQUID_LIVE_DEMAND_HOLD_MS-5_000;
/** Longest an unlabelled request waits in all for shared REST capacity: within
 * a trader page's 12 s deadline, with room for the call itself. */
export const PAGE_CAPACITY_WAIT_MS=6_000;
/** Longest a snapshot or sweep of watched leaders waits in all for room in
 * the background lane (within the info client's 20 s request timeout). */
export const ESSENTIAL_CAPACITY_WAIT_MS=15_000;
/** Longest a trade-analytics read (a background job a page started, never
 * the page's own request) waits in all for room in the background lane: two
 * charge lifetimes, so it outlasts the full page its own computation sent
 * just before it and one more list of another process's background job.
 * On Stage (lane 400, ~250 of the window held by live and page reads) the
 * lane holds one full list (120) at a time: at 40 s a cold dense trader's
 * second page could never wait out the first one's 65 s, the computation
 * failed, and every retry of the page answered 503 busy (2026-10-07). The
 * info client sends this process's analytics reads one at a time, so they
 * don't race each other for that room. */
export const ANALYTICS_CAPACITY_WAIT_MS=2*REST_CHARGE_LIFETIME_MS;
const lists=new Set(['recentTrades','userFillsByTime','userFills','userTwapSliceFills','userTwapSliceFillsByTime','userFunding','userNonFundingLedgerUpdates']);
const sendable=new Set([...cheap,...ordinary,...lists,'candleSnapshot']);
/** A list's prepaid weight (20 + its largest answer's 100). */
const LIST_PREPAID=infoPrepaidWeight({type:'userFills'});
/** The request types this transport sends, for the weight-table agreement test. */
export const TRANSPORT_INFO_TYPES:readonly string[]=Object.freeze([...sendable]);
/** An answered list call's settlement hook, by its response. */
const listSettlements=new WeakMap<Response,(units:number)=>void>();
/** A list call's real weight once its items are counted (the provider's 20 +
 * 1 per 20 items, at most the 120 prepaid): lowers the shared meter's charge
 * with this process's next request, so a short list (a TWAP history, an
 * address with few fills) no longer holds 120 of the window for a minute. */
export function settleListAnswer(response:Response,items:number):void {
 if(!Number.isSafeInteger(items)||items<0)return;
 listSettlements.get(response)?.(Math.min(LIST_PREPAID,infoWeight({type:'userFills'})+infoListSurcharge('userFills',items)));
}
/** Fixed-origin actual dispatch. Original-session context is private and may
 * never be replaced with an unscoped SQL transaction while locks are held. */
export class HyperliquidGlobalTransport {
 readonly #original=new AsyncLocalStorage<LiveRiskDatabaseSession>();
 readonly #unscoped=Object.freeze({});
 private readonly options:Readonly<{egressKey?:string;ownerId:string}>;
 constructor(private readonly quota:PostgresHyperliquidQuota,options:{egressKey?:string;ownerId:string},private readonly rawFetch:typeof fetch=fetch,private readonly now=Date.now,
  private readonly sleep:(ms:number,signal?:AbortSignal|null)=>Promise<void>=(ms,signal)=>wait(ms,undefined,signal?{signal}:undefined),
  /** Where this transport's rate limits are counted (foreign-usage.ts; tests pass their own). */
  private readonly foreignUsage:ForeignUsageCounter=processForeignUsage){
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
 /** A copy setup about to run a step of `weight` (its provider weight in the
  * next minute): records the setup's demand on the shared meter, so
  * background leaves the setups' share free (HYPERLIQUID_SETUP_REST_CAP), and
  * answers in how many ms that weight fits in the setup lane (0: now, and
  * the step's weight stays free for it while it runs). `key`: the setup's id
  * (its earlier charges never count against its own share). Nothing is sent.
  * `connects`: the step's socket connects, held with it. `queue`: only its
  * place in the queue (while it still waits for its local bucket): never
  * granted, nothing held. */
 async claimSetup(weight:number,key?:string,observe?:(meter:HyperliquidMeterComposition)=>void,connects?:number,queue?:boolean):Promise<number>{
  if(this.isOriginal())fail('hyperliquid_quota_invalid');
  const budget=this.currentQuota();
  return budget.claimSetupRest?budget.claimSetupRest(weight,this.now()+5000,key===undefined?undefined:setupLaneToken(key),observe,connects,queue):0;
 }
 /** A copy setup's step is over: what its granted claim still holds (`key`:
  * the setup's id, as claimed) goes back to the shared window. */
 async releaseSetup(key:string):Promise<void>{
  if(this.isOriginal())fail('hyperliquid_quota_invalid');
  const budget=this.currentQuota();
  await budget.releaseSetupRest?.(setupLaneToken(key),this.now()+5000);
 }
 /** Runs work nobody waits for through clients shared with live or setup
  * work: its charges are background (runInBackgroundLane). */
 runBackground<T>(work:()=>Promise<T>):Promise<T>{return runInBackgroundLane(work);}
 /** Runs a copy setup's step: its unlabelled REST charges go in the setup
  * lane (`key`: the setup's id, as claimed). */
 runSetup<T>(work:()=>Promise<T>,key?:string):Promise<T>{return runInSetupLane(work,key===undefined?undefined:setupLaneToken(key));}
 /**
  * A live order's need (`weight`: its evidence reads, risk gates, transport
  * check and POST), announced on the shared meter before its SQL locks:
  * from then on setups, background and unlabelled work leave what it still
  * needs free, and the room that frees up is its first. Waits (recording the
  * demand again every LIVE_DEMAND_RENEW_MS) until it fits; answers its token
  * (run the order in runLive(token)). Throws HyperliquidRestCapacityError
  * when it won't fit before `giveUpAt`. Undefined when this meter records no
  * demand: the order runs as before. Nothing is sent.
  */
 async claimLive(weight:number,giveUpAt:number):Promise<string|undefined>{
  if(this.isOriginal()||!Number.isFinite(weight)||weight<1||!Number.isFinite(giveUpAt))fail('hyperliquid_quota_invalid');
  const budget=this.currentQuota();if(!budget.claimLiveRest)return undefined;
  const token=newLiveLaneToken(),need=Math.min(HYPERLIQUID_MAX_LIVE_DEMAND,Math.ceil(weight));
  for(;;){
   let wait:number;
   try{wait=await budget.claimLiveRest(need,this.now()+5000,token);}
   catch(error){const retry=sharedRestRetryAfterMs(error);if(retry===undefined)throw error;wait=retry;}
   if(wait<=0)return token;
   if(this.now()+wait>giveUpAt)throw new HyperliquidRestCapacityError(Math.min(REST_CHARGE_LIFETIME_MS,Math.max(1,Math.ceil(wait))));
   await this.sleep(Math.min(wait,LIVE_DEMAND_RENEW_MS));
  }
 }
 /** A worker running live copies: records that one order's need (`weight`,
  * its heaviest evidence) is kept free on the shared meter for
  * HYPERLIQUID_LIVE_STANDBY_HOLD_MS, so an order that comes finds it free
  * instead of waiting for background's charges to expire. Nothing is sent
  * or waited for; a meter without standbys ignores it. */
 async standbyLive(weight:number):Promise<void>{
  if(this.isOriginal()||!Number.isSafeInteger(weight)||weight<1)fail('hyperliquid_quota_invalid');
  await this.currentQuota().standbyLiveRest?.(Math.min(HYPERLIQUID_MAX_LIVE_DEMAND,weight),this.now()+5000);
 }
 /** The shared meter's setup and live lanes on this transport's egress
  * (heartbeat): undefined when no egress is configured. */
 async laneStatus():Promise<Awaited<ReturnType<PostgresHyperliquidQuota['laneStatus']>>|undefined>{
  const egressKey=this.options.egressKey;return egressKey?this.quota.laneStatus(egressKey):undefined;
 }
 /** The shared meter on this transport's egress as it stands (diagnostics:
  * a plain read, no lock); undefined when no egress is configured. */
 async meterSnapshot():Promise<HyperliquidMeterSnapshot|undefined>{
  const egressKey=this.options.egressKey;return egressKey?this.quota.meterSnapshot(egressKey):undefined;
 }
 /** Runs a live order under its demand token: its charges are the live lane's and count against its need. */
 runLive<T>(token:string,work:()=>Promise<T>):Promise<T>{return runInLiveLane(token,work);}
 /**
  * Hyperliquid refused a request of this egress for its rate limit (`rest`:
  * an HTTP 429; `ws`: a WebSocket rate-limit error): reads our own meter's
  * share of that window and counts `foreign_usage_suspected` below 80 %
  * (foreign-usage.ts). Never throws, never delays the caller.
  */
 async noteRateLimited(kind:'rest'|'ws'):Promise<boolean>{
  const egressKey=this.options.egressKey;if(!egressKey)return false;
  let use:number|undefined;
  try{const snapshot=await this.quota.meterSnapshot(egressKey);use=kind==='rest'?restWindowUse(snapshot):wsWindowUse(snapshot);}catch{use=undefined;}
  return this.foreignUsage.note(egressKey,kind==='rest'?'429':'ws_rate_limit',use);
 }
 /** A WebSocket `error` channel message on this egress: a rate limit is noted (noteRateLimited). */
 noteWsError(data:unknown):void{if(isWsRateLimit(data))void this.noteRateLimited('ws').catch(()=>{});}
 /** Looks at what a dispatched REST send answered (a Response, a list of
  * them, or a promise of either) for a 429, without changing it. */
 #watch<T>(result:T):T{
  const seen=(value:unknown)=>{const answers=Array.isArray(value)?value:[value];if(answers.some(a=>(a as {status?:unknown}|null)?.status===429))void this.noteRateLimited('rest').catch(()=>{});};
  if(result&&typeof (result as {then?:unknown}).then==='function')(result as unknown as Promise<unknown>).then(seen,()=>{});else seen(result);
  return result;
 }
 readonly fetchExplorer:typeof fetch=async(input,init)=>{
  const budget=this.currentQuota(),url=typeof input==='string'?input:input instanceof URL?input.toString():'';
  if(!['https://rpc.hyperliquid.xyz/explorer','https://rpc.hyperliquid-testnet.xyz/explorer'].includes(url)||!init||init.method!=='POST'||typeof init.body!=='string'||Buffer.byteLength(init.body)>1024)return fail('hyperliquid_quota_request_invalid');
  let body:unknown;try{body=JSON.parse(init.body);}catch{fail('hyperliquid_quota_request_invalid');}
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='hash,type'||(body as {type:unknown}).type!=='txDetails'||!/^0x[0-9a-f]{64}$/.test((body as {hash:string}).hash))fail('hyperliquid_quota_request_invalid');
  const captured:RequestInit={method:'POST',body:init.body,headers:new Headers(init.headers),redirect:'error',signal:init.signal};captured.signal?.throwIfAborted();
  const permit=await budget.acquireRest(40,this.now()+5000,undefined,{fallback:'live'});return this.#watch(permit.dispatch(()=>{captured.signal?.throwIfAborted();return this.rawFetch(url,captured);}));
 };
 /**
  * The permit for one exchange POST (1 unit): an order, a cancel, a
  * leverage update, a deposit, return, refund or withdrawal (usdSend,
  * withdraw3), an account-mode or agent approval. Real money or an account
  * action: the live lane (a setup step's stays its setup's), so a full
  * background lane or a waiting setup never leaves it not dispatched.
  */
 async acquireExchange(deadline:number):Promise<HyperliquidSendPermit>{
  const permit=await this.currentQuota().acquireRest(1,deadline,undefined,{fallback:'live'});
  // Its answer is looked at for a 429 (foreign_usage_suspected), never changed.
  return Object.freeze({...permit,dispatch:<T>(work:()=>T):T=>this.#watch(permit.dispatch(work))});
 }
 /** Live copy work's info request: an order's evidence outside its session,
  * settlement and receipts that release its reservation, closes and stops,
  * the testnet leader source, funding evidence, wallet authorization checks
  * (a setup step's reads stay the setup's). The live lane: the whole window,
  * ahead of setups, pages and background; refused at once when it is full. */
 readonly fetchInfo:typeof fetch=(input,init)=>this.#info(input,init,undefined,false,PAGE_CAPACITY_WAIT_MS,'live');
 /** A page's info request (`page` lane): the whole window less what live
  * orders and granted setup claims need, held back for a waiting setup at
  * most HYPERLIQUID_PAGE_HOLD_MS; when it is full it waits for the charges
  * ahead of it to expire (at most PAGE_CAPACITY_WAIT_MS in all, never past
  * its own signal) instead of answering the page "busy" at once. */
 readonly fetchPageInfo:typeof fetch=(input,init)=>this.#info(input,init,'page',true);
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
 async #acquire(budget:BoundHyperliquidQuota,weight:number,lane:HyperliquidRestLane|undefined,waitForCapacity:boolean,signal:AbortSignal|null|undefined,maxWaitMs=PAGE_CAPACITY_WAIT_MS,fallback?:HyperliquidRestLane){
  const asked=this.now(),giveUpAt=asked+maxWaitMs;
  for(;;){
   // A page says how long it has waited (the meter holds it back for a waiting setup at most HYPERLIQUID_PAGE_HOLD_MS).
   const options=lane==='page'?{heldMs:this.now()-asked}:fallback?{fallback}:undefined;
   try{return await (options?budget.acquireRest(weight,this.now()+5000,lane,options):lane===undefined?budget.acquireRest(weight,this.now()+5000):budget.acquireRest(weight,this.now()+5000,lane));}
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
  const type=(parsed as {type:string}).type,weight=sendable.has(type)?infoPrepaidWeight({type}):0;
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
  return this.#sendInfoBatch(url,bodies,{maxWaitMs,signal,onDispatch},undefined,16,'live');
 }
 /** Complete background snapshots keep the capped background lane. A denial
  * happens before any venue is sent; this never borrows live/page capacity.
  * An imminent release may be awaited within the existing essential bound. */
 async fetchBackgroundInfoBatch(url:string,bodies:readonly Readonly<Record<string,unknown>>[],{signal,onDispatch}:{signal?:AbortSignal;onDispatch?:()=>AbortSignal|undefined}={}):Promise<Response[]>{
  return this.#sendInfoBatch(url,bodies,{maxWaitMs:ESSENTIAL_CAPACITY_WAIT_MS,signal,onDispatch},'background',64);
 }
 async #sendInfoBatch(url:string,bodies:readonly Readonly<Record<string,unknown>>[],{maxWaitMs,signal,onDispatch}:{maxWaitMs:number;signal?:AbortSignal;onDispatch?:()=>AbortSignal|undefined},lane:HyperliquidRestLane|undefined,limit:number,fallback?:HyperliquidRestLane):Promise<Response[]>{
  const budget=this.currentQuota();
  if(!Array.isArray(bodies)||bodies.length<1||bodies.length>limit||!Number.isSafeInteger(maxWaitMs)||maxWaitMs<0||maxWaitMs>ESSENTIAL_CAPACITY_WAIT_MS)return fail('hyperliquid_quota_request_invalid');
  const requests=bodies.map(body=>this.#infoRequest(url,{method:'POST',body:JSON.stringify(body)}));
  if(requests.some(r=>lists.has(r.type)))fail('hyperliquid_quota_request_invalid');
  const weight=requests.reduce((sum,r)=>sum+r.weight,0);
  signal?.throwIfAborted();const permit=await timedLiveSpan('rest_wave_quota',()=>this.#acquire(budget,weight,lane,maxWaitMs>0,signal,maxWaitMs,fallback));signal?.throwIfAborted();
  return this.#watch(permit.dispatch(()=>{
   signal?.throwIfAborted();const bound=onDispatch?.(),signals=[signal,bound].filter((s):s is AbortSignal=>s!==undefined);
   const shared=signals.length>1?AbortSignal.any(signals):signals[0];
   const work=requests.map(r=>this.rawFetch(r.url,{method:'POST',body:r.body,headers:new Headers({'Content-Type':'application/json'}),redirect:'error',signal:shared}));
   const answered=liveSpan('rest_wave_http');return Promise.all(work).finally(()=>answered());
  }));
 }
 async #info(input:Parameters<typeof fetch>[0],init:Parameters<typeof fetch>[1],lane:HyperliquidRestLane|undefined,waitForCapacity:boolean,maxWaitMs=PAGE_CAPACITY_WAIT_MS,fallback?:HyperliquidRestLane):Promise<Response>{
  // Configuration is checked before parsing or scheduling any outbound work.
  const budget=this.currentQuota(),{url,type,weight}=this.#infoRequest(input,init);
  if(!init)return fail('hyperliquid_quota_request_invalid');
  const captured:RequestInit={method:'POST',body:init.body,headers:new Headers(init.headers),redirect:'error',signal:init.signal};
  captured.signal?.throwIfAborted();const permit=await this.#acquire(budget,weight,lane,waitForCapacity,captured.signal,maxWaitMs,fallback);captured.signal?.throwIfAborted();
  const response=await this.#watch(permit.dispatch(()=>{captured.signal?.throwIfAborted();return this.rawFetch(url,captured);}));
  if(lists.has(type)&&permit.settle&&response instanceof Response)listSettlements.set(response,permit.settle);
  return response;
 }
}
