import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { copyExecutionAccounts, copyFollowerObservationBudget, copyFollowerObservationJobs, copyFollowerObservations, copyFollowerAccountState, users } from '@trading-dashboard/shared/database';
import { AppConfig } from '../config/app-config.js';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import type { LiveAccountSnapshot } from './live/live-account-observer.js';
import { mapLiveAccountView } from './live/live-account-view.js';
import { LiveBoundaryError } from './live/wallet-authorization.js';
import { lockCopyUser } from './copy-user-lock.js';
import { deploymentNetwork } from './live-deployment.js';

export type FollowerSnapshotClaim = Readonly<{ accountId: string; userId: number; strategyId: number; accountAddress: string; accountRevision: number; ownerPrivyUserId: string; claimToken: string }>;
export type FollowerSnapshotIssue = NonNullable<typeof copyFollowerObservationJobs.$inferSelect['issue']>;
/** Observations of the deployment's network's copy accounts only (another
 * network's accounts keep their last observation as history). */
@Injectable()
export class CopyFollowerSnapshotRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, private readonly config: AppConfig) {}
  private get network() { return deploymentNetwork(this.config); }

  claim(): Promise<FollowerSnapshotClaim | null> {
    const network = this.network;
    return this.db.transaction(async tx => {
      await tx.insert(copyFollowerObservationBudget).values({ network, nextAllowedAt: sql`clock_timestamp()` }).onConflictDoNothing();
      await tx.select().from(copyFollowerObservationBudget).where(eq(copyFollowerObservationBudget.network, network)).for('update');
      // Check server time after acquiring the row: no pre-wait projection can
      // admit a second replica against the previous allowance.
      const [budget] = await tx.select({ available: sql<boolean>`${copyFollowerObservationBudget.nextAllowedAt} <= clock_timestamp()` })
        .from(copyFollowerObservationBudget).where(eq(copyFollowerObservationBudget.network, network));
      if (!budget?.available) return null;
      // Retained stopped/revoked/disabled identities can still have actual
      // balances. They remain observable; the owner GET is separately guarded.
      await tx.execute(sql`insert into copy_follower_observation_jobs (account_id)
        select id from copy_execution_accounts where network = ${network} and address is not null
        and address <> '0x0000000000000000000000000000000000000000' on conflict (account_id) do nothing`);
      const [row] = await tx.select({ account: copyExecutionAccounts }).from(copyFollowerObservationJobs)
        .innerJoin(copyExecutionAccounts, eq(copyExecutionAccounts.id, copyFollowerObservationJobs.accountId))
        .where(and(eq(copyExecutionAccounts.network, network), sql`${copyExecutionAccounts.address} is not null and ${copyExecutionAccounts.address} <> '0x0000000000000000000000000000000000000000'`, sql`${copyFollowerObservationJobs.nextRunAt} <= clock_timestamp()`))
        .orderBy(copyFollowerObservationJobs.nextRunAt, copyFollowerObservationJobs.accountId).limit(1).for('update', { of: copyFollowerObservationJobs, skipLocked: true });
      if (!row?.account.address) return null;
      const claimToken = randomUUID();
      await tx.update(copyFollowerObservationJobs).set({ claimToken, attemptedAt: sql`clock_timestamp()`, nextRunAt: sql`clock_timestamp() + interval '120 seconds'`, updatedAt: sql`clock_timestamp()` })
        .where(eq(copyFollowerObservationJobs.accountId, row.account.id));
      // Consume before provider work. A crash or failed read does not restore
      // the global allowance, including after another process restarts.
      await tx.update(copyFollowerObservationBudget).set({ nextAllowedAt: sql`clock_timestamp() + interval '60 seconds'` }).where(eq(copyFollowerObservationBudget.network, network));
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
      const id = randomUUID();
      const [saved] = await tx.insert(copyFollowerObservations).values({ id, accountId: claim.accountId, userId: claim.userId, strategyId: claim.strategyId,
        network, accountAddress: claim.accountAddress, sourceDigest: snapshot.sourceDigest,
        observedAt: new Date(snapshot.observedAt), completedAt: new Date(snapshot.completedAt), earliestProviderTime: new Date(snapshot.coverage.earliestProviderTime),
        snapshot: snapshot as unknown as Record<string, unknown> }).onConflictDoNothing().returning({ id: copyFollowerObservations.id });
      const existing = saved ? null : (await tx.select().from(copyFollowerObservations).where(and(eq(copyFollowerObservations.accountId, claim.accountId), eq(copyFollowerObservations.sourceDigest, snapshot.sourceDigest))))[0];
      if (!saved && (!existing || existing.accountAddress !== claim.accountAddress || existing.network !== network ||
          existing.userId !== claim.userId || existing.strategyId !== claim.strategyId || !isDeepStrictEqual(existing.snapshot, snapshot)))
        throw new LiveBoundaryError('follower_snapshot_identity_mismatch');
      await tx.update(copyFollowerObservationJobs).set({ latestObservationId: saved?.id ?? existing!.id, issue: null, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(copyFollowerObservationJobs.accountId, claim.accountId), eq(copyFollowerObservationJobs.claimToken, claim.claimToken)));
      return true;
    });
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
