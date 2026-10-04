import { and,eq, or, sql } from 'drizzle-orm';
import { copyLivePositionBaselines,copyLiveExecutions,copyLiveIntentProvenance,copyLiveSignalLegs,copyLiveSourceFills,copyLiveRiskReservations,copyLiveExecutionEvidence,
  copyFollowerReceipts,copyFollowerLedger,copyFollowerScans,copyFollowerReceiptConflicts,copyFollowerAccountState,copyLiveReductionCarry,copyLiveMandates,copyStrategyVersions,copyRiskPolicies } from '@trading-dashboard/shared/database';
import {copyRiskLimitsSchema,copyStrategySettingsSchema} from '@trading-dashboard/shared/contracts';
import type { DbExecutor } from '../../db/unit-of-work.js';
import { assertOriginalLiveRiskSession,type LiveRiskDatabaseSession } from './postgres-live-risk-scope.js';
import { riskSourceRequire as check,type LivePreparationAuthority } from './postgres-live-risk-authority.js';
import type { LiveGenerationManifestV1,LiveGenerationJournalV1 } from './copy-live-generation-projection.js';
import { decodeLivePositionBaseline } from './live-position-baseline.js';
import { canonicalLiveSourceLegs,decodeLiveSourceFill,liveSourceDigest } from './copy-live-source-evidence.js';
import {decodeLiveSourceSizingEnvelope,planLiveSourceOrder} from './copy-live-source-planner.js';
import {decodeLiveCopyMandate} from '../copy-live-mandate-evidence.js';
import type {LiveOrderIntent} from './live-order.js';
import { freezeLiveReservation } from './live-risk-reservation.js';
import type { LiveExecutionRecord } from './live-execution.js';
const canonical=<T>(value:unknown):T=>JSON.parse(JSON.stringify(value)) as T;
/** Existing generation only. Initial empty baselines belong to the atomic
 * preparation coordinator. All quantities come from the original SQL session. */
