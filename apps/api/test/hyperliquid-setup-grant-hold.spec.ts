import {describe,expect,it} from 'vitest';
import {HyperliquidRestCapacityError} from '../src/hyperliquid/hyperliquid-capacity-error.js';
import { planHyperliquidQuota, setupDemandTicket, type HyperliquidQuotaEvent, type HyperliquidQuotaRequest, type HyperliquidQuotaState } from '../src/hyperliquid/hyperliquid-global-quota.js';
import { HYPERLIQUID_LIVE_WS_CONNECT_RESERVE } from '../src/config/constants/hyperliquid.js';

/**
 * A granted setup claim is a reservation, not a priority (gate 2026-10-13
 * 09:48, the 5th run): the grant holds the step's weight, and its socket
 * connects, as events of the window; every other lane and process counts
 * them like charges, and the step's own charges draw them down, so none of
 * its reads is refused partway. Pure planner, the same accounting the
 * Postgres meter commits. (On the release before, a grant was only a
 * priority: a charge of another lane that came between the claim and the
 * reads could take the room and refuse the attempt partway, and the claim
 * could not ask for socket connects.)
 */
const now=1790000000000,egressKey='grant-hold',T='0123456789abcdef',U='fedcba9876543210',ORDER='aaaaaaaaaaaaaaaa';
const S=(events:readonly HyperliquidQuotaEvent[]):HyperliquidQuotaState=>({egressKey,revision:1,events:[...events],updatedAt:now});
const plan=(request:HyperliquidQuotaRequest,state:HyperliquidQuotaState,at=now)=>planHyperliquidQuota({now:at,state:{...state,updatedAt:Math.min(state.updatedAt,at)},leases:[],request});
const rest=(id:string,units:number,expiresIn=65_000,at=now):HyperliquidQuotaEvent=>({id,kind:'rest',units,reservedAt:at,expiresAt:at+expiresIn});
const connected=(id:string,expiresIn:number):HyperliquidQuotaEvent=>({id,kind:'ws_connect',units:1,reservedAt:now+expiresIn-65_000,expiresAt:now+expiresIn});
const total=(state:HyperliquidQuotaState,kind:HyperliquidQuotaEvent['kind']='rest',at=now)=>state.events.filter(e=>e.kind===kind&&e.expiresAt>at).reduce((sum,e)=>sum+e.units,0);
const refusal=(work:()=>unknown)=>{try{work();}catch(error){return error;}return undefined;};
let tickets=0;const id=(prefix='')=>`${prefix}${String(++tickets).padStart(8,'0')}-0000-4000-8000-000000000000`;
const claim=(weight:number,state:HyperliquidQuotaState,{token=T,at=now,connects}:{token?:string;at?:number;connects?:number}={})=>
  plan({kind:'setup_demand',id:setupDemandTicket(weight,token,connects),weight,sendUntil:at+5000,...(connects?{connects}:{})} as HyperliquidQuotaRequest,state,at);
const own=(weight:number,state:HyperliquidQuotaState,token=T,at=now)=>plan({kind:'rest',id:id(`setup:${token}:`),weight,sendUntil:at+5000,lane:'setup'},state,at);
const live=(weight:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'rest',id:id('live:'),weight,sendUntil:at+5000,lane:'live'},state,at);
const background=(weight:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'rest',id:id('bg:'),weight,sendUntil:at+5000,lane:'background'},state,at);
const page=(weight:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'rest',id:id('page:'),weight,sendUntil:at+5000,lane:'page'},state,at);
const announce=(need:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'live_demand',id:`live-demand:${need}:${ORDER}:${id()}`,weight:need,sendUntil:at+5000},state,at);
const connect=(state:HyperliquidQuotaState,owner:{setupToken?:string;live?:boolean}={})=>{
  const lease=id('lease-');
  return plan({kind:'connect',id:id(),sendUntil:now+5000,lease:{id:lease,egressKey,socketId:lease,fenceToken:`fence-${lease}`,ownerId:'worker',leaseUntil:now+60_000,latestAllowedSendAt:now+5000},...owner} as HyperliquidQuotaRequest,state);
};
/** An account-mode step's charges (two preflights, the POST, the observation after it): 635. */
const STEP=[102,42,20,102,102,42,20,102,1,102];

