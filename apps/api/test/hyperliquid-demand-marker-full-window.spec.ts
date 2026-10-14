import {describe,expect,it} from 'vitest';
import {HyperliquidRestCapacityError} from '../src/hyperliquid/hyperliquid-capacity-error.js';
import {HYPERLIQUID_DEMAND_MARKER_CAP} from '../src/config/constants/hyperliquid.js';
import {planHyperliquidQuota,setupDemandTicket,type HyperliquidQuotaEvent,type HyperliquidQuotaRequest,type HyperliquidQuotaState} from '../src/hyperliquid/hyperliquid-global-quota.js';

/**
 * CI, 2026-10-14 (copy-live-settlement-priority-postgres.spec.ts, 5 of 8
 * runs): a settlement's claim was refused at ~9 s, inside its 15 s. Its
 * demand marker (1 unit, never sent) went in only when a unit of the window
 * was free, and pages that wait for room took every 20 that freed up first:
 * ten refused markers in a row on a loaded runner, so the claim was never
 * recorded, nothing was kept free for it, and once the room that was to
 * free up in time was gone the meter quoted ~50 s, past its claim. Here the
 * same race, in the order that loses it: at every expiry a page asks first.
 * Pure planner: the same accounting the Postgres meter commits.
 */
const now=1790000000000,egressKey='demand-marker';
const S=(events:HyperliquidQuotaEvent[]):HyperliquidQuotaState=>({egressKey,revision:1,events,updatedAt:now});
const plan=(request:HyperliquidQuotaRequest,state:HyperliquidQuotaState,at:number)=>planHyperliquidQuota({now:at,state:{...state,updatedAt:Math.min(state.updatedAt,at)},leases:[],request});
const refusal=(work:()=>unknown)=>{try{work();}catch(error){return error;}return undefined;};
let tickets=0;const id=(prefix='')=>`${prefix}${String(++tickets).padStart(8,'0')}-0000-4000-8000-000000000000`;
const ORDER='aaaaaaaaaaaaaaaa',SETUP='0123456789abcdef';
const alive=(state:HyperliquidQuotaState,at:number)=>state.events.filter(e=>e.kind==='rest'&&e.expiresAt>at);
const isMarker=(e:HyperliquidQuotaEvent)=>e.id.startsWith('live-demand:')||e.id.startsWith('setup-demand:');
/** What is sent (or may be): every charge but the demand markers. */
const sent=(state:HyperliquidQuotaState,at:number)=>alive(state,at).filter(e=>!isMarker(e)).reduce((sum,e)=>sum+e.units,0);
/** The window full: 60 charges of 20, one expiring every 150 ms (the gate's
 * staircase), all gone 9 s on; after that only charges made since. */
const staircase=()=>S(Array.from({length:60},(_,i)=>({id:i<42?`bg-${i}`:id('page:'),kind:'rest' as const,units:20,reservedAt:now-60_000+i*150,expiresAt:now+(i+1)*150})));
const page=(state:HyperliquidQuotaState,at:number)=>plan({kind:'rest',id:id('page:'),weight:20,sendUntil:at+5000,lane:'page'},state,at);

