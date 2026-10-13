import {describe,expect,it} from 'vitest';
import {HyperliquidRestCapacityError} from '../src/hyperliquid/hyperliquid-capacity-error.js';
import {planHyperliquidQuota,type HyperliquidQuotaEvent,type HyperliquidQuotaRequest,type HyperliquidQuotaState} from '../src/hyperliquid/hyperliquid-global-quota.js';

/**
 * While live copies run, one order's need is kept free on the shared meter
 * before any order comes (a worker's `live_standby`, renewed every 10 s).
 * A live order's own demand made background leave its need free from then
 * on, but background's 840 already charged stayed for its minute: in the
 * 7th gate's model (copy-live-starvation-postgres.spec.ts, 2026-10-13) the
 * order's 568 waited ~27 s for it to expire. Pure planner, the same
 * accounting the Postgres meter commits; tickets are built here so the file
 * runs against the release before (which refuses the standby: the order
 * then waits).
 */
const now=1790000000000,egressKey='live-standby';
const S=(events:readonly HyperliquidQuotaEvent[]):HyperliquidQuotaState=>({egressKey,revision:1,events:[...events],updatedAt:now});
const plan=(request:HyperliquidQuotaRequest,state:HyperliquidQuotaState,at=now)=>planHyperliquidQuota({now:at,state:{...state,updatedAt:Math.min(state.updatedAt,at)},leases:[],request});
const total=(state:HyperliquidQuotaState,at=now)=>state.events.filter(e=>e.kind==='rest'&&e.expiresAt>at).reduce((sum,e)=>sum+e.units,0);
let tickets=0;const id=(prefix='')=>`${prefix}${String(++tickets).padStart(8,'0')}-0000-4000-8000-000000000000`;
const ORDER='aaaaaaaaaaaaaaaa';
/** The worker's standby for its heaviest order (589: one account and the leader, and the boundary). */
const standby=(need:number,state:HyperliquidQuotaState,at=now)=>{
  try{return plan({kind:'live_standby',id:id(`live-standby:${need}:`),weight:need,sendUntil:at+5000} as unknown as HyperliquidQuotaRequest,state,at).state;}
  catch(error){if((error as {code?:string}).code!=='hyperliquid_quota_invalid')throw error;return state;}
};
const background=(weight:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'rest',id:id('bg:'),weight,sendUntil:at+5000,lane:'background'},state,at);
const page=(weight:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'rest',id:id('page:'),weight,sendUntil:at+5000,lane:'page'},state,at);
const announce=(need:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'live_demand',id:`live-demand:${need}:${ORDER}:${id()}`,weight:need,sendUntil:at+5000},state,at);
const live=(weight:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'rest',id:id(`live:${ORDER}:`),weight,sendUntil:at+5000,lane:'live'},state,at);
/** contention.mjs's loops: background, 20 at a time, as long as the meter lets it. */
const fill=(state:HyperliquidQuotaState,at=now)=>{for(;;){try{state=background(20,state,at).state;}catch{return state;}}};

describe('a live standby keeps one order\'s need free before the order comes', () => {
  it('background (and pages) leave it free while it is alive, so the order announced then fits at once and its evidence goes out', () => {
    let state=fill(standby(589,S([])));
    // Background stops at 1200 − 589 (the standby's marker counts too).
    expect(total(state)).toBeLessThanOrEqual(1200-589+1);
    expect(total(state)).toBeGreaterThan(1200-589-20);
    const refused=(()=>{try{background(20,state);}catch(error){return error;}})();
    expect(refused).toBeInstanceOf(HyperliquidRestCapacityError);
    expect(()=>page(20,state)).toThrow();
    // The order: its demand fits now (before: background at 840 left 360, ~27 s), and its waves and POST go out.
    const demand=announce(568,state);
    expect(demand.waitMs).toBe(0);
    state=demand.state;
    for(const wave of [404,143,20])state=live(wave,state).state;
    state=live(1,state).state;
    expect(total(state)).toBeLessThanOrEqual(1200);
  });

  it('without live copies (no standby, or once it has lapsed) background has its cap again', () => {
    expect(total(fill(S([])))).toBe(840);
    const lapsed=fill(standby(589,S([]),now-31_000));
    // Its 1-unit marker stays in the window for its minute, as any charge.
    expect(total(lapsed)).toBeGreaterThan(840-20);
  });
});
