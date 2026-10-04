import { Pool } from 'pg';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { copyLiveExecutions, copyLiveRiskReservations, copyLiveExecutionEvidence, copyLiveReductionCarry, copyLiveSignalLegs, copyLiveIntentProvenance, copyLiveMandates,
  copyLiveSourceFills, copyLiveSourceStreams, copyStrategyVersions, copyFollowerScans, copyFollowerReceipts, copyFollowerLedger, copyStrategies, users, copyWalletAuthorizations, copyAgentSetups } from '@trading-dashboard/shared/database';
import { PostgresLivePreparation } from '../src/copy/live/postgres-live-preparation.js';
import { PostgresLiveSettlement } from '../src/copy/live/postgres-live-settlement.js';
import { NEVER_PLACED, NEVER_PLACED_GRACE_MS, LIVE_CLOCK_SKEW_ALLOWANCE_MS, LIVE_HTTP_TIMEOUT_MS } from '../src/copy/live/live-execution.js';
import { PostgresLiveRiskScope, type LiveRiskDatabaseSession } from '../src/copy/live/postgres-live-risk-scope.js';
import { HyperliquidLiveAccountObserver } from '../src/copy/live/live-account-observer.js';
import { HyperliquidLiveMarketResolver } from '../src/copy/live/live-market-resolver.js';
import { HyperliquidLiveRiskProvider } from '../src/copy/live/live-risk-provider.js';
import { parseLiveSourceFill } from '../src/copy/live/copy-live-source-evidence.js';
import { parseLiveOrderEvidence, parseLiveIocAcknowledgement, captureLiveOrderIdentity } from '../src/copy/live/live-order-evidence.js';
import { planLiveReservation } from '../src/copy/live/live-risk-reservation.js';
import { projectLiveGenerationPositions } from '../src/copy/live/copy-live-generation-projection.js';
import { loadLiveGenerationManifest } from '../src/copy/live/postgres-live-generation-manifest.js';
import { loadLivePreparationAuthority } from '../src/copy/live/postgres-live-risk-authority.js';
import { CopyFollowerLedger } from '../src/copy/live/copy-follower-ledger.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { Dec } from '../src/common/decimal/dec.js';
import { digest } from '../src/copy/copy-live-mandate-evidence.js';
import { liveCopySettingsDigest } from '../src/copy/copy-live-mandate-consent.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
let db: TestDb, pool: Pool, clock:number, scope:PostgresLiveRiskScope, seed:Awaited<ReturnType<typeof preparationFixture>>,
  prep:PostgresLivePreparation, settlement:PostgresLiveSettlement, observer:HyperliquidLiveAccountObserver, resolver:HyperliquidLiveMarketResolver, provider:HyperliquidLiveRiskProvider;
