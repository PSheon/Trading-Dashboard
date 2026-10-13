import {describe,expect,it} from 'vitest';
import {HyperliquidRestCapacityError} from '../src/hyperliquid/hyperliquid-capacity-error.js';
import {HYPERLIQUID_PAGE_FLOOR,HYPERLIQUID_PAGE_HOLD_MS,HYPERLIQUID_SETUP_PENDING_HOLD_MS,planHyperliquidQuota,setupDemandTicket,type HyperliquidQuotaEvent,type HyperliquidQuotaRequest,type HyperliquidQuotaState} from '../src/hyperliquid/hyperliquid-global-quota.js';

/**
 * The shared meter as a queue (2026-10-13 08:18 gate: a setup at `funded`
 * for 603 s, its claim never granted). A charge without a lane is
 * background; pages (`page:`) come after live and setups, before
 * background; the room that frees up is the oldest waiting setup's until
 * its need fits; live comes first. 1200 per IP, never more.
 */
const now=1790000000000,T='0123456789abcdef',U='fedcba9876543210';
const S=(events:HyperliquidQuotaEvent[]):HyperliquidQuotaState=>({egressKey:'setup-queue',revision:1,events,updatedAt:now-60_000});
const plan=(request:HyperliquidQuotaRequest,state:HyperliquidQuotaState,at=now)=>planHyperliquidQuota({now:at,state,leases:[],request});
/** A charge made `age` ms ago (its 65 s life from then). */
const rest=(id:string,units:number,age=0):HyperliquidQuotaEvent=>({id,kind:'rest',units,reservedAt:now-age,expiresAt:now-age+65_000});
const total=(state:HyperliquidQuotaState,at=now)=>state.events.filter(e=>e.kind==='rest'&&e.expiresAt>at).reduce((sum,e)=>sum+e.units,0);
const refusal=(work:()=>unknown)=>{try{work();}catch(error){return error;}return undefined;};
let n=0;const id=(prefix='')=>`${prefix}q${++n}`;
const claim=(weight:number,state:HyperliquidQuotaState,token=T,at=now)=>plan({kind:'setup_demand',id:setupDemandTicket(weight,token),weight,sendUntil:at+5000},state,at);
const own=(weight:number,state:HyperliquidQuotaState,token=T,at=now)=>plan({kind:'rest',id:id(`setup:${token}:`),weight,sendUntil:at+5000,lane:'setup'},state,at);
const unlabelled=(weight:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'rest',id:id(),weight,sendUntil:at+5000},state,at);
const background=(weight:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'rest',id:id('bg:'),weight,sendUntil:at+5000,lane:'background'},state,at);
const page=(weight:number,state:HyperliquidQuotaState,heldMs=0,at=now)=>plan({kind:'rest',id:id('page:'),weight,sendUntil:at+5000,lane:'page',...(heldMs?{heldMs}:{})},state,at);
const live=(weight:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'rest',id:id('live:'),weight,sendUntil:at+5000,lane:'live'},state,at);
/** Other work in the window as the gate had it: unlabelled reads charged over the last minute. */
const window=(units:number,per=20)=>Array.from({length:units/per},(_,i)=>rest(`other-${i}`,per,64_000-i*Math.floor(64_000/(units/per))));

