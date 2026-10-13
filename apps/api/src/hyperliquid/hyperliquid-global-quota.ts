import {createHash,randomUUID} from 'node:crypto';
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
 |{readonly kind:'live_demand';readonly id:string;readonly weight:number;readonly sendUntil:number}
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
 * `live`: real-money copy work (every charge of an original live-risk
 * session: an order's evidence and epoch reads, its risk gates, transport
 * check and exchange POST; settlement, stops and closes): the whole window.
 * A live order that announced its need (`live_demand`) comes before setups,
 * background and unlabelled work while that need is outstanding.
 * Unlabelled requests (pages, wallet and operator calls) may use the whole
 * window, less what live orders and granted setup claims still need. */
export type HyperliquidRestLane='background'|'setup'|'live';
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
/** One setup's token (16 hex, from its id): its charges (`setup:<token>:`)
 * and demand markers (`setup-demand:<need>:<token>:<id>`, `:g` once
 * granted) carry it. A setup's own earlier charges (a previous step, an
 * attempt that failed partway) are never counted against its next claim's
 * share: the 720 bounds setups together, not one setup's steps in a row
 * (gate 2026-10-13 06:51: a mode attempt's 144 plus its retry's 613 was over
 * 720, and the retry waited the 144 out, ~61 s; the agent's 81 after the
 * mode's 635, ~44 s). */
export const SETUP_LANE_TOKEN=/^[0-9a-f]{16}$/;
/** How long a granted setup claim keeps what its step still needs free:
 * background leaves it, and the step's own charges (up to its need) are
 * admitted in the whole window, never refused by a page's or a live order's
 * charge that came between its claim and its reads. A claim that said "fits
 * now" no longer turns into a refusal partway through the attempt and a
 * 65 s wait (the gate's alternating 63.5 s / 65 s waits). */
export const HYPERLIQUID_SETUP_GRANT_HOLD_MS=30_000;
const SETUP_DEMAND_TICKET=/^setup-demand:([1-9][0-9]{0,3}):([0-9a-f]{16}):[0-9a-f-]{1,36}(:g)?$/;
const SETUP_TOKEN_CHARGE=/^setup:([0-9a-f]{16}):/;
/** A setup's demand ticket: its need, its token and a fresh id. */
export function setupDemandTicket(need:number,token:string):string{return `${SETUP_DEMAND_ID_PREFIX}${need}:${token}:${randomUUID()}`;}
/** Whether a stored event is one setup's (by its token). */
const ownedBy=(e:{id:string},token:string|undefined)=>token!==undefined&&(SETUP_TOKEN_CHARGE.exec(e.id)?.[1]===token||SETUP_DEMAND_TICKET.exec(e.id)?.[2]===token);
/**
 * Claims alive at `now` that keep weight free, by token: the latest one's
 * need, from when, until when; what each still needs is its need less its
 * token's charges since. A claim that is fully charged holds nothing.
 */
function reservations(rest:readonly HyperliquidQuotaEvent[],now:number,ticket:RegExp,charge:RegExp,hold:number,reserving:(match:RegExpExecArray)=>boolean){
  const latest=new Map<string,{need:number;since:number;until:number}>();
  for(const e of rest){
    const match=ticket.exec(e.id);if(!match||!reserving(match)||e.reservedAt+hold<=now)continue;
    const token=match[2]!,known=latest.get(token);
    if(!known||e.reservedAt>=known.since)latest.set(token,{need:Number(match[1]),since:e.reservedAt,until:e.reservedAt+hold});
  }
  const charged=new Map<string,number>();
  for(const e of rest){const token=charge.exec(e.id)?.[1],claim=token===undefined?undefined:latest.get(token);if(claim&&e.reservedAt>=claim.since)charged.set(token!,(charged.get(token!)??0)+e.units);}
  const left=(token:string)=>{const claim=latest.get(token);return claim?Math.max(0,claim.need-(charged.get(token)??0)):0;};
  const holding=(except?:string)=>[...latest.keys()].filter(t=>t!==except&&left(t)>0);
  return {left,count:latest.size,
    /** What alive claims (but `except`'s) still need. */
    outstanding:(except?:string)=>holding(except).reduce((sum,t)=>sum+left(t),0),
    /** When the last alive claim (but `except`'s) that still needs something ends. */
    until:(except?:string)=>{const ends=holding(except).map(t=>latest.get(t)!.until);return ends.length?Math.max(...ends):undefined;}};
}
const setupClaims=(rest:readonly HyperliquidQuotaEvent[],now:number)=>reservations(rest,now,SETUP_DEMAND_TICKET,SETUP_TOKEN_CHARGE,HYPERLIQUID_SETUP_GRANT_HOLD_MS,match=>match[3]===':g');
/** Live copy work's charges (`live:`; `live:<token>:` for an order that
 * announced its need) and a live order's demand marker
 * (`live-demand:<need>:<token>:<id>`, 1 unit, never sent), told apart by
 * ticket id only: a process on the previous release reads them as ordinary
 * REST charges. */
