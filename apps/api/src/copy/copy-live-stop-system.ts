import { HttpException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { ACTUAL_STRATEGY_MODE } from '@trading-dashboard/shared/contracts';
import { copyAgentSetups, copyExecutionAccounts, copyLiveMandates, copyLiveStopOperations, copyStrategies } from '@trading-dashboard/shared/database';
import { recordAdminAudit, type AuditActor } from '../common/audit/admin-audit.js';
import { AppConfig } from '../config/app-config.js';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { CopyLiveStopRepository } from './copy-live-stop.repository.js';
import { deploymentNetwork } from './live-deployment.js';

/** A running actual copy that a system stop can end: its account, owner and
 * the account's newest activated generation that has not stopped. */
export interface RunningCopy { readonly userId: number; readonly strategyId: number; readonly accountId: string; readonly mandateId: string; readonly mandateRevision: number }
export interface SystemStopOutcome { readonly stopped: Array<{ accountId: string; stopId: string }>; readonly refused: Array<{ accountId: string; code: string }> }
/** Why the system stops a copy; part of the stop's idempotency key and audit. */
export type SystemStopReason = 'admin_close_all' | 'agent_expiring';
const KEY_PREFIX: Record<SystemStopReason, string> = { admin_close_all: 'admin-close-all', agent_expiring: 'agent-expiry' };

/**
 * Stops the system starts for actual copies of this deployment's network:
 * the admin's 全部平倉 (close-all at platform or user scope) and a copy whose
 * agent is about to expire. Each is the same stop an owner asks for (close
 * every position, then return the funds, worked by CopyLiveStopper), one
 * transaction per copy so one copy's refusal never holds the others, audited
 * as copy.control on the account. Copies already stopping (an open stop) are
 * left to that stop.
 */
@Injectable()
export class CopyLiveSystemStops {
  /** Replaced in tests. */
  now: () => number = Date.now;
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, private readonly uow: UnitOfWork, private readonly stops: CopyLiveStopRepository, private readonly config: AppConfig) {}

  /** Running copies (active or paused, activated, no open stop), optionally
   * of one owner, or only those whose active agent expires by `agentExpiresBy`. */
  async running(filter: { userId?: number; agentExpiresBy?: Date } = {}): Promise<RunningCopy[]> {
    const network = deploymentNetwork(this.config);
    const accounts = await this.db.select({ accountId: copyExecutionAccounts.id, userId: copyExecutionAccounts.userId, strategyId: copyStrategies.id }).from(copyExecutionAccounts)
      .innerJoin(copyStrategies, eq(copyStrategies.id, copyExecutionAccounts.strategyId))
      .where(and(eq(copyStrategies.mode, ACTUAL_STRATEGY_MODE), eq(copyStrategies.network, network), eq(copyExecutionAccounts.network, network),
        inArray(copyStrategies.status, ['active', 'paused']), filter.userId === undefined ? undefined : eq(copyExecutionAccounts.userId, filter.userId),
        filter.agentExpiresBy ? sql`exists (select 1 from ${copyAgentSetups} s where s.account_id = ${copyExecutionAccounts.id} and s.state = 'active' and s.expires_at <= ${filter.agentExpiresBy})` : undefined,
        sql`not exists (select 1 from ${copyLiveStopOperations} o where o.account_id = ${copyExecutionAccounts.id} and o.state <> 'stopped')`))
      .orderBy(copyExecutionAccounts.id).limit(500);
    const copies: RunningCopy[] = [];
    for (const account of accounts) {
      const [generation] = await this.db.select({ id: copyLiveMandates.id, revision: copyLiveMandates.revision }).from(copyLiveMandates)
        .where(and(eq(copyLiveMandates.accountId, account.accountId), isNotNull(copyLiveMandates.activationCursor), ne(copyLiveMandates.state, 'stopped')))
        .orderBy(desc(copyLiveMandates.createdAt)).limit(1);
      if (generation) copies.push({ ...account, mandateId: generation.id, mandateRevision: generation.revision });
    }
    return copies;
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
        outcome.stopped.push({ accountId: copy.accountId, stopId: stop.id });
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

  /** Copies whose agent expires within `marginMs` are stopped before it does
   * (a stop needs the agent to close; an expired one strands the positions). */
  async stopExpiring(marginMs: number): Promise<SystemStopOutcome> {
    const copies = await this.running({ agentExpiresBy: new Date(this.now() + marginMs) });
    return copies.length ? this.stopAll(copies, 'agent_expiring', null, 'agent') : { stopped: [], refused: [] };
  }
}
