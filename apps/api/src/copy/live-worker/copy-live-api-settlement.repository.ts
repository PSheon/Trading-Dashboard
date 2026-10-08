import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { copyLiveDispatches, copyLiveExecutions, copyLiveMandates, copyExecutionAccounts, users, copyLiveRiskReservations } from '@trading-dashboard/shared/database';
import type { DrizzleDb } from '../../db/drizzle.provider.js';
import { UNHELD_REJECTED } from '../live/live-execution.js';
import { decodeLiveExecutionRow } from '../live/postgres-live-journal.js';
import { liveSourceExecutionCloid } from '../live/postgres-live-preparation.js';
import { LiveBoundaryError } from '../live/wallet-authorization.js';
import type { DispatchRow } from './copy-live-worker.repository.js';
import { TERMINAL_STATES, type LiveSettleOutcome, type LiveSettleRequest } from './copy-live-settler.js';

export class CopyLiveApiSettlementRepository {
  constructor(private readonly db: DrizzleDb) {}
  async candidates(): Promise<string[]> {
    const rows = await this.db.select({ key: copyLiveExecutions.key }).from(copyLiveDispatches)
      .innerJoin(copyLiveExecutions, eq(copyLiveExecutions.key, copyLiveDispatches.executionKey))
      .innerJoin(copyLiveMandates, eq(copyLiveMandates.id, copyLiveDispatches.mandateId))
      .innerJoin(copyExecutionAccounts, eq(copyExecutionAccounts.id, copyLiveDispatches.accountId))
      .innerJoin(users, eq(users.id, copyLiveDispatches.userId))
      .leftJoin(copyLiveRiskReservations, eq(copyLiveRiskReservations.key, copyLiveExecutions.key))
      .where(and(eq(copyLiveMandates.network, 'testnet'), eq(copyExecutionAccounts.network, 'testnet'),
        eq(copyLiveDispatches.userId, copyLiveMandates.userId), eq(copyLiveDispatches.userId, copyExecutionAccounts.userId), eq(copyLiveDispatches.userId, copyLiveExecutions.userId),
        eq(copyLiveDispatches.strategyId, copyLiveMandates.strategyId), eq(copyLiveDispatches.strategyId, copyExecutionAccounts.strategyId), eq(copyLiveDispatches.strategyId, copyLiveExecutions.strategyId),
        eq(copyLiveDispatches.accountId, copyLiveMandates.accountId), eq(copyExecutionAccounts.privyUserId, users.privyUserId),
        eq(copyExecutionAccounts.address, copyLiveMandates.accountAddress), eq(copyExecutionAccounts.address, copyLiveExecutions.accountAddress),
        or(and(isNull(copyLiveRiskReservations.key), sql`${copyLiveExecutions.record}->>'errorCode' = ${UNHELD_REJECTED}`),
          and(eq(copyLiveRiskReservations.network, 'testnet'), eq(copyLiveRiskReservations.userId, copyLiveDispatches.userId),
            eq(copyLiveRiskReservations.strategyId, copyLiveDispatches.strategyId), eq(copyLiveRiskReservations.accountId, copyLiveDispatches.accountId),
            eq(copyLiveRiskReservations.accountAddress, copyExecutionAccounts.address), eq(copyLiveRiskReservations.cloid, copyLiveExecutions.cloid))),
        eq(copyLiveDispatches.state, 'submitted'), eq(copyLiveExecutions.network, 'testnet'),
        inArray(copyLiveExecutions.state, [...TERMINAL_STATES])))
      .orderBy(asc(copyLiveDispatches.updatedAt), asc(copyLiveDispatches.id)).limit(20);
    return rows.map(r => r.key);
  }
  async load(key: string): Promise<{ row: DispatchRow; request: LiveSettleRequest } | null> {
    const [r] = await this.db.select({ row: copyLiveDispatches, journal: copyLiveExecutions, mandate: copyLiveMandates, account: copyExecutionAccounts, owner: users,
      reservation: { key: copyLiveRiskReservations.key, userId: copyLiveRiskReservations.userId, strategyId: copyLiveRiskReservations.strategyId,
        accountId: copyLiveRiskReservations.accountId, network: copyLiveRiskReservations.network, accountAddress: copyLiveRiskReservations.accountAddress,
        cloid: copyLiveRiskReservations.cloid, fingerprint: copyLiveRiskReservations.fingerprint, walletId: copyLiveRiskReservations.walletId,
        authorizationId: copyLiveRiskReservations.authorizationId, authorizationVersion: copyLiveRiskReservations.authorizationVersion } })
      .from(copyLiveDispatches).innerJoin(copyLiveExecutions, eq(copyLiveExecutions.key, copyLiveDispatches.executionKey))
      .innerJoin(copyLiveMandates, eq(copyLiveMandates.id, copyLiveDispatches.mandateId))
      .innerJoin(copyExecutionAccounts, eq(copyExecutionAccounts.id, copyLiveDispatches.accountId))
      .innerJoin(users, eq(users.id, copyLiveDispatches.userId))
      .leftJoin(copyLiveRiskReservations, eq(copyLiveRiskReservations.key, copyLiveExecutions.key))
      .where(and(eq(copyLiveExecutions.key, key), eq(copyLiveDispatches.state, 'submitted')));
    if (!r) return null;
    const { row, journal, mandate: m, account: a, owner, reservation } = r;
    const record = decodeLiveExecutionRow(journal);
    const cloid = liveSourceExecutionCloid(m.id, row.sourceFillId, row.leg);
    if ((!reservation && record.errorCode !== UNHELD_REJECTED) || reservation && (reservation.userId !== row.userId || reservation.strategyId !== row.strategyId ||
      reservation.accountId !== row.accountId || reservation.network !== 'testnet' || reservation.accountAddress !== a.address ||
      reservation.cloid !== cloid || reservation.fingerprint !== record.fingerprint || reservation.walletId !== record.authorization.walletId ||
      reservation.authorizationId !== record.authorization.id || reservation.authorizationVersion !== record.authorization.version) ||
      !TERMINAL_STATES.has(record.state) || journal.network !== 'testnet' || m.network !== 'testnet' || a.network !== 'testnet' ||
      row.userId !== m.userId || row.userId !== a.userId || row.userId !== journal.userId ||
      row.strategyId !== m.strategyId || row.strategyId !== a.strategyId || row.strategyId !== journal.strategyId ||
      row.accountId !== m.accountId || a.privyUserId !== owner.privyUserId || a.address !== m.accountAddress ||
      a.address !== journal.accountAddress || journal.cloid !== cloid || key !== `testnet:${a.address}:${cloid}`)
      throw new LiveBoundaryError('live_settlement_claim_identity');
    return { row, request: { userId: row.userId, accountId: row.accountId, accountAddress: a.address!, sourceNetwork: m.sourceNetwork,
      leaderAddress: m.leaderAddress, key } };
  }
  async finish(read: DispatchRow, outcome: LiveSettleOutcome): Promise<void> {
    await this.db.transaction(async tx => {
      const [current] = await tx.select().from(copyLiveDispatches).where(eq(copyLiveDispatches.id, read.id)).for('update');
      if (!current || current.state !== 'submitted' || current.executionKey !== read.executionKey || current.attempts !== read.attempts || current.reason !== read.reason) return;
      const patch = outcome.kind === 'released' ? { state: 'settled' as const, settledAt: new Date(), reason: null }
        : outcome.kind === 'unplaced' ? { state: 'refused' as const, reason: 'exchange_order_never_placed' }
        : outcome.kind === 'quarantine' || outcome.kind === 'unsent' ? { state: 'refused' as const, reason: outcome.reason.slice(0, 80) }
        : { reason: outcome.reason.slice(0, 80) };
      await tx.update(copyLiveDispatches).set({ ...patch, updatedAt: new Date() }).where(eq(copyLiveDispatches.id, read.id));
    });
  }
}
