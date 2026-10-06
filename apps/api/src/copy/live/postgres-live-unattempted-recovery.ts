import {and,eq,inArray,or,sql} from 'drizzle-orm';
import {loadMergedMembers} from './copy-live-merged-members.js';
import {isDeepStrictEqual} from 'node:util';
import {copyExecutionAccounts,copyExecutionWallets,copyWalletAuthorizations,copyWalletAuthorizationEvents,copyAgentSetups,copyStrategies,users,copyLiveExecutions,copyLiveRiskReservations,copyLiveExecutionEvidence,copyFollowerReceipts,copyLiveIntentProvenance,copyLiveSignalLegs,copyLiveReductionCarry,copyLiveSourceFills,copyLiveMandates,copyLiveStrategyConfigs,copyStrategyVersions,copyRiskPolicies} from '@trading-dashboard/shared/database';
import {copyRiskLimitsSchema,copyStrategySettingsSchema} from '@trading-dashboard/shared/contracts';
import type {DbTransaction} from '../../db/unit-of-work.js';
import {assertOriginalLiveRiskSession,type LiveRiskDatabaseSession} from './postgres-live-risk-scope.js';
import {LiveBoundaryError} from './wallet-authorization.js';
import {decodeLiveCopyMandate} from '../copy-live-mandate-evidence.js';
import {decodeLiveSourceSizingEnvelope,planLiveSourceOrder} from './copy-live-source-planner.js';
import {canonicalLiveSourceLegs,decodeLiveSourceFill,liveSourceDigest} from './copy-live-source-evidence.js';
import {decodeLiveExecutionRow} from './postgres-live-journal.js';
import {captureLiveUnattemptedRelease,decodeLiveUnattemptedRelease,assertLiveUnattemptedReleaseMirrors,type LiveUnattemptedReleaseCertificate,type LiveUnattemptedCarry} from './live-unattempted-release.js';
import type {LiveGenerationJournalV1,LiveGenerationProjectionIdentity} from './copy-live-generation-projection.js';
import type {LiveExecutionRecord} from './live-execution.js';
import type {LiveOrderIntent} from './live-order.js';
function check(value:unknown):asserts value{if(!value)throw new LiveBoundaryError('live_unattempted_release_unproven');}
const canonical=<T>(value:unknown):T=>JSON.parse(JSON.stringify(value)) as T;
/** Unregistered zero-effect recovery. It uses one original account/user/source
 * lock capability and SQL only; it never queries, signs or submits an order. */
