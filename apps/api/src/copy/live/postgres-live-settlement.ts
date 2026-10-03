import { isDeepStrictEqual } from 'node:util';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { copyExecutionAccounts, copyExecutionWallets, copyWalletAuthorizations, copyLiveExecutions, copyLiveRiskReservations, copyLiveExecutionEvidence,
  copyFollowerReceipts, copyFollowerLedger, copyFollowerAccountState, copyStrategies, users } from '@trading-dashboard/shared/database';
import type { DbTransaction } from '../../db/unit-of-work.js';
import type { LiveRiskDatabaseSession } from './postgres-live-risk-scope.js';
import type { LiveExecutionRecord } from './live-execution.js';
import { captureLiveOrderIdentity, liveOrderIdentityBinding, parseLiveOrderEvidence, parseLiveIocAcknowledgement,
  type LiveOrderEvidence, type LiveIocAcknowledgement } from './live-order-evidence.js';
import type { LiveAccountRiskInput } from './live-account-risk.js';
import { assessLiveReservationSettlement, type LiveReservationSettlementDecision, type LiveSettlementReceipt } from './live-reservation-settlement.js';
import { validateLiveReservationPayload, freezeLiveReservation, type LiveReservationStored } from './live-risk-reservation.js';
import { LiveBoundaryError } from './wallet-authorization.js';

export interface LiveSettlementObservationInput { readonly accountId: string; readonly key: string; readonly evidence: LiveOrderEvidence; readonly acknowledgement?: LiveIocAcknowledgement; }
export interface LiveSettlementAcknowledgementInput { readonly accountId:string; readonly key:string; readonly acknowledgement:LiveIocAcknowledgement; }
export interface LiveSettlementReconcileInput { readonly accountId: string; readonly key: string; readonly expectedReservationRevision: number; readonly accountSource: LiveAccountRiskInput['accountSource']; }
export type LiveSettlementObservationResult = Readonly<{ kind:'recorded'; oid:string|null; revision:number }> | Readonly<{ kind:'pending'|'quarantine'; reason:string }>;
type ReservationRow = typeof copyLiveRiskReservations.$inferSelect;
function check(value: unknown, code = 'live_settlement_identity_changed'): asserts value { if (!value) throw new LiveBoundaryError(code); }
const json = (value: object) => value as unknown as Record<string, unknown>;

/** Unregistered reconciliation DAL. It only accepts the original account/user
 * SQL lock session, and performs no provider I/O, booking, signing or orders.
 * Incoming provider sources belong to an internal trusted producer, never HTTP
 * request arrays. Durable receipts/ledger are always loaded by this DAL. */
