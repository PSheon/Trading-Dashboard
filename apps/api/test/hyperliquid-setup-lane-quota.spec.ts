import {describe,expect,it} from 'vitest';
import {HyperliquidRestCapacityError} from '../src/hyperliquid/hyperliquid-capacity-error.js';
import {HYPERLIQUID_BACKGROUND_REST_CAP,planHyperliquidQuota,type HyperliquidQuotaEvent,type HyperliquidQuotaRequest,type HyperliquidQuotaState} from '../src/hyperliquid/hyperliquid-global-quota.js';

/**
 * The shared per-IP window's setup lane (2026-10-13 gate: a setup sat at
 * `funded` for 602 s beside a full background lane). Pure planner: the same
 * accounting the Postgres meter commits. 1200 a minute per IP, never more.
 */
const now=1790000000000,egressKey='setup-lane';
const S=(events:HyperliquidQuotaEvent[]):HyperliquidQuotaState=>({egressKey,revision:1,events,updatedAt:now});
const plan=(request:HyperliquidQuotaRequest,state:HyperliquidQuotaState,at=now)=>planHyperliquidQuota({now:at,state,leases:[],request});
const rest=(id:string,units:number,expiresIn=65_000):HyperliquidQuotaEvent=>({id,kind:'rest',units,reservedAt:now,expiresAt:now+expiresIn});
/** Background as Stage's loops (and contention.mjs) leave it: its 840, in
 * 20s granted over the last minute, expiring one after another. */
const fullBackground=()=>Array.from({length:HYPERLIQUID_BACKGROUND_REST_CAP/20},(_,i)=>rest(`bg-${i}`,20,1_500*(i+1)));
const total=(state:HyperliquidQuotaState)=>state.events.filter(e=>e.kind==='rest').reduce((sum,e)=>sum+e.units,0);
const refusal=(work:()=>unknown)=>{try{work();}catch(error){return error;}return undefined;};
let tickets=0;const id=(prefix='')=>`${prefix}t${++tickets}`;
const setupCharge=(weight:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'rest',id:id('setup:'),weight,sendUntil:at+5000,lane:'setup'},state,at);
const background=(weight:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'rest',id:id(),weight,sendUntil:at+5000,lane:'background'},state,at);
const live=(weight:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'rest',id:id(),weight,sendUntil:at+5000},state,at);
const demand=(weight:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'setup_demand',id:id('setup-demand:'),weight,sendUntil:at+5000} as unknown as HyperliquidQuotaRequest,state,at);
/** One account-mode attempt's REST charges (two preflights and the POST). */
const ATTEMPT=[102,42,102,102,42,102,1];

describe('the shared window: setups ahead of background, live orders keep their share', () => {
  it('a waiting setup makes background leave the setups\' share free: background is refused first, and the setup fits when the meter said', () => {
    const state=S(fullBackground());
    expect(total(state)).toBe(840);
    // Before: background takes any room that expires below its cap.
    expect(background(20,S(fullBackground().slice(1))).charged).toBe(20);
    // The setup's account-mode attempt (613): not now (840 + 614 > 960); the
    // meter says when, and the setup's marker (1 unit) is recorded either way.
    const claimed=demand(613,state);
    expect(claimed.charged).toBe(1);
    expect(claimed.waitMs).toBeGreaterThan(0);
    expect(claimed.waitMs).toBeLessThanOrEqual(65_000);
    // Until then background gets nothing more, though its own cap has room.
    const later=now+claimed.waitMs!;
    const afterExpiry=S(claimed.state.events.filter(e=>e.expiresAt>later));
    expect(total(afterExpiry)).toBeLessThan(HYPERLIQUID_BACKGROUND_REST_CAP);
    expect(refusal(()=>background(20,afterExpiry,later))).toBeInstanceOf(HyperliquidRestCapacityError);
    // …and the setup's whole attempt fits at exactly the time it was told.
    expect(demand(613,afterExpiry,later).waitMs).toBe(0);
    let s=afterExpiry;
    for(const weight of ATTEMPT){const next=setupCharge(weight,s,later);expect(next.charged).toBe(weight);s=next.state;}
    // Live work still has its room beside it.
    expect(live(240,s,later).charged).toBe(240);
  });

  it('background without a waiting setup keeps its cap as before', () => {
    const state=S(fullBackground().slice(10));
    expect(background(200,state).charged).toBe(200);
    expect(refusal(()=>background(220,state))).toBeInstanceOf(HyperliquidRestCapacityError);
  });

  it('once no setup waits (its marker expired), background has its cap again', () => {
    const claimed=demand(81,S([])).state;
    // Refused while the setup waits: told to come back when its marker expires.
    expect(refusal(()=>background(500,claimed))).toMatchObject({retryAfterMs:65_000});
    expect(background(500,claimed,now+65_001).charged).toBe(500);
  });

  it('a burst of setups holds at most its share and never the live reserve: live orders still go out', () => {
    let state=S([]);
    const granted:number[]=[];
    for(let setup=0;setup<3;setup++){
      state=demand(613,state).state;
      for(const weight of ATTEMPT){
        try{const next=setupCharge(weight,state);state=next.state;granted.push(next.charged);}catch(error){expect(error).toBeInstanceOf(HyperliquidRestCapacityError);}
      }
    }
    const setupHeld=state.events.filter(e=>e.id.startsWith('setup')).reduce((sum,e)=>sum+e.units,0);
    expect(setupHeld).toBeLessThanOrEqual(720);
    expect(granted.reduce((a,b)=>a+b,0)).toBeGreaterThanOrEqual(493);
    // Live orders: everything else, up to the provider's 1200.
    expect(live(1200-total(state),state).charged).toBe(1200-total(state));
    // With other work in the window too, setups stop below the live reserve.
    let crowded=S([rest('page',500)]);
    for(let i=0;i<10;i++){try{crowded=setupCharge(100,crowded).state;}catch{break;}}
    expect(total(crowded)).toBeLessThanOrEqual(960);
    expect(live(240,crowded).charged).toBe(240);
  });

  it('a setup charge needs the setup lane\'s ticket, and no other ticket passes for a setup\'s', () => {
    expect(()=>plan({kind:'rest',id:'plain',weight:1,sendUntil:now+5000,lane:'setup'} as unknown as HyperliquidQuotaRequest,S([]))).toThrow('hyperliquid_quota_invalid');
    expect(()=>plan({kind:'rest',id:'setup:forged',weight:1,sendUntil:now+5000},S([]))).toThrow('hyperliquid_quota_invalid');
    expect(()=>plan({kind:'rest',id:'setup-demand:forged',weight:1,sendUntil:now+5000,lane:'background'},S([]))).toThrow('hyperliquid_quota_invalid');
    expect(()=>plan({kind:'setup_demand',id:'plain',weight:1,sendUntil:now+5000} as unknown as HyperliquidQuotaRequest,S([]))).toThrow('hyperliquid_quota_invalid');
    // A setup step heavier than the setups' share is never waited for.
    expect(()=>demand(720,S([]))).toThrow('hyperliquid_quota_exhausted');
  });

  it('the provider\'s 1200 holds whatever the lanes: a setup marker is a charge like any other', () => {
    const state=S([rest('live',1200)]);
    expect(refusal(()=>demand(10,state))).toBeInstanceOf(HyperliquidRestCapacityError);
    expect(refusal(()=>setupCharge(1,state))).toBeInstanceOf(HyperliquidRestCapacityError);
    expect(refusal(()=>live(1,state))).toBeInstanceOf(HyperliquidRestCapacityError);
  });
});
