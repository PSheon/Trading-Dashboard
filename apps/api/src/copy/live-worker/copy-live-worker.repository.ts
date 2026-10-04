import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { copyExecutionAccounts, copyFundingOperations, copyLiveActivations, copyLiveDispatches, copyLiveExecutions, copyLiveMandates,
  copyLiveSourceFills, copyLiveSourceStreams, copyLiveStopOperations, copyLiveStrategyConfigs, copyStrategies, copyRiskPolicies } from '@trading-dashboard/shared/database';
import { copyRiskLimitsSchema, DEFAULT_COPY_RISK_LIMITS } from '@trading-dashboard/shared/contracts';
import { DRIZZLE_CLIENT } from '../../db/db.constants.js';
import type { DrizzleDb } from '../../db/drizzle.provider.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { lockCopyUser } from '../copy-user-lock.js';
import type { LiveSourceNetwork } from '../live/copy-live-source-evidence.js';

export type DispatchRow = typeof copyLiveDispatches.$inferSelect;
export interface LiveMandateWork {
  mandateId: string; userId: number; strategyId: number; accountId: string; accountAddress: string;
  sourceNetwork: LiveSourceNetwork; leaderAddress: string; cursor: Date; expiresAt: Date;
  strategyStatus: string; activated: boolean;
  /** When the worker started trading this generation; fills before it are not copied. */
  activatedAt: Date | null;
}
export interface LiveStreamWork { network: LiveSourceNetwork; leaderAddress: string; earliestCursor: Date }

