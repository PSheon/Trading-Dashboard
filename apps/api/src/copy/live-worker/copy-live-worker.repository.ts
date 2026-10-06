import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { copyControls, copyExecutionAccounts, copyFundingOperations, copyLiveManualCloses, copyLiveActivations, copyLiveDispatches, copyLiveExecutions, copyLiveMandates,
  copyLiveSourceFills, copyLiveSourceStreams, copyLiveStopOperations, copyLiveStrategyConfigs, copyStrategies, copyRiskPolicies, fillCoverage, fills } from '@trading-dashboard/shared/database';
import { CHAIN_DEFAULT, copyRiskLimitsSchema, DEFAULT_COPY_RISK_LIMITS } from '@trading-dashboard/shared/contracts';
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
    const rows = await this.db.select({ mandate: copyLiveMandates, account: copyExecutionAccounts, strategy: copyStrategies, activatedAt: copyLiveActivations.activatedAt, activationState: copyLiveActivations.state })
      .from(copyLiveMandates)
      .innerJoin(copyExecutionAccounts, eq(copyExecutionAccounts.id, copyLiveMandates.accountId))
      .innerJoin(copyStrategies, eq(copyStrategies.id, copyLiveMandates.strategyId))
      .leftJoin(copyLiveActivations, eq(copyLiveActivations.mandateId, copyLiveMandates.id))
      .where(and(eq(copyLiveMandates.state, 'active'), isNotNull(copyLiveMandates.consentDigest), isNotNull(copyLiveMandates.activationCursor),
        gt(copyLiveMandates.expiresAt, new Date(now)), eq(copyStrategies.mode, 'testnet'), isNotNull(copyExecutionAccounts.address)))
      .orderBy(asc(copyLiveMandates.createdAt)).limit(500);
    return rows.map(({ mandate: m, account: a, strategy: s, activatedAt, activationState }) => ({ mandateId: m.id, userId: m.userId, strategyId: m.strategyId, accountId: m.accountId,
      accountAddress: a.address!, sourceNetwork: m.sourceNetwork, leaderAddress: m.leaderAddress, cursor: m.activationCursor!, expiresAt: m.expiresAt,
      strategyStatus: s.status, activated: activationState === 'activated', activatedAt }));
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
   * A funded, acknowledged generation starts trading: its strategy goes from
   * paused to active once. Only a generation the owner's approval left
   * `pending`, and only while the strategy is exactly as approval left it
   * (paused, same control revision: no pause, reduce-only or kill switch
   * since), with platform and user controls clear. Funded means a credited
   * transfer to the account and none pending; a stop request blocks it.
   */
  async activateFunded(mandates: readonly LiveMandateWork[], now: number): Promise<string[]> {
    const activated: string[] = [];
    for (const m of mandates.filter(row => !row.activated && row.strategyStatus === 'paused')) {
      const done = await this.uow.run(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock_shared(7403, 0)`);
        await tx.execute(sql`select pg_advisory_xact_lock_shared(7405, 0)`);
        await lockCopyUser(tx, m.userId);
        const [pending] = await tx.select().from(copyLiveActivations).where(eq(copyLiveActivations.mandateId, m.mandateId)).for('update');
        if (!pending || pending.state !== 'pending' || pending.strategyId !== m.strategyId || pending.accountId !== m.accountId) return false;
        const [mandate] = await tx.select().from(copyLiveMandates).where(eq(copyLiveMandates.id, m.mandateId)).for('update');
        const [strategy] = await tx.select().from(copyStrategies).where(eq(copyStrategies.id, m.strategyId)).for('update');
        if (!mandate || mandate.state !== 'active' || mandate.expiresAt.getTime() <= now || !strategy || strategy.mode !== 'testnet' || strategy.status !== 'paused' ||
          strategy.reduceOnly || strategy.controlRevision !== pending.controlRevision) return false;
        const controls = await tx.select().from(copyControls).where(sql`${copyControls.scope} = 'platform' or (${copyControls.scope} = 'user' and ${copyControls.scopeId} = ${m.userId})`);
        if (controls.some(row => row.pauseNewRisk || row.reduceOnly)) return false;
        const funding = await tx.select({ status: copyFundingOperations.status, direction: copyFundingOperations.direction }).from(copyFundingOperations).where(eq(copyFundingOperations.accountId, m.accountId));
        if (!funding.some(f => f.status === 'credited' && f.direction === 'to_account') || funding.some(f => ['prepared', 'unknown', 'accepted'].includes(f.status))) return false;
        const stops = await tx.select({ id: copyLiveStopOperations.id }).from(copyLiveStopOperations)
          .where(and(eq(copyLiveStopOperations.accountId, m.accountId), ne(copyLiveStopOperations.state, 'stopped'))).limit(1);
        if (stops.length) return false;
        const changed = await tx.update(copyStrategies).set({ status: 'active', pauseNewRisk: false, controlRevision: strategy.controlRevision + 1 })
          .where(and(eq(copyStrategies.id, m.strategyId), eq(copyStrategies.status, 'paused'), eq(copyStrategies.controlRevision, pending.controlRevision))).returning({ id: copyStrategies.id });
        if (changed.length !== 1) return false;
        await tx.update(copyLiveActivations).set({ state: 'activated', activatedAt: new Date(now) }).where(and(eq(copyLiveActivations.mandateId, m.mandateId), eq(copyLiveActivations.state, 'pending')));
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
  /** Open work: pending legs first (a fresh signal must not wait behind
   * reconciliation, which has no deadline), with the submitted close of a
   * flip whose open is pending (the open goes once it settles); then the
   * other submitted legs not yet settled; oldest first within each, a
   * fill's close before its open. `mandateIds` narrows it to those copies. */
  async open(limit = 100, mandateIds?: readonly string[]): Promise<DispatchRow[]> {
    if (mandateIds && !mandateIds.length) return [];
    const fresh = sql`case when ${copyLiveDispatches.state} = 'pending' or exists (select 1 from ${copyLiveDispatches} p where p.mandate_id = ${copyLiveDispatches.mandateId}
      and p.source_fill_id = ${copyLiveDispatches.sourceFillId} and p.state = 'pending') then 0 else 1 end`;
    return this.db.select().from(copyLiveDispatches)
      .where(and(inArray(copyLiveDispatches.state, ['pending', 'submitted']), mandateIds ? inArray(copyLiveDispatches.mandateId, [...mandateIds]) : undefined))
      .orderBy(fresh, asc(copyLiveDispatches.leaderTime), asc(copyLiveDispatches.id)).limit(limit);
  }
  /** Fills the watcher confirmed over REST inside both its verified span and
   * the leader's mainnet copy stream's coverage that the stream does not
   * hold. Zero-hash fills without a TWAP id are left out on both paths. */
  async unmirroredFills(leader: string, limit = 100): Promise<{ tid: string; time: number }[]> {
    const id = `mainnet:${leader}`;
    const rows = await this.db.select({ tid: fills.tid, ts: fills.ts }).from(fills)
      .innerJoin(fillCoverage, and(eq(fillCoverage.chain, fills.chain), eq(fillCoverage.address, fills.address)))
      .innerJoin(copyLiveSourceStreams, eq(copyLiveSourceStreams.id, id))
      .where(and(eq(fills.chain, CHAIN_DEFAULT), eq(fills.address, leader),
        sql`${fills.ts} >= greatest(${copyLiveSourceStreams.coverageFrom}, ${fillCoverage.verifiedFrom})`,
        sql`${fills.ts} <= least(${copyLiveSourceStreams.coverageThrough}, ${fillCoverage.verifiedThrough})`,
        sql`not (coalesce(${fills.raw}->>'hash', '') ~ '^0x0{64}$' and coalesce(jsonb_typeof(${fills.raw}->'twapId'), 'null') = 'null')`,
        sql`not exists (select 1 from ${copyLiveSourceFills} s where s.stream_id = ${id} and s.tid = ${fills.tid}::text)`))
      .orderBy(asc(fills.ts), asc(fills.tid)).limit(limit);
    return rows.map(row => ({ tid: row.tid.toString(), time: row.ts.getTime() }));
  }
  async dispatch(id: string): Promise<DispatchRow | null> {
    const [row] = await this.db.select().from(copyLiveDispatches).where(eq(copyLiveDispatches.id, id));
    return row ?? null;
  }
  /** Moves a work row on from exactly the row its caller read (compare and
   * set on state, attempts and reason), never from a terminal one (settled,
   * refused): a stale or concurrent pass changes nothing, so two passes that
   * read the same attempt cannot both count it, and neither can overwrite
   * the other's reason. */
  async update(read: Pick<DispatchRow, 'id' | 'state' | 'attempts' | 'reason'>, patch: Partial<typeof copyLiveDispatches.$inferInsert>): Promise<boolean> {
    if (read.state !== 'pending' && read.state !== 'submitted') return false;
    const { id: _id, mandateId: _m, sourceFillId: _f, leg: _l, ...allowed } = patch;
    const rows = await this.db.update(copyLiveDispatches).set({ ...allowed, updatedAt: new Date() })
      .where(and(eq(copyLiveDispatches.id, read.id), eq(copyLiveDispatches.state, read.state), eq(copyLiveDispatches.attempts, read.attempts),
        read.reason === null ? isNull(copyLiveDispatches.reason) : eq(copyLiveDispatches.reason, read.reason)))
      .returning({ id: copyLiveDispatches.id });
    return rows.length === 1;
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
  /** Whether the owner closed `coin` by hand after this generation's latest
   * open of it: the leader's later reductions have nothing left to reduce. */
  async closedByOwner(mandateId: string, accountId: string, coin: string): Promise<boolean> {
    const [open] = await this.db.select({ at: copyLiveDispatches.createdAt }).from(copyLiveDispatches)
      .where(and(eq(copyLiveDispatches.mandateId, mandateId), eq(copyLiveDispatches.coin, coin), eq(copyLiveDispatches.leg, 'open'), inArray(copyLiveDispatches.state, ['submitted', 'settled'])))
      .orderBy(sql`${copyLiveDispatches.createdAt} desc`).limit(1);
    if (!open) return false;
    const [closed] = await this.db.select({ id: copyLiveManualCloses.id }).from(copyLiveManualCloses)
      .where(and(eq(copyLiveManualCloses.accountId, accountId), eq(copyLiveManualCloses.coin, coin), eq(copyLiveManualCloses.state, 'done'), gt(copyLiveManualCloses.updatedAt, open.at))).limit(1);
    return closed !== undefined;
  }
  async sourceNetwork(strategyId: number): Promise<LiveSourceNetwork | null> {
    const [row] = await this.db.select({ network: copyLiveStrategyConfigs.sourceNetwork }).from(copyLiveStrategyConfigs).where(eq(copyLiveStrategyConfigs.strategyId, strategyId));
    return row?.network ?? null;
  }
  async strategyStatus(id: number): Promise<string | null> {
    const [row] = await this.db.select({ status: copyStrategies.status }).from(copyStrategies).where(eq(copyStrategies.id, id));
    return row?.status ?? null;
  }
  async mandate(id: string) {
    const [row] = await this.db.select().from(copyLiveMandates).where(eq(copyLiveMandates.id, id));
    return row ?? null;
  }
}
