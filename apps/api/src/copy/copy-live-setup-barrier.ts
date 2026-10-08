import { ConflictException, NotFoundException } from '@nestjs/common';
import { and, eq, ne, or, isNull } from 'drizzle-orm';
import { copyLiveSetupAborts, copyLiveSetups } from '@trading-dashboard/shared/database';
import type { DbTransaction } from '../db/unit-of-work.js';
import { lockCopyUser } from './copy-user-lock.js';

/** Every new child admission shares the abort transaction's user lock.
 * Applied before attemptedAt; reconciliation of an existing attempt remains legal. */
export async function assertSetupAdmission(tx: DbTransaction, userId: number, setupId: string | null | undefined) {
  if (!setupId) return;
  await lockCopyUser(tx, userId);
  const [setup] = await tx.select().from(copyLiveSetups).where(and(eq(copyLiveSetups.id, setupId), eq(copyLiveSetups.userId, userId))).for('update');
  if (!setup) throw new NotFoundException('Setup not found');
  const [abort] = await tx.select({ id: copyLiveSetupAborts.id }).from(copyLiveSetupAborts)
    .where(and(eq(copyLiveSetupAborts.setupId, setupId), eq(copyLiveSetupAborts.userId, userId))).limit(1);
  if (abort || setup.stage === 'cancelled') throw new ConflictException({ statusCode: 409, code: 'setup_abort_requested', message: 'The setup is being safely ended' });
  return setup;
}

/** Account-wide admission prevents ordinary top-ups/returns racing a setup
 * abort. Known original attempts remain readable; only its genuine delegated
 * stop may admit the already-bound stop return for a start. A pending
 * edit/renewal never owns its older generation's genuine system stop. */
export async function assertAccountAbortAdmission(tx: DbTransaction, userId: number, accountId: string,
  network: 'testnet' | 'mainnet', delegatedStopId?: string | null, genuineSystemStop = false) {
  await lockCopyUser(tx, userId);
  const [abort] = await tx.select({ id: copyLiveSetupAborts.id }).from(copyLiveSetupAborts)
    .where(and(eq(copyLiveSetupAborts.userId, userId), eq(copyLiveSetupAborts.accountId, accountId), eq(copyLiveSetupAborts.network, network),
      ne(copyLiveSetupAborts.state, 'done'), genuineSystemStop ? eq(copyLiveSetupAborts.kind, 'start') : undefined, delegatedStopId ? or(isNull(copyLiveSetupAborts.stopId), ne(copyLiveSetupAborts.stopId, delegatedStopId)) : undefined)).limit(1);
  if (abort) throw new ConflictException({ statusCode: 409, code: 'setup_abort_requested', message: 'The setup is being safely ended' });
}
