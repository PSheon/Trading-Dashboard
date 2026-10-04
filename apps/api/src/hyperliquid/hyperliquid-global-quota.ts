import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {address,LiveBoundaryError} from '../copy/live/wallet-authorization.js';
import {LIVE_DEX_NAME,LIVE_PERP_COIN} from '../copy/live/live-market-resolver.js';
import {freezeLiveReservation} from '../copy/live/live-risk-reservation.js';
import {HyperliquidRestCapacityError} from './hyperliquid-capacity-error.js';
import type { LiveNetwork } from '../copy/live/wallet-authorization.js';
export interface HyperliquidQuotaEvent {readonly id:string;readonly kind:'rest'|'ws_message'|'ws_connect';readonly units:number;readonly reservedAt:number;readonly expiresAt:number;}
export interface HyperliquidQuotaSubscription {readonly id:string;readonly network:LiveNetwork;readonly user:string|null;readonly subscription:Readonly<Record<string,unknown>>;}
export interface HyperliquidQuotaLease {readonly id:string;readonly egressKey:string;readonly socketId:string;readonly fenceToken:string;readonly ownerId:string;readonly state:'reserved'|'open'|'closing'|'uncertain'|'closed';readonly revision:number;readonly leaseUntil:number;readonly latestAllowedSendAt:number;readonly subscriptions:readonly HyperliquidQuotaSubscription[];readonly createdAt:number;readonly updatedAt:number;readonly closedAt:number|null;}
export interface HyperliquidQuotaState {readonly egressKey:string;readonly revision:number;readonly events:readonly HyperliquidQuotaEvent[];readonly updatedAt:number;}
export type HyperliquidQuotaRequest=
 |{readonly kind:'rest';readonly id:string;readonly weight:number;readonly sendUntil:number;readonly lane?:HyperliquidRestLane;readonly settle?:readonly HyperliquidRestSettlement[]}
 |{readonly kind:'connect';readonly id:string;readonly sendUntil:number;readonly lease:Omit<HyperliquidQuotaLease,'state'|'revision'|'subscriptions'|'createdAt'|'updatedAt'|'closedAt'>}
 |{readonly kind:'subscribe';readonly id:string;readonly leaseId:string;readonly fenceToken:string;readonly ownerId:string;readonly sendUntil:number;readonly subscriptions:readonly HyperliquidQuotaSubscription[];readonly prepayCleanup:boolean;readonly prepayClose?:boolean}
 |{readonly kind:'ping'|'close'|'unsubscribe';readonly id:string;readonly leaseId:string;readonly fenceToken:string;readonly ownerId:string;readonly sendUntil:number;readonly subscriptionIds?:readonly string[]}
 |{readonly kind:'opened'|'uncertain'|'closing'|'closed';readonly leaseId:string;readonly fenceToken:string;readonly ownerId:string}
 |{readonly kind:'renew';readonly leaseId:string;readonly fenceToken:string;readonly ownerId:string;readonly sendUntil:number;readonly leaseUntil:number}
 |{readonly kind:'ack_unsubscribe';readonly leaseId:string;readonly fenceToken:string;readonly ownerId:string;readonly subscriptionIds:readonly string[]};
/** A list call's charge brought down to what the provider counted once its
 * answer is in: Hyperliquid weighs a list by the items it returns (20 + 1 per
 * 20, at most 120 for 2,000), and the meter prepays the most. Sent with the
 * same process's next REST request; never raises a charge. */
export interface HyperliquidRestSettlement {readonly id:string;readonly units:number;}
/** Settlements one REST request may carry. */
export const HYPERLIQUID_MAX_SETTLEMENTS=64;
/** `background`: work nobody is waiting for (pool loops, warm-ups, sweeps of
 * uncopied leaders). It may fill the shared per-IP REST window only up to
 * HYPERLIQUID_BACKGROUND_REST_CAP, so a page or a copy signal always finds
 * room. Unlabelled requests (pages, live copy work, exchange actions) may use
 * the whole window. */
export type HyperliquidRestLane='background';
/** Hyperliquid's REST weight per minute per IP. */
export const HYPERLIQUID_REST_CAP=1200;
/** What background work may hold of it. Before this, the worker's and the
 * api's background loops (each budgeted 840 a minute locally; the shared
 * meter prepays list calls at 120) kept the window full, and a cold trader
 * page's /activity and /fills answered 503 within 0.4 s. */