describe('a granted setup claim holds its step\'s weight in the window', () => {
  it('the grant is held weight: unannounced live work, pages and background leave it, and the whole step goes out', () => {
    let state=S([rest('bg:a',240)]);
    const granted=claim(635,state);
    expect(granted.waitMs).toBe(0);
    state=granted.state;
    // Held: in the window's total like a charge (the marker's 1 and the 635).
    expect(total(state)).toBe(240+1+635);
    // Live work that announced nothing, a page and background between the claim and the reads: none takes the held room.
    expect(refusal(()=>live(400,state))).toBeInstanceOf(HyperliquidRestCapacityError);
    expect(refusal(()=>page(400,state))).toBeInstanceOf(HyperliquidRestCapacityError);
    expect(refusal(()=>background(20,state))).toBeInstanceOf(HyperliquidRestCapacityError);
    // What is left beside the hold is still theirs.
    state=live(324,state).state;
    expect(total(state)).toBe(1200);
    // Every read of the step goes out against its hold, the window full or not; the total never moves past 1200.
    for(const weight of STEP){const next=own(weight,state);expect(next.charged).toBe(weight);state=next.state;expect(total(state)).toBe(1200);}
    // Drawn to nothing: no hold left, only real charges.
    expect(state.events.some(e=>e.id.startsWith('setup-hold:'))).toBe(false);
  });

  it('a step that ends gives back what its grant still holds; a hold ends by itself once its time is over', () => {
    let state=claim(635,S([rest('bg:a',240)])).state;
    state=own(102,state).state;
    expect(refusal(()=>page(700,state))).toBeInstanceOf(HyperliquidRestCapacityError);
    const released=plan({kind:'setup_release',token:T},state);
    expect(released.charged).toBe(0);
    expect(total(released.state)).toBe(240+1+102);
    expect(page(700,released.state).charged).toBe(700);
    // Never released (a process that died): its hold ends with HYPERLIQUID_SETUP_GRANT_HOLD_MS.
    const held=claim(635,S([rest('bg:a',240)])).state;
    expect(refusal(()=>page(700,held))).toBeInstanceOf(HyperliquidRestCapacityError);
    expect(page(700,held,now+46_000).charged).toBe(700);
    // Another setup's release takes nothing of this one's.
    expect(total(plan({kind:'setup_release',token:U},held).state)).toBe(total(held));
  });

  it('a claim again continues the setup\'s grant: its unused hold is not asked for twice, another setup\'s is', () => {
    // A partial attempt: 410 drawn, 225 still held. The window: 240 + 1 + 410 + 225.
    let state=claim(635,S([rest('bg:a',240)])).state;
    for(const weight of [102,42,20,102,102,42])state=own(weight,state).state;
    expect(total(state)).toBe(240+1+635);
    // Its own next claim replaces its hold: 240 + 2 + 410 + 635 = 1287 > 960, it waits for its own 410 to expire (they were sent: the 1200 counts them).
    const again=claim(635,state);
    expect(again.waitMs).toBeGreaterThan(0);
    // Without its hold counted twice: it fits as soon as 960 does, ignoring its old hold.
    const later=now+65_000;
    const expired=S(state.events.filter(e=>e.id.startsWith('setup-hold:')||e.expiresAt>later).map(e=>e.id.startsWith('setup-hold:')?{...e,reservedAt:later,expiresAt:later+30_000}:e));
    expect(claim(635,expired,{at:later}).waitMs).toBe(0);
    // Another setup's hold counts in full.
    expect(claim(635,expired,{token:U,at:later}).waitMs).toBeGreaterThan(0);
  });

  it('a live order that announces its need takes the room of a grant whose step sent nothing yet, then of one under way', () => {
    const base=S([rest('bg:a',240)]);
    // Nothing drawn: the grant gives way; the setup's reads are then refused (before anything went out) until it claims again.
    let state=claim(635,base).state;
    const announced=announce(700,state);
    expect(announced.waitMs).toBe(0);
    state=announced.state;
    expect(state.events.some(e=>e.id.startsWith('setup-hold:'))).toBe(false);
    expect(refusal(()=>own(102,state))).toBeInstanceOf(HyperliquidRestCapacityError);
    // Under way and the order still does not fit: real money first, the step is refused partway.
    let started=claim(635,base).state;started=own(102,started).state;
    const second=announce(700,started);
    expect(second.waitMs).toBe(0);
    expect(second.state.events.some(e=>e.id.startsWith('setup-hold:'))).toBe(false);
    expect(refusal(()=>own(42,second.state))).toBeInstanceOf(HyperliquidRestCapacityError);
    // Its next claim is an ordinary claim again (after the order).
    expect(claim(635,second.state).waitMs).toBeGreaterThan(0);
    // An order that fits beside the grant leaves it.
    const small=announce(200,claim(635,base).state);
    expect(small.waitMs).toBe(0);
    expect(small.state.events.some(e=>e.id.startsWith('setup-hold:'))).toBe(true);
  });

  it('the step\'s socket connects: claimed with it, held once granted, and its sockets draw them while others fill the connect window', () => {
    // contention.mjs's two socket loops: 18 of the 20 connects a minute that
    // non-live sockets may take (live keeps HYPERLIQUID_LIVE_WS_CONNECT_RESERVE), expiring one every ~2 s.
    let state=S([rest('bg:a',240),...Array.from({length:18},(_,i)=>connected(`ws-${i}`,2_000*(i+1)))]);
    // 2 free: granted, and they are held.
    const granted=claim(635,state,{connects:2});
    expect(granted.waitMs).toBe(0);
    state=granted.state;
    expect(total(state,'ws_connect')).toBe(30-HYPERLIQUID_LIVE_WS_CONNECT_RESERVE);
    // Another socket is refused; the step's two are not.
    expect(refusal(()=>connect(state))).toBeDefined();
    state=connect(state,{setupToken:T}).state;state=connect(state,{setupToken:T}).state;
    expect(total(state,'ws_connect')).toBe(30-HYPERLIQUID_LIVE_WS_CONNECT_RESERVE);
    expect(refusal(()=>connect(state,{setupToken:T}))).toBeDefined();
    // A live socket still has its reserve.
    expect(connect(state,{live:true}).charged).toBe(1);
  });

  it('a waiting setup\'s connects: other sockets leave them free (live ones excepted), and the claim is told when they fit', () => {
    let state=S([rest('bg:a',240),...Array.from({length:19},(_,i)=>connected(`ws-${i}`,2_000*(i+1)))]);
    const waiting=claim(635,state,{connects:2});
    // One connect is free, two are needed: in ~2 s.
    expect(waiting.waitMs).toBeGreaterThan(0);
    expect(waiting.waitMs).toBeLessThanOrEqual(2_000);
    state=waiting.state;
    // The free connect is the waiting setup's: a background socket is refused, a live one is not.
    expect(refusal(()=>connect(state))).toBeDefined();
    expect(connect(state,{live:true}).charged).toBe(1);
    // A claim that asks for connects carries them in its ticket, and a ticket that says otherwise is refused.
    expect(()=>plan({kind:'setup_demand',id:setupDemandTicket(635,T,3),weight:635,sendUntil:now+5000,connects:2} as HyperliquidQuotaRequest,state)).toThrow('hyperliquid_quota_invalid');
    expect(()=>plan({kind:'setup_demand',id:setupDemandTicket(635,T),weight:635,sendUntil:now+5000,connects:2} as HyperliquidQuotaRequest,state)).toThrow('hyperliquid_quota_invalid');
  });

  it('a claim made while the step still waits for its local bucket only takes its place in the queue: never granted, nothing held', () => {
    const state=S([rest('bg:a',240)]);
    const queued=plan({kind:'setup_demand',id:setupDemandTicket(635,T,2),weight:635,sendUntil:now+5000,connects:2,queue:true} as HyperliquidQuotaRequest,state);
    expect(queued.waitMs).toBe(0);
    expect(queued.charged).toBe(1);
    expect(queued.state.events.some(e=>e.id.endsWith(':g')||e.id.startsWith('setup-hold:'))).toBe(false);
    // Background already leaves its need (it is the queue's head).
    expect(refusal(()=>background(500,queued.state))).toBeInstanceOf(HyperliquidRestCapacityError);
  });

  it('a process on the release before reads held weight as ordinary charges: 1200 holds across versions', () => {
    const state=claim(635,S([rest('bg:a',240)]),{connects:2}).state;
    for(const e of state.events){expect(Object.keys(e).sort()).toEqual(['expiresAt','id','kind','reservedAt','units']);expect(e.id).toMatch(/^[^\s\p{Cc}\p{Cf}]{1,128}$/u);}
    expect(refusal(()=>plan({kind:'rest',id:id(),weight:1200-total(state)+1,sendUntil:now+5000},state))).toBeDefined();
  });

  it('live sockets keep a reserve of the connect window: other sockets are refused below it and told when one fits; a live order\'s observation is not (gate 2026-10-13 11:15)', () => {
    // contention.mjs's socket loops keep taking a connect every ~2 s, as many as the window lets them.
    let state=S([rest('bg:a',240)]),granted=0;
    for(let i=0;i<30;i++){try{state=connect(state).state;granted++;}catch{break;}}
    // Before: all 30; the order's six account sockets were then refused (live_account_observation_unavailable).
    expect(granted).toBe(30-HYPERLIQUID_LIVE_WS_CONNECT_RESERVE);
    const refused=refusal(()=>connect(state));
    expect(refused).toBeInstanceOf(HyperliquidRestCapacityError);
    expect((refused as HyperliquidRestCapacityError).retryAfterMs).toBeGreaterThan(0);
    expect((refused as HyperliquidRestCapacityError).retryAfterMs).toBeLessThanOrEqual(65_000);
    // A live order's follower and leader observations: six connects, and a stop's beside them.
    for(let i=0;i<HYPERLIQUID_LIVE_WS_CONNECT_RESERVE;i++)state=connect(state,{live:true}).state;
    expect(total(state,'ws_connect')).toBe(30);
    // 30 a minute still holds for everyone.
    expect(refusal(()=>connect(state,{live:true}))).toBeDefined();
    // A setup's claim for its step's connects is below the reserve too.
    expect(claim(635,S([rest('bg:a',240),...Array.from({length:19},(_,i)=>connected(`ws-${i}`,2_000*(i+1)))]),{connects:2}).waitMs).toBeGreaterThan(0);
  });
});
