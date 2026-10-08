import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { copyControls, copyExecutionAccounts, copyFundingOperations, copyLiveManualCloses, copyLiveActivations, copyLiveDispatches, copyLiveExecutions, copyLiveMandates,
  copyLiveReductionCarry, copyLiveRiskReservations, copyLiveSignalLegs, copyLiveIntentProvenance, copyLiveSourceFills, copyLiveSourceStreams, copyLiveStopOperations, copyLiveStrategyConfigs, copyStrategies, copyStrategyVersions, copyRiskPolicies, fillCoverage, fills, users } from '@trading-dashboard/shared/database';
import { ACTUAL_STRATEGY_MODE, CHAIN_DEFAULT, copyRiskLimitsSchema, copyStrategySettingsSchema, DEFAULT_COPY_RISK_LIMITS } from '@trading-dashboard/shared/contracts';
import { AppConfig } from '../../config/app-config.js';
import { DRIZZLE_CLIENT } from '../../db/db.constants.js';
import type { DrizzleDb } from '../../db/drizzle.provider.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { lockCopyUser } from '../copy-user-lock.js';
import { deploymentNetwork } from '../live-deployment.js';
import type { LiveSourceNetwork } from '../live/copy-live-source-evidence.js';
import { NEVER_PLACED } from '../live/live-execution.js';
import { decodeLiveCopyMandate } from '../copy-live-mandate-evidence.js';
import { liveCopySettingsDigest } from '../copy-live-mandate-consent.js';
import { canonicalLiveSourceLegs, decodeLiveSourceFill, liveSourceLegId } from '../live/copy-live-source-evidence.js';
import { liveSourceExecutionCloid } from '../live/postgres-live-preparation.js';

// A fill can still have an unsettled risk reservation. Prioritize its settlement
// before another same-coin leg; a terminal journal alone is not a release proof.
const unresolvedExecution = sql`exists (select 1 from ${copyLiveExecutions} j where j.key = ${copyLiveDispatches.executionKey}
  and (j.state in ('prepared', 'submitting', 'unknown', 'resting')
    or (j.state = 'rejected' and j.record->>'errorCode' = ${NEVER_PLACED})
    or exists (select 1 from ${copyLiveRiskReservations} r where r.key = j.key and r.state <> 'released')))`;

export type DispatchRow = typeof copyLiveDispatches.$inferSelect;
export interface LiveMandateWork {
  mandateId: string; userId: number; strategyId: number; accountId: string; accountAddress: string;
  sourceNetwork: LiveSourceNetwork; leaderAddress: string; cursor: Date; expiresAt: Date;
  strategyStatus: string; activated: boolean;
  /** When the worker started trading this generation; fills before it are not copied. */
  activatedAt: Date | null;
  /** Ratio sizing merges same-coin legs into one adjustment; fixed does not. */
  sizingMode?: 'ratio' | 'fixed' | null;
  budgetUsd?: string | null;
}
/** A merged leg: never sent on its own; its lead row's order carries it. */
export const MERGED_REASON = 'merged_into_adjustment';
export interface LiveStreamWork { network: LiveSourceNetwork; leaderAddress: string; earliestCursor: Date }

/** SQL for the live worker. Short transactions only; no provider I/O here.
 * Only the deployment's network: a generation, leg or order of another
 * network (a database that moved networks) is never worked here. */
