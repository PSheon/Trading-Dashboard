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
 |{readonly kind:'rest';readonly id:string;readonly weight:number;readonly sendUntil:number;readonly lane?:HyperliquidRestLane;readonly settle?:readonly HyperliquidRestSettlement[];
   /** `page` only: how long this page read has already waited for room (HYPERLIQUID_PAGE_HOLD_MS). */
   readonly heldMs?:number}
 |{readonly kind:'setup_demand';readonly id:string;readonly weight:number;readonly sendUntil:number;
   /** The socket connects the step opens (its ticket carries them too): held with its REST weight once granted. */
   readonly connects?:number;
   /** Only its place in the queue (background starts to leave its need): never granted, nothing held. */
   readonly queue?:boolean}
 /** A setup's step is over: what its grant still holds is given back. */
 |{readonly kind:'setup_release';readonly token:string}
 |{readonly kind:'live_demand';readonly id:string;readonly weight:number;readonly sendUntil:number}
 |{readonly kind:'connect';readonly id:string;readonly sendUntil:number;readonly lease:Omit<HyperliquidQuotaLease,'state'|'revision'|'subscriptions'|'createdAt'|'updatedAt'|'closedAt'>;
   /** A setup step's socket (its token): drawn from what its grant holds. */
   readonly setupToken?:string;
   /** A live order's or an original session's socket: never held back for a waiting setup. */
   readonly live?:boolean}
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
/** Every REST charge has a class; the meter arbitrates between them as a
 * queue: live first, then setups (the oldest waiting one first), then pages,
 * then background.
 * `background`: work nobody is waiting for (pool loops, warm-ups, sweeps of
 * uncopied leaders, follower snapshots and receipts). It may fill the shared
 * per-IP REST window only up to HYPERLIQUID_BACKGROUND_REST_CAP, so a page or
 * a copy signal always finds room, and less while a setup waits
 * (HYPERLIQUID_SETUP_REST_CAP). A charge without a lane is background: a
 * consumer that must come before it says so (2026-10-13 08:18 gate: the
 * unlabelled reads took the whole window, every unit that freed up, and a
 * setup's 613 never once fit).
 * `setup`: a copy setup's steps (funded → mode_set → agent_active), someone
 * waiting on them: ahead of background, within their own share.
 * `live`: real-money copy work (every charge of an original live-risk
 * session: an order's evidence and epoch reads, its risk gates, transport
 * check and exchange POST; settlement, stops and closes): the whole window.
 * A live order that announced its need (`live_demand`) comes before setups,
 * pages and background while that need is outstanding.
 * `page`: someone's request (`page:` tickets: trader and wallet pages): the
 * whole window, less what live orders and granted setup claims still need;
 * while a setup waits it leaves that setup's need free too, but for at most
 * HYPERLIQUID_PAGE_HOLD_MS, after which it has HYPERLIQUID_PAGE_FLOOR. */
export type HyperliquidRestLane='background'|'setup'|'live'|'page';
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
/** What a granted claim holds (`setup-hold:<token>:…`): an event of the
 * window like any charge (REST, or socket connects), never sent, so every
 * other lane and every other process (a previous release too) leaves it
 * free; the step's own charges draw it down. */
export const SETUP_HOLD_ID_PREFIX='setup-hold:';
const isSetupEvent=(e:{kind:string;id:string})=>e.kind==='rest'&&(e.id.startsWith(SETUP_REST_ID_PREFIX)||e.id.startsWith(SETUP_DEMAND_ID_PREFIX)||e.id.startsWith(SETUP_HOLD_ID_PREFIX));
/** One setup's token (16 hex, from its id): its charges (`setup:<token>:`)
 * and demand markers (`setup-demand:<need>:<token>:<id>`, `:g` once
 * granted) carry it. A setup's own earlier charges (a previous step, an
 * attempt that failed partway) are never counted against its next claim's
 * share: the 720 bounds setups together, not one setup's steps in a row
 * (gate 2026-10-13 06:51: a mode attempt's 144 plus its retry's 613 was over
 * 720, and the retry waited the 144 out, ~61 s; the agent's 81 after the
 * mode's 635, ~44 s). */
