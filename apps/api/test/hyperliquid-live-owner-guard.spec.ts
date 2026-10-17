import {describe,expect,it,vi} from 'vitest';
import {HyperliquidGlobalTransport} from '../src/hyperliquid/hyperliquid-global-transport.js';
import {PostgresHyperliquidQuota,runInBackgroundLane,runInLeaderSourceLane,sourceLaneOwner} from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import {hyperliquidMeterComposition,planHyperliquidQuota,type HyperliquidQuotaEvent,type HyperliquidQuotaRequest,type HyperliquidQuotaState} from '../src/hyperliquid/hyperliquid-global-quota.js';
import {UnitOfWork} from '../src/db/unit-of-work.js';
import type {DrizzleDb} from '../src/db/drizzle.provider.js';

/**
 * H-R11: every charge of the shared meter's live lane names its owner. On
 * Stage (32ddfbc4) the lane held 313 p50 / 520 p95 units of `live:<id>`
 * nobody could attribute, with no order in flight: the watcher's confirms,
 * sweeps and audits of three copied leaders (21 a list, 120 prepaid), the
 * fast path's state reads (2) and the paper copier's market reads. One
 * guard keeps that from coming back: the quota (PostgresHyperliquidQuota.
 * acquireRest, the only way production charges the meter) refuses a live
 * charge without an owner before any round trip; the planner still accepts
 * the release before's ownerless tickets, so the two releases share a meter.
 * Below, every transport entry point that can charge the live lane is
 * enumerated: without an owner each is refused and nothing is sent; with
 * one (runOwned, runDefaultOwner, fetchInfoOwned, the explorer's own) the
 * ticket carries it. Against the release before, the ownerless charges go
 * through as `live:<id>`.
 */
const now=1790000000000,egressKey='owner-guard',TOKEN='aaaaaaaaaaaaaaaa',LEADER='0x'+'44'.repeat(20);
const uuid=()=>`${String(++tickets).padStart(8,'0')}-0000-4000-8000-000000000000`;let tickets=0;
const S=(events:readonly HyperliquidQuotaEvent[]=[]):HyperliquidQuotaState=>({egressKey,revision:1,events:[...events],updatedAt:now});
const plan=(request:HyperliquidQuotaRequest,state=S())=>planHyperliquidQuota({now,state,leases:[],request});
const code=(work:()=>unknown)=>{try{work();}catch(error){return (error as {code?:string}).code;}return undefined;};
type RestRequest=Extract<HyperliquidQuotaRequest,{kind:"rest"}>;
const live=(id:string)=>({kind:"rest",id,weight:20,sendUntil:now+5000,lane:"live"}) as HyperliquidQuotaRequest;

describe('the meter still reads the release before\'s live tickets (compatibility), and tells owned from untagged',()=>{
  it('a ticket charged without an owner (`live:<id>`, `live:<token>:<id>`) is counted as `untagged` until it expires; a token is never read as an owner',()=>{
    const old:HyperliquidQuotaEvent[]=[{id:`live:${uuid()}`,kind:'rest',units:21,reservedAt:now-30_000,expiresAt:now+35_000},{id:`live:${TOKEN}:${uuid()}`,kind:'rest',units:2,reservedAt:now-30_000,expiresAt:now+35_000}];
    const composition=hyperliquidMeterComposition(old,now);
    expect(composition.live).toBe(23);
    expect(composition.liveKinds).toEqual({untagged:23});
    // The planner (the same accounting the Postgres meter commits) still charges the old ids and owned ones beside them.
    for(const id of [`live:${uuid()}`,`live:${TOKEN}:${uuid()}`,`live:order:${uuid()}`,`live:${TOKEN}:settle:${uuid()}`,`live:explorer:${uuid()}`,`live:setup:${uuid()}`]){
      const planned=plan(live(id),S(old));
      expect(planned.charged).toBe(20);
      expect(planned.state.events.map(e=>e.id)).toContain(id);
    }
    expect(hyperliquidMeterComposition([...old,{id:`live:${TOKEN}:order:${uuid()}`,kind:'rest',units:589,reservedAt:now,expiresAt:now+60_000}],now).liveKinds).toEqual({untagged:23,order:589});
    expect(code(()=>plan(live(`source:${sourceLaneOwner(LEADER)}:${uuid()}`)))).toBe('hyperliquid_quota_invalid');
  });
});