/** SQL for the live worker. Short transactions only; no provider I/O here. */
@Injectable()
export class CopyLiveWorkerRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, private readonly uow: UnitOfWork) {}

  /** Consent generations that are acknowledged and unexpired. */
  async mandates(now: number): Promise<LiveMandateWork[]> {
    const rows = await this.db.select({ mandate: copyLiveMandates, account: copyExecutionAccounts, strategy: copyStrategies, activatedAt: copyLiveActivations.activatedAt })
      .from(copyLiveMandates)
      .innerJoin(copyExecutionAccounts, eq(copyExecutionAccounts.id, copyLiveMandates.accountId))
      .innerJoin(copyStrategies, eq(copyStrategies.id, copyLiveMandates.strategyId))
      .leftJoin(copyLiveActivations, eq(copyLiveActivations.mandateId, copyLiveMandates.id))
      .where(and(eq(copyLiveMandates.state, 'active'), isNotNull(copyLiveMandates.consentDigest), isNotNull(copyLiveMandates.activationCursor),
        gt(copyLiveMandates.expiresAt, new Date(now)), eq(copyStrategies.mode, 'testnet'), isNotNull(copyExecutionAccounts.address)))
      .orderBy(asc(copyLiveMandates.createdAt)).limit(500);
    return rows.map(({ mandate: m, account: a, strategy: s, activatedAt }) => ({ mandateId: m.id, userId: m.userId, strategyId: m.strategyId, accountId: m.accountId,
      accountAddress: a.address!, sourceNetwork: m.sourceNetwork, leaderAddress: m.leaderAddress, cursor: m.activationCursor!, expiresAt: m.expiresAt,
      strategyStatus: s.status, activated: activatedAt !== null, activatedAt }));
  }
  streams(mandates: readonly LiveMandateWork[]): LiveStreamWork[] {
    const out = new Map<string, LiveStreamWork>();
    for (const m of mandates) {
      const key = `${m.sourceNetwork}:${m.leaderAddress}`, held = out.get(key);
      if (!held || m.cursor < held.earliestCursor) out.set(key, { network: m.sourceNetwork, leaderAddress: m.leaderAddress, earliestCursor: m.cursor });
    }
    return [...out.values()];
  }
  async stream(network: LiveSourceNetwork, leaderAddress: string) {
    const [row] = await this.db.select().from(copyLiveSourceStreams).where(eq(copyLiveSourceStreams.id, `${network}:${leaderAddress}`));
    return row ?? null;
  }

  /**
   * A funded, acknowledged generation starts trading: its paused strategy
   * becomes active once. Funded means a credited transfer to the account and
   * none still pending; a stop request on the account blocks it. Returns the
   * mandates activated now.
   */
  async activateFunded(mandates: readonly LiveMandateWork[], now: number): Promise<string[]> {
    const activated: string[] = [];
    for (const m of mandates.filter(row => !row.activated && row.strategyStatus === 'paused')) {
      const done = await this.uow.run(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock_shared(7403, 0)`);
        await tx.execute(sql`select pg_advisory_xact_lock_shared(7405, 0)`);
        await lockCopyUser(tx, m.userId);
        const [mandate] = await tx.select().from(copyLiveMandates).where(eq(copyLiveMandates.id, m.mandateId)).for('update');
        const [strategy] = await tx.select().from(copyStrategies).where(eq(copyStrategies.id, m.strategyId)).for('update');
        if (!mandate || mandate.state !== 'active' || mandate.expiresAt.getTime() <= now || !strategy || strategy.mode !== 'testnet' || strategy.status !== 'paused' || strategy.reduceOnly) return false;
        const [already] = await tx.select().from(copyLiveActivations).where(eq(copyLiveActivations.mandateId, m.mandateId));
        if (already) return false;
        const funding = await tx.select({ status: copyFundingOperations.status }).from(copyFundingOperations).where(eq(copyFundingOperations.accountId, m.accountId));
        if (!funding.some(f => f.status === 'credited') || funding.some(f => ['prepared', 'unknown', 'accepted'].includes(f.status))) return false;
        const stops = await tx.select({ id: copyLiveStopOperations.id }).from(copyLiveStopOperations)
          .where(and(eq(copyLiveStopOperations.accountId, m.accountId), ne(copyLiveStopOperations.state, 'stopped'))).limit(1);
        if (stops.length) return false;
        await tx.update(copyStrategies).set({ status: 'active', pauseNewRisk: false }).where(eq(copyStrategies.id, m.strategyId));
        await tx.insert(copyLiveActivations).values({ mandateId: m.mandateId, userId: m.userId, strategyId: m.strategyId, accountId: m.accountId, activatedAt: new Date(now) });
        return true;
      });
      if (done) activated.push(m.mandateId);
    }
    return activated;
  }

  async signalAgeLimitMs(): Promise<number> {
    const [policy] = await this.db.select().from(copyRiskPolicies).orderBy(sql`${copyRiskPolicies.version} desc`).limit(1);
    const parsed = copyRiskLimitsSchema.safeParse(policy?.limits ?? DEFAULT_COPY_RISK_LIMITS);
    return (parsed.success ? parsed.data.maxSignalAgeSeconds : DEFAULT_COPY_RISK_LIMITS.maxSignalAgeSeconds) * 1000;
  }

  /** Leader fills after the cursor that this generation has not picked up yet. */
  async newFills(m: LiveMandateWork, limit = 50) {
    const after = m.activatedAt && m.activatedAt > m.cursor ? m.activatedAt : m.cursor;
    return this.db.select().from(copyLiveSourceFills)
      .where(and(eq(copyLiveSourceFills.streamId, `${m.sourceNetwork}:${m.leaderAddress}`), gt(copyLiveSourceFills.providerTime, after),
        sql`not exists (select 1 from ${copyLiveDispatches} d where d.mandate_id = ${m.mandateId} and d.source_fill_id = ${copyLiveSourceFills.id})`))
      .orderBy(asc(copyLiveSourceFills.providerTime), asc(copyLiveSourceFills.tid)).limit(limit);
  }
  async record(rows: (typeof copyLiveDispatches.$inferInsert)[]): Promise<void> {
    if (rows.length) await this.db.insert(copyLiveDispatches).values(rows).onConflictDoNothing();
  }
  /** Open work, oldest first: pending legs and submitted legs not yet settled. */
  async open(limit = 100): Promise<DispatchRow[]> {
    return this.db.select().from(copyLiveDispatches).where(inArray(copyLiveDispatches.state, ['pending', 'submitted']))
      .orderBy(asc(copyLiveDispatches.leaderTime), asc(copyLiveDispatches.id)).limit(limit);
  }
  async dispatch(id: string): Promise<DispatchRow | null> {
    const [row] = await this.db.select().from(copyLiveDispatches).where(eq(copyLiveDispatches.id, id));
    return row ?? null;
  }
  async update(id: string, patch: Partial<typeof copyLiveDispatches.$inferInsert>): Promise<void> {
    await this.db.update(copyLiveDispatches).set({ ...patch, updatedAt: new Date() }).where(eq(copyLiveDispatches.id, id));
  }
  async journalState(key: string): Promise<string | null> {
    const [row] = await this.db.select({ state: copyLiveExecutions.state }).from(copyLiveExecutions).where(eq(copyLiveExecutions.key, key));
    return row?.state ?? null;
  }
  /** Whether this generation ever opened `coin`: a close of a position the
   * copy never held (opened before the cursor) has nothing to reduce. */
  async everOpened(mandateId: string, coin: string): Promise<boolean> {
    const [row] = await this.db.select({ id: copyLiveDispatches.id }).from(copyLiveDispatches)
      .where(and(eq(copyLiveDispatches.mandateId, mandateId), eq(copyLiveDispatches.coin, coin), eq(copyLiveDispatches.leg, 'open'), inArray(copyLiveDispatches.state, ['submitted', 'settled']))).limit(1);
    return row !== undefined;
  }
  async sourceNetwork(strategyId: number): Promise<LiveSourceNetwork | null> {
    const [row] = await this.db.select({ network: copyLiveStrategyConfigs.sourceNetwork }).from(copyLiveStrategyConfigs).where(eq(copyLiveStrategyConfigs.strategyId, strategyId));
    return row?.network ?? null;
  }
  async mandate(id: string) {
    const [row] = await this.db.select().from(copyLiveMandates).where(eq(copyLiveMandates.id, id));
    return row ?? null;
  }
  /** Rows of settled latency for the admin percentiles. */
  async latencyRows(since: Date) {
    return this.db.select({ leaderTime: copyLiveDispatches.leaderTime, receivedAt: copyLiveDispatches.receivedAt, sentAt: copyLiveDispatches.sentAt, ackedAt: copyLiveDispatches.ackedAt })
      .from(copyLiveDispatches).where(and(gt(copyLiveDispatches.leaderTime, since), isNotNull(copyLiveDispatches.sentAt))).limit(10000);
  }
}