describe('a demand marker is recorded on a full window: the claim is never starved by the lanes it goes ahead of', () => {
  it('a settlement\'s live demand: recorded at once, pages leave its need from then on, and it fits before the room runs out', () => {
    const need=546;let state=staircase(),marked:number|undefined,granted:number|undefined,pagesAfter=0;
    for(let at=now+10;at<now+9_000&&granted===undefined;at+=150){
      // Every expiry: a page asks first and takes the room if it may.
      try{state=page(state,at).state;if(marked!==undefined)pagesAfter++;}catch(error){expect(error).toBeInstanceOf(HyperliquidRestCapacityError);}
      // Then the settlement claims (again): its marker, and when its need fits.
      const claimed=refusal(()=>{const p=plan({kind:'live_demand',id:`live-demand:${need}:${ORDER}:${id()}`,weight:need,sendUntil:at+5000},state,at);state=p.state;marked??=at;if(p.waitMs===0)granted=at;});
      if(claimed!==undefined)expect(claimed).toBeInstanceOf(HyperliquidRestCapacityError);
      expect(sent(state,at)).toBeLessThanOrEqual(1200);
    }
    // Recorded on the full window at its first ask (before: refused, a page took every unit that freed).
    expect(marked).toBe(now+10);
    expect(pagesAfter).toBe(0);
    // 546 frees up in 28 expiries (~4.2 s), well before the staircase ends.
    expect(granted).toBeDefined();expect(granted!-now).toBeLessThan(5_000);
    // Its reads go out: the live lane within its need, and still never past 1200 sent.
    for(const weight of [120,120,306]){const p=plan({kind:'rest',id:id(`live:${ORDER}:`),weight,sendUntil:granted!+5000,lane:'live'},state,granted!);expect(p.charged).toBe(weight);state=p.state;}
    expect(sent(state,granted!)).toBeLessThanOrEqual(1200);
  });

  it('a setup\'s demand: recorded on a full window too, and background is refused first from then on', () => {
    const state=staircase(),at=now+10;
    const claimed=plan({kind:'setup_demand',id:setupDemandTicket(300,SETUP),weight:300,sendUntil:at+5000},state,at);
    expect(claimed.charged).toBe(1);expect(claimed.waitMs).toBeGreaterThan(0);
    expect(alive(claimed.state,at).some(e=>e.id.startsWith(`setup-demand:300:${SETUP}:`))).toBe(true);
    expect(sent(claimed.state,at)).toBe(1200);
    // The first 20 that frees up is not background's.
    expect(refusal(()=>plan({kind:'rest',id:id('bg:'),weight:20,sendUntil:at+5150,lane:'background'},claimed.state,at+150))).toBeInstanceOf(HyperliquidRestCapacityError);
  });

  it('a flood of claims stays bounded: a claimant\'s renewals keep one marker (a setup two), new claimants past the cap get the old wait, and pages are served once the window frees', () => {
    // The window full until now+1000; the flood at now+10.
    let state=S(Array.from({length:60},(_,i)=>({id:i<42?`bg-${i}`:id('page:'),kind:'rest' as const,units:20,reservedAt:now-59_000,expiresAt:now+1_000})));
    const at=now+10,live=(token:string,s:HyperliquidQuotaState)=>plan({kind:'live_demand',id:`live-demand:10:${token}:${id()}`,weight:10,sendUntil:at+5000},s,at);
    const markers=(s:HyperliquidQuotaState)=>alive(s,at).filter(isMarker);
    // One settlement's claimLive renewing 1300 times (a hot retry loop): one marker.
    for(let n=0;n<1300;n++)state=live(ORDER,state).state;
    expect(markers(state).filter(e=>e.id.includes(`:${ORDER}:`))).toHaveLength(1);
    // One setup step claiming again and again: its first and its latest.
    for(let n=0;n<50;n++)state=plan({kind:'setup_demand',id:setupDemandTicket(300,SETUP),weight:300,sendUntil:at+5000},state,at).state;
    expect(markers(state).filter(e=>e.id.includes(`:${SETUP}:`))).toHaveLength(2);
    // Distinct claimants: recorded until HYPERLIQUID_DEMAND_MARKER_CAP stand over the window, then refused with a wait (as before).
    let recorded=0,refused=0;
    for(let n=0;n<40;n++){const token=n.toString(16).padStart(16,'c');
      const error=refusal(()=>{state=live(token,state).state;recorded++;});
      if(error!==undefined){expect(error).toBeInstanceOf(HyperliquidRestCapacityError);expect((error as HyperliquidRestCapacityError).retryAfterMs).toBe(990);refused++;}}
    expect(recorded).toBe(HYPERLIQUID_DEMAND_MARKER_CAP-3);expect(refused).toBe(40-recorded);
    expect(markers(state).length).toBe(HYPERLIQUID_DEMAND_MARKER_CAP);
    expect(alive(state,at).reduce((sum,e)=>sum+e.units,0)).toBe(1200+HYPERLIQUID_DEMAND_MARKER_CAP);
    // A renewal past the cap still goes in: it reuses its own marker's room.
    expect(live(ORDER,state).charged).toBe(1);
    // Once the window's charges expire, a page, background and live work are served beside the markers.
    const later=now+1_100;
    state=page(state,later).state;
    state=plan({kind:'rest',id:id('bg:'),weight:20,sendUntil:later+5000,lane:'background'},state,later).state;
    expect(plan({kind:'rest',id:id(`live:${ORDER}:`),weight:20,sendUntil:later+5000,lane:'live'},state,later).charged).toBe(20);
  });

  it('the provider\'s 1200 holds for what is sent: a marker over the window is never room for a charge', () => {
    let state=staircase();const at=now+10;
    state=plan({kind:'live_demand',id:`live-demand:100:${ORDER}:${id()}`,weight:100,sendUntil:at+5000},state,at).state;
    expect(alive(state,at).reduce((sum,e)=>sum+e.units,0)).toBe(1201);
    for(const lane of ['live','page','background','setup'] as const)
      expect(refusal(()=>plan({kind:'rest',id:id(lane==='background'?'bg:':`${lane}:`),weight:1,sendUntil:at+5000,lane},state,at))).toBeInstanceOf(HyperliquidRestCapacityError);
    // Charges past the window are still refused when the state is read back.
    expect(()=>plan({kind:'rest',id:id('page:'),weight:1,sendUntil:at+5000,lane:'page'},S([...state.events,{id:'over',kind:'rest',units:20,reservedAt:at,expiresAt:at+60_000}]),at)).toThrow('hyperliquid_quota_invalid');
  });
});
