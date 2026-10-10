import {appendFileSync} from 'node:fs';
import { Pool } from 'pg';
import { beforeAll,beforeEach,afterAll,describe,it,expect,vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { liveCopyMandateIntentSchema } from '@trading-dashboard/shared/contracts';
import { copyExecutionAccounts,copyStrategies,copyLiveExecutions,copyAgentSetups,copyExecutionWallets,copyWalletAuthorizations,copyLiveMandates,copyLiveStrategyConfigs,copyStrategyVersions,copyLiveIntentProvenance,copyLiveSignalLegs,copyLiveSourceStreams,copyLiveSourceFills,copyLivePositionBaselines,copyLiveReductionCarry,copyRiskPolicies,copyControls,users,appSettings,copyFollowerScans,copyFollowerAccountState } from '@trading-dashboard/shared/database';
import { PostgresLiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';
import { captureLivePositionBaseline } from '../src/copy/live/live-position-baseline.js';
import * as authority from '../src/copy/live/postgres-live-risk-authority.js';
import { loadLiveGenerationManifest } from '../src/copy/live/postgres-live-generation-manifest.js';
import { liveSourceDigest } from '../src/copy/live/copy-live-source-evidence.js';
import { followerReceiptDigestV1 } from '../src/copy/live/actual-fill-accounting.js';
import { planLiveSourceOrder } from '../src/copy/live/copy-live-source-planner.js';
import { canonicalLiveSourceLegs,decodeLiveSourceFill } from '../src/copy/live/copy-live-source-evidence.js';
import type { LiveSourceSizingEnvelopeV1 } from '../src/copy/live/copy-live-sizing-evidence.js';
import { liveCopySettingsDigest } from '../src/copy/copy-live-mandate-consent.js';
import { digest as mandateDigest } from '../src/copy/copy-live-mandate-evidence.js';
import { parseLiveSourceFill,liveSourceLegId } from '../src/copy/live/copy-live-source-evidence.js';
import { buildOrderAction,intentFingerprint } from '../src/copy/live/live-order.js';
import { fixture,now } from './copy-live-risk-test-utils.js';
import { getTestDb,closeTestDb,truncateAll,insertUser,type TestDb } from './db-test-utils.js';
let db:TestDb,pool:Pool,scopes:PostgresLiveRiskScope,f:ReturnType<typeof fixture>;
beforeAll(()=>{db=getTestDb();pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:3});scopes=new PostgresLiveRiskScope(pool,()=>now);});
beforeEach(async()=>{
  await truncateAll(db);f=fixture();const user=await insertUser(db,{privyUserId:'did:privy:risk-source'});expect(user.id).toBe(f.identity.userId);
  await db.insert(copyStrategies).values({id:9,userId:user.id,mode:'testnet',leaderAddress:`0x${'44'.repeat(20)}`,allocated:'0',cash:'0',status:'active',activatedAt:new Date(now)});
  await db.insert(copyExecutionAccounts).values({id:'account',userId:user.id,strategyId:9,network:'testnet',state:'ready',address:f.identity.accountAddress,privyUserId:user.privyUserId,externalId:'source-master',privyWalletId:'master',ownerQuorumId:'owner'});
  await db.insert(copyLiveExecutions).values({key:f.reservations.own.key,network:'testnet',accountAddress:f.identity.accountAddress,signerAddress:`0x${'33'.repeat(20)}`,cloid:f.intent.cloid,nonce:now,userId:user.id,strategyId:9,state:'prepared',updatedAt:new Date(now),
    record:{key:f.reservations.own.key,fingerprint:f.reservations.own.fingerprint,market:f.market,action:f.action,nonce:now,expiresAfter:now+60000,state:'prepared',createdAt:now,updatedAt:now,
      authorization:{id:'grant',version:4,userId:1,strategyId:9,walletId:'agent',privyOwnerId:'owner',signerAddress:`0x${'33'.repeat(20)}`,accountAddress:f.identity.accountAddress,network:'testnet',scopes:['copy:trade','copy:reduce'],validFrom:now-1,expiresAt:now+60000,revokedAt:null,exchangeApprovedAt:now-1}}});

});
afterAll(async()=>{await pool?.end();await closeTestDb();});
const id=()=>({userId:f.identity.userId,network:'testnet' as const,accountAddress:f.identity.accountAddress,source:{network:'testnet' as const,leaderAddress:`0x${'44'.repeat(20)}`}});
async function genuineSizing() {
  const [mandate]=await db.select().from(copyLiveMandates),[provenance]=await db.select().from(copyLiveIntentProvenance),[fillRow]=await db.select().from(copyLiveSourceFills),[version]=await db.select().from(copyStrategyVersions);
  const intent={...f.intent,timeInForce:'Ioc' as const};f={...f,intent,action:buildOrderAction(intent)};const fingerprint=intentFingerprint(f.intent,f.action);
  const [journal]=await db.select().from(copyLiveExecutions);
  await db.update(copyLiveExecutions).set({record:{...journal!.record,action:f.action,fingerprint}});
  const baseline=captureLivePositionBaseline({mandateId:'mandate',accountId:'account',strategyId:9,firstExecutionKey:f.reservations.own.key,network:'testnet',accountAddress:f.identity.accountAddress},f.accountSource.snapshot,now);
  await db.insert(copyLivePositionBaselines).values({...baseline,record:baseline as never,observedAt:new Date(baseline.observedAt),completedAt:new Date(baseline.completedAt),createdAt:new Date(baseline.createdAt)});
  await db.insert(copyLiveReductionCarry).values({mandateId:'mandate',coin:'BTC',carry:'0',revision:1,updatedAt:new Date(now)});
  const follower=f.accountSource.snapshot,leader=structuredClone({...follower,accountAddress:mandate!.leaderAddress}),fill=decodeLiveSourceFill(fillRow!);
  const envelope:LiveSourceSizingEnvelopeV1={version:1,basis:{version:1,mandateId:'mandate',mandateRevision:2,settingsDigest:mandate!.settingsDigest,sourceFillId:fill.id,sourceDigest:fill.sourceDigest,network:'testnet',accountAddress:f.identity.accountAddress,coin:'BTC',leg:'open',direction:'same',sizingMode:'ratio',budgetUsd:'100',perTradeUsd:null,market:f.market,
    quote:{midPrice:'100',slippageBps:'0',observedAt:now,completedAt:now,sourceDigest:f.quote.sourceDigest},
    follower:{network:'testnet',accountAddress:follower.accountAddress,equity:follower.perpEquity,positionSize:'0',observedAt:now,completedAt:now,sourceDigest:follower.sourceDigest,snapshotDigest:followerReceiptDigestV1(follower),positionsDigest:liveSourceDigest({})},
    leader:{network:'testnet',accountAddress:leader.accountAddress,equity:leader.perpEquity,observedAt:now,completedAt:now,sourceDigest:leader.sourceDigest,snapshotDigest:followerReceiptDigestV1(leader)},
    generation:{mandateId:'mandate',baselineDigest:baseline.baselineDigest,receiptManifestDigest:liveSourceDigest({receipts:[],ledger:[]}),positionsDigest:liveSourceDigest({}),positionSize:'0'},carry:{amount:'0',revision:1},fixedTradeClaim:false,settledDependency:null},
    observations:{follower,leader,quote:{network:'testnet',accountAddress:follower.accountAddress,coin:'BTC',dex:'',asset:0,market:f.market,earliestObservedAt:now,completedAt:now,sourceDigest:'a'.repeat(64),accountModeProof:{network:'testnet',accountAddress:follower.accountAddress,role:'user',accountAbstraction:'disabled',dexAbstraction:false,portfolioMargin:false,observedAt:now,completedAt:now,sourceDigest:'a'.repeat(64)},quote:f.quote,leverageProofs:f.leverageProofs,fees:{...f.fees,scope:'validator_perp',calculation:'documented_fee_formula'}},
      generationManifest:{version:1,accountId:'account',mandateId:'mandate',checkedAt:now,baseline,journals:[],receipts:[],ledger:[],scan:null,conflicts:[],accountState:null,carry:[{mandateId:'mandate',coin:'BTC',carry:'0',revision:1,updatedAt:new Date(now).toISOString()}]}}};
  const planned=planLiveSourceOrder({mandate:mandate!,settings:version!.settings as never,fill,leg:canonicalLiveSourceLegs(fill)[0]!,sizingBasis:envelope,now,limits:f.policy.limits,currentExecutionKey:f.reservations.own.key});
  expect(planned.order).toMatchObject({size:'1',limitPrice:'100',timeInForce:'Ioc'});
  await db.update(copyLiveIntentProvenance).set({intent:f.intent as never,fingerprint,sizingBasis:envelope as never}).where(eq(copyLiveIntentProvenance.key,provenance!.key));

}
async function fullAuthority() {
  const ownerAddress=`0x${'55'.repeat(20)}`,settings={...f.strategy.settings,copyStartMode:'delta' as const};
  await db.update(users).set({embeddedWalletAddress:ownerAddress});
  await db.update(copyStrategies).set({version:2});
  await db.insert(copyStrategyVersions).values({strategyId:9,version:2,settings:settings as never});
  await db.insert(copyLiveStrategyConfigs).values({strategyId:9,userId:1,idempotencyKey:'source-live-config-0001',sourceNetwork:'testnet',budgetUsd:'100',strategyVersion:2});
  await db.insert(copyExecutionWallets).values({id:'wallet-row',userId:1,strategyId:9,network:'testnet',accountAddress:f.identity.accountAddress,privyWalletId:'agent',privyOwnerId:'owner',signerAddress:`0x${'33'.repeat(20)}`});
  await db.insert(copyWalletAuthorizations).values({id:'grant',walletId:'wallet-row',version:4,scopes:['copy:trade','copy:reduce'],validFrom:new Date(now-1),expiresAt:new Date(now+60000),exchangeApprovedAt:new Date(now-1)});
  await db.insert(copyAgentSetups).values({id:'setup',userId:1,strategyId:9,accountId:'account',network:'testnet',idempotencyKey:'source-live-setup-0001',validForDays:1,externalId:'source-agent-external',workerQuorumId:'worker',policyAttemptId:'source-policy',policyId:'policy',policyFingerprint:'a'.repeat(64),agentWalletId:'agent',agentOwnerQuorumId:'owner',agentAddress:`0x${'33'.repeat(20)}`,accountAddress:f.identity.accountAddress,accountWalletId:'master',accountOwnerQuorumId:'owner',state:'active',authorizationId:'grant',expiresAt:new Date(now+60000),createdAt:new Date(now-4000),updatedAt:new Date(now-1)});
  const consent=liveCopyMandateIntentSchema.parse({mandateId:'mandate',accountId:'account',userId:1,strategyId:9,strategyVersion:2,network:'testnet',sourceNetwork:'testnet',leaderAddress:`0x${'44'.repeat(20)}`,accountAddress:f.identity.accountAddress,accountRevision:1,ownerPrivyUserId:'did:privy:risk-source',ownerAddress,setupId:'setup',setupRevision:1,executionWalletId:'wallet-row',agentWalletId:'agent',agentAddress:`0x${'33'.repeat(20)}`,authorizationId:'grant',authorizationVersion:4,policyId:'policy',policyFingerprint:'a'.repeat(64),workerQuorumId:'worker',settingsDigest:liveCopySettingsDigest(settings),budgetUsd:'100',builderAddress:null,builderMaxFeeTenthsOfBps:0,plannerVersion:1,nonce:now-3000,consentExpiresAt:now+30000,expiresAt:now+60000});
  const {mandateId,consentExpiresAt,expiresAt,...columns}=consent;
  await db.insert(copyLiveMandates).values({...columns,id:mandateId,idempotencyKey:'source-live-mandate-0001',intent:consent,intentDigest:mandateDigest(consent),consentDigest:'b'.repeat(64),state:'active',revision:2,activationCursor:new Date(now-2000),consentExpiresAt:new Date(consentExpiresAt),expiresAt:new Date(expiresAt),createdAt:new Date(now-3000),updatedAt:new Date(now-2000)});
  const fill=parseLiveSourceFill({tid:1,oid:2,time:now-1000,coin:'BTC',px:'100',sz:'1',side:'B',startPosition:'0'},{network:'testnet',leaderAddress:consent.leaderAddress,from:now-2000,to:now,receivedAt:now,kind:'fills'});
  await db.insert(copyLiveSourceStreams).values({id:fill.streamId,network:'testnet',leaderAddress:fill.leaderAddress,state:'ready',coverageFrom:new Date(now-2000),coverageThrough:new Date(now),coverageDigest:'c'.repeat(64)});
  await db.insert(copyLiveSourceFills).values({...fill,normalized:{...fill.normalized},providerTime:new Date(fill.providerTime),receivedAt:new Date(fill.receivedAt)});
  const legId=liveSourceLegId('mandate',fill.id,'open');
  await db.insert(copyLiveSignalLegs).values({id:legId,mandateId:'mandate',sourceFillId:fill.id,leg:'open',tradeKey:fill.tradeKey,sign:1,size:'1',fraction:null,state:'prepared',executionKey:f.reservations.own.key,createdAt:new Date(now),updatedAt:new Date(now)});
  await db.insert(copyLiveIntentProvenance).values({key:f.reservations.own.key,legId,mandateId:'mandate',mandateRevision:2,sourceDigest:fill.sourceDigest,settingsDigest:consent.settingsDigest,fingerprint:f.reservations.own.fingerprint,plannerVersion:1,intent:f.intent as never,sizingBasis:{},admittedAt:new Date(now)});
  await db.insert(copyRiskPolicies).values({version:3,limits:{...f.policy.limits}});
  await db.insert(copyControls).values([{scope:'platform',scopeId:0},{scope:'user',scopeId:1}]);
  await db.insert(appSettings).values({key:'general',value:{copyTradingEnabled:true}});
}

