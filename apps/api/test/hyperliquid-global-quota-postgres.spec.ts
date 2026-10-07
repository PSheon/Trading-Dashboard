import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import * as schema from '@trading-dashboard/shared/database';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {closeTestDb,getTestDb} from './db-test-utils.js';
import {UnitOfWork,type DbTransaction} from '../src/db/unit-of-work.js';
import {PostgresHyperliquidQuota} from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import {HyperliquidGlobalTransport} from '../src/hyperliquid/hyperliquid-global-transport.js';
import {HyperliquidAllDexsAccountSource,PerReadAllDexsAccountSource} from '../src/copy/live/live-account-ws-source.js';
import {liveSourceDigest} from '../src/copy/live/copy-live-source-evidence.js';
import {quotaSubscription} from '../src/hyperliquid/hyperliquid-global-quota.js';
import {PostgresLiveRiskScope} from '../src/copy/live/postgres-live-risk-scope.js';
import WebSocket from 'ws';
import {EventEmitter} from 'node:events';
import type {HyperliquidSendPermit} from '../src/hyperliquid/postgres-hyperliquid-quota.js';
vi.mock('ws',async()=>{const {EventEmitter}=await import('node:events');return {default:class extends EventEmitter {static OPEN=1;readyState=1;constructor(readonly url:string){super();}close(code:number){this.readyState=3;this.emit('close',code,Buffer.alloc(0));}terminate(){this.readyState=3;this.emit('close',1006);}}};});
let pool:Pool;let meter:PostgresHyperliquidQuota;let db:ReturnType<typeof getTestDb>;
const identity={egressKey:'project-shared-egress',ownerId:'worker-a'};
const user=`0x${'ab'.repeat(20)}`;
beforeAll(()=>{db=getTestDb();pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});meter=new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool,{schema})));});
beforeEach(async()=>{await db.delete(schema.hyperliquidWsLeases);await db.delete(schema.hyperliquidEgressQuota);});
afterAll(async()=>{await pool?.end();await closeTestDb();});
describe('durable shared egress meter, never provider I/O',()=>{
 it('serializes two owners racing for the last REST weight',async()=>{
  await meter.bindUnscoped(identity).acquireRest(1199,Date.now()+5000);
  const a=meter.bindUnscoped(identity),b=meter.bindUnscoped({...identity,ownerId:'worker-b'});
  const result=await Promise.allSettled([a.acquireRest(1,Date.now()+5000),b.acquireRest(1,Date.now()+5000)]);
  expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(result.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect((await db.select().from(schema.hyperliquidEgressQuota))[0]!.events.reduce((n,e)=>n+e.units,0)).toBe(1200);
 });
 it('retains unused permits over a new meter instance and cannot refund after expiry',async()=>{
  await meter.bindUnscoped(identity).acquireRest(1200,Date.now()+100);
  const restarted=new PostgresHyperliquidQuota(new UnitOfWork(db));
  await expect(restarted.bindUnscoped(identity).acquireRest(1,Date.now()+5000)).rejects.toThrow('hyperliquid_quota_exhausted');
 });
 it('settles an answered list call to its real weight with the next charge, never raising it (item 6)',async()=>{
  const charges=async()=>(await db.select().from(schema.hyperliquidEgressQuota))[0]!.events.map(e=>e.units);
  const list=await meter.bindUnscoped(identity).acquireRest(120,Date.now()+5000);
  list.dispatch(()=>undefined);list.settle!(25);
  // Ten such pages would have held the whole window for a minute.
  expect(await charges()).toEqual([120]);
  await meter.bindUnscoped(identity).acquireRest(2,Date.now()+5000);
  expect(await charges()).toEqual([25,2]);
  // A full page is not settled, and a settlement never raises a charge.
  const full=await meter.bindUnscoped(identity).acquireRest(120,Date.now()+5000);full.settle!(120);full.settle!(500);
  await meter.bindUnscoped(identity).acquireRest(2,Date.now()+5000);
  expect(await charges()).toEqual([25,2,120,2]);
  // With the prepaid surplus back, room that was gone is there again.
  await meter.bindUnscoped(identity).acquireRest(1200-25-2-120-2,Date.now()+5000);
  await expect(meter.bindUnscoped(identity).acquireRest(1,Date.now()+5000)).rejects.toThrow('hyperliquid_quota_exhausted');
 });
 it('returns a private one-use send fence only after durable reservation',async()=>{
  const permit=await meter.bindUnscoped(identity).acquireRest(20,Date.now()+5000);
  const send=vi.fn(()=>42);expect(permit.dispatch(send)).toBe(42);expect(()=>permit.dispatch(send)).toThrow('hyperliquid_quota_permit_lost');expect(send).toHaveBeenCalledOnce();
  expect((await db.select().from(schema.hyperliquidEgressQuota))[0]!.events).toHaveLength(1);
 });
 it('refuses stale dispatch even while a reserved charge remains durable',async()=>{
  let now=Date.now();const controlled=new PostgresHyperliquidQuota(new UnitOfWork(db),()=>now);
  const permit=await controlled.bindUnscoped(identity).acquireRest(1,now+5000);now+=5001;
  const send=vi.fn();expect(()=>permit.dispatch(send)).toThrow('hyperliquid_quota_expired');expect(send).not.toHaveBeenCalled();
  expect((await db.select().from(schema.hyperliquidEgressQuota))[0]!.events[0]!.units).toBe(1);
 });
 it('uses the same original pool connection and queues concurrent acquisitions without reacquiring',async()=>{
  const scopes=new PostgresLiveRiskScope(pool);await scopes.run({userId:1,network:'testnet',accountAddress:user},async(_scope,session)=>{
   const connect=vi.spyOn(pool,'connect');try{
    const bound=meter.bindOriginal(session,identity);const permits=await Promise.all([bound.acquireRest(20,Date.now()+5000),bound.acquireRest(20,Date.now()+5000)]);
    expect(connect).not.toHaveBeenCalled();expect(permits).toHaveLength(2);permits.forEach(p=>p.dispatch(()=>{}));
   }finally{connect.mockRestore();}
  });
 });
 it('tombstones an original-session permit at scope exit and rejects structural sessions',async()=>{
  const scopes=new PostgresLiveRiskScope(pool);let permit!:HyperliquidSendPermit;
  await scopes.run({userId:1,network:'testnet',accountAddress:user},async(_scope,session)=>{
   expect(()=>meter.bindOriginal({...session},identity)).toThrow('live_risk_serialization_lost');permit=await meter.bindOriginal(session,identity).acquireRest(1,Date.now()+5000);
  });expect(()=>permit.dispatch(()=>{})).toThrow('live_risk_serialization_lost');
 });
 it('counts all socket owners and retains ten crash-expired leases',async()=>{
  const bound=meter.bindUnscoped(identity);for(let i=0;i<10;i++)await bound.reserveSocket(Date.now()+5000);
  await db.update(schema.hyperliquidWsLeases).set({leaseUntil:sql`${schema.hyperliquidWsLeases.createdAt} + interval '1 millisecond'`,latestAllowedSendAt:sql`${schema.hyperliquidWsLeases.createdAt} + interval '1 millisecond'`});
  await new Promise(resolve=>setTimeout(resolve,3));
  await expect(meter.bindUnscoped({...identity,ownerId:'worker-b'}).reserveSocket(Date.now()+5000)).rejects.toThrow('hyperliquid_quota_connections');
  expect(await db.select().from(schema.hyperliquidWsLeases)).toHaveLength(10);
 });
 it('admits a new connection past ten leases left uncertain beyond the stale margin and keeps their evidence',async()=>{
  const bound=meter.bindUnscoped(identity);for(let i=0;i<10;i++)await bound.reserveSocket(Date.now()+5000);
  const T=schema.hyperliquidWsLeases,evidence={version:1,kind:'test_prior_crash'};
  await db.update(T).set({state:'uncertain',createdAt:sql`now() - interval '11 minutes'`,leaseUntil:sql`now() - interval '10 minutes'`,latestAllowedSendAt:sql`now() - interval '11 minutes'`,updatedAt:sql`now() - interval '10 minutes'`,cleanupEvidence:evidence,cleanupEvidenceDigest:liveSourceDigest(evidence)});
  const before=await db.select().from(T);
  const events=(await db.select().from(schema.hyperliquidEgressQuota))[0]!.events;
  const fresh=await meter.bindUnscoped({...identity,ownerId:'worker-b'}).reserveSocket(Date.now()+5000);
  const after=await db.select().from(T);expect(after).toHaveLength(11);
  for(const row of before)expect(after.find(r=>r.id===row.id)).toEqual(row);
  expect(after.filter(r=>r.ownerId==='worker-b')[0]!.state).toBe('reserved');
  // Every connection attempt stays charged, the reclaimed ones included.
  expect((await db.select().from(schema.hyperliquidEgressQuota))[0]!.events.slice(0,events.length)).toEqual(events);
  await fresh.connection.cancelBeforeConnect();
 });
 it('still refuses an eleventh connection with ten live leases when more stale leases than the scan bound exist',async()=>{
  const bound=meter.bindUnscoped(identity),T=schema.hyperliquidWsLeases;
  const age=()=>db.update(T).set({state:'uncertain',createdAt:sql`now() - interval '11 minutes'`,leaseUntil:sql`now() - interval '10 minutes'`,latestAllowedSendAt:sql`now() - interval '11 minutes'`,updatedAt:sql`now() - interval '10 minutes'`}).where(sql`${T.state} <> 'uncertain'`);
  for(let i=0;i<10;i++)await bound.reserveSocket(Date.now()+5000);await age();
  for(let i=0;i<2;i++)await bound.reserveSocket(Date.now()+5000);await age();
  for(let i=0;i<10;i++)await bound.reserveSocket(Date.now()+5000);
  expect((await db.select().from(T)).filter(r=>r.state==='uncertain')).toHaveLength(12);
  await expect(meter.bindUnscoped({...identity,ownerId:'worker-b'}).reserveSocket(Date.now()+5000)).rejects.toThrow('hyperliquid_quota_connections');
 });
 it('lets the original owner of a reclaimed lease still record its close evidence',async()=>{
  const result=await meter.bindUnscoped(identity).reserveSocket(Date.now()+5000);const T=schema.hyperliquidWsLeases;
  await db.update(T).set({createdAt:sql`now() - interval '11 minutes'`,leaseUntil:sql`now() - interval '10 minutes'`,latestAllowedSendAt:sql`now() - interval '11 minutes'`,updatedAt:sql`now() - interval '10 minutes'`});
  await result.connection.cancelBeforeConnect();
  const row=(await db.select().from(T))[0]!;expect(row.state).toBe('closed');expect(row.cleanupEvidence?.kind).toBe('connect_not_dispatched');
 });
 it('counts all subscription messages before ACK, and exact cleanup frees capacity without refund',async()=>{
  const socket=await meter.bindUnscoped(identity).reserveSocket(Date.now()+5000);const transport=socket.connect.dispatch(()=>new WebSocket('wss://api.hyperliquid-testnet.xyz/ws'));socket.connection.attach(transport);await socket.connection.whenIdle();
  const sub=quotaSubscription('testnet',{type:'openOrders',user,dex:'i<3fl'}),permit=await socket.connection.subscribe([sub],Date.now()+5000,true);
  expect((await db.select().from(schema.hyperliquidWsLeases))[0]!.subscriptions).toEqual([sub]);
  const callback=vi.fn();permit.dispatch({method:'subscribe',subscription:sub.subscription},callback);expect(()=>permit.dispatch({method:'subscribe',subscription:sub.subscription},callback)).toThrow('hyperliquid_quota_permit_lost');
  permit.dispatch({method:'unsubscribe',subscription:sub.subscription},callback);transport.emit('message',Buffer.from(JSON.stringify({channel:'subscriptionResponse',data:{method:'unsubscribe',subscription:sub.subscription}})));await socket.connection.whenIdle();
  const row=(await db.select().from(schema.hyperliquidWsLeases))[0]!;expect(row.subscriptions).toEqual([]);
  expect((await db.select().from(schema.hyperliquidEgressQuota))[0]!.events.filter(e=>e.kind==='ws_message')[0]!.units).toBe(2);
 });
 it('does not release a crashed socket by timeout or let a successor attach from JSON',async()=>{
  const result=await meter.bindUnscoped(identity).reserveSocket(Date.now()+5000);await result.connection.uncertain();
  expect(JSON.parse(JSON.stringify(result.connection))).toEqual({});
  const row=(await db.select().from(schema.hyperliquidWsLeases))[0]!;expect(row.state).toBe('uncertain');expect(row.closedAt).toBeNull();
 });
 it('releases confirmed transport shutdown but retains original attempt charges',async()=>{
  const result=await meter.bindUnscoped(identity).reserveSocket(Date.now()+5000);const transport=result.connect.dispatch(()=>new WebSocket('wss://api.hyperliquid-testnet.xyz/ws'));result.connection.attach(transport);await result.connection.whenIdle();transport.emit('close',1000);await result.connection.whenIdle();
  expect((await db.select().from(schema.hyperliquidWsLeases))[0]!.state).toBe('closed');
  expect((await db.select().from(schema.hyperliquidEgressQuota))[0]!.events[0]!.kind).toBe('ws_connect');
 });
 it('rejects a malformed persisted quota instead of assuming remaining capacity',async()=>{
  const now=Date.now();await db.insert(schema.hyperliquidEgressQuota).values({egressKey:identity.egressKey,events:[{id:'invalid',kind:'rest',units:-1,reservedAt:now,expiresAt:now+60000}],updatedAt:new Date(now)});
  await expect(meter.bindUnscoped(identity).acquireRest(1,Date.now()+5000)).rejects.toThrow('hyperliquid_quota_invalid');
 });
 it('keeps a definite failed callback attempt charged and non-reusable',async()=>{
  const permit=await meter.bindUnscoped(identity).acquireRest(1,Date.now()+5000);expect(()=>permit.dispatch(()=>{throw Error('send failed');})).toThrow('send failed');
  expect(()=>permit.dispatch(()=>{})).toThrow('hyperliquid_quota_permit_lost');expect((await db.select().from(schema.hyperliquidEgressQuota))[0]!.events[0]!.units).toBe(1);
 });
 it('checks the COMMIT completion deadline and leaves a late committed reservation charged',async()=>{
  let clock=Date.now();class DelayedCommit extends UnitOfWork {override async run<T>(work:(tx:DbTransaction)=>Promise<T>):Promise<T>{const result=await super.run(work);clock+=5001;return result;}}
  const delayed=new PostgresHyperliquidQuota(new DelayedCommit(db),()=>clock);
  await expect(delayed.bindUnscoped(identity).acquireRest(20,clock+5000)).rejects.toThrow('hyperliquid_quota_expired');
  expect((await db.select().from(schema.hyperliquidEgressQuota))[0]!.events[0]!.units).toBe(20);
 });
 it('denies unverified DB/local clock skew without minting a dispatch permit',async()=>{
  const skewed=new PostgresHyperliquidQuota(new UnitOfWork(db),()=>Date.now()+2000);
  await expect(skewed.bindUnscoped(identity).acquireRest(1,Date.now()+7000)).rejects.toThrow('hyperliquid_quota_clock_skew');
  expect(await db.select().from(schema.hyperliquidEgressQuota)).toEqual([]);
 });
 it('serializes independent owners racing for the last global WS message',async()=>{
  const bound=meter.bindUnscoped(identity),other=meter.bindUnscoped({...identity,ownerId:'worker-b'}),a=await bound.reserveSocket(Date.now()+5000),b=await other.reserveSocket(Date.now()+5000);
  for(const s of [a,b]){s.connection.attach(s.connect.dispatch(()=>new WebSocket('wss://api.hyperliquid-testnet.xyz/ws')));await s.connection.whenIdle();}
  const clock=Date.now();await db.update(schema.hyperliquidEgressQuota).set({events:[{id:'existing-message-reservations',kind:'ws_message',units:1999,reservedAt:clock,expiresAt:clock+65000}],updatedAt:new Date(clock)});
  const result=await Promise.allSettled([a.connection.ping(Date.now()+5000),b.connection.ping(Date.now()+5000)]);
  expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(result.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect((await db.select().from(schema.hyperliquidEgressQuota))[0]!.events.filter(e=>e.kind==='ws_message').reduce((sum,e)=>sum+e.units,0)).toBe(2000);
 });
 it('enforces 1000 reserved subscriptions across independent sockets before any ACK',async()=>{
  const bound=meter.bindUnscoped(identity),a=await bound.reserveSocket(Date.now()+5000),b=await bound.reserveSocket(Date.now()+5000);
  for(const s of [a,b]){s.connection.attach(s.connect.dispatch(()=>new WebSocket('wss://api.hyperliquid-testnet.xyz/ws')));await s.connection.whenIdle();}
  const subs=Array.from({length:1000},(_,i)=>quotaSubscription('testnet',{type:'trades',coin:`TOKEN${i}`}));await a.connection.subscribe(subs,Date.now()+5000,false);
  await expect(b.connection.subscribe([quotaSubscription('testnet',{type:'trades',coin:'NEXT'})],Date.now()+5000,false)).rejects.toThrow('hyperliquid_quota_subscriptions');
  expect((await db.select().from(schema.hyperliquidWsLeases)).reduce((sum,l)=>sum+l.subscriptions.length,0)).toBe(1000);
 });
 it('enforces ten unique users across mainnet and testnet sockets sharing one alias',async()=>{
  const bound=meter.bindUnscoped(identity),a=await bound.reserveSocket(Date.now()+5000),b=await bound.reserveSocket(Date.now()+5000,'mainnet');
  a.connection.attach(a.connect.dispatch(()=>new WebSocket('wss://api.hyperliquid-testnet.xyz/ws')));b.connection.attach(b.connect.dispatch(()=>new WebSocket('wss://api.hyperliquid.xyz/ws')));await Promise.all([a.connection.whenIdle(),b.connection.whenIdle()]);
  const subs=Array.from({length:10},(_,i)=>quotaSubscription('testnet',{type:'openOrders',user:`0x${String(i+1).padStart(40,'0')}`,dex:''}));await a.connection.subscribe(subs,Date.now()+5000,false);
  await expect(b.connection.subscribe([quotaSubscription('mainnet',{type:'openOrders',user,dex:''})],Date.now()+5000,false)).rejects.toThrow('hyperliquid_quota_users');
 });
 it('retains abnormal-close capacity and refuses a wrong-account cleanup ACK',async()=>{
  const result=await meter.bindUnscoped(identity).reserveSocket(Date.now()+5000),transport=result.connect.dispatch(()=>new WebSocket('wss://api.hyperliquid-testnet.xyz/ws'));result.connection.attach(transport);await result.connection.whenIdle();
  const sub=quotaSubscription('testnet',{type:'openOrders',user,dex:''}),permit=await result.connection.subscribe([sub],Date.now()+5000,true);permit.dispatch({method:'unsubscribe',subscription:sub.subscription},()=>{});
  transport.emit('message',Buffer.from(JSON.stringify({channel:'subscriptionResponse',data:{method:'unsubscribe',subscription:{type:'openOrders',user:`0x${'cd'.repeat(20)}`,dex:''}}})));await expect(result.connection.whenIdle()).rejects.toThrow('hyperliquid_quota_lease_lost');
  transport.emit('close',1006);await expect(result.connection.whenIdle()).rejects.toThrow('hyperliquid_quota_lease_lost');
  const row=(await db.select().from(schema.hyperliquidWsLeases))[0]!;expect(row.state).toBe('uncertain');expect(row.closedAt).toBeNull();expect(row.subscriptions).toEqual([sub]);
 });
 it('passes the immutable validated command to the dispatch callback and rejects substitution',async()=>{
  const result=await meter.bindUnscoped(identity).reserveSocket(Date.now()+5000),transport=result.connect.dispatch(()=>new WebSocket('wss://api.hyperliquid-testnet.xyz/ws'));result.connection.attach(transport);await result.connection.whenIdle();
  const sub=quotaSubscription('testnet',{type:'openOrders',user,dex:''}),permit=await result.connection.subscribe([sub],Date.now()+5000,true);
  expect(()=>permit.dispatch({method:'subscribe',subscription:{...sub.subscription,user:`0x${'cd'.repeat(20)}`}},()=>{})).toThrow('hyperliquid_quota_permit_lost');
  permit.dispatch({method:'subscribe',subscription:sub.subscription},captured=>{expect(captured).toEqual({method:'subscribe',subscription:sub.subscription});expect(Object.isFrozen(captured)).toBe(true);expect(Object.isFrozen(captured.subscription)).toBe(true);});
 });
 it('retains the entry monotonic deadline when SQL and wall time advance by different amounts',async()=>{
  let clock=Date.now(),mono=1000;class SkewedCommit extends UnitOfWork {override async run<T>(work:(tx:DbTransaction)=>Promise<T>):Promise<T>{const result=await super.run(work);clock+=500;mono+=1000;return result;}}
  const controlled=new PostgresHyperliquidQuota(new SkewedCommit(db),()=>clock,()=>mono),permit=await controlled.bindUnscoped(identity).acquireRest(1,clock+5000);
  clock+=4000;mono+=4100;const send=vi.fn();expect(()=>permit.dispatch(send)).toThrow('hyperliquid_quota_expired');expect(send).not.toHaveBeenCalled();
 });
 it('batches 269 real unsubscribe ACKs in one SQL transaction and retains their original evidence',async()=>{
  const result=await meter.bindUnscoped(identity).reserveSocket(Date.now()+5000),transport=result.connect.dispatch(()=>new WebSocket('wss://api.hyperliquid-testnet.xyz/ws'));result.connection.attach(transport);await result.connection.whenIdle();
  const subs=Array.from({length:269},(_,i)=>quotaSubscription('testnet',{type:'openOrders',user,dex:i?`venue${i}`:''})),permit=await result.connection.subscribe(subs,Date.now()+5000,true);
  for(const sub of subs){permit.dispatch({method:'unsubscribe',subscription:sub.subscription},()=>{});transport.emit('message',Buffer.from(JSON.stringify({channel:'subscriptionResponse',data:{method:'unsubscribe',subscription:sub.subscription}})));}
  const revision=(await db.select().from(schema.hyperliquidEgressQuota))[0]!.revision;await result.connection.whenIdle();
  const row=(await db.select().from(schema.hyperliquidWsLeases))[0]!,proof=row.cleanupEvidence!;
  expect((await db.select().from(schema.hyperliquidEgressQuota))[0]!.revision).toBe(revision+1);expect(row.subscriptions).toEqual([]);
  expect(proof.kind).toBe('unsubscribe');expect((proof.acknowledgements as any[])).toHaveLength(269);expect(row.cleanupEvidenceDigest).toBe(liveSourceDigest(proof));
  expect((proof.acknowledgements as any[])[0]).toMatchObject({subscriptionId:subs[0]!.id,raw:{channel:'subscriptionResponse',data:{method:'unsubscribe',subscription:subs[0]!.subscription}}});
  expect((proof.acknowledgements as any[]).every(ack=>Number.isSafeInteger(ack.receivedAt)&&ack.receivedAt<=Date.now())).toBe(true);
 });
 it('precharges actual graceful close and durably releases only after the peer close event',async()=>{
  const result=await meter.bindUnscoped(identity).reserveSocket(Date.now()+5000),transport=result.connect.dispatch(()=>new WebSocket('wss://api.hyperliquid-testnet.xyz/ws'));result.connection.attach(transport);await result.connection.whenIdle();
  const sub=quotaSubscription('testnet',{type:'userTwapHistory',user});await result.connection.subscribe([sub],Date.now()+5000,true,true);
  const events=(await db.select().from(schema.hyperliquidEgressQuota))[0]!.events;expect(events.find(e=>e.kind==='ws_message')!.units).toBe(3);
  await result.connection.close(Date.now()+5000);const row=(await db.select().from(schema.hyperliquidWsLeases))[0]!;
  expect(row.state).toBe('closed');expect(row.subscriptions).toEqual([]);expect(row.cleanupEvidence).toMatchObject({kind:'close',code:1000,network:'testnet'});expect(row.cleanupEvidenceDigest).toBe(liveSourceDigest(row.cleanupEvidence));
  expect((await db.select().from(schema.hyperliquidEgressQuota))[0]!.events).toEqual(events);
 });
 it('does not free capacity when a dispatched close never gets a peer close event',async()=>{
  const result=await meter.bindUnscoped(identity).reserveSocket(Date.now()+5000),transport=result.connect.dispatch(()=>new WebSocket('wss://api.hyperliquid-testnet.xyz/ws'));result.connection.attach(transport);await result.connection.whenIdle();
  transport.close=vi.fn();await expect(result.connection.close(Date.now()+50)).rejects.toThrow('hyperliquid_quota_expired');
  const row=(await db.select().from(schema.hyperliquidWsLeases))[0]!;expect(row.state).not.toBe('closed');expect(row.closedAt).toBeNull();expect(row.cleanupEvidence).toBeNull();expect(transport.close).toHaveBeenCalledWith(1000);
 });
 it('closes and flushes a complete 268-venue source before original scope exit, then permits a successor connection',async()=>{
  let sentSubscriptions=0,subscriptionsBeforeFirstAck:number|undefined;
  const global=new HyperliquidGlobalTransport(meter,identity),scopes=new PostgresLiveRiskScope(pool),create=vi.fn((url:string,options:WebSocket.ClientOptions)=>{
   expect(options.autoPong).toBe(false);const socket=new WebSocket(url);
   socket.send=((body:string)=>{const command=JSON.parse(body);if(command.method==='subscribe')sentSubscriptions++;queueMicrotask(()=>{
    subscriptionsBeforeFirstAck??=sentSubscriptions;
    socket.emit('message',Buffer.from(JSON.stringify({channel:'subscriptionResponse',data:command})));
    if(command.method==='subscribe')socket.emit('message',Buffer.from(JSON.stringify(command.subscription.type==='openOrders'?{channel:'openOrders',data:{user,dex:command.subscription.dex,orders:[]}}:{channel:'allDexsClearinghouseState',data:{user,clearinghouseStates:[]}})));
   });}) as typeof socket.send;return socket;
  });
  const source=new HyperliquidAllDexsAccountSource(Date.now,create,'testnet',global),dexes=Array.from({length:268},(_,i)=>i?`venue${i}`:'');
  await scopes.run({userId:1,network:'testnet',accountAddress:user},async(_scope,session)=>global.runOriginal(session,async()=>{
   const connect=vi.spyOn(pool,'connect');try{const result=await source.readAccount(user,dexes,5000);expect(result.orders.venues).toHaveLength(268);expect(connect).not.toHaveBeenCalled();expect(subscriptionsBeforeFirstAck).toBe(269);}finally{connect.mockRestore();}
  }));
  expect((await db.select().from(schema.hyperliquidWsLeases))[0]!.state).toBe('closed');
  await scopes.run({userId:1,network:'testnet',accountAddress:user},async(_scope,session)=>global.runOriginal(session,async()=>{await source.read(user,5000);}));
  expect(create).toHaveBeenCalledTimes(2);expect((await db.select().from(schema.hyperliquidWsLeases)).every(row=>row.state==='closed')).toBe(true);
 });

 it('reads 268 venues through two original-session sockets, preserving all evidence and the shared meter',async()=>{
  const global=new HyperliquidGlobalTransport(meter,identity),scopes=new PostgresLiveRiskScope(pool),sent:string[]=[];
  const create=vi.fn((url:string)=>{
   const socket=new WebSocket(url);
   socket.send=((body:string)=>{const command=JSON.parse(body);sent.push(command.method);queueMicrotask(()=>{
    socket.emit('message',Buffer.from(JSON.stringify({channel:'subscriptionResponse',data:command})));
    if(command.method==='subscribe')socket.emit('message',Buffer.from(JSON.stringify(command.subscription.type==='openOrders'?{channel:'openOrders',data:{user,dex:command.subscription.dex,orders:[]}}:{channel:'allDexsClearinghouseState',data:{user,clearinghouseStates:[]}})));
   });}) as typeof socket.send;return socket;
  });
  const source=new PerReadAllDexsAccountSource(()=>new HyperliquidAllDexsAccountSource(Date.now,create,'testnet',global),2);
  const dexes=Array.from({length:268},(_,i)=>i?`venue${i}`:'');
  await scopes.run({userId:1,network:'testnet',accountAddress:user},async(_scope,session)=>global.runOriginal(session,async()=>{
   const connect=vi.spyOn(pool,'connect');try{const result=await source.readAccount(user,dexes,5000);expect(result.orders.requestedDexes).toEqual(dexes);expect(result.orders.venues.map(v=>v.dex)).toEqual(dexes);expect(result.state.accountAddress).toBe(user);expect(connect).not.toHaveBeenCalled();}finally{connect.mockRestore();}
  }));
  expect(create).toHaveBeenCalledTimes(2);expect(sent.filter(m=>m==='subscribe')).toHaveLength(269);expect(sent).not.toContain('unsubscribe');
  const rows=await db.select().from(schema.hyperliquidWsLeases);expect(rows).toHaveLength(2);expect(rows.every(row=>row.state==='closed')).toBe(true);
  const events=(await db.select().from(schema.hyperliquidEgressQuota))[0]!.events;
  expect(events.filter(e=>e.kind==='ws_message').reduce((sum,e)=>sum+e.units,0)).toBe(271);
  expect(events.filter(e=>e.kind==='ws_connect').reduce((sum,e)=>sum+e.units,0)).toBe(2);
 });

 it('a closeAfterRead source subscribes each of 268 venues once and ends its read with one prepaid close: 270 WS units, no unsubscribes, lease closed',async()=>{
  // The api's account-mode absence proof: 538 units a read before (269
  // subscriptions with their unsubscribes prepaid), two per setup attempt,
  // over the 2,000-unit window next to the collector's reads.
  const global=new HyperliquidGlobalTransport(meter,identity),methods:string[]=[];
  const create=vi.fn((url:string)=>{
   // A ws client that never touches the network: the peer is simulated.
   const socket=Object.create(WebSocket.prototype) as WebSocket;EventEmitter.call(socket);let state:number=WebSocket.OPEN;
   Object.defineProperties(socket,{url:{value:url},readyState:{get:()=>state},bufferedAmount:{value:0}});
   socket.send=((body:string)=>{const command=JSON.parse(body);methods.push(command.method);queueMicrotask(()=>{
    socket.emit('message',Buffer.from(JSON.stringify({channel:'subscriptionResponse',data:command})));
    if(command.method==='subscribe')socket.emit('message',Buffer.from(JSON.stringify(command.subscription.type==='openOrders'?{channel:'openOrders',data:{user,dex:command.subscription.dex,orders:[]}}:{channel:'allDexsClearinghouseState',data:{user,clearinghouseStates:[]}})));
   });}) as typeof socket.send;
   socket.close=((code?:number)=>{state=WebSocket.CLOSED;queueMicrotask(()=>socket.emit('close',code??1000,Buffer.alloc(0)));}) as typeof socket.close;
   socket.terminate=(()=>{state=WebSocket.CLOSED;queueMicrotask(()=>socket.emit('close',1006,Buffer.alloc(0)));}) as typeof socket.terminate;
   return socket;
  });
  const source=new HyperliquidAllDexsAccountSource(Date.now,create,'testnet',global,{closeAfterRead:true}),dexes=Array.from({length:268},(_,i)=>i?`venue${i}`:'');
  const result=await source.readAccount(user,dexes,5000);
  expect(result.orders.venues).toHaveLength(268);expect(methods.filter(m=>m==='subscribe')).toHaveLength(269);expect(methods.filter(m=>m==='unsubscribe')).toEqual([]);
  const events=(await db.select().from(schema.hyperliquidEgressQuota))[0]!.events;
  expect(events.filter(e=>e.kind==='ws_message').reduce((sum,e)=>sum+e.units,0)).toBe(270);
  const leases=await db.select().from(schema.hyperliquidWsLeases);expect(leases).toHaveLength(1);
  expect(leases[0]).toMatchObject({state:'closed',subscriptions:[]});expect(leases[0]!.cleanupEvidence).toMatchObject({kind:'close',code:1000});
  // The next read opens a new socket (the source's one-a-second pacing first).
  await new Promise(resolve=>setTimeout(resolve,1_050));
  await source.readAccount(user,dexes,5000);expect(create).toHaveBeenCalledTimes(2);
  expect((await db.select().from(schema.hyperliquidWsLeases)).every(row=>row.state==='closed')).toBe(true);
 });

 it('an abandoned all-venue read reserves no socket and leaves no lease (no uncertain lease from an orphaned absence proof)',async()=>{
  const global=new HyperliquidGlobalTransport(meter,identity),create=vi.fn(),abandon=new AbortController();abandon.abort();
  const source=new HyperliquidAllDexsAccountSource(Date.now,create,'testnet',global,{closeAfterRead:true});
  await expect(source.readAccount(user,['',...Array.from({length:267},(_,i)=>`venue${i}`)],5000,abandon.signal)).rejects.toThrow('live_account_read_abandoned');
  expect(create).not.toHaveBeenCalled();expect(await db.select().from(schema.hyperliquidWsLeases)).toEqual([]);
 });

 it('rechecks the same private send permit after costly synchronous callback work without allowing reuse',async()=>{
  let clock=Date.now();const controlled=new PostgresHyperliquidQuota(new UnitOfWork(db),()=>clock),permit=await controlled.bindUnscoped(identity).acquireRest(1,clock+5000),send=vi.fn();
  expect(()=>permit.dispatch(()=>{clock+=5001;permit.assertFresh();send();})).toThrow('hyperliquid_quota_expired');expect(send).not.toHaveBeenCalled();
  expect(()=>permit.assertFresh()).toThrow();expect((await db.select().from(schema.hyperliquidEgressQuota))[0]!.events).toHaveLength(1);
 });

 it('awaits delayed durable abnormal-close cleanup before a failed original source scope exits',async()=>{
  const global=new HyperliquidGlobalTransport(meter,identity),scopes=new PostgresLiveRiskScope(pool);let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  type Apply=(...args:unknown[])=>Promise<()=>void>;const privateMeter=meter as unknown as {apply:Apply},original=privateMeter.apply.bind(meter);
  const hook=vi.spyOn(privateMeter,'apply').mockImplementation(async(...args)=>{
   const make=args[1] as (now:number,until:number)=>{kind:string};if(make(Date.now(),Date.now()).kind==='uncertain'){entered();await gate;}return original(...args);
  });
  const source=new HyperliquidAllDexsAccountSource(Date.now,url=>{const socket=new WebSocket(url);socket.send=vi.fn();return socket;},'testnet',global);let finished=false;
  const work=scopes.run({userId:1,network:'testnet',accountAddress:user},async(_scope,session)=>global.runOriginal(session,async()=>{await expect(source.read(user,500)).rejects.toThrow('live_account_aggregate_unavailable');})).finally(()=>{finished=true;});
  try{await started;await new Promise(r=>setTimeout(r,10));expect(finished).toBe(false);release();await work;
   expect((await db.select().from(schema.hyperliquidWsLeases))[0]!.state).toBe('uncertain');
  }finally{release();await work.catch(()=>{});hook.mockRestore();}
 });

 it('cancels only a privately proven never-dispatched connection, keeping minute charges and tombstoning construction',async()=>{
  const result=await meter.bindUnscoped(identity).reserveSocket(Date.now()+5000);await result.connection.cancelBeforeConnect();
  const row=(await db.select().from(schema.hyperliquidWsLeases))[0]!;expect(row.state).toBe('closed');expect(row.cleanupEvidence).toMatchObject({kind:'connect_not_dispatched',network:'testnet'});expect(row.cleanupEvidenceDigest).toBe(liveSourceDigest(row.cleanupEvidence));
  const create=vi.fn();expect(()=>result.connect.dispatch(create)).toThrow('hyperliquid_quota_permit_lost');expect(create).not.toHaveBeenCalled();expect(()=>result.connect.assertFresh()).toThrow('hyperliquid_quota_permit_lost');
  expect((await db.select().from(schema.hyperliquidEgressQuota))[0]!.events.find(e=>e.kind==='ws_connect')!.units).toBe(1);await expect(result.connection.cancelBeforeConnect()).rejects.toThrow('hyperliquid_quota_permit_lost');
 });
 it('refuses local-unsent cancellation once construction began, including a throwing constructor',async()=>{
  const result=await meter.bindUnscoped(identity).reserveSocket(Date.now()+5000);expect(()=>result.connect.dispatch(()=>{throw Error('constructor uncertain');})).toThrow('constructor uncertain');
  await expect(result.connection.cancelBeforeConnect()).rejects.toThrow('hyperliquid_quota_permit_lost');const row=(await db.select().from(schema.hyperliquidWsLeases))[0]!;expect(row.state).not.toBe('closed');expect(row.cleanupEvidence).toBeNull();
 });

});
