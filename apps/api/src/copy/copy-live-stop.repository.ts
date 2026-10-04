import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, getTableColumns, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { liveCopyStopSchema, liveStopCancellationIntentSchema, type RequestLiveCopyStop } from '@trading-dashboard/shared/contracts';
import { copyAgentSetups, copyExecutionAccounts, copyExecutionWallets, copyLiveExecutions, copyLiveIntentProvenance, copyLiveMandates,
  copyLiveRiskReservations, copyLiveStopConsents, copyLiveStopOperations, copyStrategies, copyWalletAuthorizations } from '@trading-dashboard/shared/database';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import type { DbTransaction } from '../db/unit-of-work.js';
import { CopyLiveMandateRepository } from './copy-live-mandate.repository.js';
import { liveSourceDigest } from './live/copy-live-source-evidence.js';
import { buildOrderAction, executionKey, intentFingerprint, type LiveOrderIntent } from './live/live-order.js';
import { decodeLiveExecutionRow, immutableLiveExecution } from './live/postgres-live-journal.js';
import { liveStopCancellationIntentDigest } from './copy-live-stop-consent.js';

type StopRow = typeof copyLiveStopOperations.$inferSelect;
const conflict = (code = 'live_stop_binding_changed'): never => { throw new ConflictException({ statusCode: 409, code, message: 'Refresh the original stop operation' }); };
@Injectable()
export class CopyLiveStopRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, private readonly mandates: CopyLiveMandateRepository) {}
  async lock(tx: DbTransaction, userId: number) { return this.mandates.lock(tx, userId); }
  private async context(tx: DbTransaction, userId: number, mandateId: string) {
    const owner = await this.mandates.owner(userId, tx), mandate = await this.mandates.find(userId, mandateId, tx, true);
    const [binding] = await tx.select({ account: copyExecutionAccounts, strategy: copyStrategies, setup: copyAgentSetups })
      .from(copyExecutionAccounts).innerJoin(copyStrategies, eq(copyStrategies.id, copyExecutionAccounts.strategyId))
      .innerJoin(copyAgentSetups, eq(copyAgentSetups.id, mandate.setupId))
      .where(and(eq(copyExecutionAccounts.id, mandate.accountId), eq(copyExecutionAccounts.userId, userId))).for('update');
    if (!binding) throw new NotFoundException('Copy account not found');
    const { account, strategy, setup } = binding;
    if (strategy.userId !== userId || strategy.mode !== 'testnet' || strategy.id !== mandate.strategyId ||
      account.strategyId !== mandate.strategyId || account.network !== 'testnet' || account.address !== mandate.accountAddress ||
      owner.privyUserId !== mandate.ownerPrivyUserId || owner.embeddedWalletAddress !== mandate.ownerAddress ||
      account.privyUserId !== owner.privyUserId || !account.privyWalletId || !account.ownerQuorumId ||
      setup.userId !== userId || setup.accountId !== account.id || setup.strategyId !== strategy.id ||
      setup.network !== account.network || setup.accountAddress !== account.address ||
      setup.accountWalletId !== account.privyWalletId || setup.accountOwnerQuorumId !== account.ownerQuorumId) conflict();
    return { owner, mandate, account, strategy };
  }
  private assertStored(row: StopRow, context: Awaited<ReturnType<CopyLiveStopRepository['context']>>) {
    const { owner, mandate, account, strategy } = context;
    if (row.accountId !== account.id || row.mandateId !== mandate.id || row.strategyId !== strategy.id ||
      row.userId !== owner.id || row.network !== account.network || row.accountAddress !== account.address ||
      row.ownerPrivyUserId !== owner.privyUserId || row.ownerAddress !== owner.embeddedWalletAddress ||
      row.accountWalletId !== account.privyWalletId || row.accountOwnerQuorumId !== account.ownerQuorumId ||
      row.originalIntentDigest !== mandate.intentDigest || row.originalConsentDigest !== mandate.consentDigest ||
      Buffer.byteLength(JSON.stringify(row.targetManifest)) > 2 * 1024 * 1024 ||
      row.targetDigest !== liveSourceDigest(row.targetManifest)) conflict();
    const manifest = row.targetManifest;
    if (manifest.version !== 1 || manifest.userId !== row.userId || manifest.accountId !== row.accountId ||
      manifest.accountAddress !== row.accountAddress || manifest.strategyId !== row.strategyId || manifest.mandateId !== row.mandateId ||
      manifest.originalMandateRevision !== row.originalMandateRevision || manifest.trackingComplete !== row.trackingComplete ||
      manifest.checkedAt !== row.createdAt.getTime() || !Array.isArray(manifest.generations) || manifest.generations.length > 1000 ||
      !Array.isArray(manifest.executions) || manifest.executions.length !== row.trackedExecutionCount || manifest.executions.length > 1000) conflict();
  }
  wire(row: StopRow) {
    return liveCopyStopSchema.parse({ id: row.id, accountId: row.accountId, mandateId: row.mandateId,
      strategyId: row.strategyId, network: row.network, accountAddress: row.accountAddress,
      originalMandateRevision: row.originalMandateRevision, revision: row.revision, state: row.state,
      desiredAction: row.desiredAction, trackedExecutionCount: row.trackedExecutionCount,
      trackingComplete: row.trackingComplete, issue: row.issue, flatVerifiedAt: row.flatVerifiedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
  }
  async byKey(tx: DbTransaction, userId: number, key: string) {
    await this.lock(tx, userId);
    const [row] = await tx.select().from(copyLiveStopOperations).where(and(eq(copyLiveStopOperations.userId, userId), eq(copyLiveStopOperations.idempotencyKey, key)));
    if (!row) throw new NotFoundException('Stop operation not found');
    this.assertStored(row, await this.context(tx, userId, row.mandateId));
    return row;
  }
  async overview(tx: DbTransaction, userId: number) {
    await this.lock(tx, userId);
    const ids = await tx.select({ id: copyLiveStopOperations.id }).from(copyLiveStopOperations).where(eq(copyLiveStopOperations.userId, userId))
      .orderBy(sql`case when ${copyLiveStopOperations.state} <> 'stopped' then 0 else 1 end`, desc(copyLiveStopOperations.createdAt)).limit(101);
    const items: ReturnType<CopyLiveStopRepository['wire']>[] = [];
    // Validate one bounded manifest at a time; history never retains 100 full
    // provider/target envelopes just to return their small public summaries.
    for (const { id } of ids.slice(0, 100)) {
      const [row] = await tx.select().from(copyLiveStopOperations).where(and(eq(copyLiveStopOperations.id, id), eq(copyLiveStopOperations.userId, userId)));
      if (!row) conflict();
      this.assertStored(row, await this.context(tx, userId, row.mandateId)); items.push(this.wire(row));
    }
    return { items, truncated: ids.length > 100 };
  }
  /** The current cancellation consent intent of a cancelling stop, created
   * on first request (five-minute approval window, thirty-minute lifetime,
   * bound to the stop's current revision and the account's current agent). */
  async cancellationChallenge(tx: DbTransaction, userId: number, stopId: string, clock: () => number) {
    await this.lock(tx, userId);
    const [stop] = await tx.select().from(copyLiveStopOperations).where(and(eq(copyLiveStopOperations.id, stopId), eq(copyLiveStopOperations.userId, userId))).for('update');
    if (!stop) throw new NotFoundException('Stop not found');
    const context = await this.context(tx, userId, stop.mandateId); this.assertStored(stop, context);
    if (stop.state !== 'cancelling') conflict('live_stop_not_cancelling');
    const now = clock();
    const [held] = await tx.select().from(copyLiveStopConsents).where(eq(copyLiveStopConsents.stopId, stop.id)).for('update');
    if (held) {
      const parsed = liveStopCancellationIntentSchema.safeParse(held.intent);
      if (parsed.success && parsed.data.capturedStopRevision === stop.revision && (held.consentDigest ? parsed.data.expiresAt > now + 60_000 : parsed.data.consentExpiresAt > now + 30_000))
        return { stopId: stop.id, intent: parsed.data, consented: held.consentDigest !== null };
    }
    const [row] = await tx.select({ setup: copyAgentSetups, wallet: copyExecutionWallets, grant: copyWalletAuthorizations }).from(copyAgentSetups)
      .innerJoin(copyWalletAuthorizations, eq(copyWalletAuthorizations.id, copyAgentSetups.authorizationId))
      .innerJoin(copyExecutionWallets, eq(copyExecutionWallets.id, copyWalletAuthorizations.walletId))
      .where(and(eq(copyAgentSetups.accountId, stop.accountId), eq(copyAgentSetups.state, 'active')));
    if (!row || row.grant.revokedAt || !row.setup.agentWalletId || !row.setup.agentAddress || !row.setup.agentOwnerQuorumId || !row.setup.policyId || !row.setup.policyFingerprint) conflict('live_stop_agent_unavailable');
    // The grant must outlive the consent: approval window first, then lifetime.
    const expiresAt = Math.min(now + 1_800_000, row!.grant.expiresAt.getTime()), consentExpiresAt = Math.min(now + 300_000, expiresAt - 30_000);
    if (consentExpiresAt <= now + 10_000) conflict('live_stop_agent_expiring');
    const intent = liveStopCancellationIntentSchema.parse({ authorizationId: `stop-cancel:${stop.id}`, stopId: stop.id, accountId: stop.accountId, strategyId: stop.strategyId,
      userId, network: 'testnet', purpose: 'cancel_tracked_orders', schemaVersion: 1, capturedStopRevision: stop.revision, targetDigest: stop.targetDigest,
      accountAddress: stop.accountAddress, accountRevision: context.account.revision, accountWalletId: stop.accountWalletId, accountOwnerQuorumId: stop.accountOwnerQuorumId,
      ownerPrivyUserId: stop.ownerPrivyUserId, ownerAddress: stop.ownerAddress, setupId: row!.setup.id, setupRevision: row!.setup.revision, executionWalletId: row!.wallet.id,
      agentWalletId: row!.setup.agentWalletId, agentAddress: row!.setup.agentAddress, agentOwnerQuorumId: row!.setup.agentOwnerQuorumId, workerQuorumId: row!.setup.workerQuorumId,
      grantId: row!.grant.id, grantVersion: row!.grant.version, grantValidFrom: row!.grant.validFrom.getTime(), grantExpiresAt: row!.grant.expiresAt.getTime(),
      policyId: row!.setup.policyId, policyFingerprint: row!.setup.policyFingerprint, nonce: now, consentExpiresAt, expiresAt });
    const values = { userId, intent: intent as unknown as Record<string, unknown>, intentDigest: liveStopCancellationIntentDigest(intent), consentDigest: null, verifiedAt: null,
      expiresAt: new Date(intent.expiresAt), updatedAt: new Date(now) };
    await tx.insert(copyLiveStopConsents).values({ stopId: stop.id, ...values, createdAt: new Date(now) }).onConflictDoUpdate({ target: copyLiveStopConsents.stopId, set: values });
    return { stopId: stop.id, intent, consented: false };
  }
  /** Records the owner's verified consent (its digest; never the signature). */
  async approveCancellation(tx: DbTransaction, userId: number, stopId: string, intentDigest: string, signature: string, clock: () => number) {
    await this.lock(tx, userId);
    const [stop] = await tx.select().from(copyLiveStopOperations).where(and(eq(copyLiveStopOperations.id, stopId), eq(copyLiveStopOperations.userId, userId))).for('update');
    const [held] = await tx.select().from(copyLiveStopConsents).where(eq(copyLiveStopConsents.stopId, stopId)).for('update');
    if (!stop || !held) throw new NotFoundException('Stop not found');
    const parsed = liveStopCancellationIntentSchema.safeParse(held.intent);
    if (stop.state !== 'cancelling' || held.intentDigest !== intentDigest || !parsed.success || parsed.data.capturedStopRevision !== stop.revision) conflict('live_stop_consent_changed');
    const now = clock(), consentDigest = createHash('sha256').update(signature.toLowerCase()).digest('hex');
    if (held.consentDigest && held.consentDigest !== consentDigest) conflict('live_stop_consent_changed');
    await tx.update(copyLiveStopConsents).set({ consentDigest, verifiedAt: new Date(now), updatedAt: new Date(now) }).where(eq(copyLiveStopConsents.stopId, stopId));
    return { stopId, intent: parsed.data!, consented: true };
  }
  async consentIntent(userId: number, stopId: string) {
    const [held] = await this.db.select().from(copyLiveStopConsents).where(and(eq(copyLiveStopConsents.stopId, stopId), eq(copyLiveStopConsents.userId, userId)));
    return held ?? null;
  }
  async request(tx: DbTransaction, userId: number, mandateId: string, input: RequestLiveCopyStop, clock: () => number) {
    await this.lock(tx, userId);
    const context = await this.context(tx, userId, mandateId), { owner, account, strategy, mandate } = context;
    const [existing] = await tx.select().from(copyLiveStopOperations).where(and(eq(copyLiveStopOperations.userId, userId), eq(copyLiveStopOperations.idempotencyKey, input.idempotencyKey)));
    if (existing) {
      this.assertStored(existing, context);
      if (existing.originalMandateRevision !== input.expectedMandateRevision) conflict('live_stop_key_conflict');
      return existing;
    }
    if (mandate.revision !== input.expectedMandateRevision) conflict('stale_revision');
    if (!mandate.consentDigest || !mandate.activationCursor || mandate.state === 'prepared' || strategy.status === 'stopped') conflict('live_stop_unapproved_generation');
    const originalConsentDigest = mandate.consentDigest!;
    if ((await tx.select({ id: copyLiveStopOperations.id }).from(copyLiveStopOperations)
      .where(and(eq(copyLiveStopOperations.accountId, account.id), ne(copyLiveStopOperations.state, 'stopped'))).limit(1)).length) conflict('live_stop_pending');
    const now = clock();
    if (!Number.isSafeInteger(now) || now <= 0 || now > 8640000000000000 || now < mandate.updatedAt.getTime()) conflict('live_stop_invalid_clock');
    const generations = await tx.select().from(copyLiveMandates).where(eq(copyLiveMandates.accountId, account.id)).orderBy(asc(copyLiveMandates.id)).limit(1001);
    // A terminal order can still carry an unsettled reservation. Include it;
    // neither ACK nor this manifest is permission to cancel or release funds.
    // Do not fetch sizing envelopes or reservation payloads here. They can
    // contain megabytes of provider history and do not grant stop authority.
    const candidates = await tx.select({
      execution: { ...getTableColumns(copyLiveExecutions),
        record: sql<Record<string, unknown>>`case when octet_length(${copyLiveExecutions.record}::text) <= 16384 then ${copyLiveExecutions.record} else '{}'::jsonb end` },
      provenance: { key: copyLiveIntentProvenance.key, mandateId: copyLiveIntentProvenance.mandateId,
        mandateRevision: copyLiveIntentProvenance.mandateRevision, settingsDigest: copyLiveIntentProvenance.settingsDigest,
        fingerprint: copyLiveIntentProvenance.fingerprint, plannerVersion: copyLiveIntentProvenance.plannerVersion,
        admittedAt: copyLiveIntentProvenance.admittedAt,
        intent: sql<Record<string, unknown>>`case when octet_length(${copyLiveIntentProvenance.intent}::text) <= 16384 then ${copyLiveIntentProvenance.intent} else '{}'::jsonb end` },
      reservation: { key: copyLiveRiskReservations.key, accountId: copyLiveRiskReservations.accountId,
        userId: copyLiveRiskReservations.userId, strategyId: copyLiveRiskReservations.strategyId,
        network: copyLiveRiskReservations.network, accountAddress: copyLiveRiskReservations.accountAddress,
        fingerprint: copyLiveRiskReservations.fingerprint, cloid: copyLiveRiskReservations.cloid, asset: copyLiveRiskReservations.asset,
        walletId: copyLiveRiskReservations.walletId, authorizationId: copyLiveRiskReservations.authorizationId,
        authorizationVersion: copyLiveRiskReservations.authorizationVersion, state: copyLiveRiskReservations.state, revision: copyLiveRiskReservations.revision },
    })
      .from(copyLiveExecutions).leftJoin(copyLiveIntentProvenance, eq(copyLiveIntentProvenance.key, copyLiveExecutions.key))
      .leftJoin(copyLiveRiskReservations, eq(copyLiveRiskReservations.key, copyLiveExecutions.key))
      .where(and(eq(copyLiveExecutions.userId, userId), eq(copyLiveExecutions.strategyId, strategy.id), eq(copyLiveExecutions.network, 'testnet'),
        eq(copyLiveExecutions.accountAddress, account.address!), or(inArray(copyLiveExecutions.state, ['prepared', 'submitting', 'unknown', 'resting']),
          and(isNotNull(copyLiveRiskReservations.key), ne(copyLiveRiskReservations.state, 'released')))))
      .orderBy(asc(copyLiveExecutions.key)).limit(1001);
    // Enumerate account liabilities independently: a malformed journal scope
    // must not make an existing reservation disappear from this operation.
    const liabilities = await tx.select({ key: copyLiveRiskReservations.key }).from(copyLiveRiskReservations)
      .where(and(ne(copyLiveRiskReservations.state, 'released'), or(eq(copyLiveRiskReservations.accountId, account.id),
        and(eq(copyLiveRiskReservations.network, 'testnet'), eq(copyLiveRiskReservations.accountAddress, account.address!)))))
      .orderBy(asc(copyLiveRiskReservations.key)).limit(1001);
    let issue: string | null = generations.length > 1000 || candidates.length > 1000 || liabilities.length > 1000 ? 'stop_tracking_limit' : null;
    if (liabilities.some(row => !candidates.some(candidate => candidate.execution.key === row.key))) issue ??= 'tracked_execution_unproven';
    const generationManifest: Record<string, unknown>[] = [], targets: Record<string, unknown>[] = [];
    for (const generation of generations.slice(0, 1000)) {
      try {
        const consent = this.mandates.decode(generation);
        if (consent.userId !== userId || consent.accountId !== account.id || consent.accountAddress !== account.address ||
          consent.strategyId !== strategy.id || consent.ownerPrivyUserId !== owner.privyUserId || consent.ownerAddress !== owner.embeddedWalletAddress) throw new Error();
        generationManifest.push({ id: generation.id, revision: generation.revision, state: generation.state,
          intentDigest: generation.intentDigest, consentDigest: generation.consentDigest });
      } catch { issue ??= 'tracked_generation_unproven'; }
    }
    for (const { execution, provenance, reservation } of candidates.slice(0, 1000)) {
      try {
        if (Buffer.byteLength(JSON.stringify(execution.record)) > 16384 || !provenance || Buffer.byteLength(JSON.stringify(provenance.intent)) > 16384) throw new Error();
        const record = decodeLiveExecutionRow(execution), intent = provenance.intent as unknown as LiveOrderIntent;
        const original = generations.find(row => row.id === provenance.mandateId), action = buildOrderAction(intent);
        if (!original || !generationManifest.some(row => row.id === original.id) || !original.consentDigest ||
          provenance.fingerprint !== record.fingerprint || provenance.settingsDigest !== original.settingsDigest ||
          provenance.plannerVersion !== original.plannerVersion || provenance.mandateRevision < 2 || provenance.mandateRevision > original.revision ||
          provenance.admittedAt.getTime() !== record.createdAt || provenance.admittedAt.getTime() > now ||
          !original.activationCursor || provenance.admittedAt < original.activationCursor || provenance.admittedAt >= original.expiresAt ||
          record.key !== executionKey(intent) || record.fingerprint !== intentFingerprint(intent, action) || !isDeepStrictEqual(record.action, action) ||
          intent.userId !== userId || intent.strategyId !== strategy.id || intent.network !== 'testnet' || intent.accountAddress !== account.address ||
          intent.authorizationId !== original.authorizationId || intent.walletId !== original.agentWalletId ||
          record.authorization.id !== original.authorizationId || record.authorization.walletId !== original.agentWalletId ||
          record.authorization.signerAddress !== original.agentAddress || record.authorization.version !== original.authorizationVersion ||
          (record.state !== 'prepared' && !reservation) || reservation && (reservation.accountId !== account.id || reservation.userId !== userId ||
            reservation.strategyId !== strategy.id || reservation.network !== 'testnet' || reservation.accountAddress !== account.address ||
            reservation.fingerprint !== record.fingerprint || reservation.cloid !== execution.cloid || reservation.asset !== intent.asset ||
            reservation.walletId !== intent.walletId || reservation.authorizationId !== original.authorizationId ||
            reservation.authorizationVersion !== original.authorizationVersion)) throw new Error();
        targets.push({ key: record.key, fingerprint: record.fingerprint, immutableDigest: liveSourceDigest(immutableLiveExecution(record)),
          mandateId: original.id, state: record.state, asset: intent.asset, cloid: intent.cloid,
          reservationState: reservation?.state ?? null, reservationRevision: reservation?.revision ?? null });
      } catch { issue ??= 'tracked_execution_unproven'; }
    }
    const manifest = { version: 1, userId, accountId: account.id, accountAddress: account.address!, strategyId: strategy.id,
      mandateId, originalMandateRevision: mandate.revision, generations: generationManifest, executions: targets,
      trackingComplete: issue === null, checkedAt: now };
    // Every account generation shares this admission barrier. A renewed grant
    // cannot reopen risk while an older stop/unknown liability remains active.
    await tx.update(copyStrategies).set({ status: 'stopping', pauseNewRisk: true, reduceOnly: true,
      controlRevision: strategy.controlRevision + 1 }).where(eq(copyStrategies.id, strategy.id));
    await tx.update(copyLiveMandates).set({ state: 'stopping', revision: sql`${copyLiveMandates.revision} + 1`, updatedAt: new Date(now) })
      .where(and(eq(copyLiveMandates.accountId, account.id), inArray(copyLiveMandates.state, ['active', 'paused'])));
    const [row] = await tx.insert(copyLiveStopOperations).values({ id: randomUUID(), userId, strategyId: strategy.id, accountId: account.id,
      mandateId, idempotencyKey: input.idempotencyKey, originalMandateRevision: input.expectedMandateRevision, network: 'testnet',
      accountAddress: account.address!, ownerPrivyUserId: owner.privyUserId, ownerAddress: owner.embeddedWalletAddress!,
      accountWalletId: account.privyWalletId!, accountOwnerQuorumId: account.ownerQuorumId!, originalIntentDigest: mandate.intentDigest,
      originalConsentDigest, state: issue ? 'blocked' : 'requested', targetManifest: manifest,
      targetDigest: liveSourceDigest(manifest), trackedExecutionCount: targets.length, trackingComplete: issue === null, issue,
      createdAt: new Date(now), updatedAt: new Date(now) }).returning();
    return row;
  }
}
