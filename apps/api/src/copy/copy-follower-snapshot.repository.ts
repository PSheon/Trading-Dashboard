import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { copyExecutionAccounts, copyFollowerObservationBudget, copyFollowerObservationJobs, copyFollowerObservations, copyFollowerAccountState,
  copyLiveExecutions, copyLiveRiskReservations, copyLiveExecutionEvidence, users } from '@trading-dashboard/shared/database';
import { AppConfig } from '../config/app-config.js';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import type { LiveAccountSnapshot } from './live/live-account-observer.js';
import { mapLiveAccountView } from './live/live-account-view.js';
import { LiveBoundaryError } from './live/wallet-authorization.js';
import { lockCopyUser } from './copy-user-lock.js';
import { deploymentNetwork } from './live-deployment.js';
import type { DbExecutor } from '../db/unit-of-work.js';
import { decodeLiveSettlementProof } from './live/live-settlement-proof.js';
import { followerForegroundReadEligible, followerRecoveryAccount, followerFreshForeground, followerAccountFreshForeground } from './copy-foreground-read-priority.js';

export type FollowerSnapshotClaim = Readonly<{ accountId: string; userId: number; strategyId: number; accountAddress: string; accountRevision: number; ownerPrivyUserId: string; claimToken: string }>;
export type FollowerSnapshotIssue = NonNullable<typeof copyFollowerObservationJobs.$inferSelect['issue']>;
/** Observations of the deployment's network's copy accounts only (another
 * network's accounts keep their last observation as history). */
/**
 * Accounts worth an observation: those of a live or stopping copy, and those
 * that may hold funds (a deposit was sent to them and their latest
 * observation, if any, still showed equity). A setup that ended before its
 * deposit (Stage's 0x0a6a…, never moved to standard mode) was observed every
 * two minutes forever and logged unsupported_mode each time.
 */
const observable = sql`(exists (select 1 from copy_live_mandates m where m.account_id = ${copyExecutionAccounts.id} and m.state in ('active', 'paused', 'stopping'))
  or (exists (select 1 from copy_funding_operations f where f.account_id = ${copyExecutionAccounts.id} and f.direction = 'to_account' and f.status in ('unknown', 'accepted', 'credited'))
    and not exists (select 1 from copy_follower_observations o where o.id = ${copyFollowerObservationJobs.latestObservationId}
      and coalesce(nullif(o.snapshot->>'perpEquity', ''), '0')::numeric < 0.01)))`;
/** Reporting shares the order bucket. Defer it during capability setup and
 * in-flight financial dispatches. A new active copy gets at most two minutes
 * for its first terminal dispatch; an idle funded copy remains observable.
 * Failed/cancelled setups and revoked/stopped generations never hide funds. */
const reportingEligible = sql`not exists (select 1 from copy_live_setups s where s.account_id = ${copyExecutionAccounts.id}
    and s.stage not in ('running', 'failed', 'expired', 'cancelled')
    and (s.created_at > clock_timestamp() - interval '120 seconds' or s.lease_until > clock_timestamp()))
  and not exists (select 1 from copy_live_mandates m where m.account_id = ${copyExecutionAccounts.id} and m.state = 'active'
    and m.created_at > clock_timestamp() - interval '120 seconds'
    and not exists (select 1 from copy_live_dispatches d where d.mandate_id = m.id and d.state in ('settled','refused')))
  and ((${copyExecutionAccounts.network} = 'testnet' and (${followerRecoveryAccount} or not ${followerAccountFreshForeground}))
    or (${copyExecutionAccounts.network} <> 'testnet' and not exists (select 1 from copy_live_dispatches d inner join copy_live_mandates m on m.id = d.mandate_id
      where d.account_id = ${copyExecutionAccounts.id} and d.state in ('pending','submitted') and m.state in ('active','paused','stopping'))))`;
