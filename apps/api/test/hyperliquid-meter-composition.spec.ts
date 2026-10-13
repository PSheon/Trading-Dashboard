import {describe,expect,it} from 'vitest';
import {hyperliquidMeterComposition,liveDemandTicket,planHyperliquidQuota,setupDemandTicket,type HyperliquidQuotaEvent,type HyperliquidQuotaRequest,type HyperliquidQuotaState} from '../src/hyperliquid/hyperliquid-global-quota.js';

/**
 * The shared meter's composition at a setup's claim (diagnostics): the gate
 * of 2026-10-13 08:18 logged only `shared_capacity` waits, never who held
 * the window. Each class by ticket: `bg:` background, unprefixed other
 * (unlabelled), `live:`, each setup's charges by token, markers, pending and
 * granted claims.
 */
const now=1790000000000,T='0123456789abcdef',U='fedcba9876543210',L='aaaaaaaaaaaaaaaa';
const rest=(id:string,units:number,age=0,life=65_000):HyperliquidQuotaEvent=>({id,kind:'rest',units,reservedAt:now-age,expiresAt:now-age+life});
const S=(events:HyperliquidQuotaEvent[]):HyperliquidQuotaState=>({egressKey:'composition',revision:1,events,updatedAt:now-30_000});

describe('the shared meter\'s composition at a setup\'s claim', () => {
  it('classifies every alive REST charge by its ticket', () => {
    const events=[rest('bg:1',300),rest('plain',120),rest('live:x',40),rest(`live:${L}:y`,60),rest(`setup:${T}:a`,102),rest(`setup:${U}:b`,42),
      rest(setupDemandTicket(613,T),1,20_000),rest(setupDemandTicket(613,T),1,5_000),rest(`${setupDemandTicket(81,U)}:g`,1),rest(liveDemandTicket(589,L),1),
      rest('expired',500,70_000),{id:'ws',kind:'ws_message' as const,units:5,reservedAt:now,expiresAt:now+65_000}];
    const c=hyperliquidMeterComposition(events,now);
    expect(c).toMatchObject({total:300+120+40+60+102+42+4,background:300,other:120,live:100,setup:{[T.slice(0,8)]:102,[U.slice(0,8)]:42},markers:{setup:3,live:1}});
    // T waits since its earliest alive marker; U's claim is granted and still needs 81 − 42.
    expect(c.pending).toEqual([{token:T.slice(0,8),need:613,waitingMs:20_000}]);
    expect(c.granted).toEqual([{token:U.slice(0,8),left:39}]);
    expect(c.liveNeed).toBe(589-60);
  });
  it('a setup\'s claim answers with the composition that decided it, its own marker included', () => {
    const plan=planHyperliquidQuota({now,state:S([rest('bg:1',840)]),leases:[],request:{kind:'setup_demand',id:setupDemandTicket(613,T),weight:613,sendUntil:now+5000} as HyperliquidQuotaRequest});
    expect(plan.waitMs).toBeGreaterThan(0);
    expect(plan.composition).toMatchObject({total:841,background:840,markers:{setup:1},pending:[{token:T.slice(0,8),need:613,waitingMs:0}]});
    // Other requests carry none (it is computed for the claims only).
    expect(planHyperliquidQuota({now,state:S([]),leases:[],request:{kind:'rest',id:'r',weight:1,sendUntil:now+5000}}).composition).toBeUndefined();
  });
});
