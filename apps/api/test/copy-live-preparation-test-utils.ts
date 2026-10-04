import { liveCopyMandateIntentSchema } from '@trading-dashboard/shared/contracts';
import { copyExecutionAccounts,copyStrategies,copyAgentSetups,copyExecutionWallets,copyWalletAuthorizations,copyLiveMandates,copyLiveStrategyConfigs,copyStrategyVersions,copyLiveSourceStreams,copyLiveSourceFills,copyRiskPolicies,copyControls,users,appSettings } from '@trading-dashboard/shared/database';
import { liveCopySettingsDigest } from '../src/copy/copy-live-mandate-consent.js';
import { digest as mandateDigest } from '../src/copy/copy-live-mandate-evidence.js';
import { parseLiveSourceFill } from '../src/copy/live/copy-live-source-evidence.js';
import { fixture,now } from './copy-live-risk-test-utils.js';
import { insertUser,truncateAll,type TestDb } from './db-test-utils.js';
export async function preparationFixture(db:TestDb, sizingMode:'fixed'|'ratio'='fixed') {
  await truncateAll(db);const f=fixture();
const user=await insertUser(db,{privyUserId:'did:privy:risk-source'});
  if(user.id!==f.identity.userId)throw Error('Fixture owner mismatch');
  await db.insert(copyStrategies).values({id:9,userId:user.id,mode:'testnet',leaderAddress:`0x${'44'.repeat(20)}`,allocated:'0',cash:'0',status:'active',activatedAt:new Date(now)});
  await db.insert(copyExecutionAccounts).values({id:'account',userId:user.id,strategyId:9,network:'testnet',state:'ready',address:f.identity.accountAddress,privyUserId:user.privyUserId,externalId:'source-master',privyWalletId:'master',ownerQuorumId:'owner'});

  const ownerAddress=`0x${'55'.repeat(20)}`,settings={...f.strategy.settings,sizingMode,perTradeUsd:sizingMode==='fixed'?10:null,copyStartMode:'delta' as const};
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
  await db.insert(copyRiskPolicies).values({version:3,limits:{...f.policy.limits}});
  await db.insert(copyControls).values([{scope:'platform',scopeId:0},{scope:'user',scopeId:1}]);
  await db.insert(appSettings).values({key:'general',value:{copyTradingEnabled:true}});
  return {f,consent,fill};
}
