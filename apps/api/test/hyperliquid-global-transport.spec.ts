import {describe,it,expect,vi} from 'vitest';
import {HyperliquidGlobalTransport} from '../src/hyperliquid/hyperliquid-global-transport.js';
import {PostgresHyperliquidQuota} from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import {UnitOfWork} from '../src/db/unit-of-work.js';
import type {DrizzleDb} from '../src/db/drizzle.provider.js';
function fixture(...args:[egressKey?:string]){
 const egressKey=args.length?args[0]:'global-project-egress';
 const quota=new PostgresHyperliquidQuota(new UnitOfWork({} as DrizzleDb)),fetcher=vi.fn<typeof fetch>(async()=>new Response('{}'));
 const acquire=vi.fn(async()=>{let used=false;return {assertFresh:()=>{},dispatch:<T>(work:()=>T):T=>{if(used)throw Error('reuse');used=true;return work();}};});
 const bind=vi.spyOn(quota,'bindUnscoped').mockReturnValue({acquireRest:acquire,reserveSocket:vi.fn()});
 return {quota,fetcher,acquire,bind,transport:new HyperliquidGlobalTransport(quota,{egressKey,ownerId:'worker-a'},fetcher)};
}
const info='https://api.hyperliquid-testnet.xyz/info';
const init=(body:unknown):RequestInit=>({method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json'}});
describe('actual read-only provider dispatch consumes durable private quota',()=>{
 it('prepays the bounded recent-trades response surcharge instead of bypassing shared admission',async()=>{
  const f=fixture();await f.transport.fetchInfo(info,init({type:'recentTrades',coin:'BTC'}));
  expect(f.acquire).toHaveBeenCalledExactlyOnceWith(120,expect.any(Number));expect(f.fetcher).toHaveBeenCalledOnce();
 });
 it('denies missing egress configuration before any quota/provider call',async()=>{
  const f=fixture(undefined);await expect(f.transport.fetchInfo(info,init({type:'meta'}))).rejects.toThrow('hyperliquid_quota_egress_unconfigured');expect(f.bind).not.toHaveBeenCalled();expect(f.fetcher).not.toHaveBeenCalled();
 });
 it.each([['userRole',60],['allMids',2],['orderStatus',2],['clearinghouseState',2],['spotClearinghouseState',2],['meta',20],['activeAssetData',20],['userFees',20],['extraAgents',20],['userFillsByTime',120],['userTwapSliceFills',120],['userFunding',120],['candleSnapshot',104]])('derives the conservative documented weight for %s',async(type,weight)=>{
  const f=fixture();await f.transport.fetchInfo(info,init({type}));expect(f.acquire).toHaveBeenCalledWith(weight,expect.any(Number));expect(f.fetcher).toHaveBeenCalledOnce();expect(f.fetcher.mock.calls[0]![1]!.redirect).toBe('error');
 });
 it.each(['http://api.hyperliquid-testnet.xyz/info','https://api.hyperliquid-testnet.xyz/info?x=1','https://api.hyperliquid-testnet.xyz/exchange','https://foreign.test/info'])('refuses unsupported origin/path %s before admission',async(url)=>{
  const f=fixture();await expect(f.transport.fetchInfo(url,init({type:'meta'}))).rejects.toThrow('hyperliquid_quota_request_invalid');expect(f.acquire).not.toHaveBeenCalled();expect(f.fetcher).not.toHaveBeenCalled();
 });
 it('cannot bypass a global denial or throw away an issued permit before actual fetch',async()=>{
  const f=fixture();f.acquire.mockRejectedValueOnce(Error('exhausted'));await expect(f.transport.fetchInfo(info,init({type:'meta'}))).rejects.toThrow('exhausted');expect(f.fetcher).not.toHaveBeenCalled();
  f.acquire.mockResolvedValueOnce({assertFresh:()=>{},dispatch:()=>{throw Error('expired at dispatch');}});await expect(f.transport.fetchInfo(info,init({type:'meta'}))).rejects.toThrow('expired at dispatch');expect(f.fetcher).not.toHaveBeenCalled();
 });
 it('captures body/headers before SQL waits and uses only that capture at dispatch',async()=>{
  const f=fixture();let release!:()=>void;f.acquire.mockImplementationOnce(async()=>{await new Promise<void>(r=>{release=r;});return {assertFresh:()=>{},dispatch:<T>(work:()=>T)=>work()};});
  const request=init({type:'meta'});const pending=f.transport.fetchInfo(info,request);void pending.catch(()=>{});request.body=JSON.stringify({type:'userRole'});(request.headers as Record<string,string>)['X-Untrusted']='changed';release();await pending;
  const sent=f.fetcher.mock.calls[0]![1]!;expect(sent.body).toBe(JSON.stringify({type:'meta'}));expect(new Headers(sent.headers).has('X-Untrusted')).toBe(false);expect(f.acquire).toHaveBeenCalledWith(20,expect.any(Number));
 });
 it.each([{}, {type:'undocumentedGuess'},'wrong'])('refuses an unknown request rather than guessing weight20',async body=>{
  const f=fixture();await expect(f.transport.fetchInfo(info,init(body))).rejects.toThrow('hyperliquid_quota_request_invalid');expect(f.fetcher).not.toHaveBeenCalled();
 });
 it('honors caller abort after quota waiting before starting transport',async()=>{
  const f=fixture(),abort=new AbortController();f.acquire.mockImplementationOnce(async()=>{abort.abort();return {assertFresh:()=>{},dispatch:<T>(work:()=>T)=>work()};});
  await expect(f.transport.fetchInfo(info,{...init({type:'meta'}),signal:abort.signal})).rejects.toMatchObject({name:'AbortError'});expect(f.fetcher).not.toHaveBeenCalled();
 });
});
