import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { copyExecutionAccounts, copyFundingOperations, copyLiveBuilderApprovals, copyLiveStopOperations, copyStrategies, users, walletWithdrawals } from '@trading-dashboard/shared/database';
import { ACTUAL_STRATEGY_MODE } from '@trading-dashboard/shared/contracts';
import { AppConfig } from '../config/app-config.js';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import type { DbTransaction } from '../db/unit-of-work.js';
import { lockCopyUser } from './copy-user-lock.js';
import { allocateSignerNonce } from './signer-nonce.js';
import { blockingFunding } from './funding-blocking.js';
import { deploymentNetwork } from './live-deployment.js';

export type ReturnRow = typeof copyFundingOperations.$inferSelect;
export type BuilderApprovalRow = typeof copyLiveBuilderApprovals.$inferSelect;
const busy = () => new ConflictException({ statusCode: 409, code: 'funding_pending', message: 'Resolve the pending wallet operation first' });
/** The owner's consent to a return is valid this long after it is prepared. */
export const RETURN_CONSENT_WINDOW_MS = 300_000;

/**
 * A return to the main wallet prepared but never attempted, whose consent
 * window has passed, can never be sent (approve refuses consent_expired):
 * it is cancelled instead of holding the account's pending slot, so a new
 * return or deposit can start (the browser's idempotency key does not
 * survive a reload).
 */
export async function expireStaleReturns(tx: DbTransaction, accountId: string): Promise<void> {
  await tx.update(copyFundingOperations).set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(copyFundingOperations.accountId, accountId), eq(copyFundingOperations.direction, 'to_main'), eq(copyFundingOperations.status, 'prepared'),
      isNull(copyFundingOperations.attemptedAt), sql`${copyFundingOperations.createdAt} < now() - make_interval(secs => ${RETURN_CONSENT_WINDOW_MS / 1000})`,
      // The worker's own sweep has no consent window: it waits for its turn.
      sql`${copyFundingOperations.idempotencyKey} not like ${SYSTEM_SWEEP_PREFIX + '%'}`));
}
/** Idempotency keys of the worker's automatic returns: `sweep:<stop id>`. */
export const SYSTEM_SWEEP_PREFIX = 'sweep:';

/** Account context of a master-signed action: the owner, the copy's ready
 * account and its strategy, and an unfinished stop if any. */
export interface MasterContext {
  owner: typeof users.$inferSelect; account: typeof copyExecutionAccounts.$inferSelect; strategy: typeof copyStrategies.$inferSelect;
  stop: typeof copyLiveStopOperations.$inferSelect | null;
}