export class PostgresLiveSettlement {
  constructor(private readonly now = Date.now) {}
  private fresh(at: number) { const now = this.now(); check(Number.isSafeInteger(now) && Number.isSafeInteger(at) && at > 0 && now >= at && now - at <= 5000, 'live_settlement_stale'); }
  private async query<T>(session: LiveRiskDatabaseSession, promise: PromiseLike<T>): Promise<T> { const value = await promise; await session.scope.assertHeld(); return value; }
  private stored(row: ReservationRow): LiveReservationStored {
    const p = validateLiveReservationPayload(row.payload);
    for (const name of ['key','accountId','userId','strategyId','network','accountAddress','fingerprint','walletId','authorizationId','strategyVersion','policyVersion',
      'authorizationVersion','notionalUsd','marginUsd','feeBufferUsd','sourceDigest'] as const) check(row[name] === p[name]);
    check(row.cloid === p.intent.cloid && row.coin === p.intent.market!.coin && row.dex === p.intent.market!.dex && row.asset === p.intent.asset && row.createdAt.getTime() === p.createdAt &&
      row.expiresAt.getTime() === p.expiresAt && row.updatedAt.getTime() >= p.createdAt && Number.isSafeInteger(row.revision) && row.revision > 0);
    check(row.state !== 'held' || row.attemptedAt === null && row.exchangeOrderId === null);
    check(!['unknown','resting'].includes(row.state) || row.attemptedAt !== null);
    return { payload:p, state:row.state, revision:row.revision, attemptedAt:row.attemptedAt?.getTime() ?? null, exchangeOrderId:row.exchangeOrderId,
      releaseEvidenceDigest:row.releaseEvidenceDigest, updatedAt:row.updatedAt.getTime() };
  }
  private async load(session: LiveRiskDatabaseSession, tx: DbTransaction, accountId: string, key: string) {
    session.scope.assertFresh();
    const [account] = await this.query(session, tx.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, accountId)).for('update'));
    check(account && account.network === 'testnet' && account.address === session.scope.identity.accountAddress && account.userId === session.scope.identity.userId &&
      session.scope.identity.network === 'testnet' && account.privyWalletId && account.ownerQuorumId);
    const [owner] = await this.query(session, tx.select().from(users).where(eq(users.id, account.userId)));
    const [strategy] = await this.query(session, tx.select().from(copyStrategies).where(eq(copyStrategies.id, account.strategyId)));
    // Enabled flags, strategy stop, and current grant revocation do not erase
    // historical liabilities. Immutable ownership is still mandatory.
    check(owner && owner.privyUserId === account.privyUserId && strategy && strategy.userId === account.userId);
    const [r] = await this.query(session, tx.select().from(copyLiveRiskReservations).where(eq(copyLiveRiskReservations.key, key)).for('update'));
    const [journal] = await this.query(session, tx.select().from(copyLiveExecutions).where(eq(copyLiveExecutions.key, key)).for('update'));
    check(r && journal); const reservation = this.stored(r), p = reservation.payload, record = journal.record as unknown as LiveExecutionRecord;
    check(p.accountId === account.id && p.userId === account.userId && p.strategyId === account.strategyId && p.network === account.network && p.accountAddress === account.address &&
      journal.key === p.key && journal.userId === p.userId && journal.strategyId === p.strategyId && journal.network === p.network && journal.accountAddress === p.accountAddress && journal.cloid === p.intent.cloid &&
      record.key === p.key && record.fingerprint === p.fingerprint && record.state === journal.state && record.nonce === journal.nonce &&
      Number.isSafeInteger(record.createdAt) && record.createdAt <= p.createdAt && record.nonce >= record.createdAt && record.updatedAt === journal.updatedAt.getTime() && record.updatedAt >= record.createdAt &&
      record.expiresAfter === p.expiresAt && record.expiresAfter > record.createdAt && record.expiresAfter <= record.createdAt + 60000 &&
      isDeepStrictEqual(record.action,p.action) && isDeepStrictEqual(record.market,p.intent.market) && record.authorization && record.authorization.signerAddress === journal.signerAddress &&
      record.authorization.userId === p.userId && record.authorization.strategyId === p.strategyId && record.authorization.walletId === p.walletId && record.authorization.id === p.authorizationId &&
      record.authorization.version === p.authorizationVersion && record.authorization.network === p.network && record.authorization.accountAddress === p.accountAddress);
    captureLiveOrderIdentity(record, p.intent.market!);
    const [grant] = await this.query(session, tx.select().from(copyWalletAuthorizations).where(eq(copyWalletAuthorizations.id,p.authorizationId)));
    const [wallet] = await this.query(session, tx.select().from(copyExecutionWallets).where(eq(copyExecutionWallets.id,grant?.walletId ?? '')));
    check(grant && wallet && wallet.userId === p.userId && wallet.strategyId === p.strategyId && wallet.network === p.network && wallet.accountAddress === p.accountAddress &&
      wallet.privyWalletId === p.walletId && wallet.privyOwnerId === record.authorization.privyOwnerId && wallet.signerAddress === journal.signerAddress);
    const [evidence] = await this.query(session, tx.select().from(copyLiveExecutionEvidence).where(eq(copyLiveExecutionEvidence.key,key)).for('update'));
    if (evidence) check(evidence.accountId === p.accountId && evidence.userId === p.userId && evidence.strategyId === p.strategyId && evidence.network === p.network && evidence.accountAddress === p.accountAddress &&
      evidence.cloid === p.intent.cloid && evidence.fingerprint === p.fingerprint && evidence.nonce === record.nonce && Number.isSafeInteger(evidence.revision) && evidence.revision > 0);
    return { account, reservation, row:r, record, evidence };
  }
  private async quarantine(session: LiveRiskDatabaseSession, tx: DbTransaction, row: ReservationRow, reason: string) {
    await this.query(session, tx.insert(copyFollowerAccountState).values({accountId:row.accountId,quarantined:true,reason,updatedAt:new Date(this.now())})
      .onConflictDoUpdate({target:copyFollowerAccountState.accountId,set:{quarantined:true,reason,updatedAt:new Date(this.now())}}));
    if (row.state !== 'released' && row.state !== 'quarantined') {
      const changed = await this.query(session, tx.update(copyLiveRiskReservations).set({state:'quarantined',revision:row.revision+1,updatedAt:new Date(this.now())})
        .where(and(eq(copyLiveRiskReservations.key,row.key),eq(copyLiveRiskReservations.revision,row.revision))).returning());
      check(changed.length === 1,'live_settlement_revision_changed');
    }
    return Object.freeze({kind:'quarantine' as const,reason});
  }
  private observation(record: LiveExecutionRecord, supplied: LiveOrderEvidence): LiveOrderEvidence {
    const parsed = parseLiveOrderEvidence({record,market:supplied.identity.market,raw:supplied.raw,checkedAt:supplied.checkedAt,completedAt:supplied.completedAt,now:this.now()});
    check(isDeepStrictEqual(parsed,supplied),'live_settlement_observation_changed'); return parsed;
  }
  private acknowledgement(record: LiveExecutionRecord, supplied: LiveIocAcknowledgement): LiveIocAcknowledgement {
    const ack = parseLiveIocAcknowledgement({identity:supplied.identity,raw:supplied.raw,checkedAt:supplied.checkedAt});
    check(isDeepStrictEqual(ack,supplied) && isDeepStrictEqual(liveOrderIdentityBinding(ack.identity),liveOrderIdentityBinding(captureLiveOrderIdentity(record,ack.identity.market))) &&
      ack.checkedAt >= record.createdAt && ack.checkedAt <= this.now(),'live_settlement_ack_changed'); return ack;
  }
  /** Persist the actual original IOC response immediately, before requesting
   * orderStatus. This prevents a subsequent read/crash from losing the only
   * proven partial-cancel quantity. Never synthesize a provider response. */
  async acknowledge(session:LiveRiskDatabaseSession,raw:LiveSettlementAcknowledgementInput):Promise<LiveSettlementObservationResult> {
    const input = structuredClone(raw), started = this.now(); session.scope.assertFresh();
    const result = await session.transaction(async tx => {
      const {row,record,evidence:old} = await this.load(session,tx,input.accountId,input.key);
      if (row.state === 'quarantined') return {kind:'quarantine' as const,reason:'live_settlement_quarantined'};
      const ack = this.acknowledgement(record,input.acknowledgement);
      if (old?.exchangeOrderId && old.exchangeOrderId !== ack.oid || row.exchangeOrderId && row.exchangeOrderId !== ack.oid ||
        old?.acknowledgement && (!isDeepStrictEqual(old.acknowledgement,ack) || old.acknowledgementDigest !== ack.responseDigest))
        return this.quarantine(session,tx,row,'live_settlement_ack_conflict');
      const other = await this.query(session,tx.select({key:copyLiveExecutionEvidence.key}).from(copyLiveExecutionEvidence)
        .where(and(eq(copyLiveExecutionEvidence.network,'testnet'),eq(copyLiveExecutionEvidence.accountAddress,row.accountAddress),eq(copyLiveExecutionEvidence.exchangeOrderId,ack.oid))).limit(2));
      if (other.some(e => e.key !== row.key)) return this.quarantine(session,tx,row,'live_settlement_oid_conflict');
      if (old?.acknowledgement) return {kind:'recorded' as const,oid:ack.oid,revision:old.revision};
      if (row.state === 'released' || old?.settlementCertificate) return {kind:'pending' as const,reason:'live_settlement_already_released'};
      const saved = old ? await this.query(session,tx.update(copyLiveExecutionEvidence).set({exchangeOrderId:ack.oid,acknowledgement:json(ack),acknowledgementDigest:ack.responseDigest,
        revision:old.revision+1,updatedAt:new Date(this.now())}).where(and(eq(copyLiveExecutionEvidence.key,row.key),eq(copyLiveExecutionEvidence.revision,old.revision))).returning()) :
        await this.query(session,tx.insert(copyLiveExecutionEvidence).values({key:row.key,accountId:row.accountId,userId:row.userId,strategyId:row.strategyId,network:'testnet',accountAddress:row.accountAddress,
          cloid:row.cloid,fingerprint:row.fingerprint,nonce:record.nonce,exchangeOrderId:ack.oid,acknowledgement:json(ack),acknowledgementDigest:ack.responseDigest,
          createdAt:new Date(started),updatedAt:new Date(this.now())}).returning());
      check(saved.length === 1,'live_settlement_revision_changed');
      if (row.state === 'held' && record.state !== 'prepared') {
        const changed = await this.query(session,tx.update(copyLiveRiskReservations).set({state:'unknown',attemptedAt:new Date(Math.max(record.updatedAt,row.createdAt.getTime())),revision:row.revision+1,updatedAt:new Date(this.now())})
          .where(and(eq(copyLiveRiskReservations.key,row.key),eq(copyLiveRiskReservations.revision,row.revision))).returning());
        check(changed.length === 1,'live_settlement_revision_changed');
      }
      session.scope.assertFresh(); this.fresh(started); return {kind:'recorded' as const,oid:ack.oid,revision:saved[0]!.revision};
    });
    const frozen = freezeLiveReservation(result); session.scope.assertFresh(); this.fresh(started); return frozen;
  }
  async observe(session: LiveRiskDatabaseSession, raw: LiveSettlementObservationInput): Promise<LiveSettlementObservationResult> {
    const input = structuredClone(raw), started = this.now(); session.scope.assertFresh();
    const oldest = Math.min(started,input.evidence.checkedAt,input.evidence.identity.market.observedAt);
    const result = await session.transaction(async tx => {
      const loaded = await this.load(session,tx,input.accountId,input.key), {record,reservation,row} = loaded;
      if (row.state === 'quarantined') return {kind:'quarantine' as const,reason:'live_settlement_quarantined'};
      const observation = this.observation(record,input.evidence), acknowledgement = input.acknowledgement ? this.acknowledgement(record,input.acknowledgement) : null;
      const old = loaded.evidence;
      const oid = observation.kind === 'order' ? observation.oid : acknowledgement?.oid ?? old?.exchangeOrderId ?? null;
      if (old?.exchangeOrderId && oid && old.exchangeOrderId !== oid || acknowledgement && oid !== acknowledgement.oid || reservation.exchangeOrderId && oid && reservation.exchangeOrderId !== oid)
        return this.quarantine(session,tx,row,'live_settlement_oid_conflict');
      if (old?.acknowledgement && acknowledgement && !isDeepStrictEqual(old.acknowledgement,acknowledgement)) return this.quarantine(session,tx,row,'live_settlement_ack_conflict');
      if (old?.statusObservation) {
        const prior = old.statusObservation as unknown as LiveOrderEvidence;
        if (prior.kind === 'order' && observation.kind === 'missing') return {kind:'pending' as const,reason:'live_settlement_order_not_yet_found'};
        if (prior.kind === 'order' && observation.kind === 'order') {
          if (observation.statusTimestamp < prior.statusTimestamp) return {kind:'pending' as const,reason:'live_settlement_older_observation'};
          if (['filled','cancelled','rejected'].includes(prior.classification) && (prior.providerStatus !== observation.providerStatus || prior.statusTimestamp !== observation.statusTimestamp ||
            prior.originalSize !== observation.originalSize || prior.observedOrderSize !== observation.observedOrderSize || !isDeepStrictEqual(prior.quantity,observation.quantity)))
            return this.quarantine(session,tx,row,'live_settlement_status_conflict');
        }
      }
      if (oid) {
        const other = await this.query(session,tx.select({key:copyLiveExecutionEvidence.key}).from(copyLiveExecutionEvidence)
          .where(and(eq(copyLiveExecutionEvidence.network,'testnet'),eq(copyLiveExecutionEvidence.accountAddress,row.accountAddress),eq(copyLiveExecutionEvidence.exchangeOrderId,oid))).limit(2));
        if (other.some(e => e.key !== row.key)) return this.quarantine(session,tx,row,'live_settlement_oid_conflict');
      }
      if (old?.settlementCertificate) return {kind:'pending' as const,reason:'live_settlement_already_released'};
      const ack = old?.acknowledgement ?? (acknowledgement ? json(acknowledgement) : null), ackDigest = old?.acknowledgementDigest ?? acknowledgement?.responseDigest ?? null;
      const saved = old ? await this.query(session,tx.update(copyLiveExecutionEvidence).set({exchangeOrderId:oid,acknowledgement:ack,acknowledgementDigest:ackDigest,
        statusObservation:json(observation),statusDigest:observation.sourceDigest,revision:old.revision+1,updatedAt:new Date(this.now())})
        .where(and(eq(copyLiveExecutionEvidence.key,input.key),eq(copyLiveExecutionEvidence.revision,old.revision))).returning()) :
        await this.query(session,tx.insert(copyLiveExecutionEvidence).values({key:row.key,accountId:row.accountId,userId:row.userId,strategyId:row.strategyId,network:'testnet',accountAddress:row.accountAddress,
          cloid:row.cloid,fingerprint:row.fingerprint,nonce:record.nonce,exchangeOrderId:oid,acknowledgement:ack,acknowledgementDigest:ackDigest,statusObservation:json(observation),statusDigest:observation.sourceDigest,
          createdAt:new Date(started),updatedAt:new Date(this.now())}).returning());
      check(saved.length === 1,'live_settlement_revision_changed');
      if (row.state === 'held' && record.state !== 'prepared') {
        const changed = await this.query(session,tx.update(copyLiveRiskReservations).set({state:'unknown',attemptedAt:new Date(Math.max(record.updatedAt,row.createdAt.getTime())),revision:row.revision+1,updatedAt:new Date(this.now())})
          .where(and(eq(copyLiveRiskReservations.key,row.key),eq(copyLiveRiskReservations.revision,row.revision))).returning());
        check(changed.length === 1,'live_settlement_revision_changed');
      }
      session.scope.assertFresh(); this.fresh(oldest); return {kind:'recorded' as const,oid,revision:saved[0]!.revision};
    });
    const frozen = freezeLiveReservation(result); session.scope.assertFresh(); this.fresh(oldest); return frozen;
  }
  async settle(session: LiveRiskDatabaseSession, raw: LiveSettlementReconcileInput): Promise<LiveReservationSettlementDecision> {
    const input = structuredClone(raw), started = this.now(); session.scope.assertFresh();
    let validUntil = NaN;
    const result = await session.transaction(async tx => {
      const {row,record,reservation,evidence} = await this.load(session,tx,input.accountId,input.key);
      check(reservation.revision === input.expectedReservationRevision,'live_settlement_revision_changed');
      if (reservation.state === 'quarantined') return {kind:'quarantine' as const,reason:'live_settlement_quarantined'};
      if (reservation.state === 'released') return {kind:'pending' as const,reason:'live_settlement_already_released'};
      if (!evidence?.statusObservation) return {kind:'pending' as const,reason:'live_settlement_terminal_unproven'};
      let observation: LiveOrderEvidence, acknowledgement: LiveIocAcknowledgement|null;
      const storedObservation = evidence.statusObservation as unknown as LiveOrderEvidence;
      const sourceTimes = [storedObservation.checkedAt, storedObservation.completedAt, storedObservation.identity?.market?.observedAt];
      const checkedNow = this.now();
      if (sourceTimes.some(at => !Number.isSafeInteger(at) || at <= 0 || at > checkedNow))
        return this.quarantine(session,tx,row,'live_settlement_stored_evidence_conflict');
      if (sourceTimes.some(at => checkedNow - at > 5000)) return {kind:'pending' as const,reason:'live_settlement_terminal_stale'};
      try {
        observation = this.observation(record,evidence.statusObservation as unknown as LiveOrderEvidence);
        acknowledgement = evidence.acknowledgement ? this.acknowledgement(record,evidence.acknowledgement as unknown as LiveIocAcknowledgement) : null;
      } catch {
        return this.quarantine(session,tx,row,'live_settlement_stored_evidence_conflict');
      }
      if (evidence.statusDigest !== observation.sourceDigest || evidence.acknowledgementDigest !== (acknowledgement?.responseDigest ?? null) || observation.kind === 'order' && evidence.exchangeOrderId !== observation.oid)
        return this.quarantine(session,tx,row,'live_settlement_stored_evidence_conflict');
      if (observation.kind !== 'order') return {kind:'pending' as const,reason:'live_settlement_terminal_unproven'};
      const receipts = await this.query(session,tx.select().from(copyFollowerReceipts).where(and(eq(copyFollowerReceipts.accountId,input.accountId),eq(copyFollowerReceipts.kind,'fill'),
        or(sql`${copyFollowerReceipts.record}->>'oid' = ${observation.oid}`,eq(copyFollowerReceipts.executionKey,input.key)))).orderBy(copyFollowerReceipts.key).limit(10001));
      if (receipts.length > 10000) return {kind:'pending' as const,reason:'live_settlement_receipt_coverage_unproven'};
      const ledger = receipts.length ? await this.query(session,tx.select().from(copyFollowerLedger).where(inArray(copyFollowerLedger.receiptKey,receipts.map(r => r.key)))) : [];
      const [state] = await this.query(session,tx.select().from(copyFollowerAccountState).where(eq(copyFollowerAccountState.accountId,input.accountId)));
      const manifest: LiveSettlementReceipt[] = receipts.map(r => ({...r, network:r.network as 'testnet',providerTime:r.providerTime.getTime(),
        record:r.record as unknown as LiveSettlementReceipt['record'],ledger:ledger.filter(l => l.receiptKey === r.key).map(l => ({receiptKey:l.receiptKey,component:l.component,token:l.token,amount:l.amount}))}));
      const decision = assessLiveReservationSettlement({now:this.now(),accountId:input.accountId,record,reservation,evidence:observation,acknowledgement,
        receipts:{accountId:input.accountId,checkedAt:started,completeForOrder:true,rows:manifest},accountSource:{...input.accountSource,quarantined:state?.quarantined ?? false}});
      if (decision.kind === 'quarantine') return this.quarantine(session,tx,row,decision.reason);
      if (decision.kind !== 'release') return decision;
      validUntil = Math.min(decision.certificate.validUntil,started+5000);
      const changed = await this.query(session,tx.update(copyLiveRiskReservations).set({state:'released',exchangeOrderId:decision.certificate.oid,releaseReason:'verified_settlement',releaseEvidenceDigest:decision.certificate.digest,
        revision:row.revision+1,updatedAt:new Date(this.now())}).where(and(eq(copyLiveRiskReservations.key,row.key),eq(copyLiveRiskReservations.revision,row.revision),inArray(copyLiveRiskReservations.state,['unknown','resting']))).returning());
      check(changed.length === 1,'live_settlement_revision_changed');
      const saved = await this.query(session,tx.update(copyLiveExecutionEvidence).set({settlementCertificate:json(decision.certificate),settlementDigest:decision.certificate.digest,revision:evidence.revision+1,updatedAt:new Date(this.now())})
        .where(and(eq(copyLiveExecutionEvidence.key,row.key),eq(copyLiveExecutionEvidence.revision,evidence.revision))).returning());
      check(saved.length === 1,'live_settlement_revision_changed'); session.scope.assertFresh(); this.fresh(validUntil-5000); return decision;
    });
    const frozen = freezeLiveReservation(result); session.scope.assertFresh(); if (result.kind === 'release') this.fresh(validUntil-5000); else this.fresh(started); return frozen;
  }
}