export class PostgresLiveUnattemptedRecovery {
 constructor(private readonly now=Date.now){}
 private async query<T>(session:LiveRiskDatabaseSession,work:PromiseLike<T>):Promise<T>{const result=await work;await session.scope.assertHeld();return result;}
 private fresh(at:number){const now=this.now();check(Number.isSafeInteger(now)&&now>=at&&now-at<=5000);}
 private async load(session:LiveRiskDatabaseSession,tx:DbTransaction,input:{accountId:string;key:string}){
  const [account]=await this.query(session,tx.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id,input.accountId)).for('update'));
  check(account&&account.network==='testnet'&&account.address===session.scope.identity.accountAddress&&account.userId===session.scope.identity.userId&&session.scope.identity.network==='testnet');
  const [owner]=await this.query(session,tx.select().from(users).where(eq(users.id,account.userId))),[strategy]=await this.query(session,tx.select().from(copyStrategies).where(eq(copyStrategies.id,account.strategyId)));
  check(owner&&owner.privyUserId===account.privyUserId&&strategy&&strategy.userId===account.userId&&strategy.mode==='testnet');
  const [journal]=await this.query(session,tx.select().from(copyLiveExecutions).where(eq(copyLiveExecutions.key,input.key)).for('update'));
  const [r]=await this.query(session,tx.select().from(copyLiveRiskReservations).where(eq(copyLiveRiskReservations.key,input.key)).for('update'));
  check(journal&&r&&journal.userId===account.userId&&journal.strategyId===account.strategyId&&journal.network===account.network&&journal.accountAddress===account.address&&r.accountId===account.id);
  check(Buffer.byteLength(JSON.stringify(journal.record),'utf8')<=16384);const record=decodeLiveExecutionRow(journal);
  const [p]=await this.query(session,tx.select().from(copyLiveIntentProvenance).where(eq(copyLiveIntentProvenance.key,input.key)));
  const legs=await this.query(session,tx.select().from(copyLiveSignalLegs).where(eq(copyLiveSignalLegs.executionKey,input.key)).limit(2).for('update'));
  check(p&&legs.length===1&&p.legId===legs[0]!.id);const leg=legs[0]!;
  const [m]=await this.query(session,tx.select().from(copyLiveMandates).where(eq(copyLiveMandates.id,p.mandateId))),[config]=await this.query(session,tx.select().from(copyLiveStrategyConfigs).where(eq(copyLiveStrategyConfigs.strategyId,strategy.id)));
  check(m&&config&&config.userId===account.userId&&['testnet','mainnet'].includes(config.sourceNetwork));
  const consent=decodeLiveCopyMandate(m),[fillRow]=await this.query(session,tx.select().from(copyLiveSourceFills).where(eq(copyLiveSourceFills.id,leg.sourceFillId)));
  check(fillRow);const fill=decodeLiveSourceFill(fillRow),source=session.scope.identity.source;
  check(config.sourceNetwork===consent.sourceNetwork&&source&&source.network===consent.sourceNetwork&&source.leaderAddress===fill.leaderAddress&&fill.network===consent.sourceNetwork&&fill.leaderAddress===consent.leaderAddress);
  check(m.consentDigest&&m.activationCursor&&m.revision>=p.mandateRevision&&consent.accountId===account.id&&consent.accountAddress===account.address&&consent.userId===account.userId&&consent.strategyId===strategy.id&&
   consent.ownerPrivyUserId===account.privyUserId&&consent.ownerAddress===owner.embeddedWalletAddress&&account.revision>=consent.accountRevision&&consent.authorizationId===record.authorization.id&&consent.authorizationVersion===record.authorization.version&&consent.agentWalletId===record.authorization.walletId&&consent.agentAddress===record.authorization.signerAddress&&
   r.authorizationId===consent.authorizationId&&r.authorizationVersion===consent.authorizationVersion&&r.strategyVersion===consent.strategyVersion&&r.walletId===consent.agentWalletId&&p.settingsDigest===consent.settingsDigest&&p.admittedAt.getTime()===record.createdAt);
  const [setup]=await this.query(session,tx.select().from(copyAgentSetups).where(eq(copyAgentSetups.id,consent.setupId))),[wallet]=await this.query(session,tx.select().from(copyExecutionWallets).where(eq(copyExecutionWallets.id,consent.executionWalletId))),[grant]=await this.query(session,tx.select().from(copyWalletAuthorizations).where(eq(copyWalletAuthorizations.id,consent.authorizationId)));
  check(grant);let historicalVersion=grant.version===record.authorization.version;
  if(!historicalVersion&&grant.revokedAt&&grant.version===record.authorization.version+1){
   const events=await this.query(session,tx.select().from(copyWalletAuthorizationEvents).where(and(eq(copyWalletAuthorizationEvents.authorizationId,grant.id),eq(copyWalletAuthorizationEvents.userId,account.userId),eq(copyWalletAuthorizationEvents.version,grant.version),eq(copyWalletAuthorizationEvents.action,'revoked'))).limit(2));
   const checkedAt=this.now(),revokedAt=grant.revokedAt.getTime(),eventAt=events[0]?.createdAt.getTime();
   // PostgreSQL defaultNow and app revokedAt are different clocks. Require
   // each original time to be known at this check; do not invent an ordering
   // between them or restamp either after a wait.
   historicalVersion=events.length===1&&Number.isSafeInteger(checkedAt)&&Number.isSafeInteger(revokedAt)&&revokedAt>=record.createdAt&&revokedAt<=checkedAt&&Number.isSafeInteger(eventAt)&&eventAt!>0&&eventAt!<=checkedAt;
  }
  check(setup&&wallet&&grant&&setup.userId===account.userId&&setup.strategyId===strategy.id&&setup.accountId===account.id&&setup.network===account.network&&setup.accountAddress===account.address&&setup.accountWalletId===account.privyWalletId&&setup.accountOwnerQuorumId===account.ownerQuorumId&&
   setup.authorizationId===grant.id&&setup.agentWalletId===wallet.privyWalletId&&setup.agentAddress===wallet.signerAddress&&setup.agentOwnerQuorumId===wallet.privyOwnerId&&setup.workerQuorumId===consent.workerQuorumId&&setup.policyId===consent.policyId&&setup.policyFingerprint===consent.policyFingerprint&&
   grant.walletId===wallet.id&&historicalVersion&&grant.validFrom.getTime()===record.authorization.validFrom&&grant.expiresAt.getTime()===record.authorization.expiresAt&&isDeepStrictEqual(grant.scopes,record.authorization.scopes)&&
   wallet.userId===account.userId&&wallet.strategyId===strategy.id&&wallet.network===account.network&&wallet.accountAddress===account.address&&wallet.privyWalletId===record.authorization.walletId&&wallet.signerAddress===record.authorization.signerAddress&&wallet.privyOwnerId===record.authorization.privyOwnerId&&wallet.privyOwnerId===account.ownerQuorumId);
  const [version]=await this.query(session,tx.select().from(copyStrategyVersions).where(and(eq(copyStrategyVersions.strategyId,strategy.id),eq(copyStrategyVersions.version,consent.strategyVersion)))),[policy]=await this.query(session,tx.select().from(copyRiskPolicies).where(eq(copyRiskPolicies.version,r.policyVersion)));
  check(version&&policy);const settings=copyStrategySettingsSchema.strict().parse(version.settings),envelope=decodeLiveSourceSizingEnvelope(p.sizingBasis),canonicalLeg=canonicalLiveSourceLegs(fill).find(v=>v.leg===leg.leg);
  check(canonicalLeg&&envelope.basis.mandateRevision===p.mandateRevision&&envelope.basis.settingsDigest===consent.settingsDigest);
  const members=await loadMergedMembers(envelope,fill.id,ids=>this.query(session,tx.select().from(copyLiveSourceFills).where(inArray(copyLiveSourceFills.id,ids))));
  const plan=planLiveSourceOrder({mandate:{...m,state:'active',revision:p.mandateRevision},settings,fill,leg:canonicalLeg,sizingBasis:envelope,now:record.createdAt,limits:copyRiskLimitsSchema.parse(policy.limits),currentExecutionKey:record.key,...(members?{members}:{})});
  const intent=p.intent as unknown as LiveOrderIntent;
  check(plan.legId===leg.id&&plan.fixedTradeClaim===leg.fixedTradeClaim&&plan.dependsOnLegId===leg.dependsOnId);
  for(const field of ['asset','side','size','limitPrice','sizeDecimals','reduceOnly','timeInForce'] as const)check(plan.order[field]===intent[field]);
  const [carry]=await this.query(session,tx.select().from(copyLiveReductionCarry).where(and(eq(copyLiveReductionCarry.mandateId,m.id),eq(copyLiveReductionCarry.coin,fill.coin))).for('update'));check(carry);
  const evidence=await this.query(session,tx.select().from(copyLiveExecutionEvidence).where(eq(copyLiveExecutionEvidence.key,input.key)).limit(1));check(evidence.length===0);
  const receipts=await this.query(session,tx.select({key:copyFollowerReceipts.key}).from(copyFollowerReceipts).where(or(eq(copyFollowerReceipts.executionKey,input.key),and(eq(copyFollowerReceipts.accountId,account.id),or(sql`${copyFollowerReceipts.record}->>'cloid' = ${journal.cloid}`,sql`${copyFollowerReceipts.record}->'raw'->>'cloid' = ${journal.cloid}`)))).limit(1));check(receipts.length===0);
  const {sizingBasis,...provenance}=p;
  const entry:LiveGenerationJournalV1=canonical({journal,provenance:{...provenance,sizingBasisDigest:liveSourceDigest(sizingBasis)},leg,fill:fillRow,reservation:r,evidence:null});
  const id:LiveGenerationProjectionIdentity={mandateId:m.id,mandateRevision:p.mandateRevision,accountId:account.id,userId:account.userId,strategyId:strategy.id,network:'testnet',accountAddress:account.address!,authorizationId:consent.authorizationId,settingsDigest:consent.settingsDigest,leaderAddress:consent.leaderAddress,direction:settings.direction};
  const originalCarry=envelope.observations.generationManifest.carry.find(row=>row.mandateId===m.id&&row.coin===fill.coin);check(originalCarry);
  return {entry,carry:canonical<LiveUnattemptedCarry>(carry),originalCarry,record,basis:envelope.basis,id};
 }
 async releaseExpired(session:LiveRiskDatabaseSession,raw:{accountId:string;key:string;expectedReservationRevision:number}):Promise<Readonly<LiveUnattemptedReleaseCertificate>>{
  assertOriginalLiveRiskSession(session);const input=structuredClone(raw),started=this.now();check(Number.isSafeInteger(started)&&started>0&&typeof input.accountId==='string'&&input.accountId.length>0&&input.accountId.length<=128&&typeof input.key==='string'&&input.key.length<=256&&Number.isSafeInteger(input.expectedReservationRevision)&&input.expectedReservationRevision>0);
  const certificate=await session.transaction(async tx=>{
   const loaded=await this.load(session,tx,input),{entry,carry,originalCarry,record,basis,id}=loaded,r=entry.reservation!,leg=entry.leg!;
   if(record.unattemptedRelease){const old=decodeLiveUnattemptedRelease(record.unattemptedRelease,r.releaseEvidenceDigest!);check(isDeepStrictEqual(old.original.carry,originalCarry)&&old.original.carry.revision===basis.carry.revision&&old.original.carry.carry===basis.carry.amount&&old.checkedAt<=this.now()&&(input.expectedReservationRevision===old.original.reservation!.revision||input.expectedReservationRevision===r.revision));assertLiveUnattemptedReleaseMirrors(old,entry,carry);return old;}
   check(r.revision===input.expectedReservationRevision&&isDeepStrictEqual(carry,originalCarry)&&carry.revision===basis.carry.revision&&carry.carry===basis.carry.amount);
   const checkedAt=this.now(),proof=captureLiveUnattemptedRelease({checkedAt,original:{identity:id,...entry,carry}}),saved:LiveExecutionRecord={...record,state:'rejected',updatedAt:checkedAt,errorCode:'unattempted_expired',unattemptedRelease:proof};
   check(Buffer.byteLength(JSON.stringify(saved),'utf8')<=16384);
   const j=await this.query(session,tx.update(copyLiveExecutions).set({state:'rejected',record:saved as unknown as Record<string,unknown>,updatedAt:new Date(checkedAt)}).where(and(eq(copyLiveExecutions.key,input.key),eq(copyLiveExecutions.state,'prepared'),eq(copyLiveExecutions.updatedAt,new Date(entry.journal.updatedAt)),eq(copyLiveExecutions.record,entry.journal.record))).returning({key:copyLiveExecutions.key}));check(j.length===1);
   const l=await this.query(session,tx.update(copyLiveSignalLegs).set({state:'skipped',revision:leg.revision+1,updatedAt:new Date(checkedAt)}).where(and(eq(copyLiveSignalLegs.id,leg.id),eq(copyLiveSignalLegs.state,'prepared'),eq(copyLiveSignalLegs.revision,leg.revision),eq(copyLiveSignalLegs.executionKey,input.key))).returning({id:copyLiveSignalLegs.id}));check(l.length===1);
   const changed=await this.query(session,tx.update(copyLiveRiskReservations).set({state:'released',releaseReason:'unattempted_expired',releaseEvidenceDigest:proof.digest,revision:r.revision+1,updatedAt:new Date(checkedAt)}).where(and(eq(copyLiveRiskReservations.key,input.key),eq(copyLiveRiskReservations.state,'held'),eq(copyLiveRiskReservations.revision,r.revision),sql`${copyLiveRiskReservations.attemptedAt} is null`,sql`${copyLiveRiskReservations.exchangeOrderId} is null`,sql`${copyLiveRiskReservations.releaseEvidenceDigest} is null`)).returning({key:copyLiveRiskReservations.key}));check(changed.length===1);
   session.scope.assertFresh();this.fresh(started);return proof;
  });session.scope.assertFresh();this.fresh(started);return certificate;
 }
}
