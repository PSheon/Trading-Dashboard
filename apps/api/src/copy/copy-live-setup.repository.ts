import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { copyAgentSetups, copyFundingOperations, copyLiveActivations, copyLiveMandates, copyLiveSetups, copyLiveSetupAborts, copyLiveStrategyConfigs, copyStrategies, copyStrategyVersions, users } from '@trading-dashboard/shared/database';
import { ACTUAL_STRATEGY_MODE, type HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import type { DbExecutor } from '../db/unit-of-work.js';

export type SetupRow = typeof copyLiveSetups.$inferSelect;
export type SetupStage = SetupRow['stage'];
export type SetupWait = NonNullable<SetupRow['lastWait']>;
/** Stages the setup driver works: confirmed, not finished. */
export const DRIVEN_STAGES: readonly SetupStage[] = ['consented', 'funding_submitted', 'funded', 'mode_set', 'agent_active', 'builder_ready'];

/** NOTIFY channel: a setup the api confirmed or advanced is due on the copy worker. */
export const COPY_SETUP_DUE_CHANNEL = 'copy_setup_due';

/** SQL for one-click setups. Short statements only; no provider I/O here. */
@Injectable()
export class CopyLiveSetupRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  reader(): DrizzleDb { return this.db; }
  async owner(userId: number) {
    const [owner] = await this.db.select().from(users).where(and(eq(users.id, userId), isNull(users.disabledAt)));
    if (!owner) throw new NotFoundException('User not found');
    return owner;
  }
  async insert(tx: DbExecutor, values: typeof copyLiveSetups.$inferInsert): Promise<SetupRow> {
    const [row] = await tx.insert(copyLiveSetups).values(values).returning();
    return row!;
  }
  async byKey(userId: number, key: string, tx: DbExecutor = this.db): Promise<SetupRow | null> {
    const [row] = await tx.select().from(copyLiveSetups).where(and(eq(copyLiveSetups.userId, userId), eq(copyLiveSetups.idempotencyKey, key)));
    return row ?? null;
  }
  async find(userId: number, id: string, tx: DbExecutor = this.db): Promise<SetupRow> {
    const query = tx.select().from(copyLiveSetups).where(and(eq(copyLiveSetups.userId, userId), eq(copyLiveSetups.id, id)));
    const [row] = await (tx === this.db ? query : query.for('update'));
    if (!row) throw new NotFoundException('Setup not found');
    return row;
  }
  /** Read only under the user's admission lock: a sent deposit cannot be cancelled. */
  async fundingAttempted(userId: number, id: string, tx: DbExecutor): Promise<boolean> {
    const [row] = await tx.select({ attemptedAt: copyFundingOperations.attemptedAt }).from(copyFundingOperations)
      .where(and(eq(copyFundingOperations.id, id), eq(copyFundingOperations.userId, userId)));
    if (!row) throw new NotFoundException('Funding operation not found');
    return row.attemptedAt !== null;
  }
  async get(id: string): Promise<SetupRow | null> {
    const [row] = await this.db.select().from(copyLiveSetups).where(eq(copyLiveSetups.id, id));
    return row ?? null;
  }
  list(userId: number) { return this.db.select().from(copyLiveSetups).where(eq(copyLiveSetups.userId, userId)).orderBy(desc(copyLiveSetups.createdAt)).limit(50); }
  /** The strategy's unfinished setup (one at most: copy_live_setups_current_uq). */
  async current(strategyId: number, tx: DbExecutor = this.db): Promise<SetupRow | null> {
    const [row] = await tx.select().from(copyLiveSetups).where(and(eq(copyLiveSetups.strategyId, strategyId), sql`${copyLiveSetups.stage} not in ('running', 'failed', 'expired', 'cancelled')`));
    return row ?? null;
  }
  /** Compare-and-set on the revision: a concurrent step wins, this one rereads. */
  async transition(row: SetupRow, changes: Partial<typeof copyLiveSetups.$inferInsert>, tx: DbExecutor = this.db): Promise<SetupRow | null> {
    const [next] = await tx.update(copyLiveSetups).set({ ...changes, revision: row.revision + 1, updatedAt: new Date() })
      .where(and(eq(copyLiveSetups.id, row.id), eq(copyLiveSetups.revision, row.revision), sql`not exists (select 1 from ${copyLiveSetupAborts} a where a.setup_id = ${copyLiveSetups.id})`)).returning();
    return next ?? null;
  }
  /** A wait's bookkeeping only: no new revision or updatedAt. A concurrent step that moved the row
   * wins (null). */
  async defer(row: SetupRow, changes: { nextAttemptAt: Date; lastWait: SetupWait }): Promise<SetupRow | null> {
    const [next] = await this.db.update(copyLiveSetups).set({ nextAttemptAt: changes.nextAttemptAt, lastWait: changes.lastWait })
      .where(and(eq(copyLiveSetups.id, row.id), eq(copyLiveSetups.revision, row.revision), sql`not exists (select 1 from ${copyLiveSetupAborts} a where a.setup_id = ${copyLiveSetups.id})`)).returning();
    return next ?? null;
  }
  /** API_SETUP_DRIVE=worker: due now, so the pass picks it up even if the wake-up is lost. No new
   * revision; null when not driven, aborted, or already due. */
  async markDue(id: string): Promise<SetupRow | null> {
    const [next] = await this.db.update(copyLiveSetups).set({ nextAttemptAt: sql`clock_timestamp()` })
      .where(and(eq(copyLiveSetups.id, id), inArray(copyLiveSetups.stage, [...DRIVEN_STAGES]), sql`${copyLiveSetups.nextAttemptAt} > clock_timestamp()`,
        sql`not exists (select 1 from ${copyLiveSetupAborts} a where a.setup_id = ${copyLiveSetups.id})`)).returning();
    return next ?? null;
  }
  /** Wakes the copy worker (CopySetupDueListener); a hint only, the pass is the fallback. */
  async notifyDue(id: string): Promise<void> {
    await this.db.execute(sql`select pg_notify(${COPY_SETUP_DUE_CHANNEL}, ${id})`);
  }
  async aborted(userId: number, setupId: string, tx: DbExecutor = this.db): Promise<boolean> {
    const [row] = await tx.select({ id: copyLiveSetupAborts.id }).from(copyLiveSetupAborts)
      .where(and(eq(copyLiveSetupAborts.userId, userId), eq(copyLiveSetupAborts.setupId, setupId))).limit(1);
    return Boolean(row);
  }
  /** A generation was ever prepared from this setup. */
  async hasMandate(setupId: string, tx: DbExecutor = this.db): Promise<boolean> {
    const [row] = await tx.select({ id: copyLiveMandates.id }).from(copyLiveMandates).where(eq(copyLiveMandates.liveSetupId, setupId)).limit(1);
    return Boolean(row);
  }
  /** One driver at a time, named by `leaseToken`; a crashed holder's lease lapses after `ms`. */
  async lease(id: string, ms: number): Promise<SetupRow | null> {
    const [row] = await this.db.update(copyLiveSetups).set({ leaseUntil: sql`clock_timestamp() + ${`${ms} milliseconds`}::interval`, leaseToken: randomUUID() })
      .where(and(eq(copyLiveSetups.id, id), or(isNull(copyLiveSetups.leaseUntil), lte(copyLiveSetups.leaseUntil, sql`clock_timestamp()`)), sql`not exists (select 1 from ${copyLiveSetupAborts} a where a.setup_id = ${copyLiveSetups.id})`)).returning();
    return row ?? null;
  }
  /** Ends this holder's lease only, never a newer holder's. */
  async release(id: string, token: string | null): Promise<void> {
    if (!token) return;
    await this.db.update(copyLiveSetups).set({ leaseUntil: null, leaseToken: null }).where(and(eq(copyLiveSetups.id, id), eq(copyLiveSetups.leaseToken, token)));
  }
  /** Due provisioning starts and driven setups on `network` only, oldest first. */
  open(now: Date, network: HyperliquidNetwork, limit = 20) {
    return this.db.select().from(copyLiveSetups).where(and(or(inArray(copyLiveSetups.stage, [...DRIVEN_STAGES]), and(eq(copyLiveSetups.stage, 'provisioning'), eq(copyLiveSetups.kind, 'start'))),
      or(isNull(copyLiveSetups.nextAttemptAt), lte(copyLiveSetups.nextAttemptAt, now)),
      sql`not exists (select 1 from ${copyLiveSetupAborts} a where a.setup_id = ${copyLiveSetups.id})`,
      sql`exists (select 1 from ${copyStrategies} s where s.id = ${copyLiveSetups.strategyId} and s.network = ${network})`)).orderBy(asc(copyLiveSetups.updatedAt)).limit(limit);
  }
  async activation(mandateId: string) {
    const [row] = await this.db.select().from(copyLiveActivations).where(eq(copyLiveActivations.mandateId, mandateId));
    return row ?? null;
  }
  async strategy(id: number) {
    const [row] = await this.db.select().from(copyStrategies).where(eq(copyStrategies.id, id));
    return row ?? null;
  }
  /** A running actual copy on `network` (an edit's or renewal's subject): its
   * strategy and config, its current generation and its active agent. */
  async runningCopy(userId: number, strategyId: number, network: HyperliquidNetwork) {
    const [found] = await this.db.select({ strategy: copyStrategies, config: copyLiveStrategyConfigs }).from(copyStrategies)
      .innerJoin(copyLiveStrategyConfigs, eq(copyLiveStrategyConfigs.strategyId, copyStrategies.id))
      .where(and(eq(copyStrategies.id, strategyId), eq(copyStrategies.userId, userId), eq(copyStrategies.mode, ACTUAL_STRATEGY_MODE), eq(copyStrategies.network, network)));
    if (!found) return { found: null, mandate: null, agent: null };
    const [mandate] = await this.db.select().from(copyLiveMandates).where(and(eq(copyLiveMandates.strategyId, strategyId), sql`${copyLiveMandates.state} in ('active', 'paused')`));
    const [agent] = mandate ? await this.db.select().from(copyAgentSetups).where(and(eq(copyAgentSetups.accountId, mandate.accountId), eq(copyAgentSetups.state, 'active'))) : [];
    return { found, mandate: mandate ?? null, agent: agent ?? null };
  }
  async strategySettings(strategyId: number, version: number) {
    const [row] = await this.db.select().from(copyStrategyVersions).where(and(eq(copyStrategyVersions.strategyId, strategyId), eq(copyStrategyVersions.version, version)));
    if (!row) throw new NotFoundException('Strategy version not found');
    return row.settings;
  }
  /** The deposit belongs to this setup (its consent binds it). */
  async tagFunding(fundingId: string, setupId: string): Promise<void> {
    await this.db.update(copyFundingOperations).set({ liveSetupId: setupId }).where(eq(copyFundingOperations.id, fundingId));
  }
  /**
   * A start that ended without a generation: its never-sent deposit is cancelled and its paused
   * strategy stops, unless a generation ever ran or another setup is still going. Arrived funds are
   * returned from the portfolio (a sweep is allowed once stopped).
   */
  async endStart(tx: DbExecutor, userId: number, setup: Pick<SetupRow, 'id' | 'strategyId' | 'fundingOperationId'>): Promise<boolean> {
    if (setup.fundingOperationId) {
      await tx.update(copyFundingOperations).set({ status: 'cancelled', updatedAt: new Date() }).where(and(eq(copyFundingOperations.id, setup.fundingOperationId),
        eq(copyFundingOperations.userId, userId), inArray(copyFundingOperations.status, ['prepared', 'unknown']), isNull(copyFundingOperations.attemptedAt)));
    }
    const stopped = await tx.update(copyStrategies).set({ status: 'stopped', pauseNewRisk: true, stoppedAt: new Date() })
      .where(and(eq(copyStrategies.id, setup.strategyId), eq(copyStrategies.userId, userId), eq(copyStrategies.mode, ACTUAL_STRATEGY_MODE), eq(copyStrategies.status, 'paused'),
        sql`not exists (select 1 from ${copyLiveMandates} m where m.strategy_id = ${copyStrategies.id} and m.state in ('active', 'paused', 'stopping', 'stopped'))`,
        sql`not exists (select 1 from ${copyLiveSetups} x where x.strategy_id = ${copyStrategies.id} and x.id <> ${setup.id} and x.stage not in ('running', 'failed', 'expired', 'cancelled'))`))
      .returning({ id: copyStrategies.id });
    if (!stopped.length) return false;
    // A generation prepared and never activated can't run any more.
    await tx.update(copyLiveMandates).set({ state: 'revoked', revision: sql`${copyLiveMandates.revision} + 1`, updatedAt: sql`greatest(now(), ${copyLiveMandates.createdAt})` })
      .where(and(eq(copyLiveMandates.strategyId, setup.strategyId), eq(copyLiveMandates.state, 'prepared')));
    return true;
  }
  /** The owner's starts for this leader that ended or never got a consent:
   * a new start for the same leader ends them first. */
  abandonedStarts(tx: DbExecutor, userId: number, leader: string, network: HyperliquidNetwork): Promise<SetupRow[]> {
    return tx.select().from(copyLiveSetups).where(and(eq(copyLiveSetups.userId, userId), eq(copyLiveSetups.kind, 'start'), eq(copyLiveSetups.leaderAddress, leader),
      inArray(copyLiveSetups.stage, ['provisioning', 'awaiting_consent', 'failed', 'expired']),
      sql`exists (select 1 from ${copyStrategies} s where s.id = ${copyLiveSetups.strategyId} and s.network = ${network})`));
  }
  /** Agents with an approval in flight whose setup ended since `since`, on a copy not stopping or
   * stopped: the worker reconciles them, oldest first. */
  abandonedApprovals(since: Date, network: HyperliquidNetwork, limit = 20) {
    return this.db.select({ id: copyAgentSetups.id, userId: copyAgentSetups.userId }).from(copyAgentSetups)
      .innerJoin(copyLiveSetups, eq(copyLiveSetups.id, copyAgentSetups.liveSetupId))
      .innerJoin(copyStrategies, eq(copyStrategies.id, copyAgentSetups.strategyId))
      .where(and(inArray(copyAgentSetups.state, ['approval_unknown', 'approval_signing']), inArray(copyLiveSetups.stage, ['failed', 'expired', 'cancelled']),
        gt(copyLiveSetups.updatedAt, since), eq(copyAgentSetups.network, network), sql`${copyStrategies.status} not in ('stopping', 'stopped')`)).orderBy(asc(copyAgentSetups.updatedAt)).limit(limit);
  }
}
