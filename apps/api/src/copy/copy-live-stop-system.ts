import { HttpException, Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { ACTUAL_STRATEGY_MODE } from '@trading-dashboard/shared/contracts';
import { copyControlEvents, copyExecutionAccounts, copyLiveMandates, copyLiveStopOperations, copyStrategies } from '@trading-dashboard/shared/database';
import { recordAdminAudit, type AuditActor } from '../common/audit/admin-audit.js';
import { AppConfig } from '../config/app-config.js';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { CopyLiveStopRepository } from './copy-live-stop.repository.js';
import { deploymentNetwork, liveExecutionEnabled } from './live-deployment.js';

/** A running actual copy that a system stop can end: its account, owner and
 * the account's newest activated generation that has not stopped. */
export interface RunningCopy { readonly userId: number; readonly strategyId: number; readonly accountId: string; readonly mandateId: string; readonly mandateRevision: number }
/** An account the system could not stop, and why (never counted as handled). */
export interface Unhandled { readonly accountId: string; readonly code: string }
export interface SystemStopOutcome { readonly stopped: Array<{ accountId: string; stopId: string }>; readonly refused: Unhandled[] }
/** Every not-stopped actual copy in scope, sorted into: stoppable now, already
 * stopping (an open stop the worker works), and unhandled (a blocked stop, no
 * activated generation, or execution disabled on this deployment). */
export interface CloseAllTargets { readonly copies: RunningCopy[]; readonly stopping: Array<{ accountId: string; stopId: string }>; readonly unhandled: Unhandled[] }
/** What a close-all did for actual copies; `complete` only when nothing was left unhandled. */
export interface CloseAllOutcome {
  readonly liveCloseAll: 'done'; readonly liveStops: number; readonly liveStopping: number; readonly liveUnhandled: Unhandled[]; readonly complete: boolean;
}
/** Why the system stops a copy; part of the stop's idempotency key and audit. */
export type SystemStopReason = 'admin_close_all' | 'agent_expiring';
const KEY_PREFIX: Record<SystemStopReason, string> = { admin_close_all: 'admin-close-all', agent_expiring: 'agent-expiry' };
const PAGE = 500;
/** A close-all the api did not finish (it crashed after the control commit)
 * is resumed by the worker once it is this old. */
export const CLOSE_ALL_RESUME_AFTER_MS = 60_000;

/**
 * Stops the system starts for actual copies of this deployment's network:
 * the admin's 全部平倉 (close-all at platform or user scope) and a copy whose
 * agent is about to expire. Each is the same stop an owner asks for (close
 * every position, then return the funds, worked by CopyLiveStopper), one
 * transaction per copy so one copy's refusal never holds the others, audited
 * as copy.control on the account.
 *
 * A close-all covers every actual copy of the network that has not stopped
 * (any of them may hold funds or positions): each is stopped, or already
 * stopping, or reported as unhandled with its reason. Its control event is
 * written `liveCloseAll: 'pending'` in the control transaction and `done`
 * with the outcome afterwards; a pending one (the api died in between) is
 * resumed by the worker (resumePendingCloseAll), with the same stop keys.
 */
@Injectable()
export class CopyLiveSystemStops {
  /** Replaced in tests. */
  now: () => number = Date.now;
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, private readonly uow: UnitOfWork, private readonly stops: CopyLiveStopRepository, private readonly config: AppConfig) {}

  /** Actual copies of this network that have not stopped, optionally of one
   * owner, started before `createdBefore`, or whose active agent expires by
   * `agentExpiresBy`; all of them (paged), none skipped silently. */
  async targets(filter: { userId?: number; createdBefore?: Date; agentExpiresBy?: Date } = {}): Promise<CloseAllTargets> {
    const network = deploymentNetwork(this.config), enabled = liveExecutionEnabled(this.config);
    const copies: RunningCopy[] = [], stopping: CloseAllTargets['stopping'] = [], unhandled: Unhandled[] = [];
    for (let after = '';;) {
      const page = await this.db.select({ accountId: copyExecutionAccounts.id, userId: copyExecutionAccounts.userId, strategyId: copyStrategies.id }).from(copyExecutionAccounts)
        .innerJoin(copyStrategies, eq(copyStrategies.id, copyExecutionAccounts.strategyId))
        .where(and(eq(copyStrategies.mode, ACTUAL_STRATEGY_MODE), eq(copyStrategies.network, network), eq(copyExecutionAccounts.network, network), ne(copyStrategies.status, 'stopped'),
          gt(copyExecutionAccounts.id, after), filter.userId === undefined ? undefined : eq(copyExecutionAccounts.userId, filter.userId),
          filter.createdBefore ? lt(copyStrategies.createdAt, filter.createdBefore) : undefined,
          filter.agentExpiresBy ? sql`exists (select 1 from copy_agent_setups s where s.account_id = ${copyExecutionAccounts.id} and s.state = 'active' and s.expires_at <= ${filter.agentExpiresBy})` : undefined))
        .orderBy(asc(copyExecutionAccounts.id)).limit(PAGE);
      for (const account of page) {
        const [open] = await this.db.select({ id: copyLiveStopOperations.id, state: copyLiveStopOperations.state }).from(copyLiveStopOperations)
          .where(and(eq(copyLiveStopOperations.accountId, account.accountId), ne(copyLiveStopOperations.state, 'stopped'))).limit(1);
        // A blocked stop is never worked: the copy is not being stopped.
        if (open?.state === 'blocked') { unhandled.push({ accountId: account.accountId, code: 'stop_blocked' }); continue; }
        if (open) {
          if (enabled) stopping.push({ accountId: account.accountId, stopId: open.id });
          else unhandled.push({ accountId: account.accountId, code: 'live_execution_disabled' });
          continue;
        }
        const [generation] = await this.db.select({ id: copyLiveMandates.id, revision: copyLiveMandates.revision }).from(copyLiveMandates)
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

  /** Stops each copy (close, then return), each in its own transaction. */
  async stopAll(copies: readonly RunningCopy[], reason: SystemStopReason, actor: AuditActor, ref: string): Promise<SystemStopOutcome> {
    const outcome: SystemStopOutcome = { stopped: [], refused: [] };
    for (const copy of copies) {
      // The generation and its revision make the key: a later generation is a new stop.
      const key = `${KEY_PREFIX[reason]}-${ref}-${copy.mandateId}-${copy.mandateRevision}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128);
      try {
        const stop = await this.uow.run(async tx => {
          const row = await this.stops.request(tx, copy.userId, copy.mandateId, { idempotencyKey: key, expectedMandateRevision: copy.mandateRevision }, this.now, true);
          await recordAdminAudit(tx, actor, 'copy.control', `account:${copy.accountId}`, null,
            { command: 'close_positions', reason, ref, stopId: row.id, stopState: row.state, strategyId: copy.strategyId, mandateId: copy.mandateId });
          return row;
        });
        // A stop created blocked (unproven tracking) is not worked: unhandled.
        if (stop.state === 'blocked') outcome.refused.push({ accountId: copy.accountId, code: 'stop_blocked' });
        else outcome.stopped.push({ accountId: copy.accountId, stopId: stop.id });
      } catch (error) {
        // Its records disagree, it changed meanwhile, or it already stopped:
        // reported, and the other copies still stop.
        const response = error instanceof HttpException ? error.getResponse() : null;
        const code = response && typeof response === 'object' && 'code' in response && typeof response.code === 'string' ? response.code : error instanceof HttpException ? `http_${error.getStatus()}` : 'stop_request_failed';
        outcome.refused.push({ accountId: copy.accountId, code });
      }
    }
    return outcome;
  }

  /**
   * The actual-copy half of a close-all whose control event is `eventId`
   * (scope: the platform, or one owner): every not-stopped copy started
   * before the event is stopped or reported; the event's result and the
   * audit record the outcome. Idempotent (same stop keys): the worker
   * resumes one the api did not finish.
   */
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

  /** Copies whose agent expires within `marginMs` are stopped before it does
   * (a stop needs the agent to close; an expired one strands the positions). */
  async stopExpiring(marginMs: number): Promise<SystemStopOutcome> {
    const targets = await this.targets({ agentExpiresBy: new Date(this.now() + marginMs) });
    const outcome = targets.copies.length ? await this.stopAll(targets.copies, 'agent_expiring', null, 'agent') : { stopped: [], refused: [] };
    return { stopped: outcome.stopped, refused: [...targets.unhandled, ...outcome.refused] };
  }
}