export const LIVE_REST_ID_PREFIX='live:';
export const LIVE_DEMAND_ID_PREFIX='live-demand:';
/** A live order's demand token (16 hex; its charges carry it). */
export const LIVE_LANE_TOKEN=/^[0-9a-f]{16}$/;
/** How long a live order's demand comes first after it is recorded: its
 * wait for its SQL locks, its 5 s evidence window and its exchange POST. An
 * order still waiting for room records it again (the same token); once no
 * order's demand is alive or outstanding, setups and background are as
 * before. A cold order's evidence (589, or 772 with two accounts) is more
 * than the 240 live reserve: beside a setup's share and background's cap it
 * was refused, and then waited out a 65 s window. */
export const HYPERLIQUID_LIVE_DEMAND_HOLD_MS=15_000;
/** The most a live order announces: with its marker's unit, the window. */
export const HYPERLIQUID_MAX_LIVE_DEMAND=HYPERLIQUID_REST_CAP-1;
const LIVE_DEMAND_TICKET=/^live-demand:([1-9][0-9]{0,3}):([0-9a-f]{16}):[0-9a-f-]{1,36}$/;
const LIVE_TOKEN_CHARGE=/^live:([0-9a-f]{16}):/;
/** A live order's demand ticket: its need, its token and a fresh id. */
export function liveDemandTicket(need:number,token:string):string{return `${LIVE_DEMAND_ID_PREFIX}${need}:${token}:${randomUUID()}`;}
const liveClaims=(rest:readonly HyperliquidQuotaEvent[],now:number)=>reservations(rest,now,LIVE_DEMAND_TICKET,LIVE_TOKEN_CHARGE,HYPERLIQUID_LIVE_DEMAND_HOLD_MS,()=>true);
/** A lane's demand as the meter holds it (heartbeat): demands alive, what
 * the lane's charges hold, and when the last demand ends (null: none). */
export interface HyperliquidLaneDemand {readonly count:number;readonly held:number;readonly until:number|null;}
/** The setup and live lanes at `now`, from the meter's events: setup
 * markers alive (a setup waiting or granted, for its marker's minute) and
 * live orders' demands alive (HYPERLIQUID_LIVE_DEMAND_HOLD_MS). */
