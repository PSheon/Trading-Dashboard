import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { copyAgentSetups, copyExecutionAccounts, copyLiveExecutions, copyLiveIntentProvenance, copyLiveManualCloses, copyLiveMandates, copyLiveStopCancellations,
  copyLiveStopConsents, copyLiveStopOperations, copySignerNonces, copyStrategies, users } from '@trading-dashboard/shared/database';
import { DRIZZLE_CLIENT } from '../../db/db.constants.js';
import type { DrizzleDb } from '../../db/drizzle.provider.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { lockCopyUser } from '../copy-user-lock.js';
import { decodeLiveExecutionRow } from '../live/postgres-live-journal.js';
import type { LiveExecutionRecord } from '../live/live-execution.js';
import type { LiveOrderIntent } from '../live/live-order.js';
import { unwatchLeaderIfUnused } from '../../watcher/leader-watch.js';
import type { CloseAccount } from './reduce-only-closer.js';

export type StopRow = typeof copyLiveStopOperations.$inferSelect;
export type StopState = StopRow['state'];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** SQL for the stop executor; every state change is a compare-and-set on the
 * stop's revision, so a stale pass changes nothing. */
@Injectable()
export class CopyLiveStopWorkerRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, private readonly uow: UnitOfWork) {}

  async open(): Promise<StopRow[]> {
    return this.db.select().from(copyLiveStopOperations).where(inArray(copyLiveStopOperations.state, ['requested', 'cancelling', 'closing', 'flat']))
      .orderBy(asc(copyLiveStopOperations.createdAt)).limit(50);
  }
  async get(id: string): Promise<StopRow | null> {
    const [row] = await this.db.select().from(copyLiveStopOperations).where(eq(copyLiveStopOperations.id, id));
    return row ?? null;
  }
  /** The agent the owner approved for this account (its active setup). */
  async closeAccount(stop: StopRow): Promise<CloseAccount | null> {
    const [row] = await this.db.select({ setup: copyAgentSetups, account: copyExecutionAccounts }).from(copyAgentSetups)
      .innerJoin(copyExecutionAccounts, eq(copyExecutionAccounts.id, copyAgentSetups.accountId))
      .where(and(eq(copyAgentSetups.accountId, stop.accountId), eq(copyAgentSetups.state, 'active')));
    if (!row?.setup.authorizationId || !row.setup.agentWalletId || row.account.address !== stop.accountAddress) return null;
    return { userId: stop.userId, strategyId: stop.strategyId, accountId: stop.accountId, accountAddress: stop.accountAddress,
      authorizationId: row.setup.authorizationId, walletId: row.setup.agentWalletId, workerQuorumId: row.setup.workerQuorumId };
  }
  /** The approved agent of an account, for a single-position close. */
  async closeAccountOf(row: { userId: number; strategyId: number; accountId: string }): Promise<CloseAccount | null> {
    const [found] = await this.db.select({ setup: copyAgentSetups, account: copyExecutionAccounts }).from(copyAgentSetups)
      .innerJoin(copyExecutionAccounts, eq(copyExecutionAccounts.id, copyAgentSetups.accountId))
      .where(and(eq(copyAgentSetups.accountId, row.accountId), eq(copyAgentSetups.state, 'active')));
    if (!found?.setup.authorizationId || !found.setup.agentWalletId || !found.account.address || found.account.userId !== row.userId) return null;
    return { userId: row.userId, strategyId: row.strategyId, accountId: row.accountId, accountAddress: found.account.address,
      authorizationId: found.setup.authorizationId, walletId: found.setup.agentWalletId, workerQuorumId: found.setup.workerQuorumId };
  }
  async manualCloses() {
    return this.db.select().from(copyLiveManualCloses).where(eq(copyLiveManualCloses.state, 'requested')).orderBy(asc(copyLiveManualCloses.createdAt)).limit(50);
  }
  async manualClose(id: string) {
    const [row] = await this.db.select().from(copyLiveManualCloses).where(eq(copyLiveManualCloses.id, id));
    return row ?? null;
  }
  async strategyStatus(id: number): Promise<string | null> {
    const [row] = await this.db.select({ status: copyStrategies.status }).from(copyStrategies).where(eq(copyStrategies.id, id));
    return row?.status ?? null;
  }
  /** Records the next attempt's order key before the order exists, so the
   * position projection always knows the close's orders. */
  async appendManualKey(id: string, expected: number, key: string): Promise<boolean> {
    const rows = await this.db.update(copyLiveManualCloses).set({ executionKeys: sql`${copyLiveManualCloses.executionKeys} || ${JSON.stringify([key])}::jsonb`, updatedAt: new Date() })
      .where(and(eq(copyLiveManualCloses.id, id), eq(copyLiveManualCloses.state, 'requested'), sql`jsonb_array_length(${copyLiveManualCloses.executionKeys}) = ${expected}`)).returning({ id: copyLiveManualCloses.id });
    return rows.length === 1;
  }
  async finishManual(id: string, state: 'done' | 'refused', reason: string | null): Promise<void> {
    await this.db.update(copyLiveManualCloses).set({ state, reason, updatedAt: new Date() }).where(and(eq(copyLiveManualCloses.id, id), eq(copyLiveManualCloses.state, 'requested')));
  }
  /** Orders on the account that are not finished: they block the close. */
  async inflight(accountAddress: string): Promise<{ record: LiveExecutionRecord; intent: LiveOrderIntent | null }[]> {
    const rows = await this.db.select({ journal: copyLiveExecutions, intent: copyLiveIntentProvenance.intent }).from(copyLiveExecutions)
      .leftJoin(copyLiveIntentProvenance, eq(copyLiveIntentProvenance.key, copyLiveExecutions.key))
      .where(and(eq(copyLiveExecutions.network, 'testnet'), eq(copyLiveExecutions.accountAddress, accountAddress),
        inArray(copyLiveExecutions.state, ['prepared', 'submitting', 'unknown', 'resting']))).limit(1001);
    return rows.map(row => ({ record: decodeLiveExecutionRow(row.journal), intent: (row.intent as unknown as LiveOrderIntent | null) ?? null }));
  }
  async journalState(key: string): Promise<string | null> {
    const [row] = await this.db.select({ state: copyLiveExecutions.state }).from(copyLiveExecutions).where(eq(copyLiveExecutions.key, key));
    return row?.state ?? null;
  }
  async move(stop: StopRow, to: StopState, patch: Partial<typeof copyLiveStopOperations.$inferInsert> = {}, now = Date.now()): Promise<StopRow | null> {
    const [row] = await this.db.update(copyLiveStopOperations).set({ ...patch, state: to, revision: stop.revision + 1, updatedAt: new Date(Math.max(now, stop.updatedAt.getTime())) })
      .where(and(eq(copyLiveStopOperations.id, stop.id), eq(copyLiveStopOperations.revision, stop.revision), eq(copyLiveStopOperations.state, stop.state))).returning();
    return row ?? null;
  }
  async issue(stop: StopRow, issue: string | null): Promise<void> {
    if (stop.issue === issue) return;
    await this.db.update(copyLiveStopOperations).set({ issue, updatedAt: new Date(Math.max(Date.now(), stop.updatedAt.getTime())) })
      .where(and(eq(copyLiveStopOperations.id, stop.id), eq(copyLiveStopOperations.revision, stop.revision)));
  }
  /** Flat and swept: the stop, every stopping generation and the strategy end;
   * the leader is unwatched when nobody else follows it. */
  async finish(stop: StopRow, now: number): Promise<boolean> {
    return this.uow.run(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(7403, 0)`);
      await tx.execute(sql`select pg_advisory_xact_lock_shared(7405, 0)`);
      await lockCopyUser(tx, stop.userId);
      const [current] = await tx.select().from(copyLiveStopOperations).where(eq(copyLiveStopOperations.id, stop.id)).for('update');
      if (!current || current.state !== 'flat' || current.revision !== stop.revision) return false;
      const at = new Date(Math.max(now, current.updatedAt.getTime()));
      await tx.update(copyLiveStopOperations).set({ state: 'stopped', revision: current.revision + 1, updatedAt: at }).where(eq(copyLiveStopOperations.id, stop.id));
      await tx.update(copyLiveMandates).set({ state: 'stopped', revision: sql`${copyLiveMandates.revision} + 1`, updatedAt: at })
        .where(and(eq(copyLiveMandates.accountId, stop.accountId), eq(copyLiveMandates.state, 'stopping')));
      const [strategy] = await tx.update(copyStrategies).set({ status: 'stopped', stoppedAt: at, pauseNewRisk: true })
        .where(and(eq(copyStrategies.id, stop.strategyId), eq(copyStrategies.mode, 'testnet'))).returning();
      if (strategy) await unwatchLeaderIfUnused(tx, strategy.leaderAddress);
      return true;
    });
  }

  // --- cancellation consent and attempts -----------------------------------
  async consent(stopId: string) {
    const [row] = await this.db.select().from(copyLiveStopConsents).where(eq(copyLiveStopConsents.stopId, stopId));
    return row ?? null;
  }
  async ownerEnabled(userId: number): Promise<boolean> {
    const [row] = await this.db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId));
    return Boolean(row) && row!.disabledAt === null;
  }
  async attempts(stopId: string, executionKey: string) {
    return this.db.select().from(copyLiveStopCancellations).where(and(eq(copyLiveStopCancellations.stopId, stopId), eq(copyLiveStopCancellations.executionKey, executionKey)))
      .orderBy(asc(copyLiveStopCancellations.attempt));
  }
  /** Claims the next cancel attempt and its nonce on the agent's signer. */
  async claim(input: { stopId: string; executionKey: string; attempt: number; signerAddress: string; consentDigest: string; now: number }) {
    return this.uow.run(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`live-nonce:testnet:${input.signerAddress}`}, 2))`);
      const allocated = await tx.execute(sql`insert into ${copySignerNonces} (network, signer_address, nonce) values ('testnet', ${input.signerAddress}, ${input.now})
        on conflict (network, signer_address) do update set nonce = greatest(${input.now}, ${copySignerNonces}.nonce + 1) returning nonce`);
      const nonce = Number(allocated.rows[0]?.nonce);
      const [row] = await tx.insert(copyLiveStopCancellations).values({ id: randomUUID(), stopId: input.stopId, executionKey: input.executionKey, attempt: input.attempt,
        state: 'claimed', claimToken: randomUUID(), nonce, expiresAfter: nonce + 55_000, consentDigest: input.consentDigest,
        createdAt: new Date(input.now), updatedAt: new Date(input.now) }).onConflictDoNothing().returning();
      return row ?? null;
    });
  }
  async attempted(id: string, state: 'accepted' | 'unknown', evidence: Record<string, unknown>): Promise<void> {
    await this.db.update(copyLiveStopCancellations).set({ state, evidence, updatedAt: new Date() }).where(and(eq(copyLiveStopCancellations.id, id), eq(copyLiveStopCancellations.state, 'claimed')));
  }
  certificate(snapshot: { accountAddress: string; sourceDigest: string; observedAt: number; completedAt: number }) {
    const certificate = { version: 1, accountAddress: snapshot.accountAddress, snapshotDigest: snapshot.sourceDigest, observedAt: snapshot.observedAt,
      completedAt: snapshot.completedAt, positions: [], restingOrders: [] };
    return { certificate, digest: digest(certificate) };
  }
}
