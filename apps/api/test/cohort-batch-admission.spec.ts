import { expect, it, vi } from 'vitest';
import { CohortService } from '../src/insights/cohort.service.js';
import type { CohortMemberRow } from '../src/insights/cohort.repository.js';
import { HyperliquidInfoClient } from '../src/hyperliquid/hyperliquid-info.client.js';
import { HyperliquidRestCapacityError } from '../src/hyperliquid/hyperliquid-capacity-error.js';
import { offlineGlobalTransport } from './hyperliquid-quota-test-utils.js';
import { testConfig } from './config-test-utils.js';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';

const address='0x'+'ab'.repeat(20);
const summary={accountValue:'100',totalMarginUsed:'0',totalNtlPos:'0',totalRawUsd:'100'};
const state={assetPositions:[],marginSummary:summary,crossMarginSummary:summary,withdrawable:'100',time:0};
function fixture(capacity=6, answer:()=>Promise<Response>=async()=>Response.json(state), signal?: AbortSignal) {
  const fetcher=vi.fn<typeof fetch>(answer),q=offlineGlobalTransport(fetcher);
  let remaining=capacity;
  q.acquire.mockImplementation(async(...args:unknown[])=>{
    const weight=args[0] as number;
    if(weight>remaining)throw new HyperliquidRestCapacityError(20_000);
    remaining-=weight; let used=false;
    return {assertFresh(){},dispatch<T>(work:()=>T){if(used)throw Error('permit reused');used=true;return work();}};
  });
  const budget={acquire:vi.fn(async()=>{}),adjust:vi.fn(),onSuccess:vi.fn(),onRateLimited:vi.fn()};
  const info=new HyperliquidInfoClient(testConfig(),budget as never,signal ? {signal} as never : undefined,q.transport);
  vi.spyOn(info,'perpDexs').mockResolvedValue([null,{name:'xyz'},{name:'vntl'}] as never);
  const repository={saveFailure:vi.fn(),saveSnapshot:vi.fn()};
  const service=new CohortService(testConfig(),repository as never,info);
  const member: CohortMemberRow={chain:'hyperliquid',address,tier:'profitable',source:'pool',rank:1,pnlAll:'1',roiAll:'1',dexes:['xyz','vntl'],positions:[],perpEquity:'100',fetchedAt:null,sweptAt:new Date(),attemptedAt:null,lastError:null};
  return {fetcher,q,budget,info,repository,service,member};
}
it('refuses the whole member when only two of three venues fit; sends no partial reads',async()=>{
  const f=fixture(4); const result=await f.service.refreshOne(f.member);
  expect(result).toMatchObject({ok:false,capacityLimited:true,weight:0,retryAfterMs:20_000});
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.repository.saveSnapshot).not.toHaveBeenCalled();
  expect(f.q.acquire).toHaveBeenCalledExactlyOnceWith(6,expect.any(Number),'background');
  expect(f.budget.adjust).toHaveBeenCalledExactlyOnceWith(-6);
  expect(f.service.log[0]).toMatchObject({weight:0,calls:0,ok:false});
});
it('waits for an imminent shared release before sending the complete background snapshot',async()=>{
  let now=1_000_000;
  const fetcher=vi.fn<typeof fetch>(async()=>Response.json(state));
  const quota=new PostgresHyperliquidQuota(new UnitOfWork({} as never));
  const acquire=vi.fn(async()=>({assertFresh(){},dispatch<T>(work:()=>T){return work();}}));
  acquire.mockRejectedValueOnce(new HyperliquidRestCapacityError(1000));
  vi.spyOn(quota,'bindUnscoped').mockReturnValue({acquireRest:acquire,reserveSocket:vi.fn()});
  const sleep=vi.fn(async(ms:number)=>{expect(fetcher).not.toHaveBeenCalled();now+=ms;});
  const transport=new HyperliquidGlobalTransport(quota,{egressKey:'offline-fixture',ownerId:'offline-worker'},fetcher,()=>now,sleep);
  const bodies=['','xyz','vntl'].map(dex=>({type:'clearinghouseState',user:address,...(dex?{dex}:{})}));
  expect(await transport.fetchBackgroundInfoBatch(testConfig().value.hyperliquid.apiUrl,bodies)).toHaveLength(3);
  expect(sleep).toHaveBeenCalledExactlyOnceWith(1000,undefined);
  expect(acquire).toHaveBeenNthCalledWith(1,6,1_005_000,'background');
  expect(acquire).toHaveBeenNthCalledWith(2,6,1_006_000,'background');
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it('cannot wait beyond the essential bound or send partial reads when shared capacity stays full',async()=>{
  let now=1_000_000;
  const fetcher=vi.fn<typeof fetch>(async()=>Response.json(state));
  const quota=new PostgresHyperliquidQuota(new UnitOfWork({} as never));
  const acquire=vi.fn(async()=>{throw new HyperliquidRestCapacityError(1000);});
  vi.spyOn(quota,'bindUnscoped').mockReturnValue({acquireRest:acquire,reserveSocket:vi.fn()});
  const transport=new HyperliquidGlobalTransport(quota,{egressKey:'offline-fixture',ownerId:'offline-worker'},fetcher,()=>now,async(ms)=>{now+=ms;});
  await expect(transport.fetchBackgroundInfoBatch(testConfig().value.hyperliquid.apiUrl,[{type:'clearinghouseState',user:address}])).rejects.toThrow('hyperliquid_quota_exhausted');
  expect(now).toBe(1_015_000);expect(acquire).toHaveBeenCalledTimes(16);expect(fetcher).not.toHaveBeenCalled();
});
it('shutdown while waiting cannot dispatch the background batch',async()=>{
  let now=1_000_000;
  const abort=new AbortController(),fetcher=vi.fn<typeof fetch>(async()=>Response.json(state));
  const quota=new PostgresHyperliquidQuota(new UnitOfWork({} as never));
  const acquire=vi.fn(async()=>{throw new HyperliquidRestCapacityError(1000);});
  vi.spyOn(quota,'bindUnscoped').mockReturnValue({acquireRest:acquire,reserveSocket:vi.fn()});
  const transport=new HyperliquidGlobalTransport(quota,{egressKey:'offline-fixture',ownerId:'offline-worker'},fetcher,()=>now,async(ms)=>{now+=ms;abort.abort();});
  await expect(transport.fetchBackgroundInfoBatch(testConfig().value.hyperliquid.apiUrl,[{type:'clearinghouseState',user:address}],{signal:abort.signal})).rejects.toMatchObject({name:'AbortError'});
  expect(acquire).toHaveBeenCalledOnce();expect(fetcher).not.toHaveBeenCalled();
});
it('charges all venues once in the background lane and only then saves their complete snapshot',async()=>{
  const f=fixture(); const result=await f.service.refreshOne(f.member);
  expect(result).toMatchObject({ok:true,weight:6});
  expect(f.q.acquire).toHaveBeenCalledExactlyOnceWith(6,expect.any(Number),'background');
  expect(f.budget.acquire).toHaveBeenCalledOnce();
  expect(f.fetcher.mock.calls.map(c=>JSON.parse(c[1]!.body as string).dex??'')).toEqual(['','xyz','vntl']);
  expect(f.repository.saveSnapshot).toHaveBeenCalledWith(address,expect.objectContaining({perpEquity:300,positions:[]}));
  expect(f.budget.adjust).not.toHaveBeenCalled();
});
it('does not refund dispatched work or save a snapshot after a provider read fails',async()=>{
  const f=fixture(6,async()=>{throw Error('provider timeout');});
  expect(await f.service.refreshOne(f.member)).toMatchObject({ok:false});
  expect(f.fetcher).toHaveBeenCalledTimes(3);
  expect(f.budget.adjust).not.toHaveBeenCalled();
  expect(f.repository.saveSnapshot).not.toHaveBeenCalled();
  expect(f.service.log[0]).toMatchObject({weight:6,calls:3,ok:false});
});
it('keeps the entire dispatched charge even when a later failure has the shared capacity error type',async()=>{
  const f=fixture(6,async()=>{throw new HyperliquidRestCapacityError(1_000);});
  expect(await f.service.refreshOne(f.member)).toMatchObject({ok:false,weight:6,capacityLimited:true});
  expect(f.fetcher).toHaveBeenCalledTimes(3);
  expect(f.budget.adjust).not.toHaveBeenCalled();
  expect(f.repository.saveSnapshot).not.toHaveBeenCalled();
  expect(f.service.log[0]).toMatchObject({weight:6,calls:3,ok:false});
});
it('a local admission failure took no tokens and never reaches shared admission',async()=>{
  const f=fixture(); f.budget.acquire.mockRejectedValueOnce(Error('local admission denied'));
  await expect(f.info.clearinghouseStates(address,['','xyz'])).rejects.toThrow('local admission denied');
  expect(f.q.acquire).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.budget.adjust).not.toHaveBeenCalled();
});
it('shutdown between local admission and dispatch refunds only the unused local charge',async()=>{
  const abort=new AbortController(),f=fixture(6,async()=>Response.json(state),abort.signal);
  f.budget.acquire.mockImplementationOnce(async()=>abort.abort());
  await expect(f.info.clearinghouseStates(address,['','xyz'])).rejects.toMatchObject({name:'AbortError'});
  expect(f.q.acquire).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.budget.adjust).toHaveBeenCalledExactlyOnceWith(-4);
});
it('rejects malformed provider data without replacing any member snapshot or refunding dispatched reads',async()=>{
  const f=fixture(6,async()=>Response.json({assetPositions:[]}));
  expect(await f.service.refreshOne(f.member)).toMatchObject({ok:false});
  expect(f.repository.saveSnapshot).not.toHaveBeenCalled(); expect(f.budget.adjust).not.toHaveBeenCalled(); expect(f.budget.onSuccess).not.toHaveBeenCalled();
});
it('a real provider 429 keeps the full charge and triggers backoff once',async()=>{
  const f=fixture(6,async()=>new Response('busy',{status:429}));
  expect(await f.service.refreshOne(f.member)).toMatchObject({ok:false});
  expect(f.fetcher).toHaveBeenCalledTimes(3); expect(f.budget.onRateLimited).toHaveBeenCalledOnce();
  expect(f.budget.adjust).not.toHaveBeenCalled(); expect(f.repository.saveSnapshot).not.toHaveBeenCalled();
});
it('background sweeps can cover 17 venues while the original live batch limit remains 16',async()=>{
  const dexes=['',...Array.from({length:16},(_,i)=>'dex'+i)],f=fixture(34);
  expect(await f.info.clearinghouseStates(address,dexes)).toHaveLength(17);
  expect(f.q.acquire).toHaveBeenCalledExactlyOnceWith(34,expect.any(Number),'background');
  const bodies=dexes.map(dex=>({type:'clearinghouseState',user:address,...(dex?{dex}:{})}));
  await expect(f.q.transport.fetchInfoBatch(testConfig().value.hyperliquid.apiUrl,bodies,{maxWaitMs:0})).rejects.toThrow('hyperliquid_quota_request_invalid');
  expect(f.fetcher).toHaveBeenCalledTimes(17); expect(f.q.acquire).toHaveBeenCalledOnce();
});
it.each([
  ['missing main',['xyz'],undefined],
  ['duplicate venues',['','xyz','xyz'],undefined],
  ['unbounded sweep',Array.from({length:65},(_,i)=>i?'dex'+i:''),undefined],
  ['page rank',['','xyz'],0],
  ['control character',['','xyz\n'],undefined],
] as const)('rejects %s before local or shared admission',async(_name,dexes,rank)=>{
  const f=fixture(); await expect(f.info.clearinghouseStates(address,dexes,rank)).rejects.toThrow('Invalid complete perp snapshot');
  expect(f.budget.acquire).not.toHaveBeenCalled(); expect(f.q.acquire).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
});
