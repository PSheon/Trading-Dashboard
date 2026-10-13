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
 |{readonly kind:'setup_demand';readonly id:string;readonly weight:number;readonly sendUntil:number}
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
 * room, and less while a setup waits (HYPERLIQUID_SETUP_REST_CAP).
 * `setup`: a copy setup's steps (funded → mode_set → agent_active), someone
 * waiting on them: ahead of background, within their own share.
 * Unlabelled requests (pages, live copy work, exchange actions) may use
 * the whole window. */
export type HyperliquidRestLane='background'|'setup';
/** Hyperliquid's REST weight per minute per IP. */
export const HYPERLIQUID_REST_CAP=1200;
/** What background work may hold of it. Before this, the worker's and the
 * api's background loops (each budgeted 840 a minute locally; the shared
 * meter prepays list calls at 120) kept the window full, and a cold trader
 * page's /activity and /fills answered 503 within 0.4 s. */
export const HYPERLIQUID_BACKGROUND_REST_CAP=840;
/** A deployment's own background cap (HYPERLIQUID_BACKGROUND_REST_CAP): lower
 * it to keep more of the window for copy orders, whose evidence (568–772 a
 * minute for one order) must fit beside whatever background holds. */
export function backgroundRestCap(value:number|undefined):number{return value===undefined?HYPERLIQUID_BACKGROUND_REST_CAP:Math.max(0,Math.min(HYPERLIQUID_REST_CAP,Math.floor(value)));}
/** Of the window, what neither setups nor background ever take: live orders,
 * pages and exchange actions (unlabelled) always find at least this. */
export const HYPERLIQUID_LIVE_REST_RESERVE=240;
/** What copy setups' charges may hold of the window together: one setup's
 * account-mode attempt (613) and its reconcile, so a burst of setups queues
 * behind it instead of taking the live reserve or every live order's room.
 * While a setup waits (a `setup_demand` marker within the last minute),
 * background may hold only what leaves this share free below the live
 * reserve: background is refused first. On 2026-10-13 a setup's mode step
 * (613 in a minute, beside the 360 that background's 840 left) waited out
 * 65 s windows for 10 minutes beside the Stage-like background load. */
export const HYPERLIQUID_SETUP_REST_CAP=720;
/** A setup's charges and demand markers are told apart by their ticket id
 * (the stored event's shape is unchanged: a process on the previous release
 * reads them as ordinary REST charges, which they are). */
