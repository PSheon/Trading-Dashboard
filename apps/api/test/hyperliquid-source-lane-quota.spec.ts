import {describe,expect,it} from 'vitest';
import {HyperliquidRestCapacityError} from '../src/hyperliquid/hyperliquid-capacity-error.js';
import {HYPERLIQUID_BACKGROUND_REST_CAP,HYPERLIQUID_REST_CAP,HYPERLIQUID_SOURCE_REST_CAP,HYPERLIQUID_SOURCE_REST_RESERVE} from '../src/config/constants/hyperliquid.js';
import {FAST_SOURCE_LEADER_WEIGHT,FAST_SOURCE_READ_WEIGHT} from '../src/config/constants/weights.js';
import {hyperliquidLaneStatus,hyperliquidMeterComposition,planHyperliquidQuota,type HyperliquidQuotaEvent,type HyperliquidQuotaRequest,type HyperliquidQuotaState} from '../src/hyperliquid/hyperliquid-global-quota.js';

/**
 * The fast leader source's reads have a lane of their own (`source:`), which
 * yields to live demand and the standby as a page does and is never starved
 * by background while a worker keeps a source standby alive. Until
 * 2026-10-17 they were the live lane's, with an order's standing: on Stage
 * one active leader held 341 p50 / 580 p95 / 662 max units of the window
 * with no order in flight, and two leaders broke the two-coin requirement
 * (orders and settlements need ≈575 units free). Pure planner, the same
 * accounting the Postgres meter commits; tickets are built here so the
 * file runs against the release before (which refuses the lane:
 * `hyperliquid_quota_invalid`).
 */
const now=1790000000000,egressKey='source-lane',ORDER='aaaaaaaaaaaaaaaa',LEADER='0badf00d',OTHER='c0ffee00';
const S=(events:readonly HyperliquidQuotaEvent[]):HyperliquidQuotaState=>({egressKey,revision:1,events:[...events],updatedAt:now});
const plan=(request:HyperliquidQuotaRequest,state:HyperliquidQuotaState,at=now)=>planHyperliquidQuota({now:at,state:{...state,updatedAt:Math.min(state.updatedAt,at)},leases:[],request});
const total=(state:HyperliquidQuotaState,at=now)=>state.events.filter(e=>e.kind==='rest'&&e.expiresAt>at).reduce((sum,e)=>sum+e.units,0);
const refusal=(work:()=>unknown)=>{try{work();}catch(error){return error;}return undefined;};
let tickets=0;const id=(prefix='')=>`${prefix}${String(++tickets).padStart(8,'0')}-0000-4000-8000-000000000000`;
/** A kick's read: 30 prepaid (settled to 21 later), the source lane under the leader's hash. */
const source=(weight:number,state:HyperliquidQuotaState,at=now,leader=LEADER)=>plan({kind:'rest',id:id(`source:${leader}:`),weight,sendUntil:at+5000,lane:'source'} as HyperliquidQuotaRequest,state,at);
const background=(weight:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'rest',id:id('bg:'),weight,sendUntil:at+5000,lane:'background'},state,at);
const page=(weight:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'rest',id:id('page:'),weight,sendUntil:at+5000,lane:'page'},state,at);
const announce=(need:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'live_demand',id:`live-demand:${need}:${ORDER}:${id()}`,weight:need,sendUntil:at+5000},state,at);
const live=(weight:number,state:HyperliquidQuotaState,at=now,owner='order')=>plan({kind:'rest',id:id(`live:${ORDER}:${owner}:`),weight,sendUntil:at+5000,lane:'live'},state,at);
const standby=(need:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'live_standby',id:id(`live-standby:${need}:`),weight:need,sendUntil:at+5000} as HyperliquidQuotaRequest,state,at).state;
const sourceStandby=(need:number,state:HyperliquidQuotaState,at=now)=>plan({kind:'source_standby',id:id(`source-standby:${need}:`),weight:need,sendUntil:at+5000} as unknown as HyperliquidQuotaRequest,state,at).state;
/** Background loops: 20 at a time, as long as the meter lets them. */
const fill=(state:HyperliquidQuotaState,at=now)=>{for(;;){try{state=background(20,state,at).state;}catch{return state;}}};
/** Kicks of one leader: 30 at a time, as long as the meter lets them. */
const kicks=(state:HyperliquidQuotaState,at=now,leader=LEADER)=>{let n=0;for(;;){try{state=source(30,state,at,leader).state;n++;}catch{return {state,n};}}};

