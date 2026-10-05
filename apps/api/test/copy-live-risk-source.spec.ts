import { Pool } from 'pg';
import { beforeAll,beforeEach,afterAll,describe,it,expect,vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { liveCopyMandateIntentSchema } from '@trading-dashboard/shared/contracts';
import { copyExecutionAccounts,copyStrategies,copyLiveExecutions,copyAgentSetups,copyExecutionWallets,copyWalletAuthorizations,copyLiveMandates,copyLiveStrategyConfigs,copyStrategyVersions,copyLiveIntentProvenance,copyLiveSignalLegs,copyLiveSourceStreams,copyLiveSourceFills,copyLivePositionBaselines,copyLiveReductionCarry,copyRiskPolicies,copyControls,users,appSettings,copyFundingOperations } from '@trading-dashboard/shared/database';
import { PostgresLiveRiskSource } from '../src/copy/live/postgres-live-risk-source.js';
import { PostgresLiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';
import { HyperliquidLiveAccountObserver } from '../src/copy/live/live-account-observer.js';
import { HyperliquidLiveMarketResolver } from '../src/copy/live/live-market-resolver.js';
import { HyperliquidLiveRiskProvider } from '../src/copy/live/live-risk-provider.js';
import { PostgresLiveReservations } from '../src/copy/live/postgres-live-reservations.js';
import { captureLivePositionBaseline } from '../src/copy/live/live-position-baseline.js';
import * as authority from '../src/copy/live/postgres-live-risk-authority.js';
import { loadLiveGenerationManifest } from '../src/copy/live/postgres-live-generation-manifest.js';
import { liveSourceDigest } from '../src/copy/live/copy-live-source-evidence.js';
import { followerReceiptDigestV1 } from '../src/copy/live/actual-fill-accounting.js';
import { planLiveSourceOrder } from '../src/copy/live/copy-live-source-planner.js';
import { canonicalLiveSourceLegs,decodeLiveSourceFill } from '../src/copy/live/copy-live-source-evidence.js';
import type { LiveSourceSizingEnvelopeV1 } from '../src/copy/live/copy-live-sizing-evidence.js';
import { assessLiveAccountRisk } from '../src/copy/live/live-account-risk.js';
import { AccountRiskExecutionGate } from '../src/copy/live/account-risk-execution-gate.js';
import type { LiveExecutionRecord } from '../src/copy/live/live-execution.js';
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
async function genuineSizing(clock=()=>now) {
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
  const acquire=async(_weight:number)=>{};
  const meta={collateralToken:7,universe:[{name:'BTC',szDecimals:2,maxLeverage:20}]};
  fetcher=vi.fn<typeof fetch>(async(url,options)=>{expect(url).toBe('https://api.hyperliquid-testnet.xyz/info');const body=JSON.parse(String(options?.body));const values:Record<string,unknown>={userRole:{role:'user'},userAbstraction:'disabled',userDexAbstraction:false,spotClearinghouseState:{portfolioMarginEnabled:false,balances:[]},perpDexs:[null],spotMeta:{tokens:[{index:7,name:'USDC',isCanonical:true}]},meta,allPerpMetas:[meta],metaAndAssetCtxs:[meta,[{midPx:'100',markPx:'100'}]],activeAssetData:{user:body.user,coin:'BTC',leverage:{type:'cross',value:10},maxTradeSzs:['1','1'],availableToTrade:['100','100'],markPx:'100'},userFees:{userAddRate:'-0.0001',userCrossRate:'0.0005',activeReferralDiscount:'0',trial:null}};if(!(body.type in values))throw Error('unexpected fixed info read');return new Response(JSON.stringify(values[body.type]));});
  const state={marginSummary:{accountValue:'100',totalNtlPos:'0',totalRawUsd:'100',totalMarginUsed:'0'},crossMarginSummary:{accountValue:'100',totalNtlPos:'0',totalRawUsd:'100',totalMarginUsed:'0'},crossMaintenanceMarginUsed:'0',withdrawable:'100',time:now,assetPositions:[] as unknown[]};
  const observer=new HyperliquidLiveAccountObserver('testnet',acquire,fetcher,clock,5000,{read:async(user)=>({network:'testnet',accountAddress:user,observedAt:clock(),data:{user,clearinghouseStates:[['',state]]}}),readOrders:async(user,dexes)=>({network:'testnet',accountAddress:user,observedAt:clock(),completedAt:clock(),requestedDexes:[...dexes],venues:dexes.map(dex=>({dex,user,observedAt:clock(),receivedAt:clock(),orders:[]}))})});
  const reservations=new PostgresLiveReservations(clock);
  source=new PostgresLiveRiskSource(observer,new HyperliquidLiveMarketResolver('testnet',acquire,fetcher,clock),new HyperliquidLiveRiskProvider('testnet',acquire,fetcher,clock),reservations,{extraRiskBufferBps:'0',restingOrderBuilderFeeCapTenthsBps:100},clock);
  return {reservations,state};
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
  it('produces an assessable actual forHold candidate from persisted genuine sizing and fresh concrete reads',async()=>{
    await genuineSizing();await scopes.run(id(),async(_scope,session)=>{
      const proof=await source.bind(session,{accountId:'account',key:f.reservations.own.key}).forHold();
      expect(assessLiveAccountRisk(proof)).toMatchObject({ok:true});expect(proof.strategy.allocatedUsd).toBe('100');expect(proof.intent.timeInForce).toBe('Ioc');
    });expect(fetcher).toHaveBeenCalled();
  });
  it('holds a fresh independently observed market while preserving the original prepared market timestamp',async()=>{
    let clock=now;const {reservations}=await genuineSizing(()=>clock);clock++;
    await scopes.run(id(),async(_scope,session)=>{
      const proof=await source.bind(session,{accountId:'account',key:f.reservations.own.key}).forHold();expect(proof.market.observedAt).toBe(now+1);
      const held=await reservations.hold(session,proof);expect(held.payload.intent.market!.observedAt).toBe(now);
      expect(held.payload.fingerprint).toBe(intentFingerprint(f.intent,f.action));
    });
  });
  it('keeps held sign/submit risk bound to the same original session and refuses a successor exemption',async()=>{
    const {reservations}=await genuineSizing();let permit!:Awaited<ReturnType<AccountRiskExecutionGate['assertReady']>>;
    await scopes.run(id(),async(_scope,session)=>{
      const bound=source.bind(session,{accountId:'account',key:f.reservations.own.key}),proof=await bound.forHold();
      const providerCalls=fetcher.mock.calls.length;
      expect(await reservations.hold(session,proof)).toMatchObject({state:'held',revision:1,attemptedAt:null});
      let [row]=await session.read(sql=>sql.select().from(copyLiveExecutions));
      const gate=new AccountRiskExecutionGate(bound.proofSource,()=>now);
      permit=await gate.assertReady({phase:'sign',intent:f.intent,record:row!.record as unknown as LiveExecutionRecord});expect(()=>permit.assertFresh()).not.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(providerCalls);
      await session.transaction(async tx=>{await tx.update(copyLiveExecutions).set({state:'submitting',record:{...row!.record,state:'submitting'}});await session.scope.assertHeld();});
      [row]=await session.read(sql=>sql.select().from(copyLiveExecutions));
      permit=await gate.assertReady({phase:'submit',intent:f.intent,record:row!.record as unknown as LiveExecutionRecord});expect(()=>permit.assertFresh()).not.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(providerCalls);
    });
    expect(()=>permit.assertFresh()).toThrow('live_risk_serialization_lost');
    await scopes.run(id(),async(_scope,session)=>{const [row]=await session.read(sql=>sql.select().from(copyLiveExecutions));
      await expect(source.bind(session,{accountId:'account',key:f.reservations.own.key}).proofSource.read({phase:'submit',intent:f.intent,record:row!.record as unknown as LiveExecutionRecord})).rejects.toThrow();
    });
  });
  it('denies substitution of retained original sizing equity rather than granting a larger canonical order',async()=>{
    await genuineSizing();const [p]=await db.select().from(copyLiveIntentProvenance),envelope=structuredClone(p!.sizingBasis) as unknown as {basis:{follower:{equity:string}}};envelope.basis.follower.equity='99999';
    await db.update(copyLiveIntentProvenance).set({sizingBasis:envelope as never});await scopes.run(id(),async(_scope,session)=>{await expect(source.bind(session,{accountId:'account',key:f.reservations.own.key}).forHold()).rejects.toThrow('live_risk_generation_unproven');});expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses actual current holdings not reconstructed by the original generation receipt chain',async()=>{
    const {state}=await genuineSizing();state.marginSummary.totalNtlPos='100';state.marginSummary.totalMarginUsed='10';state.crossMarginSummary.totalNtlPos='100';state.crossMarginSummary.totalMarginUsed='10';state.withdrawable='90';
    state.assetPositions.push({type:'oneWay',position:{coin:'BTC',szi:'1',entryPx:'100',positionValue:'100',unrealizedPnl:'0',marginUsed:'10',maxLeverage:20,leverage:{type:'cross',value:10},cumFunding:{allTime:'0',sinceOpen:'0',sinceChange:'0'}}});
    await scopes.run(id(),async(_scope,session)=>{await expect(source.bind(session,{accountId:'account',key:f.reservations.own.key}).forHold()).rejects.toThrow('live_generation_unproven');});
  });
  it('retains the oldest all-venue provider time through the captured source callback after signing reads',async()=>{
    let clock=now;const {reservations,state}=await genuineSizing(()=>clock);state.time=now-5000;
    await scopes.run(id(),async(_scope,session)=>{
      const bound=source.bind(session,{accountId:'account',key:f.reservations.own.key});await reservations.hold(session,await bound.forHold());
      const [row]=await session.read(sql=>sql.select().from(copyLiveExecutions));const evidence=await bound.proofSource.read({phase:'sign',intent:f.intent,record:row!.record as unknown as LiveExecutionRecord});
      expect(()=>evidence.assertHeld()).not.toThrow();clock++;expect(()=>evidence.assertHeld()).toThrow('live_risk_stale');
    });
  });
  it('does not reuse retained frames to bypass a newly changed SQL control',async()=>{
    const {reservations}=await genuineSizing();await scopes.run(id(),async(_scope,session)=>{
      const bound=source.bind(session,{accountId:'account',key:f.reservations.own.key});await reservations.hold(session,await bound.forHold());
      const calls=fetcher.mock.calls.length;await session.transaction(async tx=>{await tx.update(copyControls).set({pauseNewRisk:true}).where(eq(copyControls.scope,'user'));await session.scope.assertHeld();});
      const [row]=await session.read(sql=>sql.select().from(copyLiveExecutions));await expect(bound.proofSource.read({phase:'sign',intent:f.intent,record:row!.record as unknown as LiveExecutionRecord})).rejects.toThrow('live_risk_local_changed');
      expect(fetcher).toHaveBeenCalledTimes(calls);
    });
  });
  it('refuses an expired private epoch without repeating reads or restamping provider clocks',async()=>{
    let clock=now;const {reservations}=await genuineSizing(()=>clock);await scopes.run(id(),async(_scope,session)=>{
      const bound=source.bind(session,{accountId:'account',key:f.reservations.own.key});await reservations.hold(session,await bound.forHold());
      const calls=fetcher.mock.calls.length;clock+=5001;
      const [row]=await session.read(sql=>sql.select().from(copyLiveExecutions));await expect(bound.proofSource.read({phase:'sign',intent:f.intent,record:row!.record as unknown as LiveExecutionRecord})).rejects.toThrow('live_risk_stale');
      expect(fetcher).toHaveBeenCalledTimes(calls);
    });
  });
  it('collects the genuine account generation SQL manifest without recursive historical sizing observations',async()=>{
    const baseline=captureLivePositionBaseline({mandateId:'mandate',accountId:'account',strategyId:9,firstExecutionKey:f.reservations.own.key,network:'testnet',accountAddress:f.identity.accountAddress},f.accountSource.snapshot,now);
    await db.insert(copyLivePositionBaselines).values({...baseline,record:baseline as never,observedAt:new Date(baseline.observedAt),completedAt:new Date(baseline.completedAt),createdAt:new Date(baseline.createdAt)});
    await scopes.run(id(),async(_scope,session)=>{
      const manifest=await session.read(async sql=>{const prep=await authority.loadLivePreparationAuthority(session,sql,{accountId:'account',mandateId:'mandate'},now);return loadLiveGenerationManifest(session,sql,prep,{currentExecutionKey:f.reservations.own.key,now});});
      expect(manifest.baseline).toEqual(baseline);expect(manifest.journals).toHaveLength(1);
      expect(manifest.journals[0]!.provenance).toMatchObject({sizingBasisDigest:liveSourceDigest({})});
      expect(manifest.journals[0]!.provenance).not.toHaveProperty('sizingBasis');
      expect(manifest.journals[0]!.journal.updatedAt).toBe(new Date(now).toISOString());expect(manifest.journals[0]!.reservation).toBeNull();
      expect(manifest.receipts).toEqual([]);expect(manifest.scan).toBeNull();expect(manifest.checkedAt).toBe(now);
    });
  });
  it('loads the same current preparation authority before immutable journal provenance exists',async()=>{
    await db.delete(copyLiveIntentProvenance);
    const read=(authority as unknown as {loadLivePreparationAuthority?: (...args:unknown[])=>Promise<{identity:unknown;currentAuthorization:unknown;builder:unknown}>}).loadLivePreparationAuthority;
    expect(read).toBeTypeOf('function');
    await scopes.run(id(),async(_scope,session)=>{
      const prepared=await session.read(sql=>read!(session,sql,{accountId:'account',mandateId:'mandate'},now));
      expect(prepared.identity).toMatchObject({accountId:'account',userId:1,strategyId:9,network:'testnet',strategyVersion:2,authorizationVersion:4});
      expect(prepared.currentAuthorization).toMatchObject({id:'grant',walletId:'agent',network:'testnet',accountAddress:f.identity.accountAddress});
      expect(prepared.builder).toMatchObject({builderAddress:null,builderFeeTenthsBps:0});
    });expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects a legacy account-only lock even for valid source provenance',async()=>{
    await scopes.run({userId:1,network:'testnet',accountAddress:f.identity.accountAddress},async(_scope,session)=>{await expect(source.bind(session,{accountId:'account',key:f.reservations.own.key}).forHold()).rejects.toThrow('live_risk_source_scope_missing');});expect(fetcher).not.toHaveBeenCalled();
  });
  it('counts only live accounts and this account\'s transfers: stopped copies and another copy\'s funding no longer block (one-click plan §3i)',async()=>{
    const hex=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
    for(let n=20;n<29;n++){
      await db.insert(copyStrategies).values({id:n,userId:1,mode:'testnet',leaderAddress:hex(1000+n),allocated:'0',cash:'0',status:'stopped',activatedAt:new Date(now),stoppedAt:new Date(now)});
      await db.insert(copyExecutionAccounts).values({id:`old-${n}`,userId:1,strategyId:n,network:'testnet',state:'ready',address:hex(n),privyUserId:'did:privy:risk-source',externalId:`old-${n}`,privyWalletId:`old-master-${n}`,ownerQuorumId:'owner'});
    }
    await db.insert(copyStrategies).values({id:30,userId:1,mode:'testnet',leaderAddress:hex(2000),allocated:'0',cash:'0',status:'paused',activatedAt:new Date(now)});
    await db.insert(copyExecutionAccounts).values({id:'other-live',userId:1,strategyId:30,network:'testnet',state:'ready',address:hex(30),privyUserId:'did:privy:risk-source',externalId:'other-live',privyWalletId:'other-master',ownerQuorumId:'owner'});
    await db.insert(copyFundingOperations).values({id:'other-funding',userId:1,accountId:'other-live',strategyId:30,idempotencyKey:'other-funding-0001',network:'testnet',address:`0x${'55'.repeat(20)}`,destination:hex(30),amount:'10',nonce:now,status:'unknown'});
    // Past the account and transfer checks: the next proof missing is the baseline.
    await scopes.run(id(),async(_scope,session)=>{await expect(source.bind(session,{accountId:'account',key:f.reservations.own.key}).forHold()).rejects.toThrow('live_risk_baseline_unproven');});
    // Nine copies still running are more than one user's coverage.
    for(let n=20;n<28;n++)await db.update(copyStrategies).set({status:'paused',stoppedAt:null}).where(eq(copyStrategies.id,n));
    await scopes.run(id(),async(_scope,session)=>{await expect(source.bind(session,{accountId:'account',key:f.reservations.own.key}).forHold()).rejects.toThrow('live_risk_user_coverage_unproven');});
    expect(fetcher).not.toHaveBeenCalled();
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