export const SETUP_LANE_TOKEN=/^[0-9a-f]{16}$/;
/** How long a granted setup claim holds its step's weight: the weight is an
 * event of the window (SETUP_HOLD_ID_PREFIX) that ends then, unless the step
 * gives it back first (`setup_release`) or its own charges draw it all. The
 * step's charges up to it are admitted without any other check: they replace
 * held weight one for one (the window's total does not move), so no charge of
 * another lane that came between the claim and the reads can refuse them
 * partway (gate 2026-10-13 09:49: a granted attempt charged 410 and failed,
 * and its retry waited ~45 s for those 410 to expire). Long enough for the
 * attempt's two preflights, its signature and its POST. */
export const HYPERLIQUID_SETUP_GRANT_HOLD_MS=45_000;
/** Of the 30 socket connects a minute, what only live sockets (an original
 * live-risk session's, a live order's: its follower and leader account
 * observations, a stop's or a close's) may take: every other socket, and a
 * setup's claim for its step's connects, leaves it free. One order's
 * observations open about six (three per account and the leader's), and a
 * stop or close beside it a few more. Gate 2026-10-13 11:15 (7th run): the
 * harness's two socket loops (one connect every 2 s, as many as the window
 * holds) kept it full, and the order's follower observation was refused its
 * connect, twice (`live_account_observation_unavailable`, cause
 * `hyperliquid_quota_exhausted`), and so was the stop after it, many times
 * a second. */
export const HYPERLIQUID_LIVE_WS_CONNECT_RESERVE=10;
/** Socket connects one claim may ask to hold (an account-mode attempt opens two). */
export const HYPERLIQUID_MAX_SETUP_CONNECTS=9;
const SETUP_DEMAND_TICKET=/^setup-demand:([1-9][0-9]{0,3}):([0-9a-f]{16}):[0-9a-f-]{1,36}(?::c([1-9]))?(:g)?$/;
const SETUP_TOKEN_CHARGE=/^setup:([0-9a-f]{16}):/;
const SETUP_HOLD=/^setup-hold:([0-9a-f]{16}):/;
/** A setup's demand ticket: its need, its token, a fresh id and the socket connects its step opens. */
export function setupDemandTicket(need:number,token:string,connects?:number):string{return `${SETUP_DEMAND_ID_PREFIX}${need}:${token}:${randomUUID()}${connects?`:c${connects}`:''}`;}
/** Whether a stored event is one setup's (by its token). */
const ownedBy=(e:{id:string},token:string|undefined)=>token!==undefined&&(SETUP_TOKEN_CHARGE.exec(e.id)?.[1]===token||SETUP_DEMAND_TICKET.exec(e.id)?.[2]===token||SETUP_HOLD.exec(e.id)?.[1]===token);
const isHold=(e:{id:string})=>e.id.startsWith(SETUP_HOLD_ID_PREFIX);
/** What granted setup claims hold now, by token and kind (hold events still alive). */
function setupHolds(events:readonly HyperliquidQuotaEvent[],now:number){
  const alive=events.filter(e=>isHold(e)&&e.expiresAt>now);
  const of=(token:string,kind:HyperliquidQuotaEvent['kind'])=>alive.filter(e=>e.kind===kind&&SETUP_HOLD.exec(e.id)?.[1]===token);
  return {
    held:(token:string|undefined,kind:HyperliquidQuotaEvent['kind']='rest')=>token===undefined?0:of(token,kind).reduce((sum,e)=>sum+e.units,0),
    tokens:()=>[...new Set(alive.filter(e=>e.kind==='rest').map(e=>SETUP_HOLD.exec(e.id)![1]!))],
    /** When the last hold ends (undefined: none). */
    until:()=>alive.length?Math.max(...alive.map(e=>e.expiresAt)):undefined};
}
/** Draws `units` of `kind` from `token`'s holds (oldest first), in place: what it covered. */
function drawHold(events:HyperliquidQuotaEvent[],kind:HyperliquidQuotaEvent['kind'],token:string,units:number,now:number):number{
  let covered=0;
  for(const e of events.filter(e=>e.kind===kind&&isHold(e)&&e.expiresAt>now&&SETUP_HOLD.exec(e.id)?.[1]===token).sort((a,b)=>a.reservedAt-b.reservedAt)){
    if(covered>=units)break;
    const take=Math.min(e.units,units-covered);covered+=take;(e as {units:number}).units-=take;
  }
  for(let i=events.length-1;i>=0;i--)if(events[i]!.units<=0)events.splice(i,1);
  return covered;
}
const SETUP_HOLD_NEED=/^setup-hold:[0-9a-f]{16}:([1-9][0-9]{0,3}):/;
/** Tokens whose grant has not been drawn at all (its REST hold is still its
 * whole need): the step has sent nothing under it yet. */