@Injectable()
export class CopyLiveWorkerRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, private readonly uow: UnitOfWork, private readonly config: AppConfig) {}
  private get network() { return deploymentNetwork(this.config); }
  /** Legs of a generation on the deployment's network. */
  private ownNetwork() {
    return sql`exists (select 1 from ${copyLiveMandates} n where n.id = ${copyLiveDispatches.mandateId} and n.network = ${this.network})`;
  }

  /** Consent generations that are acknowledged and unexpired. */
  async mandates(now: number): Promise<LiveMandateWork[]> {
    const rows = await this.db.select({ mandate: copyLiveMandates, account: copyExecutionAccounts, strategy: copyStrategies, activatedAt: copyLiveActivations.activatedAt, activationState: copyLiveActivations.state,
      settings: copyStrategyVersions.settings, budgetUsd: copyLiveStrategyConfigs.budgetUsd })
      .from(copyLiveMandates)
      .innerJoin(copyExecutionAccounts, eq(copyExecutionAccounts.id, copyLiveMandates.accountId))
      .innerJoin(copyStrategies, eq(copyStrategies.id, copyLiveMandates.strategyId))
      .leftJoin(copyLiveActivations, eq(copyLiveActivations.mandateId, copyLiveMandates.id))
      .leftJoin(copyStrategyVersions, and(eq(copyStrategyVersions.strategyId, copyStrategies.id), eq(copyStrategyVersions.version, copyStrategies.version)))
      .leftJoin(copyLiveStrategyConfigs, eq(copyLiveStrategyConfigs.strategyId, copyStrategies.id))
      .where(and(eq(copyLiveMandates.state, 'active'), isNotNull(copyLiveMandates.consentDigest), isNotNull(copyLiveMandates.activationCursor),
        gt(copyLiveMandates.expiresAt, new Date(now)), eq(copyStrategies.mode, ACTUAL_STRATEGY_MODE), eq(copyLiveMandates.network, this.network),
        eq(copyExecutionAccounts.network, this.network), isNotNull(copyExecutionAccounts.address)))
      .orderBy(asc(copyLiveMandates.createdAt)).limit(500);
    return rows.map(({ mandate: m, account: a, strategy: s, activatedAt, activationState, settings, budgetUsd }) => ({ mandateId: m.id, userId: m.userId, strategyId: m.strategyId, accountId: m.accountId,
      accountAddress: a.address!, sourceNetwork: m.sourceNetwork, leaderAddress: m.leaderAddress, cursor: m.activationCursor!, expiresAt: m.expiresAt,
      strategyStatus: s.status, activated: activationState === 'activated', activatedAt,
      sizingMode: copyStrategySettingsSchema.safeParse(settings).data?.sizingMode ?? null, budgetUsd: budgetUsd ?? null }));
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
        if (!mandate || mandate.state !== 'active' || mandate.expiresAt.getTime() <= now || mandate.network !== this.network || !strategy || strategy.mode !== ACTUAL_STRATEGY_MODE || strategy.status !== 'paused' ||
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
    return (await this.limits()).maxSignalAgeSeconds * 1000;
  }
  /** The current risk policy's limits (the defaults when none parses). */
  async limits() {
    const [policy] = await this.db.select().from(copyRiskPolicies).orderBy(sql`${copyRiskPolicies.version} desc`).limit(1);
    const parsed = copyRiskLimitsSchema.safeParse(policy?.limits ?? DEFAULT_COPY_RISK_LIMITS);
    return parsed.success ? parsed.data : DEFAULT_COPY_RISK_LIMITS;
  }

  /** A copy's legs that may still merge: pending, on their own, never sent
   * (no journal for their order identity), with their source fills. */
  async mergeable(mandateId: string, keyOf: (row: DispatchRow) => string, limit = 200) {
    const rows = await this.db.select({ dispatch: copyLiveDispatches, fill: copyLiveSourceFills }).from(copyLiveDispatches)
      .innerJoin(copyLiveSourceFills, eq(copyLiveSourceFills.id, copyLiveDispatches.sourceFillId))
      .where(and(eq(copyLiveDispatches.mandateId, mandateId), eq(copyLiveDispatches.state, 'pending'), isNull(copyLiveDispatches.adjustmentId)))
      .orderBy(asc(copyLiveDispatches.leaderTime), asc(copyLiveDispatches.id)).limit(limit);
    if (!rows.length) return [];
    const journals = new Set((await this.db.select({ key: copyLiveExecutions.key }).from(copyLiveExecutions)
      .where(inArray(copyLiveExecutions.key, rows.map(row => keyOf(row.dispatch))))).map(row => row.key));
    return rows.filter(row => !journals.has(keyOf(row.dispatch)));
  }
  /** Makes `lead` one order for itself and `members`: each member is
   * recorded merged into it (refused, never sent on its own), all or none. */
  async merge(lead: Pick<DispatchRow, 'id' | 'mandateId'>, members: readonly string[]): Promise<boolean> {
    return this.uow.run(async tx => {
      const led = await tx.update(copyLiveDispatches).set({ adjustmentId: lead.id, updatedAt: new Date() })
        .where(and(eq(copyLiveDispatches.id, lead.id), eq(copyLiveDispatches.state, 'pending'), isNull(copyLiveDispatches.adjustmentId))).returning({ id: copyLiveDispatches.id });
      const merged = members.length ? await tx.update(copyLiveDispatches).set({ state: 'refused', reason: MERGED_REASON, adjustmentId: lead.id, updatedAt: new Date() })
        .where(and(inArray(copyLiveDispatches.id, [...members]), eq(copyLiveDispatches.mandateId, lead.mandateId), eq(copyLiveDispatches.state, 'pending'), isNull(copyLiveDispatches.adjustmentId)))
        .returning({ id: copyLiveDispatches.id }) : [];
      if (led.length !== 1 || merged.length !== members.length) throw new Error('adjustment_merge_conflict');
      return true;
    }).catch(error => { if (error instanceof Error && error.message === 'adjustment_merge_conflict') return false; throw error; });
  }
  /** Legs refused without an order, from pending and never sent: an open
   * superseded while too small (below_min_notional), a leg that waited to be
   * merged until its signal was too old (merged_signal_expired). */
  async refusePending(ids: readonly string[], reason: 'below_min_notional' | 'merged_signal_expired'): Promise<void> {
    if (!ids.length) return;
    await this.db.update(copyLiveDispatches).set({ state: 'refused', reason, updatedAt: new Date() })
      .where(and(inArray(copyLiveDispatches.id, [...ids]), eq(copyLiveDispatches.state, 'pending'), isNull(copyLiveDispatches.adjustmentId)));
  }
  /** Keep later same-coin legs behind uncertain execution outcomes and
   * never-placed orders still awaiting release. Definite fills continue
   * through the original generation and settlement proof checks. */
  async earlierPending(row: Pick<DispatchRow, 'id' | 'mandateId' | 'coin' | 'leaderTime'>): Promise<boolean> {
    const [earlier] = await this.db.select({ id: copyLiveDispatches.id }).from(copyLiveDispatches)
      .where(and(eq(copyLiveDispatches.mandateId, row.mandateId), eq(copyLiveDispatches.coin, row.coin),
        sql`(${copyLiveDispatches.state} = 'pending' or (${copyLiveDispatches.state} = 'submitted' and ${unresolvedExecution}))`, ne(copyLiveDispatches.id, row.id),
        sql`(${copyLiveDispatches.leaderTime}, ${copyLiveDispatches.id}) < (${row.leaderTime}, ${row.id})`)).limit(1);
    return earlier !== undefined;
  }
  /** The source fills an adjustment's lead order carries besides its own. */
  async members(leadId: string): Promise<string[]> {
    const rows = await this.db.select({ fill: copyLiveDispatches.sourceFillId }).from(copyLiveDispatches)
      .where(and(eq(copyLiveDispatches.adjustmentId, leadId), ne(copyLiveDispatches.id, leadId))).orderBy(asc(copyLiveDispatches.leaderTime), asc(copyLiveDispatches.id));
    return rows.map(row => row.fill);
  }
  /** An adjustment refused below the exchange minimum before any order
   * identity was claimed: its legs go back to waiting on their own (marked
   * `below_min_notional`), so the next same-side legs can join them. */
  async dissolve(lead: Pick<DispatchRow, 'id' | 'state' | 'attempts' | 'reason'>, attempts: number): Promise<boolean> {
    return this.uow.run(async tx => {
      const led = await tx.update(copyLiveDispatches).set({ adjustmentId: null, reason: 'below_min_notional', attempts, updatedAt: new Date() })
        .where(and(eq(copyLiveDispatches.id, lead.id), eq(copyLiveDispatches.state, 'pending'), eq(copyLiveDispatches.attempts, lead.attempts))).returning({ id: copyLiveDispatches.id });
      if (led.length !== 1) return false;
      await tx.update(copyLiveDispatches).set({ state: 'pending', reason: 'below_min_notional', adjustmentId: null, updatedAt: new Date() })
        .where(and(eq(copyLiveDispatches.adjustmentId, lead.id), ne(copyLiveDispatches.id, lead.id), eq(copyLiveDispatches.state, 'refused'), eq(copyLiveDispatches.reason, MERGED_REASON)));
      return true;
    });
  }

  /** Each coin's latest work row of a generation (the leader's latest leg,
   * a flip's open after its close), with its leader fill and the coin's
   * reduction carry (what a settled close still owes the follower). */
  async latestByCoin(mandateId: string): Promise<{ row: DispatchRow; fill: typeof copyLiveSourceFills.$inferSelect; carry: string | null }[]> {
    const rows = await this.db.selectDistinctOn([copyLiveDispatches.coin], { row: copyLiveDispatches, fill: copyLiveSourceFills, carry: copyLiveReductionCarry.carry })
      .from(copyLiveDispatches).innerJoin(copyLiveSourceFills, eq(copyLiveSourceFills.id, copyLiveDispatches.sourceFillId))
      .leftJoin(copyLiveReductionCarry, and(eq(copyLiveReductionCarry.mandateId, copyLiveDispatches.mandateId), eq(copyLiveReductionCarry.coin, copyLiveDispatches.coin)))
      .where(eq(copyLiveDispatches.mandateId, mandateId))
      .orderBy(copyLiveDispatches.coin, sql`${copyLiveDispatches.leaderTime} desc`, sql`case when ${copyLiveDispatches.leg} = 'open' then 0 else 1 end`, sql`${copyLiveDispatches.id} desc`).limit(1024);
    return rows.map(({ row, fill, carry }) => ({ row, fill, carry: carry ?? null }));
  }
  /** Asks the worker's single-position closer (copy_live_manual_closes, run
   * after the legs by CopyLiveManualCloser) to close what the follower still
   * holds of `row.coin` once the leader is flat: reduce-only IOCs by the
   * approved agent until the position is gone. One request per leader close
   * (`reconcile:<row id>`); none while a close of the coin is requested. */
  async requestFlatClose(row: Pick<DispatchRow, 'id' | 'userId' | 'accountId' | 'strategyId' | 'coin'>, at: Date): Promise<boolean> {
    const inserted = await this.db.insert(copyLiveManualCloses).values({ id: randomUUID(), userId: row.userId, accountId: row.accountId, strategyId: row.strategyId,
      idempotencyKey: `reconcile:${row.id}`.slice(0, 200), coin: row.coin, createdAt: at, updatedAt: at }).onConflictDoNothing().returning({ id: copyLiveManualCloses.id });
    return inserted.length === 1;
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
  /** Reconcile uncertain predecessors that block fresh same-coin work first.
   * Otherwise preserve fresh-signal priority, including a flip's close when
   * its open is pending, followed by unrelated reconciliation. */
  async open(limit = 100, mandateIds?: readonly string[]): Promise<DispatchRow[]> {
    if (mandateIds && !mandateIds.length) return [];
    const fresh = sql`case when ${copyLiveDispatches.state} = 'submitted' and ${unresolvedExecution} and exists (select 1 from ${copyLiveDispatches} p where p.mandate_id = ${copyLiveDispatches.mandateId}
      and p.coin = ${copyLiveDispatches.coin} and p.state = 'pending'
      and (${copyLiveDispatches.leaderTime}, ${copyLiveDispatches.id}) < (p.leader_time, p.id)) then 0
      when ${copyLiveDispatches.state} = 'pending' or exists (select 1 from ${copyLiveDispatches} p where p.mandate_id = ${copyLiveDispatches.mandateId}
        and p.source_fill_id = ${copyLiveDispatches.sourceFillId} and p.state = 'pending') then 1 else 2 end`;
    return this.db.select().from(copyLiveDispatches)
      .where(and(inArray(copyLiveDispatches.state, ['pending', 'submitted']), this.ownNetwork(), mandateIds ? inArray(copyLiveDispatches.mandateId, [...mandateIds]) : undefined))
      .orderBy(fresh, asc(copyLiveDispatches.leaderTime), asc(copyLiveDispatches.id)).limit(limit);
  }
  /** Fills the watcher confirmed over REST inside both its verified span and
   * the leader's mainnet copy stream's coverage that the stream does not
   * hold. Zero-hash fills without a TWAP id are left out on both paths. */
  async unmirroredFills(leader: string, limit = 100): Promise<{ tid: string; time: number; coin: string; streamFrom: number; streamThrough: number; verifiedFrom: number; verifiedThrough: number }[]> {
    const id = `mainnet:${leader}`;
    const rows = await this.db.select({ tid: fills.tid, ts: fills.ts, coin: fills.coin, streamFrom: copyLiveSourceStreams.coverageFrom, streamThrough: copyLiveSourceStreams.coverageThrough,
      verifiedFrom: fillCoverage.verifiedFrom, verifiedThrough: fillCoverage.verifiedThrough }).from(fills)
      .innerJoin(fillCoverage, and(eq(fillCoverage.chain, fills.chain), eq(fillCoverage.address, fills.address)))
      .innerJoin(copyLiveSourceStreams, eq(copyLiveSourceStreams.id, id))
      .where(and(eq(fills.chain, CHAIN_DEFAULT), eq(fills.address, leader),
        sql`${fills.ts} >= greatest(${copyLiveSourceStreams.coverageFrom}, ${fillCoverage.verifiedFrom})`,
        sql`${fills.ts} <= least(${copyLiveSourceStreams.coverageThrough}, ${fillCoverage.verifiedThrough})`,
        sql`not (coalesce(${fills.raw}->>'hash', '') ~ '^0x0{64}$' and coalesce(jsonb_typeof(${fills.raw}->'twapId'), 'null') = 'null')`,
        sql`not exists (select 1 from ${copyLiveSourceFills} s where s.stream_id = ${id} and s.tid = ${fills.tid}::text)`))
      .orderBy(asc(fills.ts), asc(fills.tid)).limit(limit);
    return rows.map(row => ({ tid: row.tid.toString(), time: row.ts.getTime(), coin: row.coin, streamFrom: row.streamFrom!.getTime(), streamThrough: row.streamThrough!.getTime(),
      verifiedFrom: row.verifiedFrom!.getTime(), verifiedThrough: row.verifiedThrough!.getTime() }));
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
  /** A negative admission hint only. A prior fixed claim already prevents a
   * second spend through the final SQL unique index, including failed claims.
   * Check its immutable source and original journal before costly provider reads.
   * This never releases a claim or proves that its order settled. */
  async knownFixedOpenClaim(row: DispatchRow, work: LiveMandateWork): Promise<boolean> {
    if (row.leg !== 'open' || row.state !== 'pending' || work.sizingMode !== 'fixed' || row.mandateId !== work.mandateId || row.userId !== work.userId || row.strategyId !== work.strategyId || row.accountId !== work.accountId) return false;
    const [binding] = await this.db.select({ dispatch: copyLiveDispatches, mandate: copyLiveMandates, account: copyExecutionAccounts,
      strategy: copyStrategies, version: copyStrategyVersions, source: copyLiveSourceFills, owner: users })
      .from(copyLiveDispatches)
      .innerJoin(copyLiveMandates, eq(copyLiveMandates.id, copyLiveDispatches.mandateId))
      .innerJoin(copyExecutionAccounts, eq(copyExecutionAccounts.id, copyLiveMandates.accountId))
      .innerJoin(copyStrategies, eq(copyStrategies.id, copyLiveMandates.strategyId))
      .innerJoin(copyStrategyVersions, and(eq(copyStrategyVersions.strategyId, copyLiveMandates.strategyId), eq(copyStrategyVersions.version, copyLiveMandates.strategyVersion)))
      .innerJoin(copyLiveSourceFills, eq(copyLiveSourceFills.id, copyLiveDispatches.sourceFillId))
      .innerJoin(users, eq(users.id, copyLiveMandates.userId))
      .where(and(eq(copyLiveDispatches.id, row.id), eq(copyLiveMandates.network, this.network))).limit(1);
    if (!binding) return false;
    let fill: ReturnType<typeof decodeLiveSourceFill>, consent: ReturnType<typeof decodeLiveCopyMandate>;
    try {
      fill = decodeLiveSourceFill(binding.source); consent = decodeLiveCopyMandate(binding.mandate);
      const settings = copyStrategySettingsSchema.parse(binding.version.settings);
      const d = binding.dispatch, a = binding.account, s = binding.strategy, m = binding.mandate;
      if (settings.sizingMode !== 'fixed' || liveCopySettingsDigest(settings) !== consent.settingsDigest || !m.consentDigest || !m.activationCursor ||
        m.id !== work.mandateId || m.userId !== work.userId || m.strategyId !== work.strategyId || m.accountId !== work.accountId || m.accountAddress !== work.accountAddress ||
        m.sourceNetwork !== work.sourceNetwork || m.leaderAddress !== work.leaderAddress || m.activationCursor.getTime() !== work.cursor.getTime() ||
        d.mandateId !== m.id || d.userId !== m.userId || d.strategyId !== m.strategyId || d.accountId !== m.accountId || d.state !== 'pending' || d.leg !== 'open' || d.executionKey !== null ||
        d.sourceFillId !== row.sourceFillId || d.coin !== row.coin || d.leaderTime.getTime() !== row.leaderTime.getTime() || d.coin !== fill.coin || d.leaderTime.getTime() !== fill.providerTime ||
        a.userId !== m.userId || a.strategyId !== m.strategyId || a.network !== m.network || a.address !== m.accountAddress || a.privyUserId !== consent.ownerPrivyUserId ||
        binding.owner.privyUserId !== consent.ownerPrivyUserId || binding.owner.embeddedWalletAddress !== consent.ownerAddress ||
        s.userId !== m.userId || s.network !== m.network || s.mode !== ACTUAL_STRATEGY_MODE || s.version !== m.strategyVersion ||
        fill.network !== consent.sourceNetwork || fill.leaderAddress !== consent.leaderAddress || fill.providerTime <= m.activationCursor.getTime() ||
        !canonicalLiveSourceLegs(fill).some(leg => leg.leg === 'open')) return false;
    } catch { return false; }
    const [claim] = await this.db.select({ leg: copyLiveSignalLegs, source: copyLiveSourceFills, journal: copyLiveExecutions, provenance: copyLiveIntentProvenance })
      .from(copyLiveSignalLegs)
      .innerJoin(copyLiveSourceFills, eq(copyLiveSourceFills.id, copyLiveSignalLegs.sourceFillId))
      .innerJoin(copyLiveExecutions, eq(copyLiveExecutions.key, copyLiveSignalLegs.executionKey))
      .innerJoin(copyLiveIntentProvenance, and(eq(copyLiveIntentProvenance.key, copyLiveExecutions.key), eq(copyLiveIntentProvenance.legId, copyLiveSignalLegs.id), eq(copyLiveIntentProvenance.mandateId, copyLiveSignalLegs.mandateId)))
      .where(and(eq(copyLiveSignalLegs.mandateId, work.mandateId), eq(copyLiveSignalLegs.tradeKey, fill.tradeKey), eq(copyLiveSignalLegs.leg, 'open'), eq(copyLiveSignalLegs.fixedTradeClaim, true), ne(copyLiveSignalLegs.sourceFillId, fill.id))).limit(1);
    if (!claim) return false;
    try {
      const original = decodeLiveSourceFill(claim.source), leg = canonicalLiveSourceLegs(original).find(value => value.leg === 'open');
      const cloid = liveSourceExecutionCloid(work.mandateId, original.id, 'open'), key = `${this.network}:${work.accountAddress}:${cloid}`;
      return !!leg && original.network === fill.network && original.leaderAddress === fill.leaderAddress && original.streamId === fill.streamId && original.coin === fill.coin &&
        original.tradeKey === fill.tradeKey && original.providerTime > binding.mandate.activationCursor!.getTime() &&
        claim.leg.id === liveSourceLegId(work.mandateId, original.id, 'open') && claim.leg.tradeKey === leg.tradeKey && claim.leg.sign === leg.sign && claim.leg.size === leg.size && claim.leg.fraction === leg.fraction &&
        claim.leg.executionKey === key && claim.journal.key === key && claim.journal.network === this.network && claim.journal.userId === work.userId && claim.journal.strategyId === work.strategyId && claim.journal.accountAddress === work.accountAddress && claim.journal.cloid === cloid &&
        claim.journal.record.key === key && claim.journal.record.fingerprint === claim.provenance.fingerprint && claim.provenance.sourceDigest === original.sourceDigest && claim.provenance.settingsDigest === consent.settingsDigest;
    } catch { return false; }
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
    const [row] = await this.db.select().from(copyLiveMandates).where(and(eq(copyLiveMandates.id, id), eq(copyLiveMandates.network, this.network)));
    return row ?? null;
  }
}