@Injectable()
export class CopyLiveReturnRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, private readonly config: AppConfig) {}
  private locked<T>(userId: number, write: (tx: DbTransaction) => PromiseLike<T>): Promise<T> {
    return this.db.transaction(async tx => { await lockCopyUser(tx, userId); return write(tx); });
  }
  /** `system`: the stop's automatic return, which still runs for an owner an
   * admin disabled (the funds go back to that owner's own main wallet). */
  async context(db: DrizzleDb | DbTransaction, userId: number, accountId: string, system = false): Promise<MasterContext> {
    const [owner] = await db.select().from(users).where(and(eq(users.id, userId), system ? undefined : isNull(users.disabledAt)));
    const [account] = await db.select().from(copyExecutionAccounts).where(and(eq(copyExecutionAccounts.id, accountId), eq(copyExecutionAccounts.userId, userId)));
    if (!owner?.embeddedWalletAddress || !account) throw new NotFoundException('Execution account not found');
    // Only an account of the deployment's network: one of another network is
    // history here (nothing on it is signed or sent).
    if (account.state !== 'ready' || !account.address || !account.privyWalletId || !account.ownerQuorumId || account.network !== deploymentNetwork(this.config) ||
      account.privyUserId !== owner.privyUserId || account.address === owner.embeddedWalletAddress) throw new ConflictException('Execution account is not ready');
    const [strategy] = await db.select().from(copyStrategies).where(and(eq(copyStrategies.id, account.strategyId), eq(copyStrategies.userId, userId)));
    if (!strategy || strategy.mode !== ACTUAL_STRATEGY_MODE) throw new NotFoundException('Execution account not found');
    const [stop] = await db.select().from(copyLiveStopOperations).where(and(eq(copyLiveStopOperations.accountId, account.id), ne(copyLiveStopOperations.state, 'stopped')));
    return { owner, account, strategy, stop: stop ?? null };
  }
  contextRead(userId: number, accountId: string, system = false): Promise<MasterContext> { return this.context(this.db, userId, accountId, system); }
  reader(): DrizzleDb { return this.db; }
  /** The account's own signer: its returns and builder fee share the
   * allocator with its account mode and agent approval (signer-nonce.ts). */
  private nonce(tx: DbTransaction, network: string, address: string): Promise<number> {
    return allocateSignerNonce(tx, network, address, Date.now());
  }
  /** A return of `amount` from the copy's account to the owner's main wallet.
   * A sweep (`stopId`) belongs to the account's flat stop. One wallet
   * operation of the account at a time. */
  async reserve(userId: number, accountId: string, input: { idempotencyKey: string; amount: string; sweep: boolean }): Promise<ReturnRow> {
    return this.locked(userId, async tx => {
      const { owner, account, strategy, stop } = await this.context(tx, userId, accountId);
      const [original] = await tx.select().from(copyFundingOperations).where(and(eq(copyFundingOperations.userId, userId), eq(copyFundingOperations.idempotencyKey, input.idempotencyKey)));
      if (original) {
        if (original.direction !== 'to_main' || original.accountId !== accountId || original.address !== account.address || original.destination !== owner.embeddedWalletAddress ||
          (!input.sweep && original.amount !== input.amount)) throw new ConflictException('Idempotency payload changed');
        return original;
      }
      if (input.sweep && stop?.state !== 'flat' && strategy.status !== 'stopped') throw new ConflictException({ statusCode: 409, code: 'return_requires_flat_stop', message: 'Stop the copy first; everything returns once it is flat' });
      if (!input.sweep && (stop || ['stopping', 'stopped'].includes(strategy.status))) throw new ConflictException({ statusCode: 409, code: 'return_use_sweep', message: 'The copy is stopping: return everything once it is flat' });
      await expireStaleReturns(tx, accountId);
      const pendingRows = await tx.select({ id: copyFundingOperations.id }).from(copyFundingOperations)
        .where(and(eq(copyFundingOperations.accountId, accountId), blockingFunding())).limit(1);
      const hubPending = await tx.select({ id: walletWithdrawals.id }).from(walletWithdrawals)
        .where(and(eq(walletWithdrawals.network, account.network), eq(walletWithdrawals.address, owner.embeddedWalletAddress!), inArray(walletWithdrawals.status, ['prepared', 'unknown']))).limit(1);
      if (pendingRows.length || hubPending.length) throw busy();
      const [row] = await tx.insert(copyFundingOperations).values({ id: randomUUID(), userId, accountId, strategyId: account.strategyId, idempotencyKey: input.idempotencyKey,
        network: account.network, address: account.address!, destination: owner.embeddedWalletAddress!, amount: input.amount, nonce: await this.nonce(tx, account.network, account.address!),
        direction: 'to_main', stopId: input.sweep ? stop?.id ?? null : null }).returning();
      return row!;
    });
  }
  /**
   * The automatic return of a flat stop on an account with the master
   * signer (one-click plan §3c): everything withdrawable, keyed by the stop
   * (`sweep:<stop id>`), so it is reserved once. Waits (null) while the stop
   * isn't flat or another wallet operation of the account or a main-wallet
   * withdrawal is pending, instead of refusing as an owner's request does.
   */
  async reserveSystem(stop: { id: string; userId: number; accountId: string }, amount: string): Promise<ReturnRow | null> {
    return this.locked(stop.userId, async tx => {
      const { owner, account, stop: open } = await this.context(tx, stop.userId, stop.accountId, true);
      const key = `${SYSTEM_SWEEP_PREFIX}${stop.id}`;
      const [original] = await tx.select().from(copyFundingOperations).where(and(eq(copyFundingOperations.userId, stop.userId), eq(copyFundingOperations.idempotencyKey, key)));
      if (original) return original;
      if (open?.id !== stop.id || open.state !== 'flat' || !account.sweepDestination || account.sweepDestination !== owner.embeddedWalletAddress) return null;
      await expireStaleReturns(tx, account.id);
      const pendingRows = await tx.select({ id: copyFundingOperations.id }).from(copyFundingOperations)
        .where(and(eq(copyFundingOperations.accountId, account.id), blockingFunding())).limit(1);
      const hubPending = await tx.select({ id: walletWithdrawals.id }).from(walletWithdrawals)
        .where(and(eq(walletWithdrawals.network, account.network), eq(walletWithdrawals.address, owner.embeddedWalletAddress!), inArray(walletWithdrawals.status, ['prepared', 'unknown']))).limit(1);
      if (pendingRows.length || hubPending.length) return null;
      const [row] = await tx.insert(copyFundingOperations).values({ id: randomUUID(), userId: stop.userId, accountId: account.id, strategyId: account.strategyId, idempotencyKey: key,
        network: account.network, address: account.address!, destination: owner.embeddedWalletAddress!, amount, nonce: await this.nonce(tx, account.network, account.address!),
        direction: 'to_main', stopId: stop.id }).returning();
      return row!;
    });
  }
  async find(userId: number, id: string): Promise<ReturnRow> {
    const [row] = await this.db.select().from(copyFundingOperations).where(and(eq(copyFundingOperations.id, id), eq(copyFundingOperations.userId, userId), eq(copyFundingOperations.direction, 'to_main')));
    if (!row) throw new NotFoundException('Return not found');
    return row;
  }
  /** One attempt: prepared → unknown with its attempt time, still owned,
   * the account ready, the destination still the owner's main wallet. */
  async begin(userId: number, id: string, system = false): Promise<ReturnRow | null> {
    return this.locked(userId, async tx => {
      const [row] = await tx.select().from(copyFundingOperations).where(and(eq(copyFundingOperations.id, id), eq(copyFundingOperations.userId, userId), eq(copyFundingOperations.direction, 'to_main'))).for('update');
      if (!row) throw new NotFoundException('Return not found');
      const { owner, account } = await this.context(tx, userId, row.accountId, system);
      if (owner.embeddedWalletAddress !== row.destination || account.address !== row.address) throw new ConflictException('Wallet identity changed');
      const [claimed] = await tx.update(copyFundingOperations).set({ status: 'unknown', claimedAt: new Date(), attemptedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(copyFundingOperations.id, id), eq(copyFundingOperations.status, 'prepared'), isNull(copyFundingOperations.attemptedAt))).returning();
      return claimed ?? null;
    });
  }
  async finish(userId: number, id: string, status: 'accepted' | 'rejected', evidenceHash: string): Promise<ReturnRow> {
    const [row] = await this.locked(userId, tx => tx.update(copyFundingOperations).set({ status, evidenceHash, updatedAt: new Date() })
      .where(and(eq(copyFundingOperations.id, id), eq(copyFundingOperations.userId, userId), eq(copyFundingOperations.status, 'unknown'), sql`${copyFundingOperations.attemptedAt} is not null`)).returning());
    return row ?? this.find(userId, id);
  }
  /** Whether a stop's sweep was credited to the main wallet. */
  async swept(stopId: string): Promise<boolean> {
    const [row] = await this.db.select({ id: copyFundingOperations.id }).from(copyFundingOperations)
      .where(and(eq(copyFundingOperations.stopId, stopId), eq(copyFundingOperations.direction, 'to_main'), eq(copyFundingOperations.status, 'credited'))).limit(1);
    return row !== undefined;
  }

  // --- builder fee approval ---------------------------------------------------
  async reserveBuilder(userId: number, accountId: string, input: { idempotencyKey: string; builderAddress: string; maxFeeTenthsBps: number; now: number }): Promise<BuilderApprovalRow> {
    return this.locked(userId, async tx => {
      const { account } = await this.context(tx, userId, accountId);
      const [original] = await tx.select().from(copyLiveBuilderApprovals).where(and(eq(copyLiveBuilderApprovals.userId, userId), eq(copyLiveBuilderApprovals.idempotencyKey, input.idempotencyKey)));
      if (original) {
        if (original.accountId !== accountId || original.builderAddress !== input.builderAddress || original.maxFeeTenthsBps !== input.maxFeeTenthsBps) throw new ConflictException('Idempotency payload changed');
        return original;
      }
      const [row] = await tx.insert(copyLiveBuilderApprovals).values({ id: randomUUID(), userId, accountId, idempotencyKey: input.idempotencyKey, network: account.network,
        accountAddress: account.address!, builderAddress: input.builderAddress, maxFeeTenthsBps: input.maxFeeTenthsBps, nonce: await this.nonce(tx, account.network, account.address!),
        createdAt: new Date(input.now), updatedAt: new Date(input.now) }).returning();
      return row!;
    });
  }
  async builder(userId: number, id: string): Promise<BuilderApprovalRow> {
    const [row] = await this.db.select().from(copyLiveBuilderApprovals).where(and(eq(copyLiveBuilderApprovals.id, id), eq(copyLiveBuilderApprovals.userId, userId)));
    if (!row) throw new NotFoundException('Approval not found');
    return row;
  }
  async beginBuilder(userId: number, id: string): Promise<BuilderApprovalRow | null> {
    const [row] = await this.locked(userId, tx => tx.update(copyLiveBuilderApprovals).set({ state: 'unknown', attemptedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(copyLiveBuilderApprovals.id, id), eq(copyLiveBuilderApprovals.userId, userId), eq(copyLiveBuilderApprovals.state, 'prepared'))).returning());
    return row ?? null;
  }
  async finishBuilder(userId: number, id: string, state: 'accepted' | 'rejected' | 'approved', evidenceDigest: string | null): Promise<BuilderApprovalRow> {
    const [row] = await this.locked(userId, tx => tx.update(copyLiveBuilderApprovals).set({ state, evidenceDigest, updatedAt: new Date() })
      .where(and(eq(copyLiveBuilderApprovals.id, id), eq(copyLiveBuilderApprovals.userId, userId), inArray(copyLiveBuilderApprovals.state, ['unknown', 'accepted']))).returning());
    return row ?? this.builder(userId, id);
  }
}
