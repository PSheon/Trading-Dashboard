import { Pool } from 'pg';
import { beforeAll,beforeEach,afterAll,describe,it,expect,vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { liveCopyMandateIntentSchema } from '@trading-dashboard/shared/contracts';
import { copyExecutionAccounts,copyStrategies,copyLiveExecutions,copyAgentSetups,copyExecutionWallets,copyWalletAuthorizations,copyLiveMandates,copyLiveStrategyConfigs,copyStrategyVersions,copyLiveIntentProvenance,copyLiveSignalLegs,copyLiveSourceStreams,copyLiveSourceFills,copyLivePositionBaselines,copyRiskPolicies,copyControls,users,appSettings,copyFundingOperations } from '@trading-dashboard/shared/database';
import { PostgresLiveRiskSource } from '../src/copy/live/postgres-live-risk-source.js';
import { PostgresLiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';
import { HyperliquidLiveAccountObserver } from '../src/copy/live/live-account-observer.js';
import { HyperliquidLiveMarketResolver } from '../src/copy/live/live-market-resolver.js';
import { HyperliquidLiveRiskProvider } from '../src/copy/live/live-risk-provider.js';
import { PostgresLiveReservations } from '../src/copy/live/postgres-live-reservations.js';
import { captureLivePositionBaseline } from '../src/copy/live/live-position-baseline.js';
import { liveCopySettingsDigest } from '../src/copy/copy-live-mandate-consent.js';
import { digest as mandateDigest } from '../src/copy/copy-live-mandate-evidence.js';
import { parseLiveSourceFill,liveSourceLegId } from '../src/copy/live/copy-live-source-evidence.js';
import { buildOrderAction,executionKey,intentFingerprint } from '../src/copy/live/live-order.js';
import { fixture,now } from './copy-live-risk-test-utils.js';
import { getTestDb,closeTestDb,truncateAll,insertUser,type TestDb } from './db-test-utils.js';
let db:TestDb,pool:Pool,scopes:PostgresLiveRiskScope,source:PostgresLiveRiskSource,fetcher:ReturnType<typeof vi.fn<typeof fetch>>,f:ReturnType<typeof fixture>;
beforeAll(()=>{db=getTestDb();pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:3});scopes=new PostgresLiveRiskScope(pool,()=>now);});
beforeEach(async()=>{
  await truncateAll(db);f=fixture();const user=await insertUser(db,{privyUserId:'did:privy:risk-source'});expect(user.id).toBe(f.identity.userId);
  await db.insert(copyStrategies).values({id:9,userId:user.id,mode:'testnet',leaderAddress:`0x${'44'.repeat(20)}`,allocated:'0',cash:'0',status:'active',activatedAt:new Date(now)});
  await db.insert(copyExecutionAccounts).values({id:'account',userId:user.id,strategyId:9,network:'testnet',state:'ready',address:f.identity.accountAddress,privyUserId:user.privyUserId,externalId:'source-master',privyWalletId:'master',ownerQuorumId:'owner'});
  await db.insert(copyLiveExecutions).values({key:f.reservations.own.key,network:'testnet',accountAddress:f.identity.accountAddress,signerAddress:`0x${'33'.repeat(20)}`,cloid:f.intent.cloid,nonce:now,userId:user.id,strategyId:9,state:'prepared',updatedAt:new Date(now),
    record:{key:f.reservations.own.key,fingerprint:f.reservations.own.fingerprint,market:f.market,action:f.action,nonce:now,expiresAfter:now+60000,state:'prepared',createdAt:now,updatedAt:now,
      authorization:{id:'grant',version:4,userId:1,strategyId:9,walletId:'agent',privyOwnerId:'owner',signerAddress:`0x${'33'.repeat(20)}`,accountAddress:f.identity.accountAddress,network:'testnet',scopes:['copy:trade','copy:reduce'],validFrom:now-1,expiresAt:now+60000,revokedAt:null,exchangeApprovedAt:now-1}}});
  fetcher=vi.fn<typeof fetch>(async()=>{throw Error('Remote must not run before local authority');});
  const acquire=async(_weight:number)=>{};
  source=new PostgresLiveRiskSource(new HyperliquidLiveAccountObserver('testnet',acquire,fetcher,()=>now),new HyperliquidLiveMarketResolver('testnet',acquire,fetcher,()=>now),new HyperliquidLiveRiskProvider('testnet',acquire,fetcher,()=>now),new PostgresLiveReservations(()=>now),{extraRiskBufferBps:'0',restingOrderBuilderFeeCapTenthsBps:100},()=>now);
});
afterAll(async()=>{await pool?.end();await closeTestDb();});
const id=()=>({userId:f.identity.userId,network:'testnet' as const,accountAddress:f.identity.accountAddress,source:{network:'testnet' as const,leaderAddress:`0x${'44'.repeat(20)}`}});
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
describe('unregistered original-session trusted risk producer',()=>{
  it('rejects a structural replacement for the factory-issued original session',async()=>{
    await scopes.run(id(),async(_scope,session)=>{expect(()=>source.bind({...session},{accountId:'account',key:f.reservations.own.key})).toThrow('live_risk_serialization_lost');});expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses a canonical prepared journal without immutable source provenance before any remote read',async()=>{
    await scopes.run(id(),async(_scope,session)=>{await expect(source.bind(session,{accountId:'account',key:f.reservations.own.key}).forHold()).rejects.toThrow('live_risk_provenance_missing');});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('cannot forge source authority by passing matching incoming intent arrays to the gate adapter',async()=>{
    await scopes.run(id(),async(_scope,session)=>{const bound=source.bind(session,{accountId:'account',key:f.reservations.own.key});const [row]=await db.select().from(copyLiveExecutions);
      await expect(bound.proofSource.read({phase:'sign',intent:f.intent,record:row!.record as never})).rejects.toThrow('live_risk_provenance_missing');});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps the callback bound to its original tombstoned session when a successor obtains the same account',async()=>{
    let bound!:ReturnType<PostgresLiveRiskSource['bind']>;await scopes.run(id(),async(_scope,session)=>{bound=source.bind(session,{accountId:'account',key:f.reservations.own.key});});
    await scopes.run(id(),async()=>{await expect(bound.forHold()).rejects.toThrow('live_risk_serialization_lost');});
  });
  it('captures binding references before a queued SQL wait and does not adopt another requested account',async()=>{
    await scopes.run(id(),async(_scope,session)=>{const input={accountId:'account',key:f.reservations.own.key},bound=source.bind(session,input);input.accountId='foreign';
      await expect(bound.forHold()).rejects.toThrow('live_risk_provenance_missing');});
  });
});

describe('durable local actual source authority before remote reads',()=>{
  beforeEach(fullAuthority);
  it('rejects a legacy account-only lock even for valid source provenance',async()=>{
    await scopes.run({userId:1,network:'testnet',accountAddress:f.identity.accountAddress},async(_scope,session)=>{await expect(source.bind(session,{accountId:'account',key:f.reservations.own.key}).forHold()).rejects.toThrow('live_risk_source_scope_missing');});expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires a durable first-empty baseline even for the genuine authority chain',async()=>{
    await scopes.run(id(),async(_scope,session)=>{await expect(source.bind(session,{accountId:'account',key:f.reservations.own.key}).forHold()).rejects.toThrow('live_risk_baseline_unproven');});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('validates the original empty baseline without treating it as a current generation receipt proof',async()=>{
    const baseline=captureLivePositionBaseline({mandateId:'mandate',accountId:'account',strategyId:9,firstExecutionKey:f.reservations.own.key,network:'testnet',accountAddress:f.identity.accountAddress},f.accountSource.snapshot,now);
    await db.insert(copyLivePositionBaselines).values({...baseline,record:baseline as never,observedAt:new Date(baseline.observedAt),completedAt:new Date(baseline.completedAt),createdAt:new Date(baseline.createdAt)});
    await scopes.run(id(),async(_scope,session)=>{await expect(source.bind(session,{accountId:'account',key:f.reservations.own.key}).forHold()).rejects.toThrow('live_risk_generation_unproven');});expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['owner','strategy','mandate','grant','source','leg','budget','platform','controls','transfer','foreignNetwork','missingMaster','coverageStartsLate','orphan'] as const)('denies %s drift before remote capacity',async change=>{
    let reason='live_risk_mandate_changed';
    if(change==='coverageStartsLate'){await db.update(copyLiveSourceStreams).set({coverageFrom:new Date(now-1000)});reason='live_risk_source_changed';}
    if(change==='orphan'){const [journal]=await db.select().from(copyLiveExecutions);const intent={...f.intent,cloid:`0x${'cd'.repeat(16)}` as `0x${string}`},action=buildOrderAction(intent),key=executionKey(intent);await db.insert(copyLiveExecutions).values({...journal!,key,cloid:intent.cloid,nonce:now+1,record:{...journal!.record,key,fingerprint:intentFingerprint(intent,action),action,nonce:now+1}});reason='live_risk_orphan_execution';}
    if(change==='owner'){await db.update(users).set({disabledAt:new Date(now)});reason='live_risk_identity';}
    if(change==='strategy')await db.update(copyStrategies).set({status:'paused'});
    if(change==='mandate')await db.update(copyLiveMandates).set({state:'paused'});
    if(change==='grant'){await db.update(copyWalletAuthorizations).set({revokedAt:new Date(now)});reason='wallet_authorization_revoked';}
    if(change==='source'){await db.update(copyLiveSourceStreams).set({state:'gap'});reason='live_risk_source_changed';}
    if(change==='leg'){await db.update(copyLiveSignalLegs).set({sign:-1});reason='live_risk_source_changed';}
    if(change==='budget')await db.update(copyLiveStrategyConfigs).set({budgetUsd:'101'});
    if(change==='platform'){await db.update(appSettings).set({value:{copyTradingEnabled:false}});reason='live_risk_platform_disabled';}
    if(change==='controls'){await db.delete(copyControls).where(eq(copyControls.scope,'user'));reason='live_risk_controls_unproven';}
    if(change==='transfer'){await db.insert(copyFundingOperations).values({id:'pending',userId:1,accountId:'account',strategyId:9,idempotencyKey:'pending-funding-0001',network:'testnet',address:f.identity.accountAddress,destination:`0x${'66'.repeat(20)}`,amount:'10',nonce:now,status:'unknown'});reason='live_risk_transfer_pending';}
    if(change==='foreignNetwork'||change==='missingMaster'){
      await db.insert(copyStrategies).values({id:10,userId:1,mode:'testnet',leaderAddress:`0x${'77'.repeat(20)}`,allocated:'0',cash:'0',status:'paused',activatedAt:new Date(now)});
      await db.insert(copyExecutionAccounts).values({id:'other',userId:1,strategyId:10,network:change==='foreignNetwork'?'mainnet':'testnet',state:'unknown',privyUserId:'did:privy:risk-source',externalId:'other-account'});reason='live_risk_user_coverage_unproven';
    }
    await scopes.run(id(),async(_scope,session)=>{await expect(source.bind(session,{accountId:'account',key:f.reservations.own.key}).forHold()).rejects.toThrow(reason);});expect(fetcher).not.toHaveBeenCalled();
  });
});
