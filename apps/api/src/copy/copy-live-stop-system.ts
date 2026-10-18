import { HttpException, Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { ACTUAL_STRATEGY_MODE } from '@trading-dashboard/shared/contracts';
import { copyControlEvents, copyExecutionAccounts, copyLiveMandates, copyLiveStopOperations, copyStrategies } from '@trading-dashboard/shared/database';
import { recordAdminAudit, type AuditActor } from '../common/audit/admin-audit.js';
import { AppConfig } from '../config/app-config.js';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import { UnitOfWork, type DbExecutor, type DbTransaction } from '../db/unit-of-work.js';
import { CopyLiveStopRepository } from './copy-live-stop.repository.js';
import { deploymentNetwork, liveExecutionEnabled } from './live-deployment.js';
import { CLOSE_ALL_RESUME_AFTER_MS } from '../config/constants/timings.js';

/** A running actual copy that a system stop can end: its account, owner and
 * the account's newest activated generation that has not stopped. */
interface RunningCopy { readonly userId: number; readonly strategyId: number; readonly accountId: string; readonly mandateId: string; readonly mandateRevision: number }
/** An account the system could not stop, and why (never counted as handled). */
export interface Unhandled { readonly accountId: string; readonly code: string }
export interface SystemStopOutcome { readonly stopped: Array<{ accountId: string; stopId: string }>; readonly refused: Unhandled[] }
/** Every not-stopped actual copy in scope, sorted into: stoppable now, already
 * stopping (an open stop the worker works), and unhandled (a blocked stop, no
 * activated generation, or execution disabled on this deployment). */
interface CloseAllTargets { readonly copies: RunningCopy[]; readonly stopping: Array<{ accountId: string; stopId: string }>; readonly unhandled: Unhandled[] }
/** What a close-all did for actual copies; `complete` only when nothing was left unhandled. */
interface CloseAllOutcome {
  readonly liveCloseAll: 'done'; readonly liveStops: number; readonly liveStopping: number; readonly liveUnhandled: Unhandled[]; readonly complete: boolean;
}
/** Why the system stops a copy; part of the stop's idempotency key and audit. */
type SystemStopReason = 'admin_close_all' | 'agent_expiring' | 'follower_liquidated' | 'owner_disabled';
const KEY_PREFIX: Record<SystemStopReason, string> = { admin_close_all: 'admin-close-all', agent_expiring: 'agent-expiry', follower_liquidated: 'liquidated', owner_disabled: 'owner-disabled' };
/** Unhandled reasons that leave nothing running: no generation ever traded, or no worker trades on this deployment. */
const NOTHING_RUNNING = new Set(['no_activated_generation', 'live_execution_disabled']);
const PAGE = 500;

/**
 * System-initiated stops for this network's actual copies (admin 全部平倉, expiring agent,
 * liquidation, disabled owner): the owner's stop (close, then return), one transaction per copy so
 * one refusal never holds the others, audited as copy.control.
 * A close-all's event is written `liveCloseAll: 'pending'`, then `done` with the outcome; a pending
 * one is resumed by the worker (resumePendingCloseAll) with the same stop keys.
 */
@Injectable()
export class CopyLiveSystemStops {
  /** Replaced in tests. */
  now: () => number = Date.now;
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, private readonly uow: UnitOfWork, private readonly stops: CopyLiveStopRepository, private readonly config: AppConfig) {}

  /** Every not-stopped actual copy of this network matching `filter` (paged), none skipped silently. */
  async targets(filter: { userId?: number; createdBefore?: Date; agentExpiresBy?: Date; liquidated?: boolean } = {}, db: DbExecutor = this.db): Promise<CloseAllTargets> {
    const network = deploymentNetwork(this.config), enabled = liveExecutionEnabled(this.config);
    const copies: RunningCopy[] = [], stopping: CloseAllTargets['stopping'] = [], unhandled: Unhandled[] = [];
    for (let after = '';;) {
      const page = await db.select({ accountId: copyExecutionAccounts.id, userId: copyExecutionAccounts.userId, strategyId: copyStrategies.id }).from(copyExecutionAccounts)
        .innerJoin(copyStrategies, eq(copyStrategies.id, copyExecutionAccounts.strategyId))
        .where(and(eq(copyStrategies.mode, ACTUAL_STRATEGY_MODE), eq(copyStrategies.network, network), eq(copyExecutionAccounts.network, network), ne(copyStrategies.status, 'stopped'),
          gt(copyExecutionAccounts.id, after), filter.userId === undefined ? undefined : eq(copyExecutionAccounts.userId, filter.userId),
          filter.createdBefore ? lt(copyStrategies.createdAt, filter.createdBefore) : undefined,
          filter.agentExpiresBy ? sql`exists (select 1 from copy_agent_setups s where s.account_id = ${copyExecutionAccounts.id} and s.state = 'active' and s.expires_at <= ${filter.agentExpiresBy})` : undefined,
          filter.liquidated ? sql`exists (select 1 from copy_follower_account_state q where q.account_id = ${copyExecutionAccounts.id} and q.quarantined and q.reason = 'follower_liquidated')` : undefined))
        .orderBy(asc(copyExecutionAccounts.id)).limit(PAGE);
      for (const account of page) {
        const [open] = await db.select({ id: copyLiveStopOperations.id, state: copyLiveStopOperations.state }).from(copyLiveStopOperations)
          .where(and(eq(copyLiveStopOperations.accountId, account.accountId), ne(copyLiveStopOperations.state, 'stopped'))).limit(1);
        // A blocked stop is never worked: the copy is not being stopped.
        if (open?.state === 'blocked') { unhandled.push({ accountId: account.accountId, code: 'stop_blocked' }); continue; }
        if (open) {
          if (enabled) stopping.push({ accountId: account.accountId, stopId: open.id });
          else unhandled.push({ accountId: account.accountId, code: 'live_execution_disabled' });
          continue;
        }
        const [generation] = await db.select({ id: copyLiveMandates.id, revision: copyLiveMandates.revision }).from(copyLiveMandates)
          .where(and(eq(copyLiveMandates.accountId, account.accountId), isNotNull(copyLiveMandates.activationCursor), ne(copyLiveMandates.state, 'stopped')))
          .orderBy(desc(copyLiveMandates.createdAt)).limit(1);
        // Mid-setup (never activated): a stop has nothing to close with; any
        // deposit that arrived is the owner's to return.
        if (!generation) { unhandled.push({ accountId: account.accountId, code: 'no_activated_generation' }); continue; }
        // No worker executes stops on a deployment without actual execution.
        if (!enabled) { unhandled.push({ accountId: account.accountId, code: 'live_execution_disabled' }); continue; }
        copies.push({ ...account, mandateId: generation.id, mandateRevision: generation.revision });
      }
      if (page.length < PAGE) break;
      after = page.at(-1)!.accountId;
    }
    return { copies, stopping, unhandled };
  }

  /**
   * Liabilities of closed copies (mainnet 2026-10-18, strategy 12): a reservation left
   * quarantined on a copy that is stopped, whose stop proved it flat after the order ended (its
   * journal terminal, or past its exchange expiry, before the flat certificate), with no money
   * moving, no generation running and no other order of the account in flight, bounds no
   * exposure; nothing else can release it once settlement gave up on it. Released
   * 'closed_account', its evidence the flat certificate; an open copy's is never touched.
   */
  async releaseClosedLiabilities(): Promise<Array<{ key: string; accountId: string; stopId: string }>> {
    const network = deploymentNetwork(this.config);
    const rows = await this.db.execute<{ key: string; account_id: string; stop_id: string }>(sql`
      update copy_live_risk_reservations r set state = 'released', release_reason = 'closed_account', release_evidence_digest = c.flat_digest,
        revision = r.revision + 1, updated_at = greatest(clock_timestamp(), r.updated_at)
      from (
        select distinct on (q.key) q.key, s.id as stop_id, s.flat_digest from copy_live_risk_reservations q
        join copy_execution_accounts a on a.id = q.account_id
        join copy_strategies st on st.id = a.strategy_id
        join copy_live_executions j on j.key = q.key
        join copy_live_stop_operations s on s.account_id = q.account_id and s.state = 'stopped' and s.flat_digest is not null and s.flat_verified_at is not null
          and s.flat_verified_at >= j.updated_at
          and (j.state in ('filled', 'partial', 'cancelled', 'rejected') or (j.record->>'expiresAfter')::bigint < extract(epoch from s.flat_verified_at) * 1000)
        where q.state = 'quarantined' and q.network = ${network} and a.network = ${network} and st.status = 'stopped'
          and not exists (select 1 from copy_funding_operations f where f.account_id = q.account_id and f.status in ('prepared', 'unknown', 'accepted'))
          and not exists (select 1 from copy_live_mandates m where m.account_id = q.account_id and m.state in ('active', 'paused', 'stopping'))
          and not exists (select 1 from copy_live_executions o where o.network = q.network and o.account_address = q.account_address and o.key <> q.key
            and o.state in ('prepared', 'submitting', 'unknown', 'resting'))
        order by q.key, s.flat_verified_at desc
      ) c
      where r.key = c.key and r.state = 'quarantined'
      returning r.key, r.account_id, c.stop_id`);
    return rows.rows.map(row => ({ key: row.key, accountId: row.account_id, stopId: row.stop_id }));
  }

  /** Stops each copy (close, then return), each in its own transaction, or
   * each in its own savepoint of `tx` when given. */
  async stopAll(copies: readonly RunningCopy[], reason: SystemStopReason, actor: AuditActor, ref: string, tx?: DbTransaction): Promise<SystemStopOutcome> {
    const run = <T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> => tx ? tx.transaction(work) : this.uow.run(work);
    const outcome: SystemStopOutcome = { stopped: [], refused: [] };
    for (const copy of copies) {
      // The generation and its revision make the key: a later generation is a new stop.
      const key = `${KEY_PREFIX[reason]}-${ref}-${copy.mandateId}-${copy.mandateRevision}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128);
      try {
        const stop = await run(async tx => {
          const row = await this.stops.request(tx, copy.userId, copy.mandateId, { idempotencyKey: key, expectedMandateRevision: copy.mandateRevision }, this.now, true);
          await recordAdminAudit(tx, actor, 'copy.control', `account:${copy.accountId}`, null,
            { command: 'close_positions', reason, ref, stopId: row.id, stopState: row.state, strategyId: copy.strategyId, mandateId: copy.mandateId });
          return row;
        });
        // A stop created blocked (unproven tracking) is not worked: unhandled.
        if (stop.state === 'blocked') outcome.refused.push({ accountId: copy.accountId, code: 'stop_blocked' });
        else outcome.stopped.push({ accountId: copy.accountId, stopId: stop.id });
      } catch (error) {
        // Reported; the other copies still stop.
        const response = error instanceof HttpException ? error.getResponse() : null;
        const code = response && typeof response === 'object' && 'code' in response && typeof response.code === 'string' ? response.code : error instanceof HttpException ? `http_${error.getStatus()}` : 'stop_request_failed';
        outcome.refused.push({ accountId: copy.accountId, code });
      }
    }
    return outcome;
  }

  /** The actual-copy half of a close-all: every not-stopped copy started before the event is stopped
   * or reported, recorded on the event and audit. Idempotent (same stop keys). */
  async closeAll(event: { id: bigint; scope: string; scopeId: number; revision: number; createdAt: Date }, actor: AuditActor): Promise<CloseAllOutcome> {
    const targets = await this.targets({ ...(event.scope === 'user' ? { userId: event.scopeId } : {}), createdBefore: event.createdAt });
    const outcome = await this.stopAll(targets.copies, 'admin_close_all', actor, `r${event.revision}`);
    const unhandled = [...targets.unhandled, ...outcome.refused];
    const result: CloseAllOutcome = { liveCloseAll: 'done', liveStops: outcome.stopped.length, liveStopping: targets.stopping.length, liveUnhandled: unhandled, complete: unhandled.length === 0 };
    await this.uow.run(async tx => {
      await tx.update(copyControlEvents).set({ result: sql`${copyControlEvents.result} || ${JSON.stringify(result)}::jsonb` }).where(eq(copyControlEvents.id, event.id));
      // The outcome is audited whenever an actual copy was in scope.
      if (targets.copies.length || targets.stopping.length || unhandled.length)
        await recordAdminAudit(tx, actor, 'copy.control', `${event.scope}:${event.scopeId}`, null, { command: 'close_positions', event: String(event.id), ...result });
    });
    return result;
  }

  /** Close-alls whose actual-copy half never finished (`pending` past the
   * resume delay): run again by the worker. */
  async resumePendingCloseAll(): Promise<Array<{ event: string } & CloseAllOutcome>> {
    const pending = await this.db.select().from(copyControlEvents)
      .where(and(eq(copyControlEvents.command, 'close_positions'), sql`${copyControlEvents.result}->>'liveCloseAll' = 'pending'`,
        lt(copyControlEvents.createdAt, new Date(this.now() - CLOSE_ALL_RESUME_AFTER_MS))))
      .orderBy(asc(copyControlEvents.id)).limit(20);
    const done: Array<{ event: string } & CloseAllOutcome> = [];
    for (const event of pending) done.push({ event: String(event.id), ...await this.closeAll(event, null) });
    return done;
  }

  /** Liquidated copies are stopped so what is left is returned (architecture review §7.3). */
  async stopLiquidated(): Promise<SystemStopOutcome> {
    const targets = await this.targets({ liquidated: true });
    const outcome = targets.copies.length ? await this.stopAll(targets.copies, 'follower_liquidated', null, 'liquidation') : { stopped: [], refused: [] };
    return { stopped: outcome.stopped, refused: [...targets.unhandled, ...outcome.refused] };
  }

  /** Takes the stop path's fences in `tx`; a caller that will stopOwner in
   * it calls this before taking the owner's copy lock or rows. */
  fenceOwnerStops(tx: DbTransaction): Promise<void> { return this.stops.fence(tx); }

  /**
   * Admin disables an owner (in the disable's `tx`, after fenceOwnerStops): nobody would manage their
   * running copies, so each is stopped. `leftRunning`: copies without a worked stop; the caller
   * refuses the disable while there are any.
   */
  async stopOwner(tx: DbTransaction, userId: number, actor: AuditActor): Promise<SystemStopOutcome & { stopping: Array<{ accountId: string; stopId: string }>; leftRunning: Unhandled[] }> {
    const targets = await this.targets({ userId }, tx);
    const outcome = targets.copies.length ? await this.stopAll(targets.copies, 'owner_disabled', actor, 'disable', tx) : { stopped: [], refused: [] };
    const refused = [...targets.unhandled, ...outcome.refused];
    return { stopped: outcome.stopped, refused, stopping: targets.stopping, leftRunning: refused.filter(u => !NOTHING_RUNNING.has(u.code)) };
  }

  /** Copies whose agent expires within `marginMs` are stopped before it does
   * (a stop needs the agent to close; an expired one strands the positions). */
  async stopExpiring(marginMs: number): Promise<SystemStopOutcome> {
    const targets = await this.targets({ agentExpiresBy: new Date(this.now() + marginMs) });
    const outcome = targets.copies.length ? await this.stopAll(targets.copies, 'agent_expiring', null, 'agent') : { stopped: [], refused: [] };
    return { stopped: outcome.stopped, refused: [...targets.unhandled, ...outcome.refused] };
  }
}
