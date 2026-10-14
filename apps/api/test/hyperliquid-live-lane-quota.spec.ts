import {describe,expect,it} from 'vitest';
import {HyperliquidRestCapacityError} from '../src/hyperliquid/hyperliquid-capacity-error.js';
import { HYPERLIQUID_LIVE_DEMAND_HOLD_MS } from '../src/config/constants/hyperliquid.js';
import {planHyperliquidQuota,type HyperliquidQuotaEvent,type HyperliquidQuotaRequest,type HyperliquidQuotaState} from '../src/hyperliquid/hyperliquid-global-quota.js';

/**
 * Live orders before setups and background on the shared per-IP window. A
 * cold-cache order's evidence weighs ~589 (772 with two accounts), more than
 * the 240 live reserve: beside a setup's share (720) and background at its
 * cap it was refused, and waited out a 65 s window, though it has 5 s and
 * real money. Pure planner, the same accounting the Postgres meter commits.
 */
const now=1790000000000,egressKey='live-lane';
const S=(events:readonly HyperliquidQuotaEvent[]):HyperliquidQuotaState=>({egressKey,revision:1,events:[...events],updatedAt:now});
const plan=(request:HyperliquidQuotaRequest,state:HyperliquidQuotaState,at=now)=>planHyperliquidQuota({now:at,state:{...state,updatedAt:Math.min(state.updatedAt,at)},leases:[],request});
const rest=(id:string,units:number,expiresIn=65_000,at=now):HyperliquidQuotaEvent=>({id,kind:'rest',units,reservedAt:at,expiresAt:at+expiresIn});
const total=(state:HyperliquidQuotaState,at=now)=>state.events.filter(e=>e.kind==='rest'&&e.expiresAt>at).reduce((sum,e)=>sum+e.units,0);
const refusal=(work:()=>unknown)=>{try{work();}catch(error){return error;}return undefined;};
let tickets=0;const id=(prefix='')=>`${prefix}${String(++tickets).padStart(8,'0')}-0000-4000-8000-000000000000`;
const SETUP='0123456789abcdef',ORDER='aaaaaaaaaaaaaaaa',OTHER='bbbbbbbbbbbbbbbb';
// Built here so the same file runs against the release before (no helpers there).
const setupTicket=(need:number)=>`setup-demand:${need}:${SETUP}:${id()}`;
const liveTicket=(need:number,token=ORDER)=>`live-demand:${need}:${token}:${id()}`;
const background=(weight:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'rest',id:id(),weight,sendUntil:at+5000,lane:'background'},state,at);
const setupClaim=(weight:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'setup_demand',id:setupTicket(weight),weight,sendUntil:at+5000},state,at);
const setupCharge=(weight:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'rest',id:id(`setup:${SETUP}:`),weight,sendUntil:at+5000,lane:'setup'},state,at);
/** The order's evidence wave: the live lane's ticket (an original session's
 * charge); the release before had no lane for it: an unlabelled charge. */
const liveCharge=(weight:number,state:HyperliquidQuotaState,at=now,token=ORDER)=>{
  try{return plan({kind:'rest',id:id(`live:${token}:`),weight,sendUntil:at+5000,lane:'live'} as HyperliquidQuotaRequest,state,at);}
  catch(error){if((error as {code?:string}).code!=='hyperliquid_quota_invalid')throw error;return plan({kind:'rest',id:id(),weight,sendUntil:at+5000},state,at);}
};
/** The order announces its need before its SQL locks (the release before: nothing to announce). */
const announce=(need:number,state:HyperliquidQuotaState,at=now,token=ORDER)=>{
  try{return plan({kind:'live_demand',id:liveTicket(need,token),weight:need,sendUntil:at+5000} as unknown as HyperliquidQuotaRequest,state,at);}
  catch(error){if((error as {code?:string}).code!=='hyperliquid_quota_invalid')throw error;return {state,charged:0,leases:[],waitMs:0};}
};
/** An account-mode attempt's charges (two preflights and the POST). */
const ATTEMPT=[102,42,102,102,42,102,1];
/** A cold order's evidence waves (first wave, the other coins, final check) and its POST. */
const waves=(need:number)=>[Math.round(need*0.6),Math.round(need*0.25),need-Math.round(need*0.6)-Math.round(need*0.25)-1,1];

