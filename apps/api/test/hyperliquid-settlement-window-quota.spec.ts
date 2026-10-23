import {describe,expect,it} from 'vitest';
import {planHyperliquidQuota,type HyperliquidQuotaEvent,type HyperliquidQuotaRequest,type HyperliquidQuotaState} from '../src/hyperliquid/hyperliquid-global-quota.js';
import {HYPERLIQUID_SOURCE_REST_RESERVE} from '../src/config/constants/hyperliquid.js';
import {LIVE_ORDER_BOUNDARY_WEIGHT,LIVE_SETTLEMENT_WEIGHT} from '../src/config/constants/weights.js';
import type {LiveMandateWork} from '../src/copy/live-worker/copy-live-worker.repository.js';
import {liveStandbyNeed} from '../src/copy/live-worker/live-standby-need.js';
import {observerRestWeight} from '../src/copy/live/live-account-observer.js';
import {LiveReadCache} from '../src/copy/live/live-read-cache.js';
import {assertLiveEvidenceCapacity,liveEvidenceWeight} from '../src/copy/live/live-shared-reads.js';

/**
 * Stage mainnet, 2026-10-18, the first real order (FARTCOIN): sent at
 * 08:05:17.456, acked 08:05:18.285 (IOC, filled); its settlement was quoted
 * `need 266, quoted 36595 ms` and settled at 08:05:44.998, 26.7 s after the
 * ack. A planner replay of the meter as it was sampled (08:05:13Z and
 * 08:05:43Z), so the term that made the quote is named, not guessed. Pure
 * planner, the same accounting the Postgres meter commits.
 */
const at=(s:number)=>Date.UTC(2026,9,18,8,5,0)+Math.round(s*1000);
const ORDER='a1a1a1a1a1a1a1a1',SETTLE='b2b2b2b2b2b2b2b2',EARLIER='c3c3c3c3c3c3c3c3',LEADERS=['0a0a0a0a','0b0b0b0b','0c0c0c0c'];
let n=0;const uuid=()=>`${String(++n).padStart(8,'0')}-0000-4000-8000-000000000000`;
/** A charge as the meter stores it: committed with a 5 s send window, alive 60 s past it. */
const ev=(id:string,units:number,reservedAt:number):HyperliquidQuotaEvent=>({id,kind:'rest',units,reservedAt,expiresAt:reservedAt+65_000});
/** `total` in charges of at most `size`, their times spread evenly over [from, to]. */
const spread=(prefix:()=>string,total:number,size:number,from:number,to:number)=>{
  const count=Math.ceil(total/size),out:HyperliquidQuotaEvent[]=[];
  for(let i=0;i<count;i++)out.push(ev(prefix(),Math.min(size,total-i*size),Math.round(from+(to-from)*(count===1?0:i/(count-1)))));
  return out;
};
const bg=()=>`bg:${uuid()}`,page=()=>`page:${uuid()}`;let leader=0;const source=()=>`source:${LEADERS[leader++%3]}:${uuid()}`;
/** The worker's standby markers (renewed every 10 s; each 1 unit for its minute) and the source standby beside it. */
const standbys=(need:number,until:number)=>[...Array.from({length:6},(_,i)=>ev(`live-standby:${need}:${uuid()}`,1,until-(5-i)*10_000)),ev(`source-standby:${HYPERLIQUID_SOURCE_REST_RESERVE}:${uuid()}`,1,until)];
/** The order: its claim of ~600 at 08:05:11 (evidence and boundary, prepaid) and the 310 it sent, 61 of it by 08:05:13. */
const order=()=>[ev(`live-demand:600:${ORDER}:${uuid()}`,1,at(11)),ev(`live:${ORDER}:order:${uuid()}`,40,at(11.5)),ev(`live:${ORDER}:order:${uuid()}`,21,at(12.5)),
  ...spread(()=>`live:${ORDER}:order:${uuid()}`,249,42,at(14),at(17.5))];
const claim=(events:readonly HyperliquidQuotaEvent[],now:number,need=266,token=SETTLE)=>planHyperliquidQuota({now,leases:[],
  state:{egressKey:'stage-replay',revision:1,events:[...events],updatedAt:Math.min(now,...events.map(e=>e.reservedAt))} satisfies HyperliquidQuotaState,
  request:{kind:'live_demand',id:`live-demand:${need}:${token}:${uuid()}`,weight:need,sendUntil:now+5000} satisfies HyperliquidQuotaRequest});
const held=(events:readonly HyperliquidQuotaEvent[],now:number)=>events.filter(e=>e.expiresAt>now).reduce((sum,e)=>sum+e.units,0);
/** The startup bound (the heaviest evidence the bucket must hold), as live-standby-need.spec.ts builds it. */
const STARTUP_BOUND=assertLiveEvidenceCapacity({capacity:900,maxStrategiesPerUser:2,network:'testnet',budgetPerMin:300}).weight;

