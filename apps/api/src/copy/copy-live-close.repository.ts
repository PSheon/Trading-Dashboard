import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { copyAgentSetups, copyExecutionAccounts, copyLiveManualCloses, copyLiveStopOperations, copyStrategies, users } from '@trading-dashboard/shared/database';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import { lockCopyUser } from './copy-user-lock.js';

export type CloseRow = typeof copyLiveManualCloses.$inferSelect;
/** CopyDog's single-position close on a running testnet copy: a durable
 * request the worker executes with reduce-only IOC orders by the approved
 * agent. The copy keeps following its leader. */
@Injectable()
export class CopyLiveCloseRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  async request(userId: number, accountId: string, idempotencyKey: string, coin: string, at: Date): Promise<CloseRow> {
    return this.db.transaction(async tx => {
      await lockCopyUser(tx, userId);
      const [existing] = await tx.select().from(copyLiveManualCloses).where(and(eq(copyLiveManualCloses.userId, userId), eq(copyLiveManualCloses.idempotencyKey, idempotencyKey)));
      if (existing) { if (existing.accountId !== accountId || existing.coin !== coin) throw new ConflictException('Idempotency payload changed'); return existing; }
      const [owner] = await tx.select().from(users).where(eq(users.id, userId));
      const [account] = await tx.select().from(copyExecutionAccounts).where(and(eq(copyExecutionAccounts.id, accountId), eq(copyExecutionAccounts.userId, userId)));
      if (!owner || owner.disabledAt || !account) throw new NotFoundException('Execution account not found');
      const [strategy] = await tx.select().from(copyStrategies).where(and(eq(copyStrategies.id, account.strategyId), eq(copyStrategies.userId, userId)));
      if (!strategy || strategy.mode !== 'testnet' || account.state !== 'ready' || account.network !== 'testnet') throw new ConflictException('Execution account is not ready');
      if (['stopping', 'stopped'].includes(strategy.status)) throw new ConflictException({ statusCode: 409, code: 'copy_stopping', message: 'The stop closes every position' });
      const [stop] = await tx.select({ id: copyLiveStopOperations.id }).from(copyLiveStopOperations).where(and(eq(copyLiveStopOperations.accountId, accountId), inArray(copyLiveStopOperations.state, ['requested', 'cancelling', 'closing', 'blocked', 'flat'])));
      if (stop) throw new ConflictException({ statusCode: 409, code: 'copy_stopping', message: 'The stop closes every position' });
      const [setup] = await tx.select({ id: copyAgentSetups.id }).from(copyAgentSetups).where(and(eq(copyAgentSetups.accountId, accountId), eq(copyAgentSetups.state, 'active')));
      if (!setup) throw new ConflictException({ statusCode: 409, code: 'agent_unavailable', message: 'The copy has no approved trading agent' });
      const [open] = await tx.select({ id: copyLiveManualCloses.id }).from(copyLiveManualCloses).where(and(eq(copyLiveManualCloses.accountId, accountId), eq(copyLiveManualCloses.coin, coin), eq(copyLiveManualCloses.state, 'requested')));
      if (open) throw new ConflictException({ statusCode: 409, code: 'close_pending', message: 'This position is already being closed' });
      const [row] = await tx.insert(copyLiveManualCloses).values({ id: randomUUID(), userId, accountId, strategyId: strategy.id, idempotencyKey, coin, createdAt: at, updatedAt: at }).returning();
      return row!;
    });
  }
  list(userId: number, accountId: string): Promise<CloseRow[]> {
    return this.db.select().from(copyLiveManualCloses).where(and(eq(copyLiveManualCloses.userId, userId), eq(copyLiveManualCloses.accountId, accountId)))
      .orderBy(desc(copyLiveManualCloses.createdAt)).limit(50);
  }
}