describe('the shared meter arbitrates as a queue: live, then the oldest waiting setup, then pages, then background', () => {
  it('a charge without a lane is background: while a setup waits it is refused, where before it took the room', () => {
    const waiting=claim(533,S(window(600))).state;
    expect(waiting.events.some(e=>e.id.endsWith(':g'))).toBe(false);
    // Before: an unlabelled read had the whole window (1200 − what claims had been granted).
    expect(refusal(()=>unlabelled(100,waiting))).toBeInstanceOf(HyperliquidRestCapacityError);
    expect(refusal(()=>background(100,waiting))).toBeInstanceOf(HyperliquidRestCapacityError);
    // Without a waiting setup it has background's cap (840), no more.
    expect(unlabelled(400,S(window(400))).charged).toBe(400);
    expect(refusal(()=>unlabelled(60,S(window(800))))).toBeInstanceOf(HyperliquidRestCapacityError);
  });

  it('every unit that frees up is the oldest waiting setup\'s until its need fits: it is granted when the meter said, never overtaken', () => {
    // The gate: other work keeps asking; the claim's "fits after the k-th expiry" must come true.
    let state=S(window(600));
    const first=claim(533,state);state=first.state;
    const told=first.waitMs!;
    expect(told).toBeGreaterThan(0);
    // Every second until it is granted, background, a page and unlabelled
    // work ask for the room that freed up: held back. The setup claims again
    // every 10 s (it does at least every 20 s).
    let at=now,granted:ReturnType<typeof claim>|undefined;
    while(!granted){
      at+=1_000;
      if((at-now)%10_000===0){const next=claim(533,state,T,at);state=next.state;if(next.waitMs===0){granted=next;break;}}
      expect(refusal(()=>background(20,state,at))).toBeInstanceOf(HyperliquidRestCapacityError);
      expect(refusal(()=>page(20,state,0,at))).toBeInstanceOf(HyperliquidRestCapacityError);
      expect(refusal(()=>unlabelled(20,state,at))).toBeInstanceOf(HyperliquidRestCapacityError);
      expect(at-now).toBeLessThan(65_000);
    }
    // Granted at the first claim after the time it was told (its renewals' markers add a little).
    expect(at-now).toBeLessThanOrEqual(told+10_000);
    expect(granted.state.events.some(e=>e.id.startsWith('setup-demand:533:')&&e.id.endsWith(':g'))).toBe(true);
    // Its whole attempt goes out.
    let s=granted.state;for(const w of [102,42,20,102,102,42,20,102,1]){const next=own(w,s,T,at+1);expect(next.charged).toBe(w);s=next.state;}
  });

  it('live comes first: a waiting setup never holds a live charge back', () => {
    const state=claim(533,S(window(700))).state;
    expect(live(400,state).charged).toBe(400);
    expect(refusal(()=>live(400,live(400,state).state))).toBeInstanceOf(HyperliquidRestCapacityError); // 1200 holds
  });

  it('a page is held back for a waiting setup at most HYPERLIQUID_PAGE_HOLD_MS, then admitted within HYPERLIQUID_PAGE_FLOOR', () => {
    const state=claim(533,S(window(600))).state;
    const held=refusal(()=>page(120,state)) as HyperliquidRestCapacityError;
    expect(held).toBeInstanceOf(HyperliquidRestCapacityError);
    // Told to come back no later than when its hold ends.
    expect(held.retryAfterMs).toBeLessThanOrEqual(HYPERLIQUID_PAGE_HOLD_MS);
    expect(refusal(()=>page(120,state,HYPERLIQUID_PAGE_HOLD_MS-1))).toBeInstanceOf(HyperliquidRestCapacityError);
    const served=page(120,state,HYPERLIQUID_PAGE_HOLD_MS);
    expect(served.charged).toBe(120);
    // Within the floor only: a burst of held pages delays the setup by at most HYPERLIQUID_PAGE_FLOOR.
    let s=served.state;
    for(let i=0;i<10;i++){try{s=page(60,s,HYPERLIQUID_PAGE_HOLD_MS).state;}catch{break;}}
    const pages=s.events.filter(e=>e.id.startsWith('page:')).reduce((sum,e)=>sum+e.units,0);
    expect(pages).toBe(HYPERLIQUID_PAGE_FLOOR);
    // Without a waiting setup, a page has the whole window as before.
    expect(page(500,S(window(600))).charged).toBe(500);
  });

  it('a page still leaves what a live order announced and a granted claim needs', () => {
    const granted=claim(300,S(window(500)));
    expect(granted.waitMs).toBe(0);
    expect(refusal(()=>page(500,granted.state,HYPERLIQUID_PAGE_HOLD_MS))).toBeInstanceOf(HyperliquidRestCapacityError);
    expect(page(300,granted.state).charged).toBe(300);
  });

  it('two setups: the younger one is granted only beside the older one\'s need; the older one is never overtaken', () => {
    // T waits first (533); U comes later with a smaller step (81).
    let state=claim(533,S(window(600))).state;
    state=claim(81,state,U,now+1_000).state;
    expect(state.events.filter(e=>e.id.endsWith(':g'))).toHaveLength(0);
    // The room that frees up goes to T first: when T fits, T is granted; U only once both fit.
    const tFits=claim(533,state,T,now+1_001).waitMs!;
    let s=claim(533,state,T,now+tFits+2_000);
    expect(s.waitMs).toBe(0);
    // U's step: beside T's granted need, within the setups' share and the 960.
    const u=claim(81,s.state,U,now+tFits+2_001);
    expect(u.waitMs===0?total(u.state,now+tFits+2_001)+533<=1200:true).toBe(true);
    s=u;
    expect(total(s.state,now+tFits+2_001)).toBeLessThanOrEqual(1200);
  });

  it('a setup that stopped claiming loses its place after HYPERLIQUID_SETUP_PENDING_HOLD_MS', () => {
    const state=claim(533,S(window(600))).state;
    expect(refusal(()=>page(20,state,0,now+1_000))).toBeInstanceOf(HyperliquidRestCapacityError);
    expect(page(20,state,0,now+HYPERLIQUID_SETUP_PENDING_HOLD_MS+1).charged).toBe(20);
  });

  it('a page charge needs the page ticket, and no other request passes for a page', () => {
    expect(()=>plan({kind:'rest',id:'plain',weight:1,sendUntil:now+5000,lane:'page'},S([]))).toThrow('hyperliquid_quota_invalid');
    expect(()=>plan({kind:'rest',id:'page:forged',weight:1,sendUntil:now+5000},S([]))).toThrow('hyperliquid_quota_invalid');
    expect(()=>plan({kind:'rest',id:'page:x',weight:1,sendUntil:now+5000,lane:'page',heldMs:70_000},S([]))).toThrow('hyperliquid_quota_invalid');
  });
});
