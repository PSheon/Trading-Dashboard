import { Inject, Injectable } from '@nestjs/common';
import { RETURN_CONSENT_WINDOW_MS } from './copy-live-return.repository.js';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { copyAgentSetups, copyExecutionAccounts, copyFundingOperations, copyLiveActivations, copyLiveDispatches, copyLiveMandates, copyLiveStopOperations,
  copyLiveStrategyConfigs, copyStrategies } from '@trading-dashboard/shared/database';
import type { LiveCopyPortfolioItem, LiveCopyStage } from '@trading-dashboard/shared/contracts';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';

/** Read model of the owner's testnet copies: one row per strategy with the
 * stage the portfolio shows. SQL only; nothing here contacts the exchange. */
@Injectable()
export class CopyLivePortfolioRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  async items(userId: number): Promise<LiveCopyPortfolioItem[]> {
    const strategies = await this.db.select({ strategy: copyStrategies, config: copyLiveStrategyConfigs }).from(copyStrategies)
      .innerJoin(copyLiveStrategyConfigs, eq(copyLiveStrategyConfigs.strategyId, copyStrategies.id))
      .where(and(eq(copyStrategies.userId, userId), eq(copyStrategies.mode, 'testnet'))).orderBy(desc(copyStrategies.createdAt)).limit(50);
    if (!strategies.length) return [];
    const ids = strategies.map(row => row.strategy.id);
    const [accounts, setups, mandates, activations, stops, transfers, refusals] = await Promise.all([
      this.db.select().from(copyExecutionAccounts).where(and(eq(copyExecutionAccounts.userId, userId), inArray(copyExecutionAccounts.strategyId, ids))),
      this.db.select().from(copyAgentSetups).where(and(eq(copyAgentSetups.userId, userId), eq(copyAgentSetups.state, 'active'))),
      this.db.select().from(copyLiveMandates).where(and(eq(copyLiveMandates.userId, userId), inArray(copyLiveMandates.strategyId, ids))).orderBy(desc(copyLiveMandates.createdAt)),
      this.db.select().from(copyLiveActivations).where(and(eq(copyLiveActivations.userId, userId), inArray(copyLiveActivations.strategyId, ids))),
      this.db.select().from(copyLiveStopOperations).where(and(eq(copyLiveStopOperations.userId, userId), inArray(copyLiveStopOperations.strategyId, ids))).orderBy(desc(copyLiveStopOperations.createdAt)),
      this.db.select().from(copyFundingOperations).where(and(eq(copyFundingOperations.userId, userId), inArray(copyFundingOperations.strategyId, ids))).orderBy(desc(copyFundingOperations.createdAt)),
      this.db.select({ strategyId: copyLiveDispatches.strategyId, reason: copyLiveDispatches.reason, at: copyLiveDispatches.updatedAt }).from(copyLiveDispatches)
        .where(and(eq(copyLiveDispatches.userId, userId), eq(copyLiveDispatches.state, 'refused'))).orderBy(desc(copyLiveDispatches.updatedAt)).limit(200),
    ]);
    return strategies.map(({ strategy: s, config: c }) => {
      const account = accounts.find(a => a.strategyId === s.id && a.network === 'testnet') ?? null;
      const setup = account ? setups.find(row => row.accountId === account.id) : undefined;
      const mandate = mandates.find(m => m.strategyId === s.id) ?? null;
      const activation = mandate ? activations.find(a => a.mandateId === mandate.id) : undefined;
      const stop = stops.find(row => row.strategyId === s.id && row.state !== 'stopped') ?? null;
      const ops = transfers.filter(t => t.strategyId === s.id);
      // A return prepared and never attempted past its consent window can no
      // longer be sent (it is cancelled on the next reservation): not pending.
      const pending = ops.find(t => ['prepared', 'unknown', 'accepted'].includes(t.status) &&
        !(t.direction === 'to_main' && t.status === 'prepared' && !t.attemptedAt && t.createdAt.getTime() < Date.now() - RETURN_CONSENT_WINDOW_MS)) ?? null;
      const deposited = ops.some(t => t.direction === 'to_account' && t.status === 'credited');
      const refusal = refusals.find(r => r.strategyId === s.id && r.reason);
      // The latest stop's sweep (newest first), shown while returning and once stopped.
      const latestStop = stops.find(row => row.strategyId === s.id);
      const sweep = latestStop ? ops.find(t => t.direction === 'to_main' && t.stopId === latestStop.id) ?? null : null;
      let stage: LiveCopyStage;
      if (s.status === 'stopped') stage = 'stopped';
      else if (stop?.state === 'flat' || pending?.direction === 'to_main' && pending.stopId) stage = 'sweeping';
      else if (stop || s.status === 'stopping') stage = 'stopping';
      else if (!account || account.state !== 'ready' || !setup || !mandate || !mandate.activationCursor || mandate.state === 'prepared') stage = 'setup';
      else if (pending?.direction === 'to_account') stage = pending.status === 'accepted' ? 'awaiting_credit' : 'funding';
      else if (!deposited) stage = 'needs_deposit';
      else if (s.status === 'active' && mandate.state === 'active') stage = 'active';
      else if (activation?.state === 'pending' && mandate.state === 'active') stage = 'starting';
      else stage = 'paused';
      return { strategyId: s.id, leaderAddress: s.leaderAddress, sourceNetwork: c.sourceNetwork, budgetUsd: c.budgetUsd, status: s.status, stage, createdAt: s.createdAt.toISOString(),
        accountId: account?.id ?? null, accountAddress: account?.address ?? null,
        mandate: mandate ? { id: mandate.id, state: mandate.state, revision: mandate.revision } : null,
        stop: stop ? { id: stop.id, state: stop.state, issue: stop.issue, revision: stop.revision } : null,
        pendingTransfer: pending ? { id: pending.id, direction: pending.direction, status: pending.status as 'prepared' | 'unknown' | 'accepted', amount: pending.amount } : null,
        lastRefusal: refusal ? { reason: refusal.reason!, at: refusal.at.toISOString() } : null,
        automaticReturn: Boolean(account?.masterPolicyId), sweep: sweep ? { amount: sweep.creditedAmount ?? sweep.amount, status: sweep.status } : null };
    });
  }
}
