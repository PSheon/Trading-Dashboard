import { assertSetupAdmission, assertAccountAbortAdmission } from './copy-live-setup-barrier.js';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ACTUAL_STRATEGY_MODE, accountModeIntentSchema } from '@trading-dashboard/shared/contracts';
import { AppConfig } from '../config/app-config.js';
import { deploymentNetwork } from './live-deployment.js';
import { allocateSignerNonce } from './signer-nonce.js';
import { copyAccountModeOperations, copyExecutionAccounts, copyExecutionWallets, copyFundingOperations, copyLiveExecutions,
  copyStrategies, copyWalletAuthorizations, users, walletWithdrawals } from '@trading-dashboard/shared/database';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import type { DbTransaction } from '../db/unit-of-work.js';

export type AccountModeRow = typeof copyAccountModeOperations.$inferSelect;
type Executor = DrizzleDb | DbTransaction;
export const accountModeDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
@Injectable()
export class CopyAccountModeRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, private readonly config: AppConfig) {}
  /** Only the deployment's network's accounts change mode here. */
  private get network() { return deploymentNetwork(this.config); }
  async owner(userId: number, tx: Executor = this.db) {
    if (tx !== this.db) await tx.execute(sql`select pg_advisory_xact_lock(7404, ${userId})`);
    const query = tx.select().from(users).where(and(eq(users.id, userId), isNull(users.disabledAt)));
    const [owner] = await (tx === this.db ? query : query.for('update'));
    if (!owner) throw new NotFoundException('User not found'); return owner;
  }
  async account(userId: number, id: string, tx: Executor = this.db) {
    const query = tx.select().from(copyExecutionAccounts).where(and(eq(copyExecutionAccounts.id, id), eq(copyExecutionAccounts.userId, userId)));
    const [account] = await (tx === this.db ? query : query.for('update'));
    if (!account) throw new NotFoundException('Execution account not found'); return account;
  }
  list(userId: number) { return this.db.select().from(copyAccountModeOperations).where(eq(copyAccountModeOperations.userId, userId)).orderBy(desc(copyAccountModeOperations.createdAt)).limit(100); }
  async find(userId: number, id: string, tx: Executor = this.db, lock = false) {
    await this.owner(userId, tx);
    const query = tx.select().from(copyAccountModeOperations).where(and(eq(copyAccountModeOperations.id, id), eq(copyAccountModeOperations.userId, userId)));
    const [row] = await (lock ? query.for('update') : query);
    if (!row) throw new NotFoundException('Account mode operation not found'); return row;
  }
  async byKey(userId: number, key: string) {
    await this.owner(userId);
    const [row] = await this.db.select().from(copyAccountModeOperations).where(and(eq(copyAccountModeOperations.userId, userId), eq(copyAccountModeOperations.idempotencyKey, key)));
    if (!row) throw new NotFoundException('Account mode operation not found'); return row;
  }
  async assertCurrent(userId: number, row: AccountModeRow, tx: Executor = this.db, mutation = false) {
    const owner = await this.owner(userId, tx), account = await this.account(userId, row.accountId, tx);
    const query = tx.select().from(copyStrategies).where(and(eq(copyStrategies.id, row.strategyId), eq(copyStrategies.userId, userId)));
    const [strategy] = await (tx === this.db ? query : query.for('update'));
    if (!strategy || account.state !== 'ready' || account.network !== this.network || row.network !== account.network ||
        owner.privyUserId !== row.ownerPrivyUserId || account.privyUserId !== owner.privyUserId || owner.embeddedWalletAddress !== row.ownerAddress ||
        account.strategyId !== row.strategyId || account.address !== row.accountAddress || account.privyWalletId !== row.accountWalletId || account.ownerQuorumId !== row.accountOwnerQuorumId)
      throw new ConflictException('account_mode_identity_changed');
    if (mutation) {
      if (['stopped', 'stopping'].includes(strategy.status) ||
          (strategy.mode === ACTUAL_STRATEGY_MODE && (strategy.status !== 'paused' || !strategy.pauseNewRisk)))
        throw new ConflictException('account_mode_strategy_not_dormant');
      await this.assertDormant(row, tx);
    }
    return { owner, account, strategy };
  }
  private async assertDormant(row: AccountModeRow, tx: Executor) {
    const grants = tx.select({ id: copyWalletAuthorizations.id }).from(copyWalletAuthorizations)
      .innerJoin(copyExecutionWallets, eq(copyExecutionWallets.id, copyWalletAuthorizations.walletId))
      .where(and(eq(copyExecutionWallets.network, row.network), eq(copyExecutionWallets.accountAddress, row.accountAddress),
        isNull(copyWalletAuthorizations.revokedAt), sql`${copyWalletAuthorizations.expiresAt} > ${new Date()}`));
    const active = await (tx === this.db ? grants : grants.for('update', { of: copyWalletAuthorizations }));
    const history = await tx.select({ key: copyLiveExecutions.key }).from(copyLiveExecutions)
      .where(and(eq(copyLiveExecutions.network, row.network), eq(copyLiveExecutions.accountAddress, row.accountAddress))).limit(1);
    const funds = tx.select({ id: copyFundingOperations.id }).from(copyFundingOperations)
      .where(and(eq(copyFundingOperations.accountId, row.accountId), inArray(copyFundingOperations.status, ['prepared', 'unknown', 'accepted'])));
    const pending = await (tx === this.db ? funds : funds.for('update'));
    const withdrawals = tx.select({ id: walletWithdrawals.id }).from(walletWithdrawals)
      .where(and(eq(walletWithdrawals.network, row.network), eq(walletWithdrawals.address, row.accountAddress), inArray(walletWithdrawals.status, ['prepared', 'unknown'])));
    const moving = await (tx === this.db ? withdrawals : withdrawals.for('update'));
    if (active.length || history.length || pending.length || moving.length) throw new ConflictException('account_mode_account_not_dormant');
  }
  async ensure(tx: DbTransaction, userId: number, accountId: string, idempotencyKey: string, liveSetupId: string | null = null) {
    const owner = await this.owner(userId, tx), account = await this.account(userId, accountId, tx);
    const [prior] = await tx.select().from(copyAccountModeOperations).where(and(eq(copyAccountModeOperations.userId, userId), eq(copyAccountModeOperations.idempotencyKey, idempotencyKey)));
    if (prior) {
      if (prior.accountId !== accountId) throw new ConflictException('account_mode_idempotency_conflict');
      await this.assertCurrent(userId, prior, tx); return prior;
    }
    if (account.state !== 'ready' || account.network !== this.network || account.privyUserId !== owner.privyUserId || !account.address || !account.privyWalletId || !account.ownerQuorumId ||
        !owner.embeddedWalletAddress || owner.embeddedWalletAddress === account.address) throw new ConflictException('account_mode_account_not_ready');
    if ((await tx.select({ id: copyAccountModeOperations.id }).from(copyAccountModeOperations).where(eq(copyAccountModeOperations.accountId, accountId))).length)
      throw new ConflictException('account_mode_setup_exists');
    await assertAccountAbortAdmission(tx, userId, accountId, account.network);
    await assertSetupAdmission(tx, userId, liveSetupId);
    const [row] = await tx.insert(copyAccountModeOperations).values({ id: randomUUID(), userId, accountId, strategyId: account.strategyId,
      network: account.network, idempotencyKey, accountAddress: account.address, accountWalletId: account.privyWalletId,
      accountOwnerQuorumId: account.ownerQuorumId, ownerPrivyUserId: owner.privyUserId, ownerAddress: owner.embeddedWalletAddress, liveSetupId }).returning();
    await this.assertCurrent(userId, row!, tx); return row!;
  }
  forAccount(tx: Executor, accountId: string) { return tx.select().from(copyAccountModeOperations).where(eq(copyAccountModeOperations.accountId, accountId)).limit(1); }
  async transition(row: AccountModeRow, changes: Partial<typeof copyAccountModeOperations.$inferInsert>, tx: Executor = this.db): Promise<AccountModeRow | null> {
    if (!row.attemptedAt && (changes.submissionState === 'signing' || changes.attemptedAt)) {
      if (tx === this.db) return this.db.transaction(inner => this.transition(row, changes, inner));
      await assertAccountAbortAdmission(tx as DbTransaction, row.userId, row.accountId, row.network);
      await assertSetupAdmission(tx as DbTransaction, row.userId, row.liveSetupId);
    }
    const [next] = await tx.update(copyAccountModeOperations).set({ ...changes, revision: row.revision + 1, updatedAt: new Date() })
      .where(and(eq(copyAccountModeOperations.id, row.id), eq(copyAccountModeOperations.revision, row.revision), eq(copyAccountModeOperations.submissionState, row.submissionState))).returning();
    return next ?? null;
  }
  /** Allocates the operation's nonce, or keeps a live one that has at least
   * `minRemainingMs` of its five-minute window left. */
  async challenge(tx: DbTransaction, userId: number, row: AccountModeRow, assertFresh: () => void, minRemainingMs = 0) {
    await this.assertCurrent(userId, row, tx, true);
    await assertSetupAdmission(tx, userId, row.liveSetupId);
    const locked = await this.find(userId, row.id, tx, true); assertFresh();
    if (locked.submissionState !== 'prepared' || locked.attemptedAt || locked.revision !== row.revision || locked.targetState === 'supported')
      throw new ConflictException('account_mode_challenge_changed');
    if (locked.intent && locked.nonce && locked.consentExpiresAt && locked.consentExpiresAt.getTime() > Date.now() + minRemainingMs) return locked;
    const nonce = await allocateSignerNonce(tx, locked.network, locked.accountAddress, Date.now(), async query => { const value = await query; assertFresh(); return value; });
    if (!Number.isSafeInteger(nonce) || nonce > Date.now() + 30000) throw new ConflictException('account_mode_nonce_clock_skew');
    const intent = accountModeIntentSchema.parse({ operationId: locked.id, accountId: locked.accountId, strategyId: locked.strategyId,
      network: locked.network, accountAddress: locked.accountAddress, nonce, consentExpiresAt: nonce + 300000 });
    const next = await this.transition(locked, { nonce, consentExpiresAt: new Date(intent.consentExpiresAt), intent, intentDigest: accountModeDigest(intent), consentDigest: null, issue: null }, tx);
    assertFresh(); if (!next) throw new ConflictException('account_mode_challenge_changed'); return next;
  }
}