export const SETUP_REST_ID_PREFIX='setup:';
export const SETUP_DEMAND_ID_PREFIX='setup-demand:';
const isSetupEvent=(e:{kind:string;id:string})=>e.kind==='rest'&&(e.id.startsWith(SETUP_REST_ID_PREFIX)||e.id.startsWith(SETUP_DEMAND_ID_PREFIX));
export interface HyperliquidQuotaPlan {readonly state:HyperliquidQuotaState;readonly leases:readonly HyperliquidQuotaLease[];readonly charged:number;
  /** `setup_demand` only: 0 when the setup's weight fits now, else in how many ms it should (its marker is recorded either way). */
  readonly waitMs?:number;}
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
  z.object({kind:z.literal('setup_demand'),id:identifier,weight:integer.positive().max(1200),sendUntil:integer.positive()}).strict(),
  z.object({kind:z.literal('rest'),id:identifier,weight:integer.positive().max(1200),sendUntil:integer.positive(),lane:z.enum(['background','setup']).optional(),
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
export function planHyperliquidQuota(raw:{readonly now:number;readonly state:HyperliquidQuotaState;readonly leases:readonly HyperliquidQuotaLease[];readonly request:HyperliquidQuotaRequest;readonly backgroundCap?:number}):HyperliquidQuotaPlan {
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
    let charged=0,waitMs:number|undefined;
    const sum=(list:readonly HyperliquidQuotaEvent[])=>list.reduce((total,e)=>total+e.units,0);
    /** In how many ms `units` more fit under `cap` as charges of `pool`
     * expire (0: now), assuming nothing else is charged; undefined: never. */
    const fitsIn=(pool:readonly HyperliquidQuotaEvent[],units:number,cap:number):number|undefined=>{
      let missing=sum(pool)+units-cap;if(missing<=0)return 0;
      for(const event of [...pool].sort((a,b)=>a.expiresAt-b.expiresAt)){missing-=event.units;if(missing<=0)return event.expiresAt-now;}
      return undefined;
    };
    /** A setup's `units` more: the window below the live reserve, and the setups' share. */
    const setupFitsIn=(units:number)=>{
      const rest=events.filter(e=>e.kind==='rest'),all=fitsIn(rest,units,HYPERLIQUID_REST_CAP-HYPERLIQUID_LIVE_REST_RESERVE),own=fitsIn(rest.filter(isSetupEvent),units,HYPERLIQUID_SETUP_REST_CAP);
      return all===undefined||own===undefined?undefined:Math.max(all,own);
    };
    const restCharge=(units:number,id:string,sendUntil:number,lane:HyperliquidRestLane|undefined)=>{
      requireQuota(sendUntil>=now&&sendUntil<=now+5000);requireQuota(!s.events.some(e=>e.id===id),'hyperliquid_quota_ticket_conflict');
      requireQuota(lane==='setup'?id.startsWith(SETUP_REST_ID_PREFIX):!isSetupEvent({kind:'rest',id}));
      const rest=events.filter(e=>e.kind==='rest');
      let wait:number|undefined;
      if(lane==='setup')wait=setupFitsIn(units);
      else if(lane==='background'){
        // While a setup waits, background leaves the setups' unused share
        // free below the live reserve (it is refused first); otherwise its cap.
        const demands=rest.filter(e=>e.id.startsWith(SETUP_DEMAND_ID_PREFIX));
        const cap=demands.length===0?backgroundRestCap(raw.backgroundCap)
          :Math.min(backgroundRestCap(raw.backgroundCap),HYPERLIQUID_REST_CAP-HYPERLIQUID_LIVE_REST_RESERVE-Math.max(0,HYPERLIQUID_SETUP_REST_CAP-sum(rest.filter(isSetupEvent))));
        wait=fitsIn(rest,units,cap);
        // Room that only comes back once no setup waits: when its last marker expires.
        if(wait===undefined&&demands.length>0&&fitsIn([],units,backgroundRestCap(raw.backgroundCap))===0)throw new HyperliquidRestCapacityError(Math.max(...demands.map(e=>e.expiresAt))-now);
      }else wait=fitsIn(rest,units,HYPERLIQUID_REST_CAP);
      // The first expiry alone may not free enough for this request. Only
      // retained REST charges contribute; leases are never refunded.
      if(wait===undefined)throw new LiveBoundaryError('hyperliquid_quota_exhausted');
      if(wait>0)throw new HyperliquidRestCapacityError(wait);
      events.push({id,kind:'rest',units,reservedAt:now,expiresAt:sendUntil+60000});charged=units;
    };
    /** Socket messages and connects (REST: restCharge). */
    const charge=(kind:'ws_message'|'ws_connect',units:number,id:string,sendUntil:number)=>{
      requireQuota(sendUntil>=now&&sendUntil<=now+5000);requireQuota(!s.events.some(e=>e.id===id),'hyperliquid_quota_ticket_conflict');
      requireQuota(sum(events.filter(e=>e.kind===kind))+units<=caps[kind],'hyperliquid_quota_exhausted');
      events.push({id,kind,units,reservedAt:now,expiresAt:sendUntil+60000});charged=units;
    };
    const active=()=>leases.filter(l=>l.state!=='closed'&&!hyperliquidLeaseReclaimed(l,now));
    const limits=()=>{requireQuota(active().length<=10,'hyperliquid_quota_connections');requireQuota(active().reduce((sum,l)=>sum+l.subscriptions.length,0)<=1000,'hyperliquid_quota_subscriptions');
      requireQuota(new Set(active().flatMap(l=>l.subscriptions.filter(sub=>sub.user!==null).map(sub=>`${sub.network}:${sub.user}`))).size<=10,'hyperliquid_quota_users');};
    limits();
    if(request.kind==='rest')restCharge(request.weight,request.id,request.sendUntil,request.lane);
    else if(request.kind==='setup_demand'){
      // A setup about to run a step that needs `weight`: its marker (1 unit,
      // an ordinary charge never sent) makes background leave the setups'
      // share free for the next minute, and says when the step fits.
      requireQuota(request.id.startsWith(SETUP_DEMAND_ID_PREFIX));
      const fits=setupFitsIn(request.weight+1);if(fits===undefined)throw new LiveBoundaryError('hyperliquid_quota_exhausted');
      requireQuota(request.sendUntil>=now&&request.sendUntil<=now+5000);requireQuota(!s.events.some(e=>e.id===request.id),'hyperliquid_quota_ticket_conflict');
      const marker=fitsIn(events.filter(e=>e.kind==='rest'),1,HYPERLIQUID_REST_CAP);
      if(marker===undefined)throw new LiveBoundaryError('hyperliquid_quota_exhausted');
      if(marker>0)throw new HyperliquidRestCapacityError(marker);
      events.push({id:request.id,kind:'rest',units:1,reservedAt:now,expiresAt:request.sendUntil+60000});charged=1;waitMs=fits;
    }
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
    requireQuota(events.length<=3500);return freezeLiveReservation({state:{...s,events,revision:s.revision+1,updatedAt:now},leases,charged,...(waitMs===undefined?{}:{waitMs})});
  }catch(error){if(error instanceof LiveBoundaryError)throw error;throw new LiveBoundaryError('hyperliquid_quota_invalid');}
}
