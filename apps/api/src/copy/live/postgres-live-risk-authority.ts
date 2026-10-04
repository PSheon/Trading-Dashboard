import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import { adminSettingsSchema, copyRiskLimitsSchema, copyStrategySettingsSchema } from '@trading-dashboard/shared/contracts';
import { appSettings, copyAgentSetups, copyControls, copyExecutionAccounts, copyExecutionWallets, copyFollowerAccountState, copyFundingOperations,
  copyAccountModeOperations, copyLivePositionBaselines, copyLiveExecutions, copyLiveIntentProvenance, copyLiveMandates, copyLiveRiskReservations, copyLiveSignalLegs, copyLiveSourceFills, copyLiveSourceStreams,
  copyLiveStrategyConfigs, copyRiskPolicies, copyStrategies, copyStrategyVersions, copyWalletAuthorizations, users, walletWithdrawals } from '@trading-dashboard/shared/database';
import type { DbExecutor } from '../../db/unit-of-work.js';
import type { LiveRiskDatabaseSession } from './postgres-live-risk-scope.js';
import { decodeLiveCopyMandate } from '../copy-live-mandate-evidence.js';
import { liveCopySettingsDigest } from '../copy-live-mandate-consent.js';
import { canonicalLiveSourceLegs, decodeLiveSourceFill, liveSourceDigest, liveSourceLegId } from './copy-live-source-evidence.js';
import { decodeLivePositionBaseline } from './live-position-baseline.js';
import { buildOrderAction, executionKey, intentFingerprint, type LiveOrderIntent } from './live-order.js';
import type { LiveExecutionRecord } from './live-execution.js';
import { address, assertSameAuthorization, assertWalletAuthorization, LiveBoundaryError } from './wallet-authorization.js';

export function riskSourceRequire(value: unknown, code: string): asserts value { if (!value) throw new LiveBoundaryError(code); }
export const riskSourceDigest = (value: unknown) => liveSourceDigest(JSON.parse(JSON.stringify(value)) as unknown);
/** Shared current authority, before an execution journal/provenance exists.
 * Requires the original source/account lock and performs only SQL reads. */