@Injectable()
export class CopyFollowerSnapshotRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, private readonly config: AppConfig) {}
  private get network() { return deploymentNetwork(this.config); }

  claim(): Promise<FollowerSnapshotClaim | null> {
    const network = this.network;
    return this.db.transaction(async tx => {
      await tx.insert(copyFollowerObservationBudget).values({ network, nextAllowedAt: sql`clock_timestamp()` }).onConflictDoNothing();
      await tx.select().from(copyFollowerObservationBudget).where(eq(copyFollowerObservationBudget.network, network)).for('update');
      const busy = network === 'testnet' && (await tx.execute<{ busy: boolean }>(sql`select ${followerFreshForeground} as busy`)).rows[0]?.busy === true;
      if (busy) {
        // Initialize once. Recovery admissions and null claims cannot postpone
        // an ordinary account's bounded turn across process restarts.
        await tx.update(copyFollowerObservationBudget).set({ nextSnapshotAllowedAt: sql`coalesce(${copyFollowerObservationBudget.nextSnapshotAllowedAt}, clock_timestamp() + interval '300 seconds')` })
          .where(eq(copyFollowerObservationBudget.network, network));
      }
      // Check server time after acquiring the row: no pre-wait projection can
      // admit a second replica against the previous allowance.
      const [budget] = await tx.select({ available: sql<boolean>`${copyFollowerObservationBudget.nextAllowedAt} <= clock_timestamp()`,
        ordinaryDue: sql<boolean>`coalesce(${copyFollowerObservationBudget.nextSnapshotAllowedAt} <= clock_timestamp(), false)` })
        .from(copyFollowerObservationBudget).where(eq(copyFollowerObservationBudget.network, network));
      if (!budget?.available) return null;
      // Testnet reporting uses the same bucket as every execution account.
      // Deferring only the account being traded still lets an older funded
      // account consume a full observation while another order waits. Keep
      // retained observations unchanged. A stalled order cannot starve other
      // accounts forever: reporting still gets one admission per five busy
      // minutes. This hint never grants or changes financial authority.
      if (busy && !budget.ordinaryDue) {
        const recovery = await tx.select({ id: copyExecutionAccounts.id }).from(copyExecutionAccounts)
          .where(and(eq(copyExecutionAccounts.network, network), followerRecoveryAccount)).limit(1);
        if (!recovery.length) return null;
      }
      // Retained stopped/revoked/disabled identities can still have actual
      // balances. They remain observable; the owner GET is separately guarded.
      await tx.execute(sql`insert into copy_follower_observation_jobs (account_id)
        select id from copy_execution_accounts where network = ${network} and address is not null
        and address <> '0x0000000000000000000000000000000000000000' on conflict (account_id) do nothing`);
      const [row] = await tx.select({ account: copyExecutionAccounts, recovery: sql<boolean>`${followerRecoveryAccount}` }).from(copyFollowerObservationJobs)
        .innerJoin(copyExecutionAccounts, eq(copyExecutionAccounts.id, copyFollowerObservationJobs.accountId))
        .where(and(eq(copyExecutionAccounts.network, network), sql`${copyExecutionAccounts.address} is not null and ${copyExecutionAccounts.address} <> '0x0000000000000000000000000000000000000000'`, observable, reportingEligible, followerForegroundReadEligible(budget.ordinaryDue), sql`${copyFollowerObservationJobs.nextRunAt} <= clock_timestamp()`))
        // Give the elapsed ordinary allowance to its oldest due account even
        // if a repeatedly due recovery account has an older scheduling time.
        .orderBy(sql`case when ${busy && budget.ordinaryDue} and ${followerRecoveryAccount} then 1 else 0 end`, copyFollowerObservationJobs.nextRunAt, copyFollowerObservationJobs.accountId).limit(1).for('update', { of: copyFollowerObservationJobs, skipLocked: true });
      if (!row?.account.address) return null;
      const claimToken = randomUUID();
      await tx.update(copyFollowerObservationJobs).set({ claimToken, attemptedAt: sql`clock_timestamp()`, nextRunAt: sql`clock_timestamp() + interval '120 seconds'`, updatedAt: sql`clock_timestamp()` })
        .where(eq(copyFollowerObservationJobs.accountId, row.account.id));
      // Consume before provider work. A crash or failed read does not restore
      // the global allowance, including after another process restarts.
      await tx.update(copyFollowerObservationBudget).set({ nextAllowedAt: sql`clock_timestamp() + interval '60 seconds'`,
        ...(network === 'testnet' && !row.recovery ? { nextSnapshotAllowedAt: sql`clock_timestamp() + interval '300 seconds'` } : {}) })
        .where(eq(copyFollowerObservationBudget.network, network));
      return { accountId: row.account.id, userId: row.account.userId, strategyId: row.account.strategyId,
        accountAddress: row.account.address, accountRevision: row.account.revision, ownerPrivyUserId: row.account.privyUserId, claimToken };
    });
  }

  async save(rawClaim: FollowerSnapshotClaim, rawSnapshot: LiveAccountSnapshot, now = Date.now()): Promise<boolean> {
    const claim = structuredClone(rawClaim), snapshot = structuredClone(rawSnapshot), network = this.network;
    // Strict pure validation strips no fields and retains original timestamps.
    mapLiveAccountView({ accountId: claim.accountId, strategyId: claim.strategyId, network, accountAddress: claim.accountAddress }, snapshot, { blocked: false, reason: null }, now, 5000);
    return this.db.transaction(async tx => {
      await lockCopyUser(tx, claim.userId);
      const [account] = await tx.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, claim.accountId)).for('share');
      if (!account || account.network !== network || account.address !== claim.accountAddress || account.revision !== claim.accountRevision ||
          account.userId !== claim.userId || account.strategyId !== claim.strategyId || account.privyUserId !== claim.ownerPrivyUserId)
        throw new LiveBoundaryError('follower_account_identity_changed');
      const [job] = await tx.select().from(copyFollowerObservationJobs).where(eq(copyFollowerObservationJobs.accountId, claim.accountId)).for('update');
      if (!job || job.claimToken !== claim.claimToken) return false;
      return this.persist(tx, claim, snapshot, job);
    });
  }

  /** Reporting only, after the financial scope has committed. The retained
   * settlement input supplies the observation; this never reads the exchange,
   * grants a financial permit, or advances any original source timestamp. */
  async saveSettlement(key: string, now = Date.now()): Promise<boolean> {
    return this.db.transaction(async tx => {
      const [stored] = await tx.select({ reservation: copyLiveRiskReservations, evidence: copyLiveExecutionEvidence, journal: copyLiveExecutions })
        .from(copyLiveRiskReservations).innerJoin(copyLiveExecutionEvidence, eq(copyLiveExecutionEvidence.key, copyLiveRiskReservations.key))
        .innerJoin(copyLiveExecutions, eq(copyLiveExecutions.key, copyLiveRiskReservations.key))
        .where(and(eq(copyLiveRiskReservations.key, key), eq(copyLiveRiskReservations.network, this.network)));
      if (!stored || stored.reservation.state !== 'released' || stored.reservation.releaseReason !== 'verified_settlement' ||
          !stored.evidence.settlementProof || !stored.evidence.settlementProofDigest) return false;
      const { reservation: r, evidence: e, journal: j } = stored;
      const proof = decodeLiveSettlementProof(e.settlementProof, e.settlementProofDigest!), cert = proof.certificate, source = proof.input.accountSource;
      const valid = cert.key === key && cert.accountId === r.accountId && r.revision === cert.reservationRevision + 1 &&
        r.exchangeOrderId === cert.oid && r.releaseEvidenceDigest === cert.digest && e.settlementDigest === cert.digest &&
        isDeepStrictEqual(e.settlementCertificate, cert) && isDeepStrictEqual(r.payload, proof.input.reservation.payload) &&
        isDeepStrictEqual(e.statusObservation, proof.input.evidence) && e.statusDigest === proof.input.evidence.sourceDigest &&
        source.accountId === r.accountId && source.userId === r.userId && source.strategyId === r.strategyId &&
        source.network === r.network && source.accountAddress === r.accountAddress && source.sourceDigest === source.snapshot.sourceDigest &&
        j.userId === r.userId && j.strategyId === r.strategyId && j.network === r.network && j.accountAddress === r.accountAddress &&
        ['key', 'fingerprint', 'authorization', 'action', 'market', 'nonce', 'expiresAfter', 'createdAt'].every(field =>
          isDeepStrictEqual(j.record[field], proof.input.record[field as keyof typeof proof.input.record]));
      if (!valid) throw new LiveBoundaryError('follower_snapshot_identity_mismatch');
      await lockCopyUser(tx, r.userId);
      const [owned] = await tx.select({ account: copyExecutionAccounts }).from(copyExecutionAccounts)
        .innerJoin(users, and(eq(users.id, copyExecutionAccounts.userId), eq(users.privyUserId, copyExecutionAccounts.privyUserId)))
        .where(and(eq(copyExecutionAccounts.id, r.accountId), eq(copyExecutionAccounts.userId, r.userId), eq(copyExecutionAccounts.strategyId, r.strategyId),
          eq(copyExecutionAccounts.network, r.network), eq(copyExecutionAccounts.address, r.accountAddress))).for('share', { of: copyExecutionAccounts });
      if (!owned?.account.address) throw new LiveBoundaryError('follower_account_identity_changed');
      const identity = { accountId: r.accountId, userId: r.userId, strategyId: r.strategyId, accountAddress: owned.account.address,
        accountRevision: owned.account.revision, ownerPrivyUserId: owned.account.privyUserId };
      mapLiveAccountView({ ...identity, network: this.network }, source.snapshot, { blocked: false, reason: null }, now, 5000);
      await tx.insert(copyFollowerObservationJobs).values({ accountId: r.accountId }).onConflictDoNothing();
      const [job] = await tx.select().from(copyFollowerObservationJobs).where(eq(copyFollowerObservationJobs.accountId, r.accountId)).for('update');
      return this.persist(tx, identity, source.snapshot, job!, true);
    });
  }

  /** Both acquisition and committed-settlement reporting use this one store.
   * An older in-flight provider read cannot replace a newer observation. */
  private async persist(tx: DbExecutor, claim: Omit<FollowerSnapshotClaim, 'claimToken'>, snapshot: LiveAccountSnapshot,
    job: typeof copyFollowerObservationJobs.$inferSelect, invalidateClaim = false): Promise<boolean> {
      const network = this.network;
      const [latest] = job.latestObservationId ? await tx.select().from(copyFollowerObservations)
        .where(eq(copyFollowerObservations.id, job.latestObservationId)) : [];
      if (latest && (latest.observedAt.getTime() > snapshot.observedAt || latest.completedAt.getTime() > snapshot.completedAt ||
          latest.earliestProviderTime.getTime() > snapshot.coverage.earliestProviderTime)) return false;
      const id = randomUUID();
      const [saved] = await tx.insert(copyFollowerObservations).values({ id, accountId: claim.accountId, userId: claim.userId, strategyId: claim.strategyId,
        network, accountAddress: claim.accountAddress, sourceDigest: snapshot.sourceDigest,
        observedAt: new Date(snapshot.observedAt), completedAt: new Date(snapshot.completedAt), earliestProviderTime: new Date(snapshot.coverage.earliestProviderTime),
        snapshot: snapshot as unknown as Record<string, unknown> }).onConflictDoNothing().returning({ id: copyFollowerObservations.id });
      const existing = saved ? null : (await tx.select().from(copyFollowerObservations).where(and(eq(copyFollowerObservations.accountId, claim.accountId), eq(copyFollowerObservations.sourceDigest, snapshot.sourceDigest))))[0];
      if (!saved && (!existing || existing.accountAddress !== claim.accountAddress || existing.network !== network ||
          existing.userId !== claim.userId || existing.strategyId !== claim.strategyId || !isDeepStrictEqual(existing.snapshot, snapshot)))
        throw new LiveBoundaryError('follower_snapshot_identity_mismatch');
      if (job.latestObservationId === (saved?.id ?? existing!.id)) return true;
      await tx.update(copyFollowerObservationJobs).set({ latestObservationId: saved?.id ?? existing!.id, issue: null, updatedAt: sql`clock_timestamp()`,
        // Supersede the old reader's token while retaining its real attempt
        // time and the original schedule/global allowance (no new read).
        ...(invalidateClaim && job.claimToken ? { claimToken: randomUUID() } : {}) })
        .where(eq(copyFollowerObservationJobs.accountId, claim.accountId));
      return true;
  }

  async issue(rawClaim: FollowerSnapshotClaim, issue: FollowerSnapshotIssue): Promise<void> {
    const claim = structuredClone(rawClaim);
    await this.db.update(copyFollowerObservationJobs).set({ issue, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(copyFollowerObservationJobs.accountId, claim.accountId), eq(copyFollowerObservationJobs.claimToken, claim.claimToken)));
  }

  getOwned(userId: number, accountId: string) {
    return this.db.transaction(async tx => {
      const [owned] = await tx.select({ account: copyExecutionAccounts }).from(copyExecutionAccounts).innerJoin(users, eq(users.id, copyExecutionAccounts.userId))
        .where(and(eq(copyExecutionAccounts.id, accountId), eq(copyExecutionAccounts.userId, userId), isNull(users.disabledAt), eq(users.privyUserId, copyExecutionAccounts.privyUserId)));
      if (!owned?.account.address) throw new NotFoundException('Execution account not found');
      const [job] = await tx.select().from(copyFollowerObservationJobs).where(eq(copyFollowerObservationJobs.accountId, accountId));
      const [observation] = job?.latestObservationId ? await tx.select().from(copyFollowerObservations).where(and(eq(copyFollowerObservations.id, job.latestObservationId),
        eq(copyFollowerObservations.accountId, accountId), eq(copyFollowerObservations.accountAddress, owned.account.address), eq(copyFollowerObservations.network, owned.account.network),
        eq(copyFollowerObservations.userId, userId), eq(copyFollowerObservations.strategyId, owned.account.strategyId))) : [];
      const [quarantine] = await tx.select().from(copyFollowerAccountState).where(eq(copyFollowerAccountState.accountId, accountId));
      return { account: { ...owned.account, address: owned.account.address }, job: job ?? null, observation: observation ?? null,
        quarantine: { blocked: quarantine?.quarantined ?? false, reason: quarantine?.quarantined ? quarantine.reason : null } };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
}