type Prepared=Awaited<ReturnType<PostgresLivePreparation['prepare']>>;
beforeAll(()=>{db=getTestDb();pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});});
beforeEach(async()=>{
  seed=await preparationFixture(db);clock=now;scope=new PostgresLiveRiskScope(pool,()=>clock);settlement=new PostgresLiveSettlement(()=>clock);
  // The signed budget includes the admitted buy limit, preserving the fixture's
  // genuine 0.9-lot execution without exceeding it at 50bps slippage.
  const [version]=await db.select().from(copyStrategyVersions);const settings={...version!.settings,perTradeUsd:90.5};
  await db.update(copyStrategyVersions).set({settings});const intent={...seed.consent,settingsDigest:liveCopySettingsDigest(settings)};seed.consent=intent;
  await db.update(copyLiveMandates).set({settingsDigest:intent.settingsDigest,intent,intentDigest:digest(intent)});
  const acquire=async()=>{},fetcher=vi.fn<typeof fetch>(async()=>{throw Error('No financial/provider fixture requests');});
  observer=new HyperliquidLiveAccountObserver('testnet',acquire,fetcher,()=>clock);resolver=new HyperliquidLiveMarketResolver('testnet',acquire,fetcher,()=>clock);provider=new HyperliquidLiveRiskProvider('testnet',acquire,fetcher,()=>clock);
  vi.spyOn(observer,'observe').mockImplementation(async()=>snapshot('0'));
  vi.spyOn(resolver,'resolve').mockImplementation(async()=>({...seed.f.market,observedAt:clock}));
  vi.spyOn(provider,'observe').mockImplementation(async()=>({network:'testnet',accountAddress:seed.f.identity.accountAddress,coin:'BTC',dex:'',asset:0,
    market:{...seed.f.market,observedAt:clock},earliestObservedAt:clock,completedAt:clock,sourceDigest:'a'.repeat(64),quote:{...seed.f.quote,market:{...seed.f.market,observedAt:clock},observedAt:clock},
    leverageProofs:seed.f.leverageProofs.map(l=>({...l,observedAt:clock})),fees:{...seed.f.fees,observedAt:clock}} as never));
  prep=new PostgresLivePreparation(observer,resolver,provider,{slippageBps:'50',extraRiskBufferBps:'0',restingOrderBuilderFeeCapTenthsBps:100},()=>clock);
});
afterAll(async()=>{await pool.end();await closeTestDb();});
const identity=()=>({userId:1,network:'testnet' as const,accountAddress:seed.f.identity.accountAddress,source:{network:'testnet' as const,leaderAddress:seed.consent.leaderAddress}});
function snapshot(size:string,at=clock){
  const s=structuredClone(seed.f.accountSource.snapshot),p=Dec.from(size),notional=p.abs().mul(100).toString(),margin=p.abs().mul(10).toString();
  Object.assign(s,{observedAt:at,completedAt:at,totalMarginUsed:margin,exposureUsd:notional});Object.assign(s.coverage,{earliestProviderTime:at});Object.assign(s.dexes[0]!,{providerTime:at,marginUsed:margin,exposureUsd:notional,crossMarginUsed:margin,crossExposureUsd:notional});
  if(!p.isZero)(s.positions as unknown[]).push({coin:'BTC',dex:'',asset:0,sizeDecimals:2,size,entryPrice:'100',positionValue:notional,unrealizedPnl:'0',marginUsed:margin,leverage:10,leverageType:'cross',maxLeverage:20,fundingSinceOpen:'0',fundingSinceChange:'0'});
  return s;
}
async function prepare(fillId=seed.fill.id,leg:'open'|'close'='open',position='0'){
  vi.mocked(observer.observe).mockImplementation(async()=>snapshot(position));
  return scope.run(identity(),async(_s,session)=>prep.prepare(session,{accountId:'account',mandateId:'mandate',sourceFillId:fillId,leg}));
}
async function attempt(p:Prepared,oid:number){
  const record={...p.record,state:'unknown' as const,updatedAt:clock,outcome:{state:'filled' as const,exchangeOrderId:String(oid)}};
  await db.update(copyLiveExecutions).set({state:'unknown',record,updatedAt:new Date(clock)}).where(eq(copyLiveExecutions.key,record.key));
  const payload=planLiveReservation({now:clock,identity:seed.f.identity,localSource:{...seed.f.localSource,checkedAt:clock},intent:p.intent,action:record.action,
    market:p.intent.market!,quote:{...seed.f.quote,market:p.intent.market!,observedAt:clock},leverage:{...seed.f.leverageProofs[0]!,observedAt:clock},fees:{...seed.f.fees,observedAt:clock},policy:seed.f.policy,expiresAt:record.expiresAfter});
  await db.insert(copyLiveRiskReservations).values({...payload,cloid:p.intent.cloid,coin:'BTC',dex:'',asset:0,payload:payload as never,state:'unknown',revision:2,attemptedAt:new Date(clock),createdAt:new Date(payload.createdAt),expiresAt:new Date(payload.expiresAt),updatedAt:new Date(clock)});
  return {...p,record};
}
async function complete(p:Prepared,oid:number,filled:string,remaining:string,status='filled',beforeSettle?:(session:LiveRiskDatabaseSession)=>Promise<void>,delay=0){
  const attempted=await attempt(p,oid);const placed=clock;clock+=delay+5;
  if(Dec.from(filled).isPositive)await new CopyFollowerLedger(db,new UnitOfWork(db)).bookFill('account',{coin:'BTC',oid,tid:100+oid,side:p.intent.side,time:placed+5,sz:filled,px:'100',feeToken:'USDC',fee:'0.1',builderFee:'0.02',closedPnl:'0'});
  await db.insert(copyFollowerScans).values({accountId:'account',through:clock}).onConflictDoUpdate({target:copyFollowerScans.accountId,set:{through:clock}});
  clock+=5;const terminal=placed+10;clock+=5;
  const evidence=parseLiveOrderEvidence({record:attempted.record,market:{...attempted.record.market!,observedAt:clock},raw:{status:'order',order:{status,statusTimestamp:terminal,order:{coin:'BTC',oid,cloid:p.intent.cloid,side:p.intent.side,reduceOnly:p.intent.reduceOnly,tif:'Ioc',origSz:p.intent.size,sz:status==='filled'?'0':p.intent.size,limitPx:p.intent.limitPrice,timestamp:placed,isTrigger:false,isPositionTpsl:false,children:[]}}},checkedAt:clock,completedAt:clock,now:clock});
  const acknowledgement=Dec.from(filled).isPositive&&status!=='filled'?parseLiveIocAcknowledgement({identity:captureLiveOrderIdentity(attempted.record,attempted.record.market!),checkedAt:placed+6,raw:{status:'ok',response:{type:'order',data:{statuses:[{filled:{oid,totalSz:filled,avgPx:'100'}}]}}}}):undefined;
  clock+=5;const source={...seed.f.accountSource,checkedAt:clock,snapshot:snapshot(remaining)};
  const result=await scope.run(identity(),async(_s,session)=>{
    await settlement.observe(session,{accountId:'account',key:p.record.key,evidence,...(acknowledgement?{acknowledgement}:{})});
    if(beforeSettle)await beforeSettle(session);
    return settlement.settle(session,{accountId:'account',key:p.record.key,expectedReservationRevision:2,accountSource:source});
  });
  return {result,source};
}
async function nextFill(tid:number,sz='1',startPosition='4'){
  clock+=20;const fill=parseLiveSourceFill({tid,oid:tid+10,time:clock-1,coin:'BTC',px:'100',sz,side:'A',startPosition},{network:'testnet',leaderAddress:seed.consent.leaderAddress,from:clock-1,to:clock,receivedAt:clock,kind:'fills'});
  await db.insert(copyLiveSourceFills).values({...fill,normalized:{...fill.normalized},providerTime:new Date(fill.providerTime),receivedAt:new Date(fill.receivedAt)});await db.update(copyLiveSourceStreams).set({coverageThrough:new Date(clock)});return fill;
}
async function projected(position:string){
  return scope.run(identity(),async(_s,session)=>session.read(async tx=>{
    const authority=await loadLivePreparationAuthority(session,tx,{accountId:'account',mandateId:'mandate'},clock);
    const key=`testnet:${seed.f.identity.accountAddress}:0x${'cc'.repeat(16)}`;
    const manifest=await loadLiveGenerationManifest(session,tx,authority,{currentExecutionKey:key,now:clock});
    return projectLiveGenerationPositions({identity:{mandateId:'mandate',mandateRevision:2,accountId:'account',userId:1,strategyId:9,network:'testnet',accountAddress:seed.f.identity.accountAddress,authorizationId:'grant',settingsDigest:seed.consent.settingsDigest,leaderAddress:seed.consent.leaderAddress,direction:'same'},snapshot:snapshot(position),manifest,currentExecutionKey:key,now:clock});
  }));
}
describe('atomic source terminal settlement on one PostgreSQL connection',()=>{
  it('releases an attempted order the exchange never placed (unknown by cloid past its expiry) and the generation continues',async()=>{
    // A generation that outlives the order's expiry window.
    const intent={...seed.consent,expiresAt:now+600000};seed.consent=intent;
    await db.update(copyLiveMandates).set({intent,intentDigest:digest(intent),expiresAt:new Date(intent.expiresAt)});
    await db.update(copyWalletAuthorizations).set({expiresAt:new Date(now+600000)});await db.update(copyAgentSetups).set({expiresAt:new Date(now+600000)});
    const p=await prepare(),attempted=await attempt(p,99);
    // The executor's terminal rule: still unknown by cloid after expiresAfter + grace.
    clock=attempted.record.expiresAfter+NEVER_PLACED_GRACE_MS+1;
    const rejected={...attempted.record,state:'rejected' as const,errorCode:NEVER_PLACED,outcome:{state:'rejected' as const,reason:NEVER_PLACED},updatedAt:clock};
    await db.update(copyLiveExecutions).set({state:'rejected',record:rejected,updatedAt:new Date(clock)}).where(eq(copyLiveExecutions.key,p.record.key));
    const missing=(at:number)=>parseLiveOrderEvidence({record:rejected,market:{...rejected.market!,observedAt:at},raw:{status:'unknownOid'},checkedAt:at,completedAt:at,now:at});
    // Without a fresh no-order observation nothing is released.
    expect(await scope.run(identity(),async(_s,session)=>settlement.releaseNeverPlaced(session,{accountId:'account',key:p.record.key}))).toMatchObject({kind:'pending'});
    const result=await scope.run(identity(),async(_s,session)=>{
      expect(await settlement.observe(session,{accountId:'account',key:p.record.key,evidence:missing(clock)})).toMatchObject({kind:'recorded',oid:null});
      return settlement.releaseNeverPlaced(session,{accountId:'account',key:p.record.key});
    });
    expect(result).toEqual({kind:'released'});
    expect((await db.select().from(copyLiveRiskReservations))[0]).toMatchObject({state:'released',releaseReason:'expired_unplaced',exchangeOrderId:null});
    expect((await db.select().from(copyLiveSignalLegs))[0]).toMatchObject({state:'skipped'});
    // The position projection accepts the released attempt and continues from zero.
    vi.mocked(observer.observe).mockImplementation(async()=>snapshot('0',clock));
    expect((await projected('0')).positions).toEqual({});
  });
  it('declares never placed only after the HTTP timeout and a clock-skew allowance have both passed',()=>{
    expect(NEVER_PLACED_GRACE_MS).toBeGreaterThanOrEqual(LIVE_HTTP_TIMEOUT_MS+LIVE_CLOCK_SKEW_ALLOWANCE_MS);
    expect(LIVE_HTTP_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
  });
  it('never releases a never-placed attempt that has an attributed fill',async()=>{
    // A generation that outlives the order's expiry window (as above).
    const intent={...seed.consent,expiresAt:now+600000};seed.consent=intent;
    await db.update(copyLiveMandates).set({intent,intentDigest:digest(intent),expiresAt:new Date(intent.expiresAt)});
    await db.update(copyWalletAuthorizations).set({expiresAt:new Date(now+600000)});await db.update(copyAgentSetups).set({expiresAt:new Date(now+600000)});
    const p=await prepare(),attempted=await attempt(p,98);
    await new CopyFollowerLedger(db,new UnitOfWork(db)).bookFill('account',{coin:'BTC',oid:98,tid:198,side:p.intent.side,time:clock+1,sz:'0.1',px:'100',feeToken:'USDC',fee:'0.1',closedPnl:'0'});
    clock=attempted.record.expiresAfter+NEVER_PLACED_GRACE_MS+1;
    const rejected={...attempted.record,state:'rejected' as const,errorCode:NEVER_PLACED,outcome:{state:'rejected' as const,reason:NEVER_PLACED},updatedAt:clock};
    await db.update(copyLiveExecutions).set({state:'rejected',record:rejected,updatedAt:new Date(clock)}).where(eq(copyLiveExecutions.key,p.record.key));
    const evidence=parseLiveOrderEvidence({record:rejected,market:{...rejected.market!,observedAt:clock},raw:{status:'unknownOid'},checkedAt:clock,completedAt:clock,now:clock});
    const result=await scope.run(identity(),async(_s,session)=>{await settlement.observe(session,{accountId:'account',key:p.record.key,evidence});return settlement.releaseNeverPlaced(session,{accountId:'account',key:p.record.key});});
    expect(result).toMatchObject({kind:'quarantine'});
    expect((await db.select().from(copyLiveRiskReservations))[0]).toMatchObject({state:'quarantined'});
    // The defined path: the account is halted under the named quarantine
    // reason (no further order is prepared) until an operator reconciles it.
    vi.mocked(observer.observe).mockImplementation(async()=>snapshot('0.1',clock));
    await expect(projected('0.1')).rejects.toThrow('live_risk_quarantined');
  });
  it('settles the original source leg and journal alongside its actual receipt certificate',async()=>{
    const p=await prepare();expect(p.intent.size).toBe('0.9');expect((await complete(p,10,'0.9','0.9')).result.kind).toBe('release');
    expect((await db.select().from(copyLiveSignalLegs))[0]).toMatchObject({state:'settled',revision:3});
    expect((await db.select().from(copyLiveExecutions))[0]).toMatchObject({state:'filled'});
    expect((await db.select().from(copyLiveReductionCarry))[0]).toMatchObject({carry:'0',revision:1});
    expect((await projected('0.9')).positions).toEqual({BTC:'0.9'});
  });
  it('carries only unpaid debt through two sequential partial reductions and admits the verified flat reversal',async()=>{
    await complete(await prepare(),10,'0.9','0.9');
    const first=await nextFill(2),p1=await prepare(first.id,'close','0.9');expect(p1.intent.size).toBe('0.22');
    const firstSettlement=await complete(p1,11,'0.1','0.8','canceled');expect(firstSettlement.result.kind).toBe('release');
    expect((await db.select().from(copyLiveReductionCarry))[0]).toMatchObject({carry:'0.125',revision:2});expect((await projected('0.8')).positions).toEqual({BTC:'0.8'});
    const second=await nextFill(3),p2=await prepare(second.id,'close','0.8');expect(p2.intent.size).toBe('0.29');
    expect((await complete(p2,12,'0.2','0.6','canceled')).result.kind).toBe('release');
    expect((await db.select().from(copyLiveReductionCarry))[0]).toMatchObject({carry:'0.09375',revision:3});expect((await projected('0.6')).positions).toEqual({BTC:'0.6'});
    await scope.run(identity(),async(_s,session)=>expect(await settlement.settle(session,{accountId:'account',key:p1.record.key,expectedReservationRevision:2,accountSource:firstSettlement.source})).toEqual(firstSettlement.result));
    expect((await db.select().from(copyLiveReductionCarry))[0]).toMatchObject({carry:'0.09375',revision:3});
    const flip=await nextFill(4,'5'),close=await prepare(flip.id,'close','0.6');expect(close.intent.size).toBe('0.6');await complete(close,13,'0.6','0');
    expect((await db.select().from(copyLiveReductionCarry))[0]).toMatchObject({carry:'0',revision:4});expect((await projected('0')).positions).toEqual({});
    const open=await prepare(flip.id,'open','0');expect(open.intent).toMatchObject({side:'A',size:'0.9',reduceOnly:false});
  });
  it('replays the exact original certificate after deadline without advancing carry or leg again',async()=>{
    const p=await prepare(),first=await complete(p,10,'0.9','0.9');
    const before=await db.select().from(copyLiveSignalLegs),carry=await db.select().from(copyLiveReductionCarry),evidence=await db.select().from(copyLiveExecutionEvidence),journal=await db.select().from(copyLiveExecutions);
    clock+=100000;
    for(const revision of [2,3])await scope.run(identity(),async(_s,session)=>expect(await settlement.settle(session,{accountId:'account',key:p.record.key,expectedReservationRevision:revision,accountSource:first.source})).toEqual(first.result));
    expect(await db.select().from(copyLiveSignalLegs)).toEqual(before);expect(await db.select().from(copyLiveReductionCarry)).toEqual(carry);expect(await db.select().from(copyLiveExecutionEvidence)).toEqual(evidence);expect(await db.select().from(copyLiveExecutions)).toEqual(journal);
  });
  it('settles a real late receipt after disabled owner, stopped strategy, revoked generation/grant and changed current settings',async()=>{
    const p=await prepare();const result=await complete(p,10,'0.9','0.9','filled',async()=>{
      await db.update(users).set({disabledAt:new Date(clock)});await db.update(copyStrategies).set({status:'stopped',stoppedAt:new Date(clock),version:3});
      await db.update(copyLiveMandates).set({state:'revoked',revision:3,updatedAt:new Date(clock)});await db.update(copyWalletAuthorizations).set({revokedAt:new Date(clock)});
      await db.insert(copyStrategyVersions).values({strategyId:9,version:3,settings:{...seed.f.strategy.settings,perTradeUsd:1,sizingMode:'fixed'}});
    },60001);expect(result.result.kind).toBe('release');expect((await db.select().from(copyLiveSignalLegs))[0]!.state).toBe('settled');
  });
  it('settles a rejected close with zero receipts and retains the full unpaid intended debt',async()=>{
    await complete(await prepare(),10,'0.9','0.9');const fill=await nextFill(2),p=await prepare(fill.id,'close','0.9');
    const result=await complete(p,11,'0','0.9','rejected');expect(result.result).toMatchObject({kind:'release',certificate:{filledSize:'0'}});
    expect((await db.select().from(copyLiveReductionCarry))[0]).toMatchObject({carry:'0.225',revision:2});expect((await projected('0.9')).positions).toEqual({BTC:'0.9'});
  });
  it('settles a partial full-close debt without admitting its dependent reversal',async()=>{
    await complete(await prepare(),10,'0.9','0.9');const fill=await nextFill(2,'5'),p=await prepare(fill.id,'close','0.9');
    expect((await complete(p,11,'0.4','0.5','canceled')).result.kind).toBe('release');expect((await db.select().from(copyLiveReductionCarry))[0]).toMatchObject({carry:'0.5',revision:2});
    await expect(prepare(fill.id,'open','0.5')).rejects.toThrow('live_source_sizing_unproven');expect((await projected('0.5')).positions).toEqual({BTC:'0.5'});
  });
  it.each(['carry_amount','carry_revision','missing_provenance','source_trade','source_raw','original_settings','original_sizing','remaining_position','future_receipt'] as const)('rejects %s before atomic progression',async kind=>{
    await complete(await prepare(),10,'0.9','0.9');const fill=await nextFill(2),p=await prepare(fill.id,'close','0.9');
    let preReservation:typeof copyLiveRiskReservations.$inferSelect|undefined;
    await expect(complete(p,11,'0.1',kind==='remaining_position'?'0.7':'0.8','canceled',async()=>{
      if(kind==='carry_amount')await db.update(copyLiveReductionCarry).set({carry:'0.01'});
      if(kind==='carry_revision')await db.update(copyLiveReductionCarry).set({revision:2});
      if(kind==='missing_provenance')await db.delete(copyLiveIntentProvenance).where(eq(copyLiveIntentProvenance.key,p.record.key));
      if(kind==='source_trade')await db.update(copyLiveSignalLegs).set({tradeKey:'oid:999'}).where(eq(copyLiveSignalLegs.executionKey,p.record.key));
      if(kind==='source_raw')await db.update(copyLiveSourceFills).set({raw:{...fill.raw,px:'999'}}).where(eq(copyLiveSourceFills.id,fill.id));
      if(kind==='original_settings')await db.update(copyStrategyVersions).set({settings:{...seed.f.strategy.settings,copyStartMode:'delta',sizingMode:'fixed',perTradeUsd:91}});
      if(kind==='original_sizing'){
        const [prov]=await db.select().from(copyLiveIntentProvenance).where(eq(copyLiveIntentProvenance.key,p.record.key));const changed=structuredClone(prov!.sizingBasis) as {basis:{carry:{amount:string}}};changed.basis.carry.amount='0.02';
        await db.update(copyLiveIntentProvenance).set({sizingBasis:changed}).where(eq(copyLiveIntentProvenance.key,p.record.key));
      }
      // The unrelated genuine opening receipt makes ALL-receipt coverage mandatory.
      if(kind==='future_receipt')await db.update(copyFollowerReceipts).set({providerTime:new Date(clock+1)}).where(eq(copyFollowerReceipts.sourceId,'110'));
      [preReservation]=await db.select().from(copyLiveRiskReservations).where(eq(copyLiveRiskReservations.key,p.record.key));
    })).rejects.toThrow();
    expect((await db.select().from(copyLiveRiskReservations).where(eq(copyLiveRiskReservations.key,p.record.key)))[0]).toEqual(preReservation);
    expect((await db.select().from(copyLiveSignalLegs).where(eq(copyLiveSignalLegs.executionKey,p.record.key)))[0]!.state).toBe('prepared');
    expect((await db.select().from(copyLiveExecutionEvidence).where(eq(copyLiveExecutionEvidence.key,p.record.key)))[0]!.settlementCertificate).toBeNull();
    expect((await db.select().from(copyLiveExecutions).where(eq(copyLiveExecutions.key,p.record.key)))[0]!.state).toBe('unknown');
  });
  it('preserves the entire reduction transaction when evidence CAS loses after carry/journal/leg writes',async()=>{
    await complete(await prepare(),10,'0.9','0.9');const fill=await nextFill(2),p=await prepare(fill.id,'close','0.9');
    const client=await pool.connect(),original=client.query.bind(client);let fail=false,injected=false;
    const spy=vi.spyOn(client,'query').mockImplementation((async(...args:unknown[])=>{
      const text=typeof args[0]==='string'?args[0]:(args[0] as {text:string}).text;
      if(fail&&/^update "copy_live_execution_evidence"[\s\S]*"settlement_certificate"/i.test(text)){injected=true;throw Error('injected evidence CAS failure');}
      return (original as (...args:unknown[])=>Promise<unknown>)(...args);
    }) as never);client.release();
    try{await expect(complete(p,11,'0.1','0.8','canceled',async()=>{fail=true;})).rejects.toThrow();expect(injected).toBe(true);}finally{spy.mockRestore();}
    expect((await db.select().from(copyLiveReductionCarry))[0]).toMatchObject({carry:'0',revision:1});expect((await db.select().from(copyLiveSignalLegs).where(eq(copyLiveSignalLegs.executionKey,p.record.key)))[0]).toMatchObject({state:'prepared',revision:2});expect((await db.select().from(copyLiveRiskReservations).where(eq(copyLiveRiskReservations.key,p.record.key)))[0]).toMatchObject({state:'unknown',revision:2});
  });
  it('rejects modified SQL receipts/components on released replay while preserving original proof',async()=>{
    const p=await prepare(),first=await complete(p,10,'0.9','0.9'),original=await db.select().from(copyLiveExecutionEvidence);
    await db.update(copyFollowerLedger).set({amount:'-1'}).where(eq(copyFollowerLedger.component,'exchange_fee'));
    await expect(scope.run(identity(),async(_s,session)=>settlement.settle(session,{accountId:'account',key:p.record.key,expectedReservationRevision:3,accountSource:first.source}))).rejects.toThrow('live_settlement_replay_changed');expect(await db.select().from(copyLiveExecutionEvidence)).toEqual(original);
  });

  it('retains an unproven IOC cancellation as unknown and never advances source or carry',async()=>{
    await complete(await prepare(),10,'0.9','0.9');const fill=await nextFill(2),p=await prepare(fill.id,'close','0.9');
    expect((await complete(p,11,'0','0.9','canceled')).result.kind).toBe('pending');
    expect((await db.select().from(copyLiveReductionCarry))[0]).toMatchObject({carry:'0',revision:1});expect((await db.select().from(copyLiveSignalLegs).where(eq(copyLiveSignalLegs.executionKey,p.record.key)))[0]).toMatchObject({state:'prepared',revision:2});
    expect((await db.select().from(copyLiveRiskReservations).where(eq(copyLiveRiskReservations.key,p.record.key)))[0]).toMatchObject({state:'unknown',revision:2});
    await expect(projected('0.9')).rejects.toThrow('live_generation_unproven');
  });
  it.each(['actual_mode_without_leg','legacy_parent_with_actual_config'] as const)('cannot silently apply legacy release to %s missing provenance',async kind=>{
    const p=await prepare();await expect(complete(p,10,'0.9','0.9','filled',async()=>{
      await db.delete(copyLiveIntentProvenance).where(eq(copyLiveIntentProvenance.key,p.record.key));
      if(kind==='actual_mode_without_leg')await db.delete(copyLiveSignalLegs).where(eq(copyLiveSignalLegs.executionKey,p.record.key));
      else await db.update(copyStrategies).set({mode:'paper',allocated:'100',cash:'100'});
    })).rejects.toThrow('live_settlement_source_missing');
    expect((await db.select().from(copyLiveRiskReservations))[0]).toMatchObject({state:'unknown',revision:2});expect((await db.select().from(copyLiveExecutionEvidence))[0]!.settlementCertificate).toBeNull();
  });

});