describe('live orders come before setups and background on the shared window', () => {
  for(const need of [589,772]){
    it(`a cold order (${need}) beside a setup holding its share and background at its cap gets its whole weight within its 5 s window`, () => {
      // A setup holding its share: 100 charged by its last step and its mode
      // attempt's 613 claimed (granted), with background at the cap a
      // granted claim leaves it (240).
      let state=S([rest(`setup:${SETUP}:${id()}`,100),...Array.from({length:12},(_,i)=>rest(`bg-${i}`,20))]);
      const claimed=setupClaim(613,state);
      expect(claimed.waitMs).toBe(0);
      state=claimed.state;
      expect(refusal(()=>background(20,state))).toBeInstanceOf(HyperliquidRestCapacityError);
      // The cold order arrives as the setup's attempt starts: it announces its need.
      const announced=announce(need,state,now+100);
      expect(announced.waitMs).toBe(0);
      state=announced.state;
      // Over the next 5 s the setup's attempt (all it can, first) and background keep asking,
      // between the order's waves; every wave goes out.
      const attempt=[...ATTEMPT];let at=now+200;
      for(const wave of waves(need)){
        while(attempt.length){try{state=setupCharge(attempt[0]!,state,at).state;attempt.shift();}catch(error){expect(error).toBeInstanceOf(HyperliquidRestCapacityError);break;}}
        expect(refusal(()=>background(20,state,at))).toBeInstanceOf(HyperliquidRestCapacityError);
        const sent=liveCharge(wave,state,at);
        expect(sent.charged).toBe(wave);state=sent.state;
        at+=1_200;
      }
      expect(at-now).toBeLessThanOrEqual(5_000);
      expect(total(state,at)).toBeLessThanOrEqual(1200);
      // The setup was refused partway, not the order. Its retry is told
      // when its whole attempt fits again (its partial charges never count
      // against its own share), and is granted then: bounded, one window at most.
      expect(attempt.length).toBeGreaterThan(0);
      const retry=setupClaim(613,state,at);
      expect(retry.waitMs).toBeGreaterThan(0);
      expect(retry.waitMs).toBeLessThanOrEqual(65_000);
      const later=at+retry.waitMs!;
      expect(setupClaim(613,S(retry.state.events.filter(e=>e.expiresAt>later)),later).waitMs).toBe(0);
    });
  }

  it('a setup holding its 720 charged and background at its cap: the order is told when, and no setup or background takes the room that frees first', () => {
    // 960 already charged this minute (setup 720, background 240), expiring over the minute.
    let state=S([...Array.from({length:12},(_,i)=>rest(`setup:${SETUP}:${id()}`,60,5_000*(i+1))),...Array.from({length:12},(_,i)=>rest(`bg-${i}`,20,2_500+5_000*i))]);
    expect(total(state)).toBe(960);
    state=setupClaim(81,state).state;
    const announced=announce(589,state);
    // Not now: 961 + 589 > 1200; it fits once 351 has expired.
    expect(announced.waitMs).toBeGreaterThan(0);
    expect(announced.waitMs).toBeLessThanOrEqual(30_000);
    state=announced.state;
    // Every few seconds, while the order still waits (renewing its demand),
    // the setup and background ask: they get nothing it needs.
    let at=now;
    while(at<now+announced.waitMs!){
      at=Math.min(now+announced.waitMs!,at+2_500);
      if((at-now)%10_000===0)state=announce(589,S(state.events),at).state;
      const s=S(state.events.filter(e=>e.expiresAt>at));
      const bg=refusal(()=>background(20,s,at)),setup=refusal(()=>setupCharge(81,s,at));
      if(total(s,at)+20+589+1>1200){expect(bg).toBeInstanceOf(HyperliquidRestCapacityError);expect(setup).toBeInstanceOf(HyperliquidRestCapacityError);}
    }
    // When it was told, it fits: the order's whole weight in its 5 s.
    state=S(state.events.filter(e=>e.expiresAt>at));
    for(const wave of waves(589)){const sent=liveCharge(wave,state,at);expect(sent.charged).toBe(wave);state=sent.state;}
    expect(total(state,at)).toBeLessThanOrEqual(1200);
  });

  it('setups go on in bounded time once the order\'s demand is gone: charged in full, or its hold over', () => {
    let state=S([rest('bg',100)]);
    state=announce(700,state).state;
    // While the order still needs 700, a setup's 613 does not fit beside it.
    const waiting=setupClaim(613,state);
    expect(waiting.waitMs).toBeGreaterThan(0);
    expect(waiting.waitMs).toBeLessThanOrEqual(HYPERLIQUID_LIVE_DEMAND_HOLD_MS);
    // Its hold over (an order that never sent), the setup fits.
    expect(setupClaim(613,S(waiting.state.events),now+HYPERLIQUID_LIVE_DEMAND_HOLD_MS).waitMs).toBe(0);
    // Charged in full, the order holds nothing more.
    let sent=state;for(const wave of waves(700))sent=liveCharge(wave,sent).state;
    expect(setupClaim(81,sent).waitMs).toBe(0);
  });

  it('two orders: the second fits beside what the first still needs, or once the first is charged', () => {
    let state=S([rest('bg',100)]);
    state=announce(600,state).state;
    const second=announce(600,state,now,OTHER);
    // 102 + 600 + 600 > 1200: the second waits for the first.
    expect(second.waitMs).toBeGreaterThan(0);
    let sent=second.state;for(const wave of waves(600))sent=liveCharge(wave,sent).state;
    expect(announce(400,sent,now,OTHER).waitMs).toBe(0);
  });

  it('pages and other unlabelled work leave an announced order\'s need; background is refused first', () => {
    let state=S([rest('bg',600)]);
    state=announce(589,state).state;
    expect(refusal(()=>plan({kind:'rest',id:id(),weight:120,sendUntil:now+5000},state))).toBeInstanceOf(HyperliquidRestCapacityError);
    expect(refusal(()=>background(20,state))).toBeInstanceOf(HyperliquidRestCapacityError);
    for(const wave of waves(589)){const sent=liveCharge(wave,state);expect(sent.charged).toBe(wave);state=sent.state;}
    expect(total(state)).toBeLessThanOrEqual(1200);
  });

  it('the provider\'s 1200 holds: a live order\'s charges never go past the window; its marker (never sent) goes in on a full one', () => {
    const full=S([rest('page',1200)]);
    // Recorded, not fitting (hyperliquid-demand-marker-full-window.spec.ts: refused, it lost every freed unit to pages).
    const marked=announce(100,full);expect(marked.charged).toBe(1);expect(marked.waitMs).toBeGreaterThan(0);
    expect(refusal(()=>liveCharge(1,marked.state))).toBeInstanceOf(HyperliquidRestCapacityError);
    expect(refusal(()=>liveCharge(1,full))).toBeInstanceOf(HyperliquidRestCapacityError);
    const announced=announce(1199,S([]));
    expect(announced.charged).toBe(1);
    expect(total(liveCharge(1199,announced.state).state)).toBe(1200);
  });

  it('tickets: a live charge needs the live lane\'s ticket, a demand its need, and no other ticket passes for them', () => {
    expect(()=>plan({kind:'rest',id:'plain',weight:1,sendUntil:now+5000,lane:'live'},S([]))).toThrow('hyperliquid_quota_invalid');
    expect(()=>plan({kind:'rest',id:`live:${ORDER}:x`,weight:1,sendUntil:now+5000},S([]))).toThrow('hyperliquid_quota_invalid');
    expect(()=>plan({kind:'rest',id:liveTicket(5),weight:1,sendUntil:now+5000,lane:'background'},S([]))).toThrow('hyperliquid_quota_invalid');
    expect(()=>plan({kind:'live_demand',id:liveTicket(5),weight:6,sendUntil:now+5000},S([]))).toThrow('hyperliquid_quota_invalid');
    expect(()=>plan({kind:'live_demand',id:`live-demand:5:nothex:${id()}`,weight:5,sendUntil:now+5000},S([]))).toThrow('hyperliquid_quota_invalid');
    expect(()=>plan({kind:'live_demand',id:liveTicket(1200),weight:1200,sendUntil:now+5000},S([]))).toThrow('hyperliquid_quota_invalid');
  });

  it('a process on the release before reads the new tickets as ordinary REST charges (the stored event keeps its shape)', () => {
    let state=announce(589,S([])).state;
    state=liveCharge(300,state).state;state=setupClaim(81,state).state;
    for(const e of state.events){expect(Object.keys(e).sort()).toEqual(['expiresAt','id','kind','reservedAt','units']);expect(e.id).toMatch(/^[^\s\p{Cc}\p{Cf}]{1,128}$/u);}
    // Its unlabelled requests see them as charges: 1200 holds across versions.
    const free=1200-total(state);
    expect(refusal(()=>plan({kind:'rest',id:id(),weight:free+1,sendUntil:now+5000},state))).toBeDefined();
  });
});
