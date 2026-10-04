import {describe,it,expect} from 'vitest';
import {LiveBoundaryError} from '../src/copy/live/wallet-authorization.js';
import {planHyperliquidQuota,quotaSubscription,type HyperliquidQuotaState,type HyperliquidQuotaLease,type HyperliquidQuotaRequest} from '../src/hyperliquid/hyperliquid-global-quota.js';
const now=1790000000000,egressKey='shared-egress-a',user=`0x${'22'.repeat(20)}`;
const state=():HyperliquidQuotaState=>({egressKey,revision:1,events:[],updatedAt:now});
const lease=(id='socket-a'):HyperliquidQuotaLease=>({id,egressKey,socketId:id,fenceToken:`fence-${id}`,ownerId:'api-a',state:'open',revision:1,leaseUntil:now+5000,latestAllowedSendAt:now+5000,subscriptions:[],createdAt:now,updatedAt:now,closedAt:null});
const plan=(request:HyperliquidQuotaRequest,partial:{state?:HyperliquidQuotaState;leases?:HyperliquidQuotaLease[];now?:number}={})=>planHyperliquidQuota({now,state:state(),leases:[],...partial,request});
const subscribe=(values:ReturnType<typeof quotaSubscription>[],id='subscribe-a'):HyperliquidQuotaRequest=>({kind:'subscribe',id,leaseId:'socket-a',fenceToken:'fence-socket-a',ownerId:'api-a',sendUntil:now+5000,subscriptions:values,prepayCleanup:true});
describe('pure shared per-IP Hyperliquid quota accounting',()=>{
 it('reports when cumulative REST expiries free the requested weight, without counting other meters or lease expiry',()=>{
  const s:HyperliquidQuotaState={...state(),events:[
   {id:'later',kind:'rest',units:1080,reservedAt:now,expiresAt:now+65000},
   {id:'first',kind:'rest',units:50,reservedAt:now,expiresAt:now+1000},
   {id:'other-meter',kind:'ws_message',units:2000,reservedAt:now,expiresAt:now+2000},
   {id:'second',kind:'rest',units:70,reservedAt:now,expiresAt:now+12345},
  ]};
  const before=structuredClone(s),leases=[lease()];
  let denied:unknown;
  try{plan({kind:'rest',id:'needed',weight:120,sendUntil:now+5000},{state:s,leases});}catch(error){denied=error;}
  expect(denied).toBeInstanceOf(LiveBoundaryError);
  expect(denied).toMatchObject({code:'hyperliquid_quota_exhausted',retryAfterMs:12345});
  expect(s).toEqual(before);expect(leases).toEqual([lease()]);
  expect(()=>plan({kind:'rest',id:'too-early',weight:120,sendUntil:now+12344},{state:s,now:now+12344,leases})).toThrow('hyperliquid_quota_exhausted');
  expect(plan({kind:'rest',id:'eligible',weight:120,sendUntil:now+12345},{state:s,now:now+12345,leases}).charged).toBe(120);
 });
 it('uses existing REST headroom and same-time expiries instead of waiting for the last retained charge',()=>{
  const s:HyperliquidQuotaState={...state(),events:[
   {id:'expired',kind:'rest',units:1200,reservedAt:now-65000,expiresAt:now},
   {id:'later',kind:'rest',units:1080,reservedAt:now,expiresAt:now+65000},
   {id:'first',kind:'rest',units:30,reservedAt:now,expiresAt:now+1500},
   {id:'second',kind:'rest',units:30,reservedAt:now,expiresAt:now+1500},
  ]};
  let denied:unknown;
  try{plan({kind:'rest',id:'needed',weight:120,sendUntil:now+5000},{state:s});}catch(error){denied=error;}
  expect(denied).toMatchObject({code:'hyperliquid_quota_exhausted',retryAfterMs:1500});
 });
 it('charges REST before send and retains a late-send reservation for its full provider window',()=>{
  const result=plan({kind:'rest',id:'rest-a',weight:1200,sendUntil:now+5000});expect(result.charged).toBe(1200);expect(result.state.events[0]).toMatchObject({reservedAt:now,expiresAt:now+65000});
  expect(()=>plan({kind:'rest',id:'rest-b',weight:1,sendUntil:now+60001},{state:result.state,now:now+60001})).toThrow('hyperliquid_quota_exhausted');
  expect(plan({kind:'rest',id:'rest-c',weight:1,sendUntil:now+65000},{state:result.state,now:now+65000}).state.events).toHaveLength(1);
 });
 it('does not restore unspent or unknown charges after restart',()=>{
  const result=plan({kind:'rest',id:'rest-a',weight:1200,sendUntil:now+5000});const restarted=JSON.parse(JSON.stringify(result.state));
  expect(()=>plan({kind:'rest',id:'rest-b',weight:1,sendUntil:now+1},{state:restarted,now:now+1})).toThrow('hyperliquid_quota_exhausted');
 });
 it('refuses duplicate ticket identities rather than minting a second send from one charge',()=>{
  const result=plan({kind:'rest',id:'rest-a',weight:1,sendUntil:now+5000});expect(()=>plan({kind:'rest',id:'rest-a',weight:1,sendUntil:now+5000},{state:result.state})).toThrow('hyperliquid_quota_ticket_conflict');
 });
 it('reserves both subscribe and cleanup commands for all268 venues',()=>{
  const values=[quotaSubscription('testnet',{type:'allDexsClearinghouseState',user}),...Array.from({length:268},(_,i)=>quotaSubscription('testnet',{type:'openOrders',user,dex:i===0?'':`i<3fl${i}`}))];
  const result=plan(subscribe(values),{leases:[lease()]});expect(result.charged).toBe(538);expect(result.leases[0]!.subscriptions).toHaveLength(269);
 });
 it('shares message capacity across independent socket owners',()=>{
  const s={...state(),events:[{id:'other-owner',kind:'ws_message' as const,units:1999,reservedAt:now,expiresAt:now+65000}]};
  expect(()=>plan(subscribe([quotaSubscription('testnet',{type:'openOrders',user,dex:''})]),{state:s,leases:[lease()]})).toThrow('hyperliquid_quota_exhausted');
 });
 it('counts distinct users across the whole egress rather than each socket',()=>{
  const existing=Array.from({length:10},(_,i)=>quotaSubscription('testnet',{type:'openOrders',user:`0x${String(i+1).padStart(40,'0')}`,dex:''}));
  expect(()=>plan(subscribe([quotaSubscription('testnet',{type:'openOrders',user,dex:''})]),{leases:[{...lease(),subscriptions:existing}]})).toThrow('hyperliquid_quota_users');
 });
 it('keeps1000 reserved subscriptions counted even before ACKs',()=>{
  const existing=Array.from({length:1000},(_,i)=>quotaSubscription('testnet',{type:'trades',coin:`COIN${i}`}));
  expect(()=>plan(subscribe([quotaSubscription('testnet',{type:'openOrders',user,dex:''})]),{leases:[{...lease(),state:'reserved',subscriptions:existing}]})).toThrow('hyperliquid_quota_subscriptions');
 });
 it('holds expired socket slots uncertain instead of reclaiming ten provider connections by TTL',()=>{
  const leases=Array.from({length:10},(_,i)=>({...lease(`socket-${i}`),createdAt:now-5000,leaseUntil:now-1,latestAllowedSendAt:now-1}));const l=lease('eleventh');
  expect(()=>plan({kind:'connect',id:'connection-attempt',sendUntil:now+5000,lease:{id:l.id,egressKey,socketId:l.socketId,fenceToken:l.fenceToken,ownerId:l.ownerId,leaseUntil:l.leaseUntil,latestAllowedSendAt:l.latestAllowedSendAt}},{leases})).toThrow('hyperliquid_quota_connections');
 });
 it('persists uncertain expiration without dropping subscriptions',()=>{
  const sub=quotaSubscription('testnet',{type:'openOrders',user,dex:''});
  const result=plan({kind:'rest',id:'rest-a',weight:2,sendUntil:now+5000},{leases:[{...lease(),createdAt:now-5000,leaseUntil:now-1,latestAllowedSendAt:now-1,subscriptions:[sub]}]});expect(result.leases[0]).toMatchObject({state:'uncertain',subscriptions:[sub]});
 });
 it('requires exact socket fence and owner for unsubscribe acknowledgement',()=>{
  const sub=quotaSubscription('testnet',{type:'openOrders',user,dex:''});
  expect(()=>plan({kind:'ack_unsubscribe',leaseId:'socket-a',fenceToken:'foreign',ownerId:'api-a',subscriptionIds:[sub.id]},{leases:[{...lease(),subscriptions:[sub]}]})).toThrow('hyperliquid_quota_lease_lost');
 });
 it('releases confirmed subscription capacity while retaining sent-message minute charges',()=>{
  const sub=quotaSubscription('testnet',{type:'openOrders',user,dex:''}),initial=plan(subscribe([sub]),{leases:[lease()]});
  const result=plan({kind:'ack_unsubscribe',leaseId:'socket-a',fenceToken:'fence-socket-a',ownerId:'api-a',subscriptionIds:[sub.id]},{state:initial.state,leases:[...initial.leases]});expect(result.leases[0]!.subscriptions).toEqual([]);expect(result.state.events).toEqual(initial.state.events);
 });
 it('normal confirmed close releases active resources but never connection-attempt charges',()=>{
  const l=lease(),initial=plan({kind:'connect',id:'new-a',sendUntil:now+5000,lease:{id:l.id,egressKey,socketId:l.socketId,fenceToken:l.fenceToken,ownerId:l.ownerId,leaseUntil:l.leaseUntil,latestAllowedSendAt:l.latestAllowedSendAt}});
  const result=plan({kind:'closed',leaseId:l.id,fenceToken:l.fenceToken,ownerId:l.ownerId},{state:initial.state,leases:[...initial.leases]});expect(result.leases[0]).toMatchObject({state:'closed',closedAt:now,subscriptions:[]});expect(result.state.events).toEqual(initial.state.events);
 });
 it('does not admit another new connection after30 failed attempts in the minute',()=>{
  const s={...state(),events:[{id:'prior-attempts',kind:'ws_connect' as const,units:30,reservedAt:now,expiresAt:now+65000}]},l=lease();
  expect(()=>plan({kind:'connect',id:'new-a',sendUntil:now+5000,lease:{id:l.id,egressKey,socketId:l.socketId,fenceToken:l.fenceToken,ownerId:l.ownerId,leaseUntil:l.leaseUntil,latestAllowedSendAt:l.latestAllowedSendAt}},{state:s})).toThrow('hyperliquid_quota_exhausted');
 });
 it('cannot impersonate a user or change a subscription body behind its identity',()=>{
  const sub=quotaSubscription('testnet',{type:'openOrders',user,dex:''});expect(()=>plan(subscribe([{...sub,user:`0x${'33'.repeat(20)}`}]),{leases:[lease()]})).toThrow('hyperliquid_quota_invalid');
 });
 it.each([0,-1,NaN,Infinity,1201])('rejects malformed/overbound REST weight %s',weight=>{expect(()=>plan({kind:'rest',id:'rest-a',weight,sendUntil:now+5000})).toThrow('hyperliquid_quota_invalid');});
 it('rejects unbounded records and a backward clock without dropping retained charges',()=>{
  expect(()=>plan({kind:'rest',id:'rest-a',weight:1,sendUntil:now+5000},{state:{...state(),updatedAt:now+1}})).toThrow('hyperliquid_quota_invalid');
 });
 it('renews a live original socket without releasing any counted subscription',()=>{
  const sub=quotaSubscription('testnet',{type:'openOrders',user,dex:''});
  const result=plan({kind:'renew',leaseId:'socket-a',fenceToken:'fence-socket-a',ownerId:'api-a',sendUntil:now+5000,leaseUntil:now+60000} as never,{leases:[{...lease(),subscriptions:[sub]}]});
  expect(result.leases[0]).toMatchObject({state:'open',leaseUntil:now+60000,subscriptions:[sub]});expect(result.charged).toBe(0);
 });
 it('does not renew an expired uncertain socket using its persisted identifiers',()=>{
  expect(()=>plan({kind:'renew',leaseId:'socket-a',fenceToken:'fence-socket-a',ownerId:'api-a',sendUntil:now+5000,leaseUntil:now+60000} as never,{leases:[{...lease(),createdAt:now-5000,leaseUntil:now-1,latestAllowedSendAt:now-1}]})).toThrow('hyperliquid_quota_lease_lost');
 });
 it('rejects a persisted lease whose permitted send extends past its capacity lease',()=>{
  expect(()=>plan({kind:'rest',id:'rest-a',weight:1,sendUntil:now+5000},{leases:[{...lease(),latestAllowedSendAt:now+5001}]})).toThrow('hyperliquid_quota_invalid');
 });
 it('binds documented TWAP history subscriptions to the exact user and network',()=>{
  expect(quotaSubscription('mainnet',{type:'userTwapHistory',user})).toMatchObject({network:'mainnet',user,subscription:{type:'userTwapHistory',user}});
 });
 it('prepays one close control frame with the bounded subscribe/unsubscribe plan',()=>{
  const sub=quotaSubscription('testnet',{type:'openOrders',user,dex:''}),result=plan({...subscribe([sub]),prepayClose:true} as never,{leases:[lease()]});expect(result.charged).toBe(3);
 });
});