const untouchedHolds=(rest:readonly HyperliquidQuotaEvent[],now:number)=>new Set(rest.filter(e=>isHold(e)&&e.expiresAt>now&&Number(SETUP_HOLD_NEED.exec(e.id)?.[1])===e.units).map(e=>SETUP_HOLD.exec(e.id)![1]!));
/** A grant a live order took back (`…:g:r`): its step's reads are refused
 * until it claims again. */
const SETUP_REVOKED=/^setup-demand:[1-9][0-9]{0,3}:([0-9a-f]{16}):[0-9a-f-]{1,36}(?::c[1-9])?:g:r$/;
/** Whether `token`'s latest grant was taken back by a live order. */
function revoked(events:readonly HyperliquidQuotaEvent[],token:string|undefined):boolean{
  if(token===undefined)return false;
  let grant=-1,taken=-1;
  for(const e of events){
    const m=SETUP_DEMAND_TICKET.exec(e.id);if(m?.[2]===token&&m[4]===':g')grant=Math.max(grant,e.reservedAt);
    if(SETUP_REVOKED.exec(e.id)?.[1]===token)taken=Math.max(taken,e.reservedAt);
  }
  return taken>=0&&taken>=grant;
}
/** Takes back `token`'s grant (a live order needs its room): its holds go, its grant marker says so. */
function revoke(events:HyperliquidQuotaEvent[],token:string):void{
  dropHolds(events,token);
  for(const e of events){const m=SETUP_DEMAND_TICKET.exec(e.id);if(m?.[2]===token&&m[4]===':g')(e as {id:string}).id=`${e.id}:r`;}
}
/** Removes `token`'s holds (every kind), in place. */
function dropHolds(events:HyperliquidQuotaEvent[],token:string):void{
  for(let i=events.length-1;i>=0;i--)if(isHold(events[i]!)&&SETUP_HOLD.exec(events[i]!.id)?.[1]===token)events.splice(i,1);
}
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
/** How long a setup's claim that does not fit yet keeps its place in the
 * queue after it was last recorded: the setup claims again at least every
 * 20 s (copy-live-setup SETUP_CLAIM_RENEW_MS), so a setup still waiting never
 * loses it, and one that gave up frees the room within this. */
export const HYPERLIQUID_SETUP_PENDING_HOLD_MS=30_000;
/**
 * Setups whose latest claim (by token) is waiting, oldest first (its earliest
 * alive marker; ties by token, the same order in every process). The room
 * that frees up is the oldest one's until its need fits: background and
 * pages (HYPERLIQUID_PAGE_HOLD_MS), and setups behind it, leave it free. On
 * 2026-10-13 08:18 a waiting claim reserved nothing: every unit that expired
 * was taken by other work before the 613 it needed came together, and its
 * "fits after the k-th expiry" never came true (30 waits, 603 s).
 */
function pendingSetups(rest:readonly HyperliquidQuotaEvent[],now:number){
  const by=new Map<string,{need:number;connects:number;first:number;latest:number;granted:boolean}>();
  for(const e of rest){
    const m=SETUP_DEMAND_TICKET.exec(e.id);if(!m||e.expiresAt<=now)continue;
    const token=m[2]!,known=by.get(token),granted=m[4]===':g',connects=Number(m[3]??0);
    if(!known)by.set(token,{need:Number(m[1]),connects,first:e.reservedAt,latest:e.reservedAt,granted});
    else{known.first=Math.min(known.first,e.reservedAt);if(e.reservedAt>=known.latest){known.latest=e.reservedAt;known.need=Number(m[1]);known.connects=connects;known.granted=granted;}}
  }
  return [...by].filter(([,c])=>!c.granted&&c.latest+HYPERLIQUID_SETUP_PENDING_HOLD_MS>now)
    .map(([token,c])=>({token,need:c.need,connects:c.connects,first:c.first,until:c.latest+HYPERLIQUID_SETUP_PENDING_HOLD_MS}))
    .sort((a,b)=>a.first-b.first||(a.token<b.token?-1:a.token>b.token?1:0));
}
/** Page reads' tickets. */
export const PAGE_REST_ID_PREFIX='page:';
/** Longest a page read is held back for a waiting setup: then it is admitted
 * within HYPERLIQUID_PAGE_FLOOR. A page waits for room at most 6 s in all
 * (PAGE_CAPACITY_WAIT_MS, inside its 12 s deadline), so the hold ends with
 * time left for its retry and the call; at 10 s every held page would have
 * answered 503 first. */