/** The transport over the real quota's `acquireRest` (its id and lane logic); the meter transaction is captured, never run. */
function fixture(){
  const quota=new PostgresHyperliquidQuota(new UnitOfWork({} as DrizzleDb),()=>now),captured:RestRequest[]=[];
  vi.spyOn(quota as unknown as {apply:(binding:unknown,request:(now:number,sendUntil:number)=>HyperliquidQuotaRequest)=>Promise<()=>void>},'apply')
    .mockImplementation(async(_binding,request)=>{captured.push(request(now,now+5000) as RestRequest);return ()=>{};});
  const fetcher=vi.fn<typeof fetch>(async()=>new Response('{}'));
  return {captured,fetcher,transport:new HyperliquidGlobalTransport(quota,{egressKey,ownerId:'worker-a'},fetcher,()=>now)};
}
const info='https://api.hyperliquid.xyz/info',explorer='https://rpc.hyperliquid.xyz/explorer';
const init=(body:unknown):RequestInit=>({method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json'}});
const meta=()=>init({type:'meta'});
type Entry=(f:ReturnType<typeof fixture>)=>Promise<unknown>;
/** Every transport entry point whose charge is the live lane's when nothing more specific applies. */
const entries:ReadonlyArray<[string,Entry]>=[
  ['fetchInfo',f=>f.transport.fetchInfo(info,meta())],
  ['fetchInfoBatch',f=>f.transport.fetchInfoBatch(info,[{type:'meta'}],{maxWaitMs:0})],
  ['acquireExchange',f=>f.transport.acquireExchange(now+5000)],
];

describe('every live-lane entry point of the transport names an owner',()=>{
  it.each(entries)('%s with no owner, token or lane store is a background charge (`bg:`), never a live one: the live lane is no default',async(_name,entry)=>{
    const f=fixture();
    await entry(f);
    expect(f.captured).toHaveLength(1);
    expect(f.captured[0]).toMatchObject({kind:'rest',lane:'background',id:expect.stringMatching(/^bg:[0-9a-f-]{36}$/)});
  });
  it.each(entries)('%s under an order\'s token (runLive) with no owner is refused before any round trip; nothing is sent',async(_name,entry)=>{
    const f=fixture();
    await expect(f.transport.runLive(TOKEN,()=>entry(f))).rejects.toThrow('hyperliquid_quota_live_unowned');
    expect(f.captured).toEqual([]);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('an explicit live charge of the quota with no owner is refused; with one it carries it',async()=>{
    const f=fixture(),bound=f.transport.currentQuota();
    await expect(bound.acquireRest(20,now+5000,'live')).rejects.toThrow('hyperliquid_quota_live_unowned');
    await bound.acquireRest(20,now+5000,'live',{owner:'order'});
    expect(f.captured.map(r=>r.id)).toEqual([expect.stringMatching(/^live:order:/)]);
  });
  it.each(entries)('%s under runOwned carries the work\'s owner and token (`live:<token>:order:<id>`)',async(_name,entry)=>{
    const f=fixture();
    await f.transport.runOwned('order',()=>f.transport.runLive(TOKEN,()=>entry(f)));
    expect(f.captured).toHaveLength(1);
    expect(f.captured[0]).toMatchObject({kind:'rest',lane:'live',id:expect.stringMatching(new RegExp(`^live:${TOKEN}:order:[0-9a-f-]{36}$`))});
  });
  it('the explorer read names itself (`live:explorer:`) unless the work it runs in has an owner',async()=>{
    const f=fixture(),body=init({type:'txDetails',hash:'0x'+'ab'.repeat(32)});
    await f.transport.fetchExplorer(explorer,body);
    await f.transport.runOwned('stop',()=>f.transport.fetchExplorer(explorer,body));
    expect(f.captured.map(r=>r.id)).toEqual([expect.stringMatching(/^live:explorer:/),expect.stringMatching(/^live:stop:/)]);
    expect(f.captured.map(r=>(r as {lane?:string}).lane)).toEqual(['live','live']);
  });
  it('fetchInfoOwned and runDefaultOwner name a shared client\'s charges, and keep the owner of the work they run in',async()=>{
    const f=fixture();
    await f.transport.fetchInfoOwned('setup')(info,meta());
    await f.transport.runOwned('stop',()=>f.transport.fetchInfoOwned('close')(info,meta()));
    await f.transport.runDefaultOwner('funding',()=>f.transport.acquireExchange(now+5000));
    await f.transport.runOwned('stop',()=>f.transport.runDefaultOwner('funding',()=>f.transport.acquireExchange(now+5000)));
    expect(f.captured.map(r=>r.id.replace(/[0-9a-f-]{36}$/,'<id>'))).toEqual(['live:setup:<id>','live:stop:<id>','live:funding:<id>','live:stop:<id>']);
  });
  it('a copied leader\'s reads (runSource / runInLeaderSourceLane) are the leader\'s source charges, never live; background work\'s are background',async()=>{
    const f=fixture();
    await f.transport.runSource(LEADER,()=>f.transport.fetchInfo(info,init({type:'userFillsByTime',user:LEADER,startTime:now})));
    await runInLeaderSourceLane(LEADER,()=>f.transport.fetchInfo(info,meta()));
    await runInBackgroundLane(()=>f.transport.fetchInfo(info,meta()));
    expect(f.captured).toHaveLength(3);
    expect(f.captured[0]).toMatchObject({lane:'source',weight:120,id:expect.stringMatching(new RegExp(`^source:${sourceLaneOwner(LEADER)}:[0-9a-f-]{36}$`))});
    expect(f.captured[1]).toMatchObject({lane:'source',id:expect.stringMatching(new RegExp(`^source:${sourceLaneOwner(LEADER)}:`))});
    expect(f.captured[2]).toMatchObject({lane:'background',id:expect.stringMatching(/^bg:/)});
    expect(f.captured.some(r=>r.id.startsWith('live:'))).toBe(false);
    expect(f.captured.some(r=>r.id.includes(LEADER.slice(2,10)))).toBe(false);
  });
});