export function hyperliquidLaneStatus(events:readonly HyperliquidQuotaEvent[],now:number):{readonly setupDemand:HyperliquidLaneDemand;readonly liveDemand:HyperliquidLaneDemand}{
  const rest=events.filter(e=>e.kind==='rest'&&e.expiresAt>now),units=(list:readonly HyperliquidQuotaEvent[])=>list.reduce((sum,e)=>sum+e.units,0);
  const markers=rest.filter(e=>e.id.startsWith(SETUP_DEMAND_ID_PREFIX)),orders=rest.filter(e=>LIVE_DEMAND_TICKET.test(e.id)&&e.reservedAt+HYPERLIQUID_LIVE_DEMAND_HOLD_MS>now);
  const tokens=new Set(orders.map(e=>LIVE_DEMAND_TICKET.exec(e.id)![2]));
  return {
    setupDemand:{count:markers.length,held:units(rest.filter(e=>e.id.startsWith(SETUP_REST_ID_PREFIX))),until:markers.length?Math.max(...markers.map(e=>e.expiresAt)):null},
    liveDemand:{count:tokens.size,held:units(rest.filter(e=>e.id.startsWith(LIVE_REST_ID_PREFIX))),until:orders.length?Math.max(...orders.map(e=>e.reservedAt+HYPERLIQUID_LIVE_DEMAND_HOLD_MS)):null},
  };
}
const isLaneTicket=(id:string)=>[SETUP_REST_ID_PREFIX,SETUP_DEMAND_ID_PREFIX,LIVE_REST_ID_PREFIX,LIVE_DEMAND_ID_PREFIX].some(prefix=>id.startsWith(prefix));
export interface HyperliquidQuotaPlan {readonly state:HyperliquidQuotaState;readonly leases:readonly HyperliquidQuotaLease[];readonly charged:number;
  /** `setup_demand` and `live_demand` only: 0 when the weight fits now, else in how many ms it should (its marker is recorded either way). */
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
  z.object({kind:z.literal('live_demand'),id:identifier,weight:integer.positive().max(HYPERLIQUID_MAX_LIVE_DEMAND),sendUntil:integer.positive()}).strict(),
  z.object({kind:z.literal('rest'),id:identifier,weight:integer.positive().max(1200),sendUntil:integer.positive(),lane:z.enum(['background','setup','live']).optional(),
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
    /** `units` more under `cap`, beside `reserved` (what claims still
     * need), or once those claims end (`ends`) and the window has room. */
    const beside=(pool:readonly HyperliquidQuotaEvent[],units:number,cap:number,reserved:number,ends:readonly (number|undefined)[])=>{
      const fits=fitsIn(pool,units,cap-reserved);if(fits!==undefined||reserved<=0)return fits;
      const after=fitsIn(pool,units,cap),end=Math.max(0,...ends.filter((e):e is number=>e!==undefined));
      return after===undefined||end<=now?after:Math.max(after,end-now);
    };
    /** A setup's `units` more (`token`: that setup's): the window below the
     * live reserve and the setups' share, beside what other setups' granted
     * claims still need, and only once what live orders announced fits too
     * (setups come after live). Its own earlier charges count in the window,
     * never in the share. */
    const setupFitsIn=(units:number,token?:string)=>{
      const rest=events.filter(e=>e.kind==='rest'),claims=setupClaims(rest,now),others=claims.outstanding(token),live=liveClaims(rest,now),ahead=live.outstanding();
      // min(960 − others, 1200 − live's need − others)
      const all=beside(rest,units,HYPERLIQUID_REST_CAP-HYPERLIQUID_LIVE_REST_RESERVE,others+Math.max(0,ahead-HYPERLIQUID_LIVE_REST_RESERVE),[claims.until(token),ahead>0?live.until():undefined]);
      const own=beside(rest.filter(e=>isSetupEvent(e)&&!ownedBy(e,token)),units,HYPERLIQUID_SETUP_REST_CAP,others,[claims.until(token)]);
      return all===undefined||own===undefined?undefined:Math.max(all,own);
    };
    const restCharge=(units:number,id:string,sendUntil:number,lane:HyperliquidRestLane|undefined)=>{
      requireQuota(sendUntil>=now&&sendUntil<=now+5000);requireQuota(!s.events.some(e=>e.id===id),'hyperliquid_quota_ticket_conflict');
      requireQuota(lane==='setup'?id.startsWith(SETUP_REST_ID_PREFIX):lane==='live'?id.startsWith(LIVE_REST_ID_PREFIX):!isLaneTicket(id));
      const rest=events.filter(e=>e.kind==='rest'),setups=setupClaims(rest,now),live=liveClaims(rest,now),ahead=live.outstanding();
      let wait:number|undefined;
      if(lane==='live')wait=fitsIn(rest,units,HYPERLIQUID_REST_CAP);
      else if(lane==='setup'){
        // Within its granted claim: the room was kept for it (background
        // left it), so the whole window beside other setups' claims and what
        // live orders announced; past its claim, as any setup charge.
        const token=SETUP_TOKEN_CHARGE.exec(id)?.[1],covered=token===undefined?0:Math.min(units,setups.left(token)),others=setups.outstanding(token);
        if(covered===0)wait=setupFitsIn(units,token);
        else{
          wait=beside(rest,units,HYPERLIQUID_REST_CAP,others+ahead,[setups.until(token),ahead>0?live.until():undefined]);
          if(wait!==undefined&&covered<units){
            const past=beside(rest,units,HYPERLIQUID_REST_CAP-HYPERLIQUID_LIVE_REST_RESERVE+covered,others+Math.max(0,ahead-HYPERLIQUID_LIVE_REST_RESERVE),[setups.until(token),ahead>0?live.until():undefined]);
            wait=past===undefined?undefined:Math.max(wait,past);
          }
        }
      }
      else if(lane==='background'){
        // While a setup waits, background leaves the setups' unused share
        // free below the live reserve; it also leaves what granted setup
        // claims and live orders' demands still need (it is refused first);
        // otherwise its cap.
        const demands=rest.filter(e=>e.id.startsWith(SETUP_DEMAND_ID_PREFIX)),granted=setups.outstanding(),base=backgroundRestCap(raw.backgroundCap);
        const share=demands.length===0?0:Math.max(0,HYPERLIQUID_SETUP_REST_CAP-sum(rest.filter(isSetupEvent)));
        let cap=demands.length===0?base:Math.min(base,HYPERLIQUID_REST_CAP-HYPERLIQUID_LIVE_REST_RESERVE-share);
        if(granted>0)cap=Math.min(cap,HYPERLIQUID_REST_CAP-HYPERLIQUID_LIVE_REST_RESERVE-granted);
        if(ahead>0)cap=Math.min(cap,HYPERLIQUID_REST_CAP-ahead-granted-share);
        wait=fitsIn(rest,units,cap);
        // Room that only comes back once no setup waits and no claim is
        // outstanding: when the last of them ends.
        if(wait===undefined&&(demands.length>0||granted>0||ahead>0)&&fitsIn([],units,base)===0)
          throw new HyperliquidRestCapacityError(Math.max(...demands.map(e=>e.expiresAt),setups.until()??0,ahead>0?live.until()!:0)-now);
      }
      // Pages, wallet and operator calls: the whole window, less what live
      // orders and granted setup claims still need.
      else wait=beside(rest,units,HYPERLIQUID_REST_CAP,ahead+setups.outstanding(),[setups.until(),ahead>0?live.until():undefined]);
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
      // share free for the next minute, and says when the step fits. A
      // setup's claim (its ticket carries its need and token) that fits now
      // is granted (`:g`): for HYPERLIQUID_SETUP_GRANT_HOLD_MS what the step
      // still needs stays free for it.
      requireQuota(request.id.startsWith(SETUP_DEMAND_ID_PREFIX)&&!request.id.endsWith(':g'));
      const ticket=SETUP_DEMAND_TICKET.exec(request.id);requireQuota(!ticket||Number(ticket[1])===request.weight);
      const fits=setupFitsIn(request.weight+1,ticket?.[2]);if(fits===undefined)throw new LiveBoundaryError('hyperliquid_quota_exhausted');
      requireQuota(request.sendUntil>=now&&request.sendUntil<=now+5000);requireQuota(!s.events.some(e=>e.id===request.id||e.id===`${request.id}:g`),'hyperliquid_quota_ticket_conflict');
      const marker=fitsIn(events.filter(e=>e.kind==='rest'),1,HYPERLIQUID_REST_CAP);
      if(marker===undefined)throw new LiveBoundaryError('hyperliquid_quota_exhausted');
      if(marker>0)throw new HyperliquidRestCapacityError(marker);
      events.push({id:ticket&&fits===0?`${request.id}:g`:request.id,kind:'rest',units:1,reservedAt:now,expiresAt:request.sendUntil+60000});charged=1;waitMs=fits;
    }
    else if(request.kind==='live_demand'){
      // A live order about to read its evidence and send (its need: what
      // that weighs in the next seconds): its marker (1 unit, an ordinary
      // charge never sent) makes setups, background and unlabelled work
      // leave what it still needs free for HYPERLIQUID_LIVE_DEMAND_HOLD_MS,
      // and says when that fits in the whole window beside other live
      // orders' demands. Recorded whether it fits or not: from now on the
      // room that frees up is the order's first.
      const ticket=LIVE_DEMAND_TICKET.exec(request.id);requireQuota(ticket&&Number(ticket[1])===request.weight);
      requireQuota(request.sendUntil>=now&&request.sendUntil<=now+5000);requireQuota(!s.events.some(e=>e.id===request.id),'hyperliquid_quota_ticket_conflict');
      const marker=fitsIn(events.filter(e=>e.kind==='rest'),1,HYPERLIQUID_REST_CAP);
      if(marker===undefined)throw new LiveBoundaryError('hyperliquid_quota_exhausted');
      if(marker>0)throw new HyperliquidRestCapacityError(marker);
      events.push({id:request.id,kind:'rest',units:1,reservedAt:now,expiresAt:request.sendUntil+60000});charged=1;
      const rest=events.filter(e=>e.kind==='rest'),live=liveClaims(rest,now),token=ticket[2]!,need=live.left(token);
      waitMs=Math.min(65000,beside(rest,need,HYPERLIQUID_REST_CAP,live.outstanding(token),[live.until(token)])??65000);
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