describe('the fast leader source has a lane of its own on the shared window', () => {
  it('its charges are source tickets (the leader\'s hash, never its address), outside `live:`; a live ticket in the lane is refused', () => {
    const charged=source(30,S([]));
    expect(charged.charged).toBe(30);
    const [event]=charged.state.events;
    expect(event!.id).toMatch(/^source:[0-9a-f]{8}:/);
    expect(event!.id.startsWith('live:')).toBe(false);
    for(const bad of [id('live:'),id(`live:${ORDER}:`),id(),id('source:'),id(`source:${'0x'+'44'.repeat(20)}:`)])
      expect((refusal(()=>plan({kind:'rest',id:bad,weight:30,sendUntil:now+5000,lane:'source'} as HyperliquidQuotaRequest,S([]))) as {code?:string})?.code).toBe('hyperliquid_quota_invalid');
    // A source ticket is no live ticket: the live lane refuses it, and a charge without a lane (background) too.
    expect((refusal(()=>plan({kind:'rest',id:id(`source:${LEADER}:`),weight:30,sendUntil:now+5000,lane:'live'},S([]))) as {code?:string})?.code).toBe('hyperliquid_quota_invalid');
    expect((refusal(()=>plan({kind:'rest',id:id(`source:${LEADER}:`),weight:30,sendUntil:now+5000},S([]))) as {code?:string})?.code).toBe('hyperliquid_quota_invalid');
  });

  it('yields to a live order\'s demand: refused with the claim\'s wait while the order\'s own charges are served', () => {
    // The window: background 580 and a page's 20, so the order's 589 fits (600 + 589 ≤ 1200) and a kick's 30 beside it would not.
    let state=S(Array.from({length:29},(_,i)=>({id:`bg-${i}`,kind:'rest' as const,units:20,reservedAt:now-30_000,expiresAt:now+35_000})));
    state=page(20,state).state;
    const announced=announce(589,state);
    state=announced.state;
    expect(announced.waitMs).toBe(0);
    // A kick's read would take the order's room: it waits until the claim ends (as a page does), not refused for good.
    const refused=refusal(()=>source(30,state));
    expect(refused).toBeInstanceOf(HyperliquidRestCapacityError);
    expect((refused as HyperliquidRestCapacityError).retryAfterMs).toBeGreaterThan(0);
    expect((refused as HyperliquidRestCapacityError).retryAfterMs).toBeLessThanOrEqual(65_000);
    // The order's evidence waves and POST go out meanwhile.
    for(const wave of [404,143,41,1])state=live(wave,state).state;
    expect(total(state)).toBeLessThanOrEqual(HYPERLIQUID_REST_CAP+1);
    // The order's charges counted against its claim: nothing left outstanding, the source read fits once something expires.
    expect(hyperliquidMeterComposition(state.events,now).liveNeed).toBe(0);
  });

  it('yields to a worker\'s live standby (one order\'s need kept free) like a page, so it never takes the order\'s room', () => {
    let state=standby(385,S([]));
    state=fill(state);
    expect(total(state)).toBeLessThanOrEqual(HYPERLIQUID_REST_CAP-385+1);
    expect(refusal(()=>source(30,state))).toBeInstanceOf(HyperliquidRestCapacityError);
    expect(refusal(()=>page(30,state))).toBeInstanceOf(HyperliquidRestCapacityError);
    // Once background's charges expire the kick's read is served beside the standby.
    const later=now+66_000;
    state=standby(385,state,later);
    expect(source(30,state,later).charged).toBe(30);
  });

  it('without live demand it is served beside background at its cap, up to the lane\'s own cap', () => {
    let state=fill(S([]));
    expect(total(state)).toBe(HYPERLIQUID_BACKGROUND_REST_CAP);
    // One leader's kicks (30 each) fill the rest of the window, as a page would; the lane's cap is 720.
    const {state:read,n}=kicks(state);state=read;
    expect(n).toBe(Math.floor((HYPERLIQUID_REST_CAP-HYPERLIQUID_BACKGROUND_REST_CAP)/30));
    expect(total(state)).toBe(HYPERLIQUID_REST_CAP);
    // On an empty window the lane alone stops at its cap: live orders and pages keep theirs whatever the leaders do.
    const alone=kicks(S([]));
    expect(alone.n).toBe(HYPERLIQUID_SOURCE_REST_CAP/30);
    expect(total(alone.state)).toBe(HYPERLIQUID_SOURCE_REST_CAP);
    expect(HYPERLIQUID_SOURCE_REST_CAP).toBe(720);
    // A second leader's reads past the cap wait for the first's to expire (never refused for good).
    const second=refusal(()=>source(30,alone.state,now,OTHER));
    expect(second).toBeInstanceOf(HyperliquidRestCapacityError);
    expect((second as HyperliquidRestCapacityError).retryAfterMs).toBe(65_000);
    // Live orders and pages still fit beside a lane at its cap.
    expect(live(240,alone.state).charged).toBe(240);
    expect(page(240,alone.state).charged).toBe(240);
  });

  it('a worker\'s source standby keeps the lane\'s reserve free of background, less what the lane holds, so a kick after a quiet minute finds room at once', () => {
    expect(HYPERLIQUID_SOURCE_REST_RESERVE).toBe(Math.ceil(FAST_SOURCE_LEADER_WEIGHT/2));
    // A worker with live copies (standby 385, a cold account) and a fast source (its reserve).
    const need=385;
    let state=fill(sourceStandby(HYPERLIQUID_SOURCE_REST_RESERVE,standby(need,S([]))));
    // Background stops at 1200 − 385 − 315 (the two markers count too); without the fast source it stopped at 1200 − 385.
    expect(total(state)).toBeLessThanOrEqual(HYPERLIQUID_REST_CAP-need-HYPERLIQUID_SOURCE_REST_RESERVE+2);
    expect(total(state)).toBeGreaterThan(HYPERLIQUID_REST_CAP-need-HYPERLIQUID_SOURCE_REST_RESERVE-20);
    expect(refusal(()=>background(20,state))).toBeInstanceOf(HyperliquidRestCapacityError);
    // The kicks are served into the reserve, and no further than the order's need allows.
    const {state:read,n}=kicks(state);state=read;
    expect(n).toBeGreaterThanOrEqual(Math.floor(HYPERLIQUID_SOURCE_REST_RESERVE/30));
    expect(total(state)).toBeGreaterThan(HYPERLIQUID_REST_CAP-need-30);
    expect(total(state)).toBeLessThanOrEqual(HYPERLIQUID_REST_CAP-need+2);
    // Once the lane holds its reserve, background has the room above it back: nothing is held for the lane twice.
    const later=now+66_000;
    let fresh=sourceStandby(HYPERLIQUID_SOURCE_REST_RESERVE,standby(need,S([]),later),later);
    for(let k=0;k<11;k++)fresh=source(30,fresh,later).state; // 330 ≥ 315 held
    fresh=fill(fresh,later);
    expect(total(fresh,later)).toBeLessThanOrEqual(HYPERLIQUID_REST_CAP-need+2);
    expect(total(fresh,later)).toBeGreaterThan(HYPERLIQUID_REST_CAP-need-20);
    // Without a fast source (no source standby) background has its cap as before (the live standby spec).
    expect(total(fill(S([])))).toBe(HYPERLIQUID_BACKGROUND_REST_CAP);
    expect(total(fill(standby(need,S([]))))).toBeGreaterThan(HYPERLIQUID_REST_CAP-need-20);
    // The standby's need is bounded by the lane's cap.
    expect((refusal(()=>sourceStandby(HYPERLIQUID_SOURCE_REST_CAP+1,S([]))) as {code?:string})?.code).toBe('hyperliquid_quota_invalid');
  });

  it('the live standby and the source standby together: background leaves both, the order and the kicks each find theirs', () => {
    let state=fill(sourceStandby(HYPERLIQUID_SOURCE_REST_RESERVE,standby(385,S([]))));
    expect(total(state)).toBeLessThanOrEqual(HYPERLIQUID_REST_CAP-385-HYPERLIQUID_SOURCE_REST_RESERVE+2);
    // The kicks are served into the lane's reserve and no further: the order's 385 stay free.
    const {state:read}=kicks(state);state=read;
    expect(total(state)).toBeLessThanOrEqual(HYPERLIQUID_REST_CAP-385+2);
    const demand=announce(385,state);
    expect(demand.waitMs).toBe(0);
    state=demand.state;
    for(const wave of [300,84,1])state=live(wave,state).state;
    expect(total(state)).toBeLessThanOrEqual(HYPERLIQUID_REST_CAP+2);
  });

  it('while a setup waits, the lane leaves the oldest one\'s need free below the live reserve (as background does): the next read waits, the setup is granted as the lane\'s charges expire', () => {
    const SETUP='0123456789abcdef',claim=(s:HyperliquidQuotaState,at:number)=>plan({kind:'setup_demand',id:`setup-demand:300:${SETUP}:${id()}`,weight:300,sendUntil:at+5000},s,at);
    // One busy leader's lane at 690 (expiring in 10 s) and pages at their floor: 930 of the window.
    let state=S([...Array.from({length:23},(_,i)=>({id:`source:${LEADER}:${i}`,kind:'rest' as const,units:30,reservedAt:now-55_000,expiresAt:now+10_000})),
      ...Array.from({length:12},(_,i)=>({id:`page:${i}`,kind:'rest' as const,units:20,reservedAt:now-5_000,expiresAt:now+60_000}))]);
    // A setup's mode-step claim of 300 does not fit under the setups' ceiling (960): it waits, the oldest in the queue.
    const claimed=claim(state,now);
    expect(claimed.waitMs).toBeGreaterThan(0);
    state=claimed.state;
    expect(hyperliquidMeterComposition(state.events,now).pending).toEqual([{token:SETUP.slice(0,8),need:300,waitingMs:0}]);
    // The lane is under its cap and the window has room, but the setup's 300 below the live reserve are left free: the kick's read waits (on 56208d9e it was served).
    const refused=refusal(()=>source(30,state,now+1));
    expect(refused).toBeInstanceOf(HyperliquidRestCapacityError);
    expect((refused as HyperliquidRestCapacityError).retryAfterMs).toBeGreaterThan(0);
    // The lane's charges expire: the setup claims again and is granted at once; the lane then reads beside its hold.
    const later=now+10_001,granted=claim(state,later);
    expect(granted.waitMs).toBe(0);
    state=granted.state;
    expect(hyperliquidMeterComposition(state.events,later).granted).toEqual([{token:SETUP.slice(0,8),left:300}]);
    expect(source(30,state,later).charged).toBe(30);
  });

  it('the composition and the lane status tell kicks, orders, settlement passes and explorer reads apart by ticket, never by address', () => {
    const T='0123456789abcdef';
    const events:HyperliquidQuotaEvent[]=[
      {id:id(`source:${LEADER}:`),kind:'rest',units:21,reservedAt:now,expiresAt:now+65_000},{id:id(`source:${LEADER}:`),kind:'rest',units:30,reservedAt:now,expiresAt:now+65_000},
      {id:id(`source:${OTHER}:`),kind:'rest',units:21,reservedAt:now,expiresAt:now+65_000},
      {id:id(`live:${ORDER}:order:`),kind:'rest',units:404,reservedAt:now,expiresAt:now+65_000},{id:id(`live:${T}:settle:`),kind:'rest',units:62,reservedAt:now,expiresAt:now+65_000},
      {id:id('live:explorer:'),kind:'rest',units:40,reservedAt:now,expiresAt:now+65_000},{id:id('live:'),kind:'rest',units:2,reservedAt:now,expiresAt:now+65_000},
      {id:id(`source-standby:${HYPERLIQUID_SOURCE_REST_RESERVE}:`),kind:'rest',units:1,reservedAt:now,expiresAt:now+65_000},
      {id:id('bg:'),kind:'rest',units:100,reservedAt:now,expiresAt:now+65_000},
    ];
    const c=hyperliquidMeterComposition(events,now);
    expect(c).toMatchObject({total:681,background:100,live:508,source:72,other:0,sources:{[LEADER]:51,[OTHER]:21},liveKinds:{order:404,settle:62,explorer:40,untagged:2},markers:{setup:0,live:0,source:1}});
    expect(JSON.stringify(c)).not.toContain('0x');
    const lanes=hyperliquidLaneStatus(events,now);
    expect(lanes.sourceLane).toEqual({count:3,held:72,until:now+65_000});
    expect(lanes.liveDemand.held).toBe(508);
  });

  it('an order\'s owned charge (`live:<token>:order:`) still counts against its claim, so a process on the previous release reads it as before', () => {
    let state=announce(100,S([])).state;
    expect(hyperliquidMeterComposition(state.events,now).liveNeed).toBe(100);
    state=live(60,state).state;
    expect(hyperliquidMeterComposition(state.events,now).liveNeed).toBe(40);
    // The release before counted a `source:` ticket as an unlabelled charge: in the window, nothing kept for it. Its id is a plain identifier.
    const stored=source(30,S([])).state.events[0]!;
    expect(stored.id.length).toBeLessThanOrEqual(128);
    expect(plan({kind:'rest',id:id(),weight:20,sendUntil:now+5000},S([stored])).charged).toBe(20);
  });

  it('the per-leader fixed cost: one read per G, each holding 21 for its minute', () => {
    expect(FAST_SOURCE_READ_WEIGHT).toBe(21);
    expect(FAST_SOURCE_LEADER_WEIGHT).toBe(30*21);
  });
});