describe('replay: the first real order\'s settlement on Stage (2026-10-18 08:05Z)', () => {
  // 08:05:13Z: background 287, page 100, source 284 (3 leaders) over the minute before; the order's first 61.
  const before=[...spread(bg,287,20,at(-45),at(13)),...spread(page,100,20,at(-45),at(13)),...spread(source,284,30,at(-45),at(13))];
  const first=[...before,...order(),...standbys(450,at(10))];

  it('its first pass (08:05:19.5) fits once its own order\'s leftover claim ends, ~7 s: it was quoted ~30 s, the window\'s oldest charges\' expiry', () => {
    const now=at(19.5);
    // The window: ~985 of 1200; the order's claim (600 at 08:05:11) still "needs" 600 − 310 = 290 until 08:05:26.
    expect(held(first,now)).toBeGreaterThan(975);expect(held(first,now)).toBeLessThan(995);
    const quoted=claim(first,now).waitMs!;
    // Before: fitsIn(window, 266, 1200 − 290) whenever that is defined, here
    // ~30 s (341 units of charges from 08:04:14 on had to expire), though the
    // 266 fits in the whole window ~4 s from now and the claim beside it ends
    // in 6.5 s. The settlement waits at most 15 s (SETTLEMENT_CLAIM_WAIT_MS):
    // a quote past that gives the pass up.
    expect(quoted).toBeGreaterThanOrEqual(6_500);
    expect(quoted).toBeLessThan(8_000);
  });

  it('a claim still beside it that ends later than the window frees up keeps the settlement behind it (live claims come in order)', () => {
    const now=at(12);
    // The order has just claimed (08:05:11) and charged 40: its 560 left until 08:05:26.
    const events=[...before.filter(e=>e.reservedAt<=now),ev(`live-demand:600:${ORDER}:${uuid()}`,1,at(11)),ev(`live:${ORDER}:order:${uuid()}`,40,at(11.5)),...standbys(450,at(10))];
    const quoted=claim(events,now).waitMs!;
    // Not before the order's claim ends (14 s from now).
    expect(quoted).toBeGreaterThanOrEqual(14_000);
  });

  it('at 08:05:43Z (the sample) nothing kept it waiting: the order\'s claim had lapsed and live:settle 166 was the settling pass itself', () => {
    // background 162 and page 86 from 08:04:43 on, source 185 as 10 charges, the order's 310, an earlier settle's 166, the markers.
    const sample=[...spread(bg,162,20,at(-17),at(10)),...spread(page,86,20,at(-17),at(10)),...spread(source,185,19,at(-17),at(40)),...order(),
      ...spread(()=>`live:${EARLIER}:settle:${uuid()}`,166,34,at(42.6),at(42.9)),...standbys(450,at(40))];
    const now=at(43);
    expect(held(sample,now)).toBeLessThan(1200-266);
    expect(claim(sample,now).waitMs).toBe(0);
  });
});

/**
 * While a copy runs, the live standby keeps one order's need AND its
 * settlement's free (liveStandbyNeed): background, pages and the leader
 * source fill the rest of the window, the order spends its part, and the
 * settlement finds its own at once instead of waiting for their charges to
 * expire (on Stage the order's 310 took the standby's room and the
 * settlement waited 26.7 s after the ack).
 */
describe('a live standby sized for an order and its settlement', () => {
  const A1='0x'+'1'.repeat(40),LEADER='0x'+'a'.repeat(40);
  const mandate:LiveMandateWork={mandateId:'m1',userId:7,strategyId:1,accountId:'acct-1',accountAddress:A1,sourceNetwork:'mainnet',leaderAddress:LEADER,cursor:new Date(0),
    expiresAt:new Date(8.64e15),strategyStatus:'active',activated:true,activatedAt:new Date(0),sizingMode:'ratio',budgetUsd:null};
  const now=at(0),cold=new LiveReadCache();
  const plan=(request:HyperliquidQuotaRequest,state:HyperliquidQuotaState)=>planHyperliquidQuota({now,state,leases:[],request});
  const rest=(id:string,weight:number,lane:'background'|'page'|'source'|'live')=>({kind:'rest',id,weight,sendUntil:now+5000,lane}) as const;
  /** Every lane but live, 20 at a time, as long as the meter lets it. */
  const fill=(state:HyperliquidQuotaState)=>{
    for(const [prefix,lane] of [['bg:','background'],['page:','page'],['source:0a0a0a0a:','source']] as const)
      for(;;){try{state=plan(rest(`${prefix}${uuid()}`,20,lane),state).state;}catch{break;}}
    return state;
  };
  const demand=(need:number,token:string,state:HyperliquidQuotaState)=>plan({kind:'live_demand',id:`live-demand:${need}:${token}:${uuid()}`,weight:need,sendUntil:now+5000},state);

  it('an order and then its settlement are both served at once on a window background, pages and the source filled', () => {
    const orderNeed=Math.min(STARTUP_BOUND,liveEvidenceWeight([A1],0,cold,[LEADER])+LIVE_ORDER_BOUNDARY_WEIGHT),settleNeed=LIVE_SETTLEMENT_WEIGHT+observerRestWeight(A1,cold);
    const need=liveStandbyNeed([mandate],'mainnet',STARTUP_BOUND,cold);
    let state:HyperliquidQuotaState={egressKey:'standby-settle',revision:1,events:[],updatedAt:now};
    state=plan({kind:'live_standby',id:`live-standby:${need}:${uuid()}`,weight:need,sendUntil:now+5000},state).state;
    state=fill(state);
    expect(held(state.events,now)).toBeGreaterThan(1200-need-20);
    // The order: claimed, every unit of its need sent, its claim released once its work is over (LiveExecutionRuntime).
    const order=demand(orderNeed,ORDER,state);expect(order.waitMs).toBe(0);state=order.state;
    for(let left=orderNeed;left>0;left-=Math.min(left,200))state=plan(rest(`live:${ORDER}:order:${uuid()}`,Math.min(left,200),'live'),state).state;
    state=plan({kind:'live_release',token:ORDER},state).state;
    // Its settlement, right after the ack: no wait for the window's charges to expire.
    const settle=demand(settleNeed,SETTLE,state);
    expect(settle.waitMs).toBe(0);state=settle.state;
    state=plan(rest(`live:${SETTLE}:settle:${uuid()}`,settleNeed,'live'),state).state;
    expect(held(state.events.filter(e=>!e.id.startsWith('live-demand:')),now)).toBeLessThanOrEqual(1200);
    // The standby was both (before: the order's need only, and the settlement waited above).
    expect(need).toBe(orderNeed+settleNeed);
  });
});