export const HYPERLIQUID_PAGE_HOLD_MS=4_000;
/** What page reads held back longer than HYPERLIQUID_PAGE_HOLD_MS may hold
 * of the window beside a waiting setup: pages never go dead, and a burst of
 * them delays the setup by at most this much (one cold trader page's reads). */
export const HYPERLIQUID_PAGE_FLOOR=240;
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
/** The setup, live and page lanes at `now`, from the meter's events: setup
 * markers alive (a setup waiting or granted, for its marker's minute), live
 * orders' demands alive (HYPERLIQUID_LIVE_DEMAND_HOLD_MS), and the page
 * lane, which announces nothing: its reads alive in the window (`count`),
 * what they hold, and when the last of them ends. */
export function hyperliquidLaneStatus(events:readonly HyperliquidQuotaEvent[],now:number):{readonly setupDemand:HyperliquidLaneDemand;readonly liveDemand:HyperliquidLaneDemand;readonly pageLane:HyperliquidLaneDemand}{
  const rest=events.filter(e=>e.kind==='rest'&&e.expiresAt>now),units=(list:readonly HyperliquidQuotaEvent[])=>list.reduce((sum,e)=>sum+e.units,0);
  const markers=rest.filter(e=>e.id.startsWith(SETUP_DEMAND_ID_PREFIX)),orders=rest.filter(e=>LIVE_DEMAND_TICKET.test(e.id)&&e.reservedAt+HYPERLIQUID_LIVE_DEMAND_HOLD_MS>now);
  const tokens=new Set(orders.map(e=>LIVE_DEMAND_TICKET.exec(e.id)![2])),pages=rest.filter(e=>e.id.startsWith(PAGE_REST_ID_PREFIX));
  return {
    setupDemand:{count:markers.length,held:units(rest.filter(e=>e.id.startsWith(SETUP_REST_ID_PREFIX))),until:markers.length?Math.max(...markers.map(e=>e.expiresAt)):null},
    liveDemand:{count:tokens.size,held:units(rest.filter(e=>e.id.startsWith(LIVE_REST_ID_PREFIX))),until:orders.length?Math.max(...orders.map(e=>e.reservedAt+HYPERLIQUID_LIVE_DEMAND_HOLD_MS)):null},
    pageLane:{count:pages.length,held:units(pages),until:pages.length?Math.max(...pages.map(e=>e.expiresAt)):null},
  };
}
/** Background charges' tickets (`bg:<id>`): told apart from unlabelled ones
 * in the meter's composition only (a process on the previous release reads
 * them as ordinary REST charges, which they are). */
export const BACKGROUND_REST_ID_PREFIX='bg:';
/** What the meter held at one decision, by class (diagnostics: the setup's
 * claim waits log it, so a gate run shows who held the window): `background`
 * (`bg:`), `other` (no lane ticket: pages, wallet and live work outside an
 * original session, a previous release's charges), `live` (`live:`), each
 * setup's charges by its token's first 8 hex (`setup`), the 1-unit markers,
 * setups whose claim waits (`pending`: need, since when its earliest alive
 * marker) and granted claims (`granted`: what each still needs). */
