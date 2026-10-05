import {Pool} from 'pg';
import {TLSSocket} from 'node:tls';
import {Socket} from 'node:net';
import {EventEmitter} from 'node:events';
import {drizzle} from 'drizzle-orm/node-postgres';
import * as schema from '@trading-dashboard/shared/database';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import WebSocket from 'ws';
import {getTestDb,closeTestDb} from './db-test-utils.js';
import {UnitOfWork} from '../src/db/unit-of-work.js';
import {PostgresHyperliquidQuota} from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import {quotaSubscription} from '../src/hyperliquid/hyperliquid-global-quota.js';
import {liveSourceDigest} from '../src/copy/live/copy-live-source-evidence.js';
import {PostgresLiveRiskScope} from '../src/copy/live/postgres-live-risk-scope.js';
vi.mock('ws',async()=>{const {EventEmitter}=await import('node:events');return {default:class extends EventEmitter {static OPEN=1;static CLOSED=3;readyState=1;bufferedAmount=0;constructor(readonly url:string){super();}close(){}terminate(){this.readyState=3;this.emit('close',1006,Buffer.alloc(0));}}};});
let pool:Pool,meter:PostgresHyperliquidQuota,db:ReturnType<typeof getTestDb>;
const identity={egressKey:'project-shared-egress',ownerId:'peer-eof-test'},user=`0x${'ab'.repeat(20)}`;
beforeAll(()=>{db=getTestDb();pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});meter=new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool,{schema})));});
beforeEach(async()=>{await db.delete(schema.hyperliquidWsLeases);await db.delete(schema.hyperliquidEgressQuota);});
afterAll(async()=>{await pool?.end();await closeTestDb();});
type NativeWebSocket=WebSocket&{_socket:TLSSocket};
async function fixture(bound=meter.bindUnscoped(identity),options:{authorized?:boolean;servername?:string;plain?:boolean}={}){
 const reserved=await bound.reserveSocket(Date.now()+5000,'mainnet');
 const native=new TLSSocket(new Socket());native.authorized=options.authorized??true;native.servername=options.servername??'api.hyperliquid.xyz';
 let readableEnded=false;Object.defineProperty(native,'readableEnded',{get:()=>readableEnded});
 native.on('error',()=>{});
 const socket=reserved.connect.dispatch(()=>new WebSocket('wss://api.hyperliquid.xyz/ws')) as NativeWebSocket;
 socket._socket=(options.plain?Object.assign(new EventEmitter(),{encrypted:true,authorized:true,servername:'api.hyperliquid.xyz'}):native) as TLSSocket;
 reserved.connection.attach(socket);await reserved.connection.whenIdle();
 const sub=quotaSubscription('mainnet',{type:'userTwapHistory',user});
 async function subscribe(clean=true,drain=true){const permit=await reserved.connection.subscribe([sub],Date.now()+5000,true);permit.dispatch({method:'subscribe',subscription:sub.subscription},()=>{});if(clean){permit.dispatch({method:'unsubscribe',subscription:sub.subscription},()=>{});socket.emit('message',Buffer.from(JSON.stringify({channel:'subscriptionResponse',data:{method:'unsubscribe',subscription:sub.subscription}})));if(drain)await reserved.connection.whenIdle();}}
 async function eof(hadError=false){readableEnded=true;native.emit('end');await new Promise<void>(resolve=>{native.once('close',()=>{Object.defineProperty(socket,'readyState',{value:WebSocket.CLOSED});socket.emit('close',1006,Buffer.alloc(0));resolve();});native.destroy(hadError?Error('native failure'):undefined);});}
 return {...reserved,socket,native,subscribe,eof};
}
describe('private original TLS peer EOF releases only transport capacity',()=>{
 it('persists unclean1006 EOF proof after exact durable unsubscribe and keeps all minute charges',async()=>{
  const f=await fixture();await f.subscribe();f.socket.close=()=>{void f.eof();};
  await f.connection.close(Date.now()+5000);await f.connection.whenIdle();
  const row=(await db.select().from(schema.hyperliquidWsLeases))[0]!;
  expect(row.state).toBe('closed');expect(row.subscriptions).toEqual([]);expect(row.cleanupEvidence).toMatchObject({kind:'peer_eof',code:1006,clean:false,network:'mainnet',servername:'api.hyperliquid.xyz',hadError:false});
  expect(row.cleanupEvidenceDigest).toBe(liveSourceDigest(row.cleanupEvidence));
  const evidence=row.cleanupEvidence!;expect(evidence.peerEndedAt).toBeGreaterThan(0);expect(evidence.nativeClosedAt).toBeGreaterThanOrEqual(evidence.peerEndedAt as number);expect(evidence.receivedAt).toBeGreaterThanOrEqual(evidence.nativeClosedAt as number);
  expect(evidence.acknowledgements).toEqual([expect.objectContaining({receivedAt:expect.any(Number),raw:{channel:'subscriptionResponse',data:{method:'unsubscribe',subscription:{type:'userTwapHistory',user}}}})]);
  const events=(await db.select().from(schema.hyperliquidEgressQuota))[0]!.events;expect(events.find(e=>e.kind==='ws_connect')!.units).toBe(1);expect(events.filter(e=>e.kind==='ws_message').reduce((n,e)=>n+e.units,0)).toBe(3);
 });
 it('closes a socket that ends subscribed after its own close frame (Hyperliquid answers a close with a bare EOF)',async()=>{
  const f=await fixture(),sub=quotaSubscription('mainnet',{type:'userTwapHistory',user});
  const permit=await f.connection.subscribe([sub],Date.now()+5000,false,true);permit.dispatch({method:'subscribe',subscription:sub.subscription},()=>{});
  f.socket.close=()=>{void f.eof();};
  await f.connection.close(Date.now()+5000);await f.connection.whenIdle();
  const row=(await db.select().from(schema.hyperliquidWsLeases))[0]!;
  expect(row.state).toBe('closed');expect(row.subscriptions).toEqual([]);expect(row.cleanupEvidence).toMatchObject({kind:'peer_eof',code:1006,clean:false,closeSent:true,hadError:false});
 });
 it('frees the tenth shared slot only after the original native EOF proof commits',async()=>{
  const f=await fixture();for(let i=0;i<9;i++)await meter.bindUnscoped(identity).reserveSocket(Date.now()+5000);
  await expect(meter.bindUnscoped(identity).reserveSocket(Date.now()+5000)).rejects.toThrow('hyperliquid_quota_connections');
  await f.eof();await f.connection.whenIdle();await expect(meter.bindUnscoped(identity).reserveSocket(Date.now()+5000)).resolves.toBeDefined();
 });
 it.each(['unauthorized','wrong_servername','plain_socket','replaced_socket','terminate_before_eof','destroy_before_eof','end_before_eof','native_error','ws_error','native_close_error','missing_unsubscribe','unmatched_ack','no_eof','ws_buffered','native_buffered'] as const)('retains uncertainty for %s',async(reason)=>{
  const f=await fixture(undefined,{authorized:reason!=='unauthorized',servername:reason==='wrong_servername'?'attacker.invalid':undefined,plain:reason==='plain_socket'});
  if(reason==='missing_unsubscribe')await f.subscribe(false);
  if(reason==='unmatched_ack')f.socket.emit('message',Buffer.from(JSON.stringify({channel:'subscriptionResponse',data:{method:'unsubscribe',subscription:{type:'userTwapHistory',user}}})));
  if(reason==='replaced_socket')f.socket._socket=new TLSSocket(new Socket());
  if(reason==='terminate_before_eof')f.socket.terminate();
  if(reason==='destroy_before_eof'){f.native.destroy();await new Promise<void>(resolve=>f.native.once('close',()=>resolve()));Object.defineProperty(f.socket,'readyState',{value:WebSocket.CLOSED});f.socket.emit('close',1006,Buffer.alloc(0));}
  if(reason==='end_before_eof')f.native.end();
  if(reason==='native_error')f.native.emit('error',Error('native failure'));
  if(reason==='ws_error')f.socket.emit('error',Error('ws failure'));
  if(reason==='ws_buffered')Object.defineProperty(f.socket,'bufferedAmount',{value:1});
  if(reason==='native_buffered')Object.defineProperty(f.native,'writableLength',{value:1});
  if(reason==='no_eof'){Object.defineProperty(f.socket,'readyState',{value:WebSocket.CLOSED});f.socket.emit('close',1006,Buffer.alloc(0));}else if(reason!=='destroy_before_eof')await f.eof(reason==='native_close_error');
  await f.connection.whenIdle().catch(()=>{});const row=(await db.select().from(schema.hyperliquidWsLeases))[0]!;expect(row.state).toBe('uncertain');expect(row.closedAt).toBeNull();expect(row.cleanupEvidence?.kind).not.toBe('peer_eof');
  await expect(f.connection.close(Date.now()+100)).rejects.toThrow('hyperliquid_quota_lease_lost');
  f.native.removeAllListeners();f.native.destroy();
 });
 it('cannot turn failed EOF persistence into successful cleanup after recovering its queue',async()=>{
  const f=await fixture();await f.subscribe(true,false);
  type Apply=(...args:unknown[])=>Promise<()=>void>;const privateMeter=meter as unknown as {apply:Apply},original=privateMeter.apply.bind(meter);
  const hook=vi.spyOn(privateMeter,'apply').mockImplementation(async(...args)=>{const make=args[1] as (now:number,until:number)=>{kind:string};if(make(Date.now(),Date.now()).kind==='closed')throw Error('durable EOF unavailable');return original(...args);});
  try{await f.eof();await expect(f.connection.whenIdle()).rejects.toThrow('durable EOF unavailable');await f.connection.uncertain();
   // Later successful queue work must not erase the failed terminal commit.
   await expect(f.connection.close(Date.now()+5000)).rejects.toThrow();expect((await db.select().from(schema.hyperliquidWsLeases))[0]!.state).toBe('uncertain');
  }finally{hook.mockRestore();}
 });
 it('does not release EOF capacity until exact unsubscribe ACK persistence completes',async()=>{
  const f=await fixture();await f.subscribe(true,false);let release!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  type Apply=(...args:unknown[])=>Promise<()=>void>;const privateMeter=meter as unknown as {apply:Apply},original=privateMeter.apply.bind(meter);
  const hook=vi.spyOn(privateMeter,'apply').mockImplementation(async(...args)=>{const make=args[1] as (now:number,until:number)=>{kind:string};if(make(Date.now(),Date.now()).kind==='ack_unsubscribe'){entered();await held;}return original(...args);});
  let finished=false;const work=f.eof().then(()=>f.connection.whenIdle()).finally(()=>{finished=true;});void work.catch(()=>{});
  try{await Promise.race([started,work]);await new Promise(resolve=>setTimeout(resolve,10));expect(finished).toBe(false);expect((await db.select().from(schema.hyperliquidWsLeases))[0]!.state).not.toBe('closed');release();await work;expect((await db.select().from(schema.hyperliquidWsLeases))[0]!.state).toBe('closed');}
  finally{release();await work.catch(()=>{});hook.mockRestore();}
 });
 it('waits for durable EOF cleanup on the original maxpool1 session before releasing its locks',async()=>{
  const scopes=new PostgresLiveRiskScope(pool);let release!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const unexpected=vi.spyOn(UnitOfWork.prototype,'run');
  type Apply=(...args:unknown[])=>Promise<()=>void>;const privateMeter=meter as unknown as {apply:Apply},original=privateMeter.apply.bind(meter);
  const hook=vi.spyOn(privateMeter,'apply').mockImplementation(async(...args)=>{const make=args[1] as (now:number,until:number)=>{kind:string};if(make(Date.now(),Date.now()).kind==='closed'){entered();await held;}return original(...args);});
  let finished=false;
  const work=scopes.run({userId:1,network:'mainnet',accountAddress:user},async(_scope,session)=>{
   const f=await fixture(meter.bindOriginal(session,identity));f.socket.close=()=>{void f.eof();};await f.connection.close(Date.now()+5000);await f.connection.whenIdle();
  }).finally(()=>{finished=true;});void work.catch(()=>{});
  try{await Promise.race([started,work]);await new Promise(resolve=>setTimeout(resolve,10));expect(finished).toBe(false);expect(unexpected).not.toHaveBeenCalled();release();await work;expect((await db.select().from(schema.hyperliquidWsLeases))[0]!.state).toBe('closed');}
  finally{release();await work.catch(()=>{});unexpected.mockRestore();hook.mockRestore();}
 });
});