export async function loadLiveGenerationManifest(session:LiveRiskDatabaseSession,db:DbExecutor,authority:LivePreparationAuthority,raw:{currentExecutionKey:string;now:number}):Promise<LiveGenerationManifestV1> {
  assertOriginalLiveRiskSession(session);session.scope.assertFresh();const input=structuredClone(raw),{account:a,mandate:m}=authority;
  check(a.userId===session.scope.identity.userId&&a.network==='testnet'&&a.address===session.scope.identity.accountAddress&&typeof input.currentExecutionKey==='string'&&input.currentExecutionKey.length>0&&Number.isSafeInteger(input.now)&&input.now>0,'live_risk_identity');
  const read=async<T>(work:PromiseLike<T>):Promise<T>=>{const result=await work;await session.scope.assertHeld();return result;};
  const [row]=await read(db.select().from(copyLivePositionBaselines).where(eq(copyLivePositionBaselines.mandateId,m.id)));
  check(row&&Buffer.byteLength(JSON.stringify(row.record))<=2*1024*1024,'live_risk_baseline_unproven');
  const baseline=decodeLivePositionBaseline({mandateId:m.id,accountId:a.id,strategyId:a.strategyId,network:'testnet',accountAddress:a.address!,firstExecutionKey:row.firstExecutionKey},row.record);
  for(const field of ['mandateId','accountId','strategyId','network','accountAddress','firstExecutionKey','sourceDigest','snapshotDigest','baselineDigest','producerVersion'] as const)check(row[field]===baseline[field],'live_risk_baseline_unproven');
  check(row.observedAt.getTime()===baseline.observedAt&&row.completedAt.getTime()===baseline.completedAt&&row.createdAt.getTime()===baseline.createdAt&&baseline.createdAt<=input.now,'live_risk_baseline_unproven');
  const entries=await read(db.select({journal:copyLiveExecutions,provenance:copyLiveIntentProvenance,leg:copyLiveSignalLegs,fill:copyLiveSourceFills,reservation:copyLiveRiskReservations,evidence:copyLiveExecutionEvidence})
    .from(copyLiveExecutions).leftJoin(copyLiveIntentProvenance,eq(copyLiveIntentProvenance.key,copyLiveExecutions.key))
    .leftJoin(copyLiveSignalLegs,eq(copyLiveSignalLegs.id,copyLiveIntentProvenance.legId)).leftJoin(copyLiveSourceFills,eq(copyLiveSourceFills.id,copyLiveSignalLegs.sourceFillId))
    .leftJoin(copyLiveRiskReservations,eq(copyLiveRiskReservations.key,copyLiveExecutions.key)).leftJoin(copyLiveExecutionEvidence,eq(copyLiveExecutionEvidence.key,copyLiveExecutions.key))
    .where(or(eq(copyLiveExecutions.accountAddress,a.address!),eq(copyLiveRiskReservations.accountId,a.id),eq(copyLiveExecutionEvidence.accountId,a.id))).orderBy(copyLiveExecutions.key).limit(5002));
  check(entries.length<=5001,'live_risk_generation_unbounded');
  const first=entries.find(e=>e.journal.key===baseline.firstExecutionKey),firstRecord=first?.journal.record as unknown as LiveExecutionRecord;
  check(first&&first.provenance?.mandateId===m.id&&first.journal.network==='testnet'&&first.journal.accountAddress===a.address&&first.journal.userId===a.userId&&first.journal.strategyId===a.strategyId&&firstRecord.key===baseline.firstExecutionKey&&firstRecord.createdAt>=baseline.createdAt&&first.provenance.admittedAt.getTime()>=baseline.createdAt,'live_risk_baseline_unproven');
  const receipts=await read(db.select().from(copyFollowerReceipts).where(or(eq(copyFollowerReceipts.accountId,a.id),eq(copyFollowerReceipts.accountAddress,a.address!))).orderBy(copyFollowerReceipts.key).limit(10001));
  const ledger=await read(db.select().from(copyFollowerLedger).where(sql`${copyFollowerLedger.receiptKey} in (select key from copy_follower_receipts where account_id=${a.id} or account_address=${a.address})`).orderBy(copyFollowerLedger.receiptKey,copyFollowerLedger.component).limit(30001));
  const [scan]=await read(db.select().from(copyFollowerScans).where(eq(copyFollowerScans.accountId,a.id)));
  const conflicts=await read(db.select().from(copyFollowerReceiptConflicts).where(sql`${copyFollowerReceiptConflicts.receiptKey} in (select key from copy_follower_receipts where account_id=${a.id} or account_address=${a.address})`).limit(1));
  const [accountState]=await read(db.select().from(copyFollowerAccountState).where(eq(copyFollowerAccountState.accountId,a.id)));
  const carry=await read(db.select().from(copyLiveReductionCarry).where(eq(copyLiveReductionCarry.mandateId,m.id)).orderBy(copyLiveReductionCarry.coin).limit(1025));
  check(receipts.length<=10000&&ledger.length<=30000&&carry.length<=1024,'live_risk_generation_unbounded');
  const journals:LiveGenerationJournalV1[]=[];
  for(const {provenance,...entry} of entries){
    let p:LiveGenerationJournalV1['provenance']=provenance?(({sizingBasis,...rest})=>canonical({...rest,sizingBasisDigest:liveSourceDigest(sizingBasis)}))(provenance):null;
    if((entry.journal.record as unknown as LiveExecutionRecord).unattemptedRelease){
      check(provenance&&p&&entry.fill&&entry.leg&&entry.reservation,'live_risk_generation_unproven');
      // Do not infer original carry from a self-hash or mutable current row.
      // Reconstruct the original plan from its full retained SQL observations.
      const envelope=decodeLiveSourceSizingEnvelope(provenance.sizingBasis),record=entry.journal.record as unknown as LiveExecutionRecord;
      const [historical]=await read(db.select().from(copyLiveMandates).where(eq(copyLiveMandates.id,provenance.mandateId)));
      check(historical,'live_risk_generation_unproven');const consent=decodeLiveCopyMandate(historical);
      const [version]=await read(db.select().from(copyStrategyVersions).where(and(eq(copyStrategyVersions.strategyId,entry.journal.strategyId),eq(copyStrategyVersions.version,consent.strategyVersion)))),
        [policy]=await read(db.select().from(copyRiskPolicies).where(eq(copyRiskPolicies.version,entry.reservation.policyVersion)));
      check(version&&policy&&provenance.admittedAt.getTime()===record.createdAt&&envelope.basis.mandateRevision===provenance.mandateRevision&&envelope.basis.settingsDigest===provenance.settingsDigest,'live_risk_generation_unproven');
      const fill=decodeLiveSourceFill(entry.fill),leg=canonicalLiveSourceLegs(fill).find(l=>l.leg===entry.leg!.leg);check(leg,'live_risk_generation_unproven');
      const plan=planLiveSourceOrder({mandate:{...historical,state:'active',revision:provenance.mandateRevision},settings:copyStrategySettingsSchema.strict().parse(version.settings),fill,leg,sizingBasis:envelope,now:record.createdAt,limits:copyRiskLimitsSchema.parse(policy.limits),currentExecutionKey:record.key}),intent=provenance.intent as unknown as LiveOrderIntent;
      check(plan.legId===entry.leg.id&&plan.fixedTradeClaim===entry.leg.fixedTradeClaim&&plan.dependsOnLegId===entry.leg.dependsOnId,'live_risk_generation_unproven');
      for(const field of ['asset','side','size','limitPrice','sizeDecimals','reduceOnly','timeInForce'] as const)check(plan.order[field]===intent[field],'live_risk_generation_unproven');
      const originalCarry=envelope.observations.generationManifest.carry.find(row=>row.mandateId===historical.id&&row.coin===fill.coin);check(originalCarry,'live_risk_generation_unproven');
      p={...p,sizingCarryWitness:{amount:envelope.basis.carry.amount,revision:envelope.basis.carry.revision,updatedAt:originalCarry.updatedAt,admittedAt:provenance.admittedAt.toISOString(),sizingBasisDigest:p.sizingBasisDigest}};
    }
    journals.push(canonical({...entry,provenance:p}));
  }
  const manifest:LiveGenerationManifestV1=canonical({version:1,accountId:a.id,mandateId:m.id,checkedAt:input.now,baseline,journals,receipts,ledger,scan:scan??null,conflicts,accountState:accountState??null,carry});
  check(Buffer.byteLength(JSON.stringify(manifest))<=2*1024*1024,'live_risk_generation_unbounded');session.scope.assertFresh();return freezeLiveReservation(manifest);
}
