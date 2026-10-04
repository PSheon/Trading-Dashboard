import {AsyncLocalStorage} from 'node:async_hooks';
import {PostgresHyperliquidQuota,type BoundHyperliquidQuota} from './postgres-hyperliquid-quota.js';
import {assertOriginalLiveRiskSession,type LiveRiskDatabaseSession} from '../copy/live/postgres-live-risk-scope.js';
import {LiveBoundaryError} from '../copy/live/wallet-authorization.js';
const fail=(code:string):never=>{throw new LiveBoundaryError(code);};
const cheap=new Set(['l2Book','allMids','clearinghouseState','orderStatus','spotClearinghouseState','exchangeStatus']);
const ordinary=new Set(['meta','perpDexs','metaAndAssetCtxs','spotMeta','spotMetaAndAssetCtxs','userAbstraction','userDexAbstraction','delegatorSummary','portfolio','referral','frontendOpenOrders','allPerpMetas','activeAssetData','userFees','extraAgents','maxBuilderFee']);
// Prepay the provider's bounded list cap. The global meter never refunds an
// unused surcharge; local RequestBudgeter adjustments remain scheduling only.
const lists=new Set(['recentTrades','userFillsByTime','userFills','userTwapSliceFills','userTwapSliceFillsByTime','userFunding','userNonFundingLedgerUpdates']);
/** Fixed-origin actual dispatch. Original-session context is private and may
 * never be replaced with an unscoped SQL transaction while locks are held. */
export class HyperliquidGlobalTransport {
 readonly #original=new AsyncLocalStorage<LiveRiskDatabaseSession>();
 readonly #unscoped=Object.freeze({});
 private readonly options:Readonly<{egressKey?:string;ownerId:string}>;
 constructor(private readonly quota:PostgresHyperliquidQuota,options:{egressKey?:string;ownerId:string},private readonly rawFetch:typeof fetch=fetch,private readonly now=Date.now){
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
 readonly fetchInfo:typeof fetch=async(input,init)=>{
  // Configuration is checked before parsing or scheduling any outbound work.
  const budget=this.currentQuota(),url=typeof input==='string'?input:input instanceof URL?input.toString():'';
  if(!['https://api.hyperliquid.xyz/info','https://api.hyperliquid-testnet.xyz/info'].includes(url)||!init||init.method!=='POST'||typeof init.body!=='string'||Buffer.byteLength(init.body)>65536)return fail('hyperliquid_quota_request_invalid');
  let parsed:unknown;try{parsed=JSON.parse(init.body);}catch{fail('hyperliquid_quota_request_invalid');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||!Object.hasOwn(parsed,'type')||typeof (parsed as {type:unknown}).type!=='string')fail('hyperliquid_quota_request_invalid');
  const type=(parsed as {type:string}).type,weight=cheap.has(type)?2:type==='userRole'?60:ordinary.has(type)?20:lists.has(type)?120:type==='candleSnapshot'?104:0;
  if(!weight)fail('hyperliquid_quota_request_invalid');
  const captured:RequestInit={method:'POST',body:init.body,headers:new Headers(init.headers),redirect:'error',signal:init.signal};
  captured.signal?.throwIfAborted();const permit=await budget.acquireRest(weight,this.now()+5000);captured.signal?.throwIfAborted();
  return permit.dispatch(()=>{captured.signal?.throwIfAborted();return this.rawFetch(url,captured);});
 };
}