export interface HyperliquidMeterComposition {
  readonly total:number;readonly background:number;readonly other:number;readonly live:number;readonly page:number;
  readonly setup:Readonly<Record<string,number>>;readonly markers:{readonly setup:number;readonly live:number};
  readonly pending:readonly {readonly token:string;readonly need:number;readonly waitingMs:number}[];
  readonly granted:readonly {readonly token:string;readonly left:number}[];
  readonly liveNeed:number;
}
export function hyperliquidMeterComposition(events:readonly HyperliquidQuotaEvent[],now:number):HyperliquidMeterComposition{
  const rest=events.filter(e=>e.kind==='rest'&&e.expiresAt>now);
  let background=0,other=0,live=0,page=0,setupMarkers=0,liveMarkers=0;const setup:Record<string,number>={};
  for(const e of rest){
    // Held weight is in the total; what each grant holds is `granted`.
    if(isHold(e))continue;
    if(e.id.startsWith(SETUP_DEMAND_ID_PREFIX))setupMarkers+=e.units;
    else if(e.id.startsWith(LIVE_DEMAND_ID_PREFIX))liveMarkers+=e.units;
    else if(e.id.startsWith(SETUP_REST_ID_PREFIX)){const token=(SETUP_TOKEN_CHARGE.exec(e.id)?.[1]??'untagged').slice(0,8);setup[token]=(setup[token]??0)+e.units;}
    else if(e.id.startsWith(LIVE_REST_ID_PREFIX))live+=e.units;
    else if(e.id.startsWith(BACKGROUND_REST_ID_PREFIX))background+=e.units;
    else if(e.id.startsWith(PAGE_REST_ID_PREFIX))page+=e.units;
    else other+=e.units;
  }
  const holds=setupHolds(rest,now);
  const pending=pendingSetups(rest,now).map(c=>({token:c.token.slice(0,8),need:c.need,waitingMs:now-c.first}));
  const granted=holds.tokens().map(t=>({token:t.slice(0,8),left:holds.held(t)}));
  return {total:rest.reduce((sum,e)=>sum+e.units,0),background,other,live,page,setup,markers:{setup:setupMarkers,live:liveMarkers},pending,granted,liveNeed:liveClaims(rest,now).outstanding()};
}
const isLaneTicket=(id:string)=>[SETUP_REST_ID_PREFIX,SETUP_DEMAND_ID_PREFIX,SETUP_HOLD_ID_PREFIX,LIVE_REST_ID_PREFIX,LIVE_DEMAND_ID_PREFIX,PAGE_REST_ID_PREFIX].some(prefix=>id.startsWith(prefix));
export interface HyperliquidQuotaPlan {readonly state:HyperliquidQuotaState;readonly leases:readonly HyperliquidQuotaLease[];readonly charged:number;
  /** `setup_demand` and `live_demand` only: 0 when the weight fits now, else in how many ms it should (its marker is recorded either way). */
  readonly waitMs?:number;
  /** `setup_demand` only: what the meter held at this decision (diagnostics). */
  readonly composition?:HyperliquidMeterComposition;}
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
  z.object({kind:z.literal('setup_demand'),id:identifier,weight:integer.positive().max(1200),sendUntil:integer.positive(),connects:integer.positive().max(HYPERLIQUID_MAX_SETUP_CONNECTS).optional(),queue:z.literal(true).optional()}).strict(),
  z.object({kind:z.literal('setup_release'),token:z.string().regex(SETUP_LANE_TOKEN)}).strict(),
  z.object({kind:z.literal('live_demand'),id:identifier,weight:integer.positive().max(HYPERLIQUID_MAX_LIVE_DEMAND),sendUntil:integer.positive()}).strict(),
  z.object({kind:z.literal('rest'),id:identifier,weight:integer.positive().max(1200),sendUntil:integer.positive(),lane:z.enum(['background','setup','live','page']).optional(),heldMs:integer.max(65_000).optional(),
    settle:z.array(z.object({id:identifier,units:integer.positive().max(1200)}).strict()).max(HYPERLIQUID_MAX_SETTLEMENTS).optional()}).strict(),
  z.object({kind:z.literal('connect'),id:identifier,sendUntil:integer.positive(),lease:leaseSchema.omit({state:true,revision:true,subscriptions:true,createdAt:true,updatedAt:true,closedAt:true}),
    setupToken:z.string().regex(SETUP_LANE_TOKEN).optional(),live:z.boolean().optional()}).strict(),
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
    let charged=0,waitMs:number|undefined,composition:HyperliquidMeterComposition|undefined;
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
     * live reserve and the setups' share, and only once what live orders
     * announced fits too (setups come after live). Other setups' grants are
     * held weight in the window (they count like charges); this setup's own
     * hold does not (what it asks replaces it). Its own earlier charges count
     * in the window, never in the share. */
    const setupFitsIn=(units:number,token?:string)=>{
      const rest=events.filter(e=>e.kind==='rest'&&!(isHold(e)&&ownedBy(e,token))),live=liveClaims(rest,now),ahead=live.outstanding();
      // A setup behind the oldest waiting one leaves that one's need free too (the queue).
      const head=pendingSetups(rest,now)[0],queued=head&&head.token!==token?head:undefined,before=queued?.need??0;
      // min(960, 1200 − live's need), beside what is charged and held
      const all=beside(rest,units,HYPERLIQUID_REST_CAP-HYPERLIQUID_LIVE_REST_RESERVE,before+Math.max(0,ahead-HYPERLIQUID_LIVE_REST_RESERVE),[queued?.until,ahead>0?live.until():undefined]);
      const own=beside(rest.filter(e=>isSetupEvent(e)&&!ownedBy(e,token)),units,HYPERLIQUID_SETUP_REST_CAP,before,[queued?.until]);
      return all===undefined||own===undefined?undefined:Math.max(all,own);
    };
    /** Live comes before setups: a live order announcing a need that does
     * not fit beside setups' grants takes their held room. Grants whose step
     * has sent nothing yet go first (their step's first read is then refused
     * before anything went out: a clean wait); only if that is not enough,
     * the others too (that step is refused partway: real money first). `fit`:
     * the request's wait in a pool. */
    const preempting=(fit:(pool:readonly HyperliquidQuotaEvent[])=>number|undefined):number|undefined=>{
      const rest=events.filter(e=>e.kind==='rest'),wait=fit(rest);if(wait===0)return wait;
      const token=(e:HyperliquidQuotaEvent)=>SETUP_HOLD.exec(e.id)?.[1];
      const all=new Set(rest.filter(e=>isHold(e)&&e.expiresAt>now).map(e=>token(e)!));
      for(const candidates of [untouchedHolds(rest,now),all]){
        if(candidates.size===0||fit(rest.filter(e=>!(isHold(e)&&candidates.has(token(e)!))))!==0)continue;
        for(const t of candidates)revoke(events,t);
        return 0;
      }
      return wait;
    };
    /** `connects` socket connects for `token`'s step: the connect window
     * beside everything but its own hold, below live sockets' reserve. */
    const connectsFitIn=(connects:number,token:string)=>fitsIn(events.filter(e=>e.kind==='ws_connect'&&!(isHold(e)&&ownedBy(e,token))),connects,caps.ws_connect-HYPERLIQUID_LIVE_WS_CONNECT_RESERVE);
    const restCharge=(units:number,id:string,sendUntil:number,lane:HyperliquidRestLane|undefined,heldMs=0)=>{
      requireQuota(sendUntil>=now&&sendUntil<=now+5000);requireQuota(!s.events.some(e=>e.id===id),'hyperliquid_quota_ticket_conflict');
      requireQuota(lane==='setup'?id.startsWith(SETUP_REST_ID_PREFIX):lane==='live'?id.startsWith(LIVE_REST_ID_PREFIX):lane==='page'?id.startsWith(PAGE_REST_ID_PREFIX):!isLaneTicket(id));
      const rest=events.filter(e=>e.kind==='rest'),holds=setupHolds(rest,now),live=liveClaims(rest,now),ahead=live.outstanding(),head=pendingSetups(rest,now)[0];
      let wait:number|undefined;
      // Live: the whole window, beside setups' grants (an order that needs
      // their room took it when it announced its need).
      if(lane==='live')wait=fitsIn(rest,units,HYPERLIQUID_REST_CAP);
      else if(lane==='setup'){
        // Within its granted claim: the charge replaces weight its grant
        // holds, one for one (the window's total does not move), so it is
        // admitted whatever else was charged since. Past its hold, the whole
        // charge is checked as any setup charge (beside everything but its
        // own hold, which it then draws to nothing).
        // A grant a live order took back: nothing more of the step goes out
        // until it claims again (once the order's need is charged or over).
        const token=SETUP_TOKEN_CHARGE.exec(id)?.[1],held=holds.held(token);
        if(held<units&&revoked(rest,token))throw new HyperliquidRestCapacityError(Math.max(1,(ahead>0?live.until()!:now+1000)-now));
        wait=held>=units?0:setupFitsIn(units,token);
        if(wait===0&&token!==undefined&&held>0)drawHold(events,'rest',token,units,now);
      }
      else if(lane==='page'){
        // The whole window (granted setup claims' holds are in it), less
        // what live orders still need. While a setup waits, a page leaves the
        // oldest one's need free below the setups' ceiling too, until it has
        // itself been held back HYPERLIQUID_PAGE_HOLD_MS: then within
        // HYPERLIQUID_PAGE_FLOOR.
        const ends=[ahead>0?live.until():undefined];
        const open=beside(rest,units,HYPERLIQUID_REST_CAP,ahead,ends);
        if(!head||open===undefined)wait=open;
        else{
          const behind=beside(rest,units,HYPERLIQUID_REST_CAP-HYPERLIQUID_LIVE_REST_RESERVE,head.need,[...ends,head.until]);
          const pages=rest.filter(e=>e.id.startsWith(PAGE_REST_ID_PREFIX)),aged=heldMs>=HYPERLIQUID_PAGE_HOLD_MS;
          const floor=fitsIn(pages,units,HYPERLIQUID_PAGE_FLOOR);
          if(open===0&&(behind===0||aged&&floor===0))wait=0;
          else{
            // Asked again once it fits behind the setup, once its hold is
            // over, or (held long enough) once the pages' floor has room.
            const again=[behind,aged?floor:HYPERLIQUID_PAGE_HOLD_MS-heldMs].filter((w):w is number=>w!==undefined);
            wait=again.length?Math.max(open,Math.min(...again),1):undefined;
          }
        }
      }
      else{
        // Background, and any charge without a lane: while a setup waits,
        // background leaves the setups' unused share free below the live
        // reserve, and the oldest waiting setup's need; it also leaves what
        // live orders' demands still need (it is refused first); otherwise
        // its cap. Granted setup claims' holds are in the window it counts.
        const demands=rest.filter(e=>e.id.startsWith(SETUP_DEMAND_ID_PREFIX)),held=holds.until(),base=backgroundRestCap(raw.backgroundCap);
        const share=demands.length===0?0:Math.max(0,HYPERLIQUID_SETUP_REST_CAP-sum(rest.filter(isSetupEvent)));
        let cap=demands.length===0?base:Math.min(base,HYPERLIQUID_REST_CAP-HYPERLIQUID_LIVE_REST_RESERVE-share);
        if(head)cap=Math.min(cap,HYPERLIQUID_REST_CAP-HYPERLIQUID_LIVE_REST_RESERVE-head.need);
        if(ahead>0)cap=Math.min(cap,HYPERLIQUID_REST_CAP-ahead-share);
        wait=fitsIn(rest,units,cap);
        // Room that only comes back once no setup waits and no grant holds
        // weight: when the last of them ends.
        if(wait===undefined&&(demands.length>0||held!==undefined||ahead>0)&&fitsIn([],units,base)===0)
          throw new HyperliquidRestCapacityError(Math.max(...demands.map(e=>e.expiresAt),held??0,ahead>0?live.until()!:0)-now);
      }
      // The first expiry alone may not free enough for this request. Only
      // retained REST charges contribute; leases are never refunded.
      if(wait===undefined)throw new LiveBoundaryError('hyperliquid_quota_exhausted');
      if(wait>0)throw new HyperliquidRestCapacityError(wait);
      events.push({id,kind:'rest',units,reservedAt:now,expiresAt:sendUntil+60000});charged=units;
    };
    /** Socket messages and connects (REST: restCharge). A refusal says when
     * the units fit beside `reserved` as the window's events expire (a
     * HyperliquidRestCapacityError), when they ever do. */
    const charge=(kind:'ws_message'|'ws_connect',units:number,id:string,sendUntil:number,reserved=0)=>{
      requireQuota(sendUntil>=now&&sendUntil<=now+5000);requireQuota(!s.events.some(e=>e.id===id),'hyperliquid_quota_ticket_conflict');
      if(sum(events.filter(e=>e.kind===kind))+units+reserved>caps[kind]){
        const wait=fitsIn(events.filter(e=>e.kind===kind),units,caps[kind]-reserved);
        if(wait!==undefined&&wait>0)throw new HyperliquidRestCapacityError(wait);
        throw new LiveBoundaryError('hyperliquid_quota_exhausted');
      }
      events.push({id,kind,units,reservedAt:now,expiresAt:sendUntil+60000});charged=units;
    };
    const active=()=>leases.filter(l=>l.state!=='closed'&&!hyperliquidLeaseReclaimed(l,now));
    const limits=()=>{requireQuota(active().length<=10,'hyperliquid_quota_connections');requireQuota(active().reduce((sum,l)=>sum+l.subscriptions.length,0)<=1000,'hyperliquid_quota_subscriptions');
      requireQuota(new Set(active().flatMap(l=>l.subscriptions.filter(sub=>sub.user!==null).map(sub=>`${sub.network}:${sub.user}`))).size<=10,'hyperliquid_quota_users');};
    limits();
    if(request.kind==='rest')restCharge(request.weight,request.id,request.sendUntil,request.lane,request.heldMs);
    else if(request.kind==='setup_demand'){
      // A setup about to run a step that needs `weight`: its marker (1 unit,
      // an ordinary charge never sent) makes background leave the setups'
      // share free for the next minute, and says when the step fits. A
      // setup's claim (its ticket carries its need and token) that fits now
      // is granted (`:g`): for HYPERLIQUID_SETUP_GRANT_HOLD_MS what the step
      // still needs stays free for it.
      // A granted claim holds the step's weight (and its socket connects) as
      // events of the window for HYPERLIQUID_SETUP_GRANT_HOLD_MS. What the
      // setup held before is replaced: a step that claims again continues
      // its grant (its unused part is not asked for twice).
      requireQuota(request.id.startsWith(SETUP_DEMAND_ID_PREFIX)&&!request.id.endsWith(':g'));
      const ticket=SETUP_DEMAND_TICKET.exec(request.id);requireQuota(!ticket||Number(ticket[1])===request.weight);
      requireQuota(ticket?Number(ticket[3]??0)===(request.connects??0):request.connects===undefined);
      const token=ticket?.[2];
      let fits=setupFitsIn(request.weight+1,token);
      if(fits!==undefined&&token!==undefined&&request.connects){const connects=connectsFitIn(request.connects,token);fits=connects===undefined?undefined:Math.max(fits,connects);}
      if(fits===undefined)throw new LiveBoundaryError('hyperliquid_quota_exhausted');
      requireQuota(request.sendUntil>=now&&request.sendUntil<=now+5000);requireQuota(!s.events.some(e=>e.id===request.id||e.id===`${request.id}:g`),'hyperliquid_quota_ticket_conflict');
      const marker=fitsIn(events.filter(e=>e.kind==='rest'),1,HYPERLIQUID_REST_CAP);
      if(marker===undefined)throw new LiveBoundaryError('hyperliquid_quota_exhausted');
      if(marker>0)throw new HyperliquidRestCapacityError(marker);
      const granted=token!==undefined&&fits===0&&request.queue!==true;
      events.push({id:granted?`${request.id}:g`:request.id,kind:'rest',units:1,reservedAt:now,expiresAt:request.sendUntil+60000});charged=1;waitMs=fits;
      if(granted){
        dropHolds(events,token);
        const hold=`${SETUP_HOLD_ID_PREFIX}${token}:${request.id.slice(SETUP_DEMAND_ID_PREFIX.length)}`,until=now+HYPERLIQUID_SETUP_GRANT_HOLD_MS;
        events.push({id:hold,kind:'rest',units:request.weight,reservedAt:now,expiresAt:until});
        if(request.connects)events.push({id:`${hold}:ws`,kind:'ws_connect',units:request.connects,reservedAt:now,expiresAt:until});
      }
      composition=hyperliquidMeterComposition(events,now);
    }
    else if(request.kind==='setup_release'){
      // The step is over: what its grant still holds goes back to the window.
      dropHolds(events,request.token);
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
      waitMs=Math.min(65000,preempting(pool=>beside(pool,need,HYPERLIQUID_REST_CAP,live.outstanding(token),[live.until(token)]))??65000);
    }
    else if(request.kind==='connect'){
      requireQuota(!leases.some(l=>l.id===request.lease.id||l.socketId===request.lease.socketId),'hyperliquid_quota_lease_lost');
      requireQuota(request.lease.egressKey===s.egressKey&&request.lease.leaseUntil>now&&request.lease.leaseUntil<=now+60000&&request.lease.latestAllowedSendAt===request.sendUntil&&request.sendUntil<=request.lease.leaseUntil);
      // A setup step's socket takes a connect its grant holds. A live socket
      // has the whole window; any other leaves live sockets' reserve free,
      // and the oldest waiting setup's connects (as background leaves its
      // REST need), so a step that opens sockets is not refused partway
      // through by a connect taken meanwhile (gate 2026-10-13: the harness's
      // two socket loops take ~29 of the 30 a minute).
      const head=pendingSetups(events.filter(e=>e.kind==='rest'),now)[0];
      const covered=request.setupToken===undefined?0:drawHold(events,'ws_connect',request.setupToken,1,now);
      charge('ws_connect',1,request.id,request.sendUntil,covered>0||request.live?0:HYPERLIQUID_LIVE_WS_CONNECT_RESERVE+(!head||head.token===request.setupToken?0:head.connects));
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
    requireQuota(events.length<=3500);return freezeLiveReservation({state:{...s,events,revision:s.revision+1,updatedAt:now},leases,charged,...(waitMs===undefined?{}:{waitMs}),...(composition===undefined?{}:{composition})});
  }catch(error){if(error instanceof LiveBoundaryError)throw error;throw new LiveBoundaryError('hyperliquid_quota_invalid');}
}