export const HYPERLIQUID_BACKGROUND_REST_CAP=840;
export interface HyperliquidQuotaPlan {readonly state:HyperliquidQuotaState;readonly leases:readonly HyperliquidQuotaLease[];readonly charged:number;}
const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identifier=z.string().min(1).max(128).regex(/^[^\s\p{Cc}\p{Cf}]+$/u);
const network=z.enum(['mainnet','testnet']);
const user=z.string().regex(/^0x[0-9a-f]{40}$/);
const bodySchema=z.union([
  z.object({type:z.literal('allDexsClearinghouseState'),user}).strict(),
  z.object({type:z.literal('userTwapHistory'),user}).strict(),
  z.object({type:z.literal('openOrders'),user,dex:z.string().max(40).refine(v=>v===''||LIVE_DEX_NAME.test(v))}).strict(),
  z.object({type:z.literal('trades'),coin:z.string().min(1).max(80).regex(LIVE_PERP_COIN)}).strict(),
]);
const subSchema=z.object({id:z.string().regex(/^[a-f0-9]{64}$/),network,user:user.nullable(),subscription:bodySchema}).strict();
const eventSchema=z.object({id:identifier,kind:z.enum(['rest','ws_message','ws_connect']),units:integer.positive(),reservedAt:integer.positive(),expiresAt:integer.positive()}).strict();
const stateSchema=z.object({egressKey:identifier,revision:integer.positive(),events:z.array(eventSchema).max(3500),updatedAt:integer.positive()}).strict();
const leaseSchema=z.object({id:identifier,egressKey:identifier,socketId:identifier,fenceToken:identifier,ownerId:identifier,state:z.enum(['reserved','open','closing','uncertain','closed']),revision:integer.positive(),leaseUntil:integer.positive(),latestAllowedSendAt:integer.positive(),subscriptions:z.array(subSchema).max(1000),createdAt:integer.positive(),updatedAt:integer.positive(),closedAt:integer.positive().nullable()}).strict();
const sourceIdentity={leaseId:identifier,fenceToken:identifier,ownerId:identifier};
const ids=z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(1000);
const requestSchema=z.union([
  z.object({kind:z.literal('rest'),id:identifier,weight:integer.positive().max(1200),sendUntil:integer.positive(),lane:z.literal('background').optional(),
    settle:z.array(z.object({id:identifier,units:integer.positive().max(1200)}).strict()).max(HYPERLIQUID_MAX_SETTLEMENTS).optional()}).strict(),
  z.object({kind:z.literal('connect'),id:identifier,sendUntil:integer.positive(),lease:leaseSchema.omit({state:true,revision:true,subscriptions:true,createdAt:true,updatedAt:true,closedAt:true})}).strict(),
  z.object({kind:z.literal('subscribe'),id:identifier,...sourceIdentity,sendUntil:integer.positive(),subscriptions:z.array(subSchema).min(1).max(1000),prepayCleanup:z.boolean(),prepayClose:z.boolean().optional()}).strict(),
  z.object({kind:z.enum(['ping','close']),id:identifier,...sourceIdentity,sendUntil:integer.positive()}).strict(),
  z.object({kind:z.literal('unsubscribe'),id:identifier,...sourceIdentity,sendUntil:integer.positive(),subscriptionIds:ids}).strict(),
  z.object({kind:z.enum(['opened','uncertain','closing','closed']),...sourceIdentity}).strict(),
  z.object({kind:z.literal('renew'),...sourceIdentity,sendUntil:integer.positive(),leaseUntil:integer.positive()}).strict(),
  z.object({kind:z.literal('ack_unsubscribe'),...sourceIdentity,subscriptionIds:ids}).strict(),
]);
function requireQuota(value:unknown,code='hyperliquid_quota_invalid'):asserts value {if(!value)throw new LiveBoundaryError(code);}
function unique(values:readonly string[],code='hyperliquid_quota_invalid'){requireQuota(new Set(values).size===values.length,code);}
/** Supported official subscription bodies only. This value is content identity,
 * not a provider acknowledgement or a capability to send. */
export function quotaSubscription(suppliedNetwork:LiveNetwork,suppliedBody:Readonly<Record<string,unknown>>):HyperliquidQuotaSubscription {
  try{
    const n=network.parse(suppliedNetwork),body=bodySchema.parse(structuredClone(suppliedBody));
    const u='user'in body?address(body.user):null;
    const ordered=Object.fromEntries(Object.entries(body).sort(([a],[b])=>a<b?-1:a>b?1:0));
    const id=createHash('sha256').update(JSON.stringify({network:n,subscription:ordered})).digest('hex');
    return freezeLiveReservation({id,network:n,user:u,subscription:body});
  }catch{throw new LiveBoundaryError('hyperliquid_quota_invalid');}
}
function validateSub(sub:HyperliquidQuotaSubscription){requireQuota(isDeepStrictEqual(quotaSubscription(sub.network,sub.subscription),sub));}
/** How long after `leaseUntil` an unclosed lease still counts toward the
 * connection, subscription and user limits. An owner cannot send anything but a
 * close frame once its lease has passed (every send permit is bounded by
 * `latestAllowedSendAt <= leaseUntil`, at most 5 s after reservation, and renewals
 * need a live lease), and Hyperliquid closes any connection that has sent it no
 * message for 60 s. Five minutes is well past both, plus the 1 s clock-skew
 * bound, so a lease left by a killed or partitioned process can no longer hold a
 * provider connection. The row, its subscriptions and its cleanup evidence are
 * kept as they are (state stays `uncertain`, never forged to `closed`), and no
 * charged unit is refunded. */
