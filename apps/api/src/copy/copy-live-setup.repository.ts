import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { copyAgentSetups, copyFundingOperations, copyLiveActivations, copyLiveMandates, copyLiveSetups, copyLiveStrategyConfigs, copyStrategies, copyStrategyVersions, users } from '@trading-dashboard/shared/database';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import type { DbExecutor } from '../db/unit-of-work.js';

export type SetupRow = typeof copyLiveSetups.$inferSelect;
export type SetupStage = SetupRow['stage'];
/** Stages the setup driver works: confirmed, not finished. */
export const DRIVEN_STAGES: readonly SetupStage[] = ['consented', 'funding_submitted', 'funded', 'mode_set', 'agent_active', 'builder_ready'];

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
  async find(userId: number, id: string): Promise<SetupRow> {
    const [row] = await this.db.select().from(copyLiveSetups).where(and(eq(copyLiveSetups.userId, userId), eq(copyLiveSetups.id, id)));
    if (!row) throw new NotFoundException('Setup not found');
    return row;
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
      .where(and(eq(copyLiveSetups.id, row.id), eq(copyLiveSetups.revision, row.revision))).returning();
    return next ?? null;
  }
  /** One driver (the worker's pass or the owner's open dialog) works a
   * setup at a time; a crashed holder's lease lapses after `ms`. The row's
   * `leaseToken` names the holder. */
  async lease(id: string, ms: number): Promise<SetupRow | null> {
    const [row] = await this.db.update(copyLiveSetups).set({ leaseUntil: sql`clock_timestamp() + ${`${ms} milliseconds`}::interval`, leaseToken: randomUUID() })
      .where(and(eq(copyLiveSetups.id, id), or(isNull(copyLiveSetups.leaseUntil), lte(copyLiveSetups.leaseUntil, sql`clock_timestamp()`)))).returning();
    return row ?? null;
  }
  /** Ends this holder's lease only: a drive that outlived its lease (another
   * driver took the setup since) leaves the new holder's lease in place. */
  async release(id: string, token: string | null): Promise<void> {
    if (!token) return;
    await this.db.update(copyLiveSetups).set({ leaseUntil: null, leaseToken: null }).where(and(eq(copyLiveSetups.id, id), eq(copyLiveSetups.leaseToken, token)));
  }
  /** Confirmed, unfinished setups whose next attempt is due, oldest first. */
  open(now: Date, limit = 20) {
    return this.db.select().from(copyLiveSetups).where(and(inArray(copyLiveSetups.stage, [...DRIVEN_STAGES]),
      or(isNull(copyLiveSetups.nextAttemptAt), lte(copyLiveSetups.nextAttemptAt, now)))).orderBy(asc(copyLiveSetups.updatedAt)).limit(limit);
  }
  async activation(mandateId: string) {
    const [row] = await this.db.select().from(copyLiveActivations).where(eq(copyLiveActivations.mandateId, mandateId));
    return row ?? null;
  }
  async strategy(id: number) {
    const [row] = await this.db.select().from(copyStrategies).where(eq(copyStrategies.id, id));
    return row ?? null;
  }
  /** A running testnet copy (an edit's or renewal's subject): its strategy
   * and config, its current generation and its active agent. */
  async runningCopy(userId: number, strategyId: number) {
    const [found] = await this.db.select({ strategy: copyStrategies, config: copyLiveStrategyConfigs }).from(copyStrategies)
      .innerJoin(copyLiveStrategyConfigs, eq(copyLiveStrategyConfigs.strategyId, copyStrategies.id))
      .where(and(eq(copyStrategies.id, strategyId), eq(copyStrategies.userId, userId), eq(copyStrategies.mode, 'testnet')));
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
  /** A start that never moved funds ends with its paused, empty strategy. */
  async stopUnfundedStrategy(tx: DbExecutor, userId: number, strategyId: number): Promise<void> {
    await tx.update(copyStrategies).set({ status: 'stopped', pauseNewRisk: true, stoppedAt: new Date() })
      .where(and(eq(copyStrategies.id, strategyId), eq(copyStrategies.userId, userId), eq(copyStrategies.mode, 'testnet'), eq(copyStrategies.status, 'paused')));
  }
}