type Kind='preparation'|'risk'|'generation';
async function observed(kind:Kind,at=now){
  return scopes.run(id(),async(_scope,session)=>session.read(async tx=>{
    const a=kind==='generation'?await authority.loadLivePreparationAuthority(session,tx,{accountId:'account',mandateId:'mandate'},now):undefined;
    const pgSession=(tx as unknown as {session:{prepareQuery(query:{sql:string;params:unknown[]},...args:unknown[]):unknown;client:{query(...args:unknown[]):unknown}}}).session;
    const queryOriginal=pgSession.client.query.bind(pgSession.client);
    let perQuery:{kind:'lock'|'select';ms:number}[]=[];
    const compiled=vi.spyOn(pgSession,'prepareQuery'),queries=vi.spyOn(pgSession.client,'query').mockImplementation(async(...args)=>{
      const started=process.hrtime.bigint();
      try{return await queryOriginal(...args);}finally{
        const text=typeof args[0]==='string'?args[0]:(args[0] as {text?:string})?.text??'';
        perQuery.push({kind:text.includes('from pg_locks')?'lock':'select',ms:Number(process.hrtime.bigint()-started)/1e6});
      }
    });
    async function capture(){
      compiled.mockClear();queries.mockClear();perQuery=[];const started=process.hrtime.bigint();
      let value:unknown,error:unknown;
      try{
        const mod=authority;
        if(kind==='preparation')value=await mod.loadLivePreparationAuthority(session,tx,{accountId:'account',mandateId:'mandate'},at);
        else if(kind==='risk')value=await mod.loadLiveRiskAuthority(session,tx,{accountId:'account',key:f.reservations.own.key},at);
        else value=await loadLiveGenerationManifest(session,tx,a!,{currentExecutionKey:f.reservations.own.key,now:at});
      }catch(e){error=e instanceof Error?{name:e.name,message:e.message}:e;}
      return {value,error,data:compiled.mock.calls.map(([q])=>q.sql),locks:queries.mock.calls.filter(([q])=>typeof q==='string'&&q.includes('from pg_locks')).length,ms:Number(process.hrtime.bigint()-started)/1e6,perQuery:[...perQuery]};
    }
    try{
      const candidate=await capture();
      if(process.env.QUERY_CONSOLIDATION_MEASUREMENT_FILE)appendFileSync(process.env.QUERY_CONSOLIDATION_MEASUREMENT_FILE,JSON.stringify({event:'query_consolidation_measurement',kind,candidateQueries:candidate.data.length,candidateLocks:candidate.locks,candidateMs:candidate.ms,error:candidate.error,candidatePerQuery:candidate.perQuery})+'\n');
      return {candidate};
    }finally{compiled.mockRestore();queries.mockRestore();}
  }));
}
describe('typed consolidated current SQL authority',()=>{
  beforeEach(fullAuthority);
  it.each(['preparation','risk','generation'] as const)('preserves exact %s DTO/digest and reduces real SELECT/fence count',async kind=>{
    await genuineSizing();const {candidate}=await observed(kind);expect(candidate.error).toBeUndefined();
    expect(candidate.data).toHaveLength({preparation:7,risk:13,generation:7}[kind]);expect(candidate.locks).toBe(candidate.data.length);
    if(kind==='generation')expect(candidate.value).toMatchObject({checkedAt:now,scan:null,accountState:null});
    else {const v=(kind==='risk'?(candidate.value as Awaited<ReturnType<typeof authority.loadLiveRiskAuthority>>).preparation:candidate.value) as Awaited<ReturnType<typeof authority.loadLivePreparationAuthority>>;
      expect(v.revenue).toBeUndefined();expect(Object.hasOwn(v,'revenue')).toBe(true);
      expect(v.mandate.createdAt).toBeInstanceOf(Date);expect(v.mandate.createdAt.getTime()).toBe(now-3000);expect(v.general[0]!.key).toBe('general');}
  });
  it('decodes present aliases and nullable table Dates, choosing the latest current policy',async()=>{
    await genuineSizing();await db.insert(appSettings).values({key:'revenue',value:{builderAddress:null,builderFeeTenthsBps:0}});
    await db.insert(copyRiskPolicies).values({version:2,limits:{...f.policy.limits}});
    await db.insert(copyRiskPolicies).values({version:4,limits:{...f.policy.limits,maxOrdersPerMinute:1}});
    await db.insert(copyFollowerScans).values({accountId:'account',through:now,nextRunAt:new Date(now),createdAt:new Date(now),updatedAt:new Date(now)});
    await db.insert(copyFollowerAccountState).values({accountId:'account',updatedAt:new Date(now)});
    const loaded=(await observed('preparation')).candidate;expect(loaded.error).toBeUndefined();
    expect(loaded.value).toMatchObject({identity:{policyVersion:4},policy:{version:4,limits:{maxOrdersPerMinute:1}},revenue:{key:'revenue'}});
    const gen=(await observed('generation')).candidate;expect(gen.error).toBeUndefined();expect(gen.value).toMatchObject({checkedAt:now,scan:{updatedAt:new Date(now).toISOString()},accountState:{updatedAt:new Date(now).toISOString()}});
    // A later phase must read the changed SQL settings/policy, not a cached earlier authority.
    await db.update(copyRiskPolicies).set({limits:{...f.policy.limits,maxOrdersPerMinute:2}}).where(eq(copyRiskPolicies.version,4));
    expect((await observed('preparation')).candidate.value).toMatchObject({policy:{limits:{maxOrdersPerMinute:2}}});
  });
  it.each(['general','policy'] as const)('preserves missing %s rejection',async missing=>{
    await genuineSizing();if(missing==='general')await db.delete(appSettings).where(eq(appSettings.key,'general'));else await db.delete(copyRiskPolicies);
    expect((await observed('preparation')).candidate.error).toMatchObject({message:missing==='general'?'live_risk_platform_disabled':'live_risk_policy_missing'});
  });
  it('preserves missing-baseline optional authority and mandatory generation behavior',async()=>{
    await genuineSizing();await db.delete(copyLiveReductionCarry);await db.delete(copyLivePositionBaselines);
    const risk=(await observed('risk')).candidate;expect(risk.error).toBeUndefined();expect(risk.value).toMatchObject({baseline:null});expect(risk.data).toHaveLength(13);
    expect((await observed('generation')).candidate.error).toMatchObject({message:'live_risk_baseline_unproven'});
  });
  it.each(['journal','provenance'] as const)('refuses a baseline whose distinct first %s row is absent',async missing=>{
    await genuineSizing();const [journal]=await db.select().from(copyLiveExecutions);
    const firstKey=`testnet:${f.identity.accountAddress}:0x${'ef'.repeat(16)}`;
    // capture creates the same genuine empty baseline with a distinct first key/digest.
    const recaptured=captureLivePositionBaseline({mandateId:'mandate',accountId:'account',strategyId:9,firstExecutionKey:firstKey,network:'testnet',accountAddress:f.identity.accountAddress},f.accountSource.snapshot,now);
    const baselineUpdate=()=>db.update(copyLivePositionBaselines).set({...recaptured,record:recaptured as never,observedAt:new Date(recaptured.observedAt),completedAt:new Date(recaptured.completedAt),createdAt:new Date(recaptured.createdAt)});
    if(missing==='journal'){
      // The real retained FK prevents this absent-journal state from becoming durable.
      await expect(baselineUpdate()).rejects.toMatchObject({cause:{code:'23503'}});return;
    }
    await db.insert(copyLiveExecutions).values({...journal!,key:firstKey,nonce:now+1,state:'rejected',cloid:`0x${'ef'.repeat(16)}`,record:{...journal!.record,key:firstKey,nonce:now+1,state:'rejected'}});
    await baselineUpdate();
    expect((await observed('risk')).candidate.error).toMatchObject({message:'live_risk_baseline_unproven'});
    expect((await observed('generation')).candidate.error).toMatchObject({message:'live_risk_baseline_unproven'});
  });
  it('does not restamp expired authorization to a fresh SQL completion',async()=>{
    await genuineSizing();expect((await observed('preparation',now+60001)).candidate.error).toBeDefined();
  });
});