export const HYPERLIQUID_STALE_LEASE_RECLAIM_MS=300_000;
/** True when an unclosed lease no longer counts toward provider capacity. */
export function hyperliquidLeaseReclaimed(lease:Pick<HyperliquidQuotaLease,'state'|'leaseUntil'>,now:number):boolean {
  return lease.state!=='closed'&&lease.leaseUntil+HYPERLIQUID_STALE_LEASE_RECLAIM_MS<=now;
}
/** Pure accounting only. The DAL must durably commit the complete plan before
 * issuing a private finite outbound capability. No refunds; an expired lease
 * keeps its slot until HYPERLIQUID_STALE_LEASE_RECLAIM_MS has passed. */
export function planHyperliquidQuota(raw:{readonly now:number;readonly state:HyperliquidQuotaState;readonly leases:readonly HyperliquidQuotaLease[];readonly request:HyperliquidQuotaRequest}):HyperliquidQuotaPlan {
  try{
    const now=integer.positive().parse(raw.now),s=stateSchema.parse(structuredClone(raw.state)),leases=z.array(leaseSchema).max(100).parse(structuredClone(raw.leases)),request=requestSchema.parse(structuredClone(raw.request));
    requireQuota(now>=s.updatedAt);unique(s.events.map(e=>e.id));unique(leases.map(l=>l.id));unique(leases.map(l=>l.socketId));
    const caps={rest:1200,ws_message:2000,ws_connect:30};
    for(const e of s.events)requireQuota(e.reservedAt<=now&&e.expiresAt>e.reservedAt&&e.expiresAt<=e.reservedAt+65000&&e.units<=caps[e.kind]);
    for(const l of leases){
      requireQuota(l.egressKey===s.egressKey&&l.createdAt<=l.updatedAt&&l.updatedAt<=now&&l.leaseUntil>l.createdAt&&l.latestAllowedSendAt>=l.createdAt&&l.latestAllowedSendAt<=l.leaseUntil&&
        (l.state==='closed'?l.closedAt!==null&&l.closedAt>=l.createdAt&&l.closedAt<=now&&l.subscriptions.length===0:l.closedAt===null));
      unique(l.subscriptions.map(sub=>sub.id));l.subscriptions.forEach(validateSub);
      if(l.state!=='closed'&&l.state!=='uncertain'&&l.leaseUntil<=now){l.state='uncertain';l.revision++;l.updatedAt=now;}
    }
    const events=s.events.filter(e=>e.expiresAt>now);
    // Answered list calls, settled to what the provider counted: a charge
    // only ever goes down, and an unknown or expired ticket is ignored.
    if(request.kind==='rest')for(const settled of request.settle??[]){
      const event=events.find(e=>e.kind==='rest'&&e.id===settled.id);
      if(event&&settled.units<event.units)event.units=settled.units;
    }
    for(const kind of ['rest','ws_message','ws_connect'] as const)requireQuota(events.filter(e=>e.kind===kind).reduce((sum,e)=>sum+e.units,0)<=caps[kind]);
    let charged=0;
    const charge=(kind:HyperliquidQuotaEvent['kind'],units:number,id:string,sendUntil:number,cap:number=caps[kind])=>{
      requireQuota(sendUntil>=now&&sendUntil<=now+5000);requireQuota(!s.events.some(e=>e.id===id),'hyperliquid_quota_ticket_conflict');
      const sameKind=events.filter(e=>e.kind===kind);
      let missing=sameKind.reduce((sum,e)=>sum+e.units,0)+units-cap;
      if(missing>0&&kind==='rest'){
        // The first expiry alone may not free enough for this request.
        // Only retained REST charges contribute; leases are never refunded.
        for(const event of [...sameKind].sort((a,b)=>a.expiresAt-b.expiresAt)){
          missing-=event.units;
          if(missing<=0)throw new HyperliquidRestCapacityError(event.expiresAt-now);
        }
        throw new LiveBoundaryError('hyperliquid_quota_exhausted');
      }
      requireQuota(missing<=0,'hyperliquid_quota_exhausted');
      events.push({id,kind,units,reservedAt:now,expiresAt:sendUntil+60000});charged=units;
    };
    const active=()=>leases.filter(l=>l.state!=='closed'&&!hyperliquidLeaseReclaimed(l,now));
    const limits=()=>{requireQuota(active().length<=10,'hyperliquid_quota_connections');requireQuota(active().reduce((sum,l)=>sum+l.subscriptions.length,0)<=1000,'hyperliquid_quota_subscriptions');
      requireQuota(new Set(active().flatMap(l=>l.subscriptions.filter(sub=>sub.user!==null).map(sub=>`${sub.network}:${sub.user}`))).size<=10,'hyperliquid_quota_users');};
    limits();
    if(request.kind==='rest')charge('rest',request.weight,request.id,request.sendUntil,request.lane==='background'?HYPERLIQUID_BACKGROUND_REST_CAP:HYPERLIQUID_REST_CAP);
    else if(request.kind==='connect'){
      requireQuota(!leases.some(l=>l.id===request.lease.id||l.socketId===request.lease.socketId),'hyperliquid_quota_lease_lost');
      requireQuota(request.lease.egressKey===s.egressKey&&request.lease.leaseUntil>now&&request.lease.leaseUntil<=now+60000&&request.lease.latestAllowedSendAt===request.sendUntil&&request.sendUntil<=request.lease.leaseUntil);
      charge('ws_connect',1,request.id,request.sendUntil);
      leases.push({...request.lease,state:'reserved',revision:1,subscriptions:[],createdAt:now,updatedAt:now,closedAt:null});limits();
    }else{
      const l=leases.find(l=>l.id===request.leaseId);requireQuota(l&&l.fenceToken===request.fenceToken&&l.ownerId===request.ownerId&&l.state!=='closed','hyperliquid_quota_lease_lost');
      if(request.kind==='renew'){
        requireQuota((l.state==='open'||l.state==='reserved')&&l.leaseUntil>now,'hyperliquid_quota_lease_lost');
        requireQuota(request.sendUntil>=now&&request.sendUntil<=now+5000&&request.leaseUntil>now&&request.leaseUntil<=now+60000&&request.sendUntil<=request.leaseUntil);
        l.leaseUntil=request.leaseUntil;l.latestAllowedSendAt=request.sendUntil;
      }else if(request.kind==='subscribe'){
        requireQuota((l.state==='open'||l.state==='reserved')&&l.leaseUntil>now&&request.sendUntil<=l.leaseUntil,'hyperliquid_quota_lease_lost');
        unique(request.subscriptions.map(sub=>sub.id));request.subscriptions.forEach(validateSub);requireQuota(request.subscriptions.every(sub=>!l.subscriptions.some(old=>old.id===sub.id)),'hyperliquid_quota_subscription_conflict');
        charge('ws_message',request.subscriptions.length*(request.prepayCleanup?2:1)+(request.prepayClose?1:0),request.id,request.sendUntil);l.subscriptions.push(...request.subscriptions);limits();
      }else if(request.kind==='ping'||request.kind==='close'||request.kind==='unsubscribe'){
        // A private original socket may still prove an actual peer close
        // after its lease expired; cleanup does not reclaim before that ACK.
        requireQuota(request.kind==='close'||l.leaseUntil>now&&request.sendUntil<=l.leaseUntil,'hyperliquid_quota_lease_lost');
        if(request.kind==='unsubscribe'){unique(request.subscriptionIds);requireQuota(request.subscriptionIds.every(id=>l.subscriptions.some(sub=>sub.id===id)),'hyperliquid_quota_subscription_conflict');}
        charge('ws_message',request.kind==='unsubscribe'?request.subscriptionIds.length:1,request.id,request.sendUntil);
      }else if(request.kind==='ack_unsubscribe'){
        unique(request.subscriptionIds);requireQuota(request.subscriptionIds.every(id=>l.subscriptions.some(sub=>sub.id===id)),'hyperliquid_quota_subscription_conflict');
        l.subscriptions=l.subscriptions.filter(sub=>!request.subscriptionIds.includes(sub.id));
      }else if(request.kind==='closed'){l.state='closed';l.closedAt=now;l.subscriptions=[];}
      else if(request.kind==='opened'){requireQuota(l.state==='reserved'&&l.leaseUntil>now,'hyperliquid_quota_lease_lost');l.state='open';}
      else l.state=request.kind;
      l.revision++;l.updatedAt=now;
    }
    requireQuota(events.length<=3500);return freezeLiveReservation({state:{...s,events,revision:s.revision+1,updatedAt:now},leases,charged});
  }catch(error){if(error instanceof LiveBoundaryError)throw error;throw new LiveBoundaryError('hyperliquid_quota_invalid');}
}