export async function loadLivePreparationAuthority(session:LiveRiskDatabaseSession,db:DbExecutor,raw:{accountId:string;mandateId:string},now:number) {
  const binding=structuredClone(raw); session.scope.assertFresh();
  const read=async<T>(work:PromiseLike<T>):Promise<T>=>{const result=await work;await session.scope.assertHeld();return result;};
  const [row]=await read(db.select({account:copyExecutionAccounts,owner:users,strategy:copyStrategies,config:copyLiveStrategyConfigs,version:copyStrategyVersions,
    mandate:copyLiveMandates,setup:copyAgentSetups,wallet:copyExecutionWallets,grant:copyWalletAuthorizations})
    .from(copyExecutionAccounts).innerJoin(users,eq(users.id,copyExecutionAccounts.userId))
    .innerJoin(copyStrategies,eq(copyStrategies.id,copyExecutionAccounts.strategyId))
    .innerJoin(copyLiveStrategyConfigs,eq(copyLiveStrategyConfigs.strategyId,copyStrategies.id))
    .innerJoin(copyStrategyVersions,and(eq(copyStrategyVersions.strategyId,copyStrategies.id),eq(copyStrategyVersions.version,copyStrategies.version)))
    .innerJoin(copyLiveMandates,eq(copyLiveMandates.id,binding.mandateId)).innerJoin(copyAgentSetups,eq(copyAgentSetups.id,copyLiveMandates.setupId))
    .innerJoin(copyExecutionWallets,eq(copyExecutionWallets.id,copyLiveMandates.executionWalletId)).innerJoin(copyWalletAuthorizations,eq(copyWalletAuthorizations.id,copyLiveMandates.authorizationId))
    .where(eq(copyExecutionAccounts.id,binding.accountId)));
  riskSourceRequire(row,'live_risk_authority_missing');
  const {account:a,owner:o,strategy:s,config:c,version:v,mandate:m,setup,wallet:w,grant:g}=row;
  const scope=session.scope.identity;
  riskSourceRequire(a.id===binding.accountId&&a.userId===scope.userId&&a.network==='testnet'&&scope.network==='testnet'&&a.address===scope.accountAddress&&a.state==='ready'&&
    a.privyWalletId&&a.ownerQuorumId&&a.privyUserId===o.privyUserId&&o.disabledAt===null,'live_risk_identity');
  const consent=decodeLiveCopyMandate(m),settings=copyStrategySettingsSchema.parse(v.settings);
  riskSourceRequire(scope.source?.network===consent.sourceNetwork&&scope.source.leaderAddress===consent.leaderAddress,'live_risk_source_scope_missing');
  riskSourceRequire(s.userId===a.userId&&s.mode==='testnet'&&s.status==='active'&&m.state==='active'&&m.consentDigest&&m.activationCursor&&m.expiresAt.getTime()>now&&
    consent.accountId===a.id&&consent.userId===a.userId&&consent.strategyId===s.id&&consent.accountRevision===a.revision&&consent.accountAddress===a.address&&
    consent.ownerPrivyUserId===o.privyUserId&&consent.ownerAddress===o.embeddedWalletAddress&&consent.strategyVersion===s.version&&
    c.strategyVersion===s.version&&c.userId===a.userId&&['testnet','mainnet'].includes(c.sourceNetwork)&&consent.sourceNetwork===c.sourceNetwork&&c.budgetUsd===consent.budgetUsd&&
    consent.leaderAddress===s.leaderAddress&&consent.settingsDigest===liveCopySettingsDigest(settings)&&consent.plannerVersion===1,'live_risk_mandate_changed');
  riskSourceRequire(setup.state==='active'&&setup.revision===consent.setupRevision&&setup.userId===a.userId&&setup.strategyId===s.id&&setup.accountId===a.id&&setup.network===a.network&&
    setup.accountAddress===a.address&&setup.accountWalletId===a.privyWalletId&&setup.accountOwnerQuorumId===a.ownerQuorumId&&setup.agentWalletId===w.privyWalletId&&setup.agentAddress===w.signerAddress&&
    setup.agentOwnerQuorumId===w.privyOwnerId&&setup.authorizationId===g.id&&setup.policyId===consent.policyId&&setup.policyFingerprint===consent.policyFingerprint&&setup.workerQuorumId===consent.workerQuorumId&&
    w.userId===a.userId&&w.strategyId===s.id&&w.network===a.network&&w.accountAddress===a.address&&w.privyOwnerId===a.ownerQuorumId&&w.retiredAt===null&&
    w.privyWalletId===consent.agentWalletId&&w.signerAddress===consent.agentAddress&&g.walletId===w.id&&g.version===consent.authorizationVersion&&setup.expiresAt.getTime()===g.expiresAt.getTime(),'live_risk_grant_changed');
  const current={id:g.id,version:g.version,userId:a.userId,strategyId:s.id,walletId:w.privyWalletId,privyOwnerId:w.privyOwnerId,signerAddress:address(w.signerAddress),
    accountAddress:address(a.address),network:a.network,scopes:g.scopes,validFrom:g.validFrom.getTime(),expiresAt:g.expiresAt.getTime(),revokedAt:g.revokedAt?.getTime()??null,exchangeApprovedAt:g.exchangeApprovedAt?.getTime()??null};
  const currentAuthorization=assertWalletAuthorization(current,{authorizationId:g.id,userId:a.userId,strategyId:s.id,walletId:w.privyWalletId,network:a.network,accountAddress:address(a.address),reduceOnly:false},now);
  riskSourceRequire(settings.copyStartMode==='delta','live_risk_adoption_unproven');
  const [policy]=await read(db.select().from(copyRiskPolicies).orderBy(desc(copyRiskPolicies.version)).limit(1));
  riskSourceRequire(policy&&Object.keys(copyRiskLimitsSchema.innerType().shape).every(k=>Object.hasOwn(policy.limits,k)),'live_risk_policy_missing');
  const limits=copyRiskLimitsSchema.parse(policy.limits);
  const controls=await read(db.select().from(copyControls).where(sql`${copyControls.scope}='platform' or (${copyControls.scope}='user' and ${copyControls.scopeId}=${a.userId})`));
  const platform=controls.find(c=>c.scope==='platform'&&c.scopeId===0),user=controls.find(c=>c.scope==='user'&&c.scopeId===a.userId);
  riskSourceRequire(controls.length===2&&platform&&user,'live_risk_controls_unproven');
  const general=await read(db.select().from(appSettings).where(eq(appSettings.key,'general')));
  riskSourceRequire(general.length===1&&(general[0]!.value as {copyTradingEnabled?:unknown}).copyTradingEnabled===true,'live_risk_platform_disabled');
  const [revenue]=await read(db.select().from(appSettings).where(eq(appSettings.key,'revenue')));
  const builder=revenue?adminSettingsSchema.shape.revenue.parse(revenue.value):{builderAddress:null,builderFeeTenthsBps:0};
  riskSourceRequire((builder.builderAddress?.toLowerCase()??null)===consent.builderAddress&&builder.builderFeeTenthsBps===consent.builderMaxFeeTenthsOfBps,'live_risk_builder_changed');
  const accounts=await read(db.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.userId,a.userId)).orderBy(copyExecutionAccounts.id).limit(9));
  riskSourceRequire(accounts.length<=8&&accounts.every(account=>account.network==='testnet'&&account.address&&account.privyWalletId&&account.ownerQuorumId&&account.privyUserId===o.privyUserId),'live_risk_user_coverage_unproven');
  const states=await read(db.select().from(copyFollowerAccountState).where(sql`${copyFollowerAccountState.accountId} in (select id from copy_execution_accounts where user_id=${a.userId})`));
  riskSourceRequire(!states.some(state=>state.quarantined),'live_risk_quarantined');
  const pending=await read(db.select({id:copyFundingOperations.id}).from(copyFundingOperations).where(and(eq(copyFundingOperations.userId,a.userId),sql`${copyFundingOperations.status} in ('prepared','unknown','accepted')`)).limit(1));
  const withdrawals=await read(db.select({id:walletWithdrawals.id}).from(walletWithdrawals).where(and(eq(walletWithdrawals.userId,a.userId),sql`${walletWithdrawals.status} in ('prepared','unknown','accepted')`)).limit(1));
  riskSourceRequire(pending.length===0&&withdrawals.length===0,'live_risk_transfer_pending');
  const modes=await read(db.select({id:copyAccountModeOperations.id}).from(copyAccountModeOperations).where(and(eq(copyAccountModeOperations.userId,a.userId),sql`${copyAccountModeOperations.submissionState} in ('signing','unknown') or (${copyAccountModeOperations.submissionState}='accepted' and ${copyAccountModeOperations.targetState}<>'supported')`)).limit(1));
  riskSourceRequire(modes.length===0,'live_risk_mode_pending');
  const [sourceStream]=await read(db.select().from(copyLiveSourceStreams).where(and(eq(copyLiveSourceStreams.network,consent.sourceNetwork),eq(copyLiveSourceStreams.leaderAddress,consent.leaderAddress))));
  riskSourceRequire(sourceStream&&sourceStream.state==='ready'&&sourceStream.coverageFrom&&sourceStream.coverageThrough&&sourceStream.coverageDigest&&sourceStream.coverageFrom.getTime()<=m.activationCursor!.getTime(),'live_risk_source_changed');
  const identity={accountId:a.id,userId:a.userId,strategyId:s.id,strategyVersion:s.version,policyVersion:policy.version,authorizationVersion:g.version,
    authorizationId:g.id,walletId:w.privyWalletId,network:'testnet' as const,accountAddress:a.address,dedicated:true as const};
  return {...row,consent,settings,currentAuthorization,identity,policy:{version:policy.version,limits},limits,builder,platform,user,
    controls:{platform:{pauseNewRisk:platform.pauseNewRisk,reduceOnly:platform.reduceOnly},user:{pauseNewRisk:user.pauseNewRisk,reduceOnly:user.reduceOnly},strategy:{pauseNewRisk:s.pauseNewRisk,reduceOnly:s.reduceOnly}},
    sourceStream,accounts,states,general,revenue,controlsRows:controls};
}
export type LivePreparationAuthority=Awaited<ReturnType<typeof loadLivePreparationAuthority>>;

/** Only invoked inside the original session's read-only transaction. */
export async function loadLiveRiskAuthority(session: LiveRiskDatabaseSession, db: DbExecutor, binding: {accountId:string;key:string}, now:number) {
  const read = async <T>(work:PromiseLike<T>):Promise<T> => { const result=await work;await session.scope.assertHeld();return result; };
  const [p] = await read(db.select().from(copyLiveIntentProvenance).where(eq(copyLiveIntentProvenance.key,binding.key)));
  riskSourceRequire(p,'live_risk_provenance_missing');
  riskSourceRequire(JSON.stringify(p.intent).length<=16384&&Buffer.byteLength(JSON.stringify(p.sizingBasis))<=2*1024*1024,'live_risk_source_unbounded');
  const prep=await loadLivePreparationAuthority(session,db,{accountId:binding.accountId,mandateId:p.mandateId},now);
  const [execution]=await read(db.select({leg:copyLiveSignalLegs,fill:copyLiveSourceFills,stream:copyLiveSourceStreams,journal:copyLiveExecutions})
    .from(copyLiveIntentProvenance).innerJoin(copyLiveSignalLegs,eq(copyLiveSignalLegs.id,copyLiveIntentProvenance.legId))
    .innerJoin(copyLiveSourceFills,eq(copyLiveSourceFills.id,copyLiveSignalLegs.sourceFillId)).innerJoin(copyLiveSourceStreams,eq(copyLiveSourceStreams.id,copyLiveSourceFills.streamId))
    .innerJoin(copyLiveExecutions,eq(copyLiveExecutions.key,copyLiveIntentProvenance.key)).where(eq(copyLiveIntentProvenance.key,binding.key)));
  riskSourceRequire(execution,'live_risk_authority_missing');
  const row={account:prep.account,owner:prep.owner,strategy:prep.strategy,config:prep.config,version:prep.version,mandate:prep.mandate,setup:prep.setup,wallet:prep.wallet,grant:prep.grant,...execution};
  riskSourceRequire(JSON.stringify(row.journal.record).length<=16384&&JSON.stringify(row.fill.raw).length<=262144,'live_risk_source_unbounded');
  const {account:a,strategy:s,mandate:m,wallet:w,grant:g,leg,stream,journal:j}=row;
  const {consent,settings}=prep;
  riskSourceRequire(p.settingsDigest===consent.settingsDigest&&p.mandateRevision===m.revision&&p.plannerVersion===1,'live_risk_mandate_changed');
  const intent=structuredClone(p.intent) as unknown as LiveOrderIntent,record=structuredClone(j.record) as unknown as LiveExecutionRecord;
  const action=buildOrderAction(intent),fingerprint=intentFingerprint(intent,action);
  riskSourceRequire(intent.network===a.network&&intent.userId===a.userId&&intent.strategyId===s.id&&intent.accountAddress===a.address&&intent.walletId===w.privyWalletId&&intent.authorizationId===g.id&&
    executionKey(intent)===binding.key&&p.fingerprint===fingerprint&&record.key===j.key&&record.fingerprint===fingerprint&&isDeepStrictEqual(action,record.action)&&isDeepStrictEqual(intent.market,record.market)&&
    j.userId===a.userId&&j.strategyId===s.id&&j.network===a.network&&j.accountAddress===a.address&&j.signerAddress===w.signerAddress&&j.cloid===intent.cloid&&j.nonce===record.nonce&&
    j.state===record.state&&j.updatedAt.getTime()===record.updatedAt&&['prepared','submitting'].includes(j.state)&&Number.isSafeInteger(record.nonce)&&record.nonce>=record.createdAt&&
    record.createdAt<=now&&record.updatedAt>=record.createdAt&&record.expiresAfter>now&&record.expiresAfter<=record.createdAt+60000&&p.admittedAt.getTime()<=record.createdAt,'live_risk_record_mismatch');
  assertSameAuthorization(record.authorization,assertWalletAuthorization(prep.currentAuthorization,intent,now));
  const fill=decodeLiveSourceFill(row.fill),canonical=canonicalLiveSourceLegs(fill).find(l=>l.leg===leg.leg);
  riskSourceRequire(canonical&&leg.id===liveSourceLegId(m.id,fill.id,leg.leg)&&leg.mandateId===m.id&&leg.executionKey===binding.key&&leg.state==='prepared'&&
    leg.sign===canonical.sign&&leg.size===canonical.size&&leg.fraction===canonical.fraction&&leg.tradeKey===canonical.tradeKey&&p.sourceDigest===fill.sourceDigest&&
    fill.network===consent.sourceNetwork&&fill.leaderAddress===consent.leaderAddress&&fill.providerTime>m.activationCursor!.getTime()&&fill.receivedAt<=p.admittedAt.getTime()&&
    stream.state==='ready'&&stream.network===fill.network&&stream.leaderAddress===fill.leaderAddress&&stream.coverageFrom&&stream.coverageThrough&&stream.coverageDigest&&
    stream.coverageFrom.getTime()<=m.activationCursor!.getTime()&&stream.coverageThrough.getTime()>=fill.providerTime,'live_risk_source_changed');
  const {policy,limits,platform,user,accounts,states,general,revenue,controlsRows:controls}=prep;
  riskSourceRequire(intent.builder?intent.builder.address===consent.builderAddress&&intent.builder.feeTenthsBps<=consent.builderMaxFeeTenthsOfBps:consent.builderMaxFeeTenthsOfBps===0,'live_risk_builder_changed');
  const liabilities=await read(db.select({reservation:copyLiveRiskReservations,journal:copyLiveExecutions,historicalGrant:copyWalletAuthorizations,historicalWallet:copyExecutionWallets}).from(copyLiveRiskReservations)
    .innerJoin(copyLiveExecutions,eq(copyLiveExecutions.key,copyLiveRiskReservations.key))
    .leftJoin(copyWalletAuthorizations,eq(copyWalletAuthorizations.id,copyLiveRiskReservations.authorizationId))
    .leftJoin(copyExecutionWallets,eq(copyExecutionWallets.id,copyWalletAuthorizations.walletId)).where(and(eq(copyLiveRiskReservations.userId,a.userId),ne(copyLiveRiskReservations.state,'released'))).orderBy(copyLiveRiskReservations.key).limit(5002));
  riskSourceRequire(liabilities.length<=5001&&JSON.stringify(liabilities).length<=8*1024*1024,'live_risk_user_coverage_unbounded');
  const orphan=await read(db.select({key:copyLiveExecutions.key}).from(copyLiveExecutions).leftJoin(copyLiveRiskReservations,eq(copyLiveRiskReservations.key,copyLiveExecutions.key))
    .where(and(eq(copyLiveExecutions.userId,a.userId),sql`${copyLiveExecutions.state} in ('prepared','submitting','unknown','resting')`,sql`(${copyLiveRiskReservations.key} is null or ${copyLiveRiskReservations.state}='released')`,ne(copyLiveExecutions.key,binding.key))).limit(1));
  riskSourceRequire(orphan.length===0,'live_risk_orphan_execution');
  const recent=await read(db.select({key:copyLiveExecutions.key}).from(copyLiveExecutions).where(and(eq(copyLiveExecutions.userId,a.userId),ne(copyLiveExecutions.key,binding.key),sql`(${copyLiveExecutions.record}->>'createdAt')::numeric >= ${now-60000}`)).limit(limits.maxOrdersPerMinute+1));
  const [baselineRow]=await read(db.select().from(copyLivePositionBaselines).where(eq(copyLivePositionBaselines.mandateId,m.id)));
  let baseline:ReturnType<typeof decodeLivePositionBaseline>|null=null;
  if(baselineRow) {
    baseline=decodeLivePositionBaseline({mandateId:m.id,accountId:a.id,strategyId:s.id,network:'testnet',accountAddress:a.address,firstExecutionKey:baselineRow.firstExecutionKey},baselineRow.record);
    for(const field of ['mandateId','accountId','strategyId','network','accountAddress','firstExecutionKey','sourceDigest','snapshotDigest','baselineDigest','producerVersion'] as const)
      riskSourceRequire(baselineRow[field]===baseline[field],'live_risk_baseline_unproven');
    riskSourceRequire(baselineRow.observedAt.getTime()===baseline.observedAt&&baselineRow.completedAt.getTime()===baseline.completedAt&&baselineRow.createdAt.getTime()===baseline.createdAt,'live_risk_baseline_unproven');
    const [first]=await read(db.select({journal:copyLiveExecutions,provenance:copyLiveIntentProvenance}).from(copyLiveExecutions).innerJoin(copyLiveIntentProvenance,eq(copyLiveIntentProvenance.key,copyLiveExecutions.key)).where(eq(copyLiveExecutions.key,baseline.firstExecutionKey)));
    const firstRecord=first?.journal.record as unknown as LiveExecutionRecord;
    riskSourceRequire(first&&first.provenance.mandateId===m.id&&first.journal.network===a.network&&first.journal.accountAddress===a.address&&first.journal.userId===a.userId&&first.journal.strategyId===s.id&&
      firstRecord.key===baseline.firstExecutionKey&&firstRecord.createdAt>=baseline.createdAt&&first.provenance.admittedAt.getTime()>=baseline.createdAt,'live_risk_baseline_unproven');
  }
  const identity=prep.identity;
  return {binding,row,preparation:prep,provenance:p,consent,fill,intent,record,action,settings,policy:{version:policy.version,limits},identity,
    controls:{platform:{pauseNewRisk:platform.pauseNewRisk,reduceOnly:platform.reduceOnly},user:{pauseNewRisk:user.pauseNewRisk,reduceOnly:user.reduceOnly},strategy:{pauseNewRisk:s.pauseNewRisk,reduceOnly:s.reduceOnly}},
    baseline,accounts,liabilities,recent,states,general,revenue,controlsRows:controls};
}
export type LiveRiskAuthority=Awaited<ReturnType<typeof loadLiveRiskAuthority>>;
