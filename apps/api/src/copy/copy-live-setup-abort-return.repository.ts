import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { canonicalUsdc, liveCopySetupIntentSchema, withdrawalUnits } from '@trading-dashboard/shared/contracts';
import { copyFundingOperations, copyLiveSetupAborts, copyLiveSetups, copyStrategies } from '@trading-dashboard/shared/database';
import { Dec } from '../common/decimal/dec.js';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import type { DbTransaction } from '../db/unit-of-work.js';
import { CopyLiveMandateRepository } from './copy-live-mandate.repository.js';
import { CopyLiveReturnRepository, type ReturnRow } from './copy-live-return.repository.js';
import type { SetupAbortRow } from './copy-live-setup-abort.repository.js';
import type { SetupAbortFlatObservation } from './live/live-account-observer.js';
import { allocateSignerNonce } from './signer-nonce.js';
import { AppConfig } from '../config/app-config.js';
import { deploymentNetwork } from './live-deployment.js';

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function refuse(code: string): never { throw new ConflictException({ statusCode: 409, code, message: 'Check the saved setup abort progress' }); }

/** Worker-only refund admission. This is neither owner approval nor a stop
 * sweep: authority, fresh full-flat proof and original child uniqueness are
 * checked atomically under the same user lock as setup child admission. */
@Injectable()
export class CopyLiveSetupAbortReturnRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, private readonly config: AppConfig,
    private readonly mandates: CopyLiveMandateRepository, private readonly returns: CopyLiveReturnRepository) {}

  private async context(tx: DbTransaction, expected: SetupAbortRow, completing = false) {
    await this.mandates.lock(tx, expected.userId, true);
    const [abort] = await tx.select().from(copyLiveSetupAborts).where(and(eq(copyLiveSetupAborts.id, expected.id), eq(copyLiveSetupAborts.userId, expected.userId))).for('update');
    if (!abort || !expected.leaseToken || abort.leaseToken !== expected.leaseToken || !abort.leaseUntil || abort.leaseUntil.getTime() <= Date.now()) refuse('setup_abort_lease_changed');
    if (abort.state === 'done' || abort.kind !== 'start' || abort.stopId || abort.mandateId || !abort.accountId || abort.network !== deploymentNetwork(this.config)) refuse('setup_abort_binding_unknown');
    const context = await this.returns.context(tx, abort.userId, abort.accountId, true), { account, owner, strategy } = context;
    const [setup] = await tx.select().from(copyLiveSetups).where(and(eq(copyLiveSetups.id, abort.setupId), eq(copyLiveSetups.userId, abort.userId))).for('update');
    const parsed = liveCopySetupIntentSchema.safeParse(setup?.intent);
    if (!setup || !parsed.success || hash(parsed.data) !== abort.intentDigest || setup.intentDigest !== abort.intentDigest ||
      parsed.data.setupId !== abort.setupId || parsed.data.userId !== abort.userId ||
      parsed.data.network !== abort.network || parsed.data.accountId !== abort.accountId || parsed.data.accountAddress !== abort.accountAddress || parsed.data.strategyId !== abort.strategyId ||
      parsed.data.ownerAddress !== abort.destination || parsed.data.ownerPrivyUserId !== abort.ownerPrivyUserId || owner.privyUserId !== abort.ownerPrivyUserId || owner.embeddedWalletAddress !== abort.destination ||
      account.address !== abort.accountAddress || account.network !== abort.network || strategy.id !== abort.strategyId || context.stop) refuse('setup_abort_binding_unknown');
    const [deposit] = abort.fundingOperationId ? await tx.select().from(copyFundingOperations).where(eq(copyFundingOperations.id, abort.fundingOperationId)).for('update') : [];
    if (!deposit || deposit.id !== parsed.data.fundingOperationId || setup.fundingOperationId !== deposit.id || deposit.userId !== abort.userId ||
      deposit.accountId !== account.id || deposit.strategyId !== abort.strategyId || deposit.network !== abort.network || deposit.direction !== 'to_account' ||
      deposit.address !== abort.destination || deposit.destination !== abort.accountAddress || deposit.nonce !== parsed.data.fundingNonce || deposit.amount !== parsed.data.fundingAmount)
      refuse('setup_abort_binding_unknown');
    // Completing an original operation that was provably never attempted
    // grants no signing authority. Every attempted/credited deposit and every
    // refund still requires the genuine consent and its original policy.
    const neverAttempted = !deposit.attemptedAt && deposit.status === 'cancelled';
    if (!(completing && neverAttempted) && (!abort.consentDigest || setup.consentDigest !== abort.consentDigest ||
      !account.masterPolicyId || account.masterPolicyId !== parsed.data.masterPolicyId || account.masterPolicyFingerprint !== parsed.data.masterPolicyFingerprint ||
      account.masterSignerQuorumId !== parsed.data.workerQuorumId || account.signerDetachedAt || account.sweepDestination !== abort.destination)) refuse('setup_abort_binding_unknown');
    return { abort, setup, account, strategy, deposit };
  }

  /** No lease expiry is evidence that an old driver or attempted child ended.
   * Every attempted outcome remains pending until its own reconciliation says
   * it cannot execute, and a real generation always uses a genuine stop. */
  private async quiescent(tx: DbTransaction, context: Awaited<ReturnType<CopyLiveSetupAbortReturnRepository['context']>>) {
    const { abort, setup } = context;
    // An expired token alone never grants permission. The persistent abort
    // already fences every new attempt; the locked child queries below seal
    // all prior SDK outcomes, and callers must provide a fresh purpose proof.
    if (setup.leaseToken && (!setup.leaseUntil || setup.leaseUntil.getTime() > Date.now())) return false;
    const result = await tx.execute<{ busy: boolean }>(sql`select (
      exists(select 1 from copy_execution_accounts where id = ${abort.accountId} and state <> 'ready')
      or exists(select 1 from copy_live_mandates where account_id = ${abort.accountId} and activation_cursor is not null)
      or exists(select 1 from copy_live_risk_reservations where account_id = ${abort.accountId} and state <> 'released')
      or exists(select 1 from copy_live_executions where network = ${abort.network} and account_address = ${abort.accountAddress} and state in ('prepared','submitting','unknown','resting'))
      or exists(select 1 from copy_funding_operations where account_id = ${abort.accountId} and status in ('prepared','unknown','accepted') and (setup_abort_id is null or setup_abort_id <> ${abort.id}))
      or exists(select 1 from wallet_withdrawals where network = ${abort.network} and address = ${abort.destination} and status in ('prepared','unknown'))
      or exists(select 1 from copy_account_mode_operations where account_id = ${abort.accountId} and (submission_state = 'signing' or (attempted_at is not null and target_state <> 'supported' and submission_state <> 'rejected')))
      or exists(select 1 from copy_agent_setups where account_id = ${abort.accountId} and (state in ('policy_prepared','policy_unknown','wallet_prepared','wallet_unknown','approval_signing','approval_unknown') or (approval_attempted_at is not null and state <> 'active')))
      or exists(select 1 from copy_live_builder_approvals where account_id = ${abort.accountId} and (state in ('unknown','accepted') or (attempted_at is not null and state not in ('approved','rejected'))))
    ) as busy`);
    return result.rows[0]?.busy === false;
  }
  private proof(abort: SetupAbortRow, proof: SetupAbortFlatObservation, now: number) {
    const s = proof.snapshot;
    if (proof.purpose !== 'setup-abort-return' || !Number.isSafeInteger(now) || !Number.isSafeInteger(s.observedAt) || !Number.isSafeInteger(s.completedAt) ||
      s.observedAt > s.completedAt || s.completedAt > now || now - s.observedAt > 5000 || now - s.coverage.earliestProviderTime > 5000 || s.coverage.earliestProviderTime > now)
      refuse('setup_abort_proof_stale');
    const zero = (v: string) => Dec.from(v).isZero;
    const primary = s.dexes.find(d => d.dex === '');
    if (s.network !== abort.network || s.accountAddress !== abort.accountAddress || (s.role !== 'user' && !(s.role === 'missing' && zero(s.withdrawable) && zero(s.perpEquity))) || !['default','disabled'].includes(s.accountAbstraction) ||
      !/^[0-9a-f]{64}$/.test(s.sourceDigest) || !s.coverage.complete || !s.coverage.balanceComplete || !s.coverage.orderComplete || s.coverage.unobservedOrderDexes.length ||
      s.positions.length || s.restingOrders.length || !zero(s.exposureUsd) || !zero(s.totalMarginUsed) || !zero(s.grossRestingExposureUsd) || !zero(s.restingExposureUsd) ||
      new Set(s.dexes.map(d => d.dex)).size !== s.dexes.length || JSON.stringify([...s.coverage.listedDexes].sort()) !== JSON.stringify(s.dexes.map(d => d.dex).sort()) ||
      JSON.stringify([...s.coverage.observedOrderDexes].sort()) !== JSON.stringify([...s.coverage.listedDexes].sort()) ||
      s.dexes.some(d => !Number.isSafeInteger(d.providerTime) || d.providerTime > now || now - d.providerTime > 5000 || !zero(d.marginUsed) || !zero(d.exposureUsd) ||
        !zero(d.crossMarginUsed) || !zero(d.crossExposureUsd) || !zero(d.crossMaintenanceMarginUsed) || (d.dex !== '' && (!zero(d.equity) || !zero(d.rawUsd) || !zero(d.withdrawable)))) ||
      !primary || primary.collateralCoin !== 'USDC' || s.collateralCoin !== 'USDC' || !Dec.from(primary.withdrawable).eq(primary.equity) || !Dec.from(primary.withdrawable).eq(primary.rawUsd) ||
      !Dec.from(primary.withdrawable).eq(primary.crossEquity) || !Dec.from(primary.withdrawable).eq(s.withdrawable) || !Dec.from(primary.withdrawable).eq(s.perpEquity)) refuse('setup_abort_proof_not_flat');
    const free = Dec.from(primary.withdrawable).floor(6);
    return { amount: free.isPositive ? canonicalUsdc(withdrawalUnits(free.toString())) : null, digest: hash({ authority: abort.id, setupId: abort.setupId,
      intentDigest: abort.intentDigest, consentDigest: abort.consentDigest, destination: abort.destination, proof }) };
  }

  async reserve(expected: SetupAbortRow, proof: SetupAbortFlatObservation, now: () => number = Date.now): Promise<ReturnRow | null> {
    return this.db.transaction(async tx => {
      const context = await this.context(tx, expected), { abort, account } = context;
      const [original] = await tx.select().from(copyFundingOperations).where(eq(copyFundingOperations.setupAbortId, abort.id));
      if (original) return original;
      const evidence = this.proof(abort, proof, now());
      if (!evidence.amount || !await this.quiescent(tx, context)) return null;
      const [row] = await tx.insert(copyFundingOperations).values({ id: randomUUID(), userId: abort.userId, accountId: account.id, strategyId: abort.strategyId,
        idempotencyKey: `abort:${abort.id}`, setupAbortId: abort.id, direction: 'to_main', network: abort.network, address: abort.accountAddress!, destination: abort.destination,
        amount: evidence.amount, nonce: await allocateSignerNonce(tx, abort.network, abort.accountAddress!, now()) }).returning();
      await tx.update(copyLiveSetupAborts).set({ state: 'returning', issue: null, returnOperationId: row!.id, proofDigest: evidence.digest, proofReadAt: new Date(proof.snapshot.observedAt),
        revision: abort.revision + 1, updatedAt: new Date(now()) }).where(eq(copyLiveSetupAborts.id, abort.id));
      return row!;
    });
  }
  async begin(expected: SetupAbortRow, id: string, proof: SetupAbortFlatObservation, now: () => number = Date.now): Promise<ReturnRow | null> {
    return this.db.transaction(async tx => {
      const context = await this.context(tx, expected), { abort } = context;
      const [row] = await tx.select().from(copyFundingOperations).where(and(eq(copyFundingOperations.id, id), eq(copyFundingOperations.setupAbortId, abort.id))).for('update');
      if (!row || row.userId !== abort.userId || row.accountId !== abort.accountId || row.network !== abort.network || row.address !== abort.accountAddress || row.destination !== abort.destination ||
        row.direction !== 'to_main' || row.stopId || abort.returnOperationId !== id) refuse('setup_abort_binding_unknown');
      if (row.status !== 'prepared' || row.attemptedAt) return null;
      const evidence = this.proof(abort, proof, now());
      if (!evidence.amount || !Dec.from(evidence.amount).gte(row.amount) || !await this.quiescent(tx, context)) return null;
      const at = new Date(now());
      await tx.update(copyLiveSetupAborts).set({ proofDigest: evidence.digest, proofReadAt: new Date(proof.snapshot.observedAt), revision: abort.revision + 1, updatedAt: at }).where(eq(copyLiveSetupAborts.id, abort.id));
      const [attempt] = await tx.update(copyFundingOperations).set({ status: 'unknown', attemptedAt: at, claimedAt: at, updatedAt: at })
        .where(and(eq(copyFundingOperations.id, id), sql`${copyFundingOperations.attemptedAt} is null`, eq(copyFundingOperations.status, 'prepared'))).returning();
      return attempt ?? null;
    });
  }
  async complete(expected: SetupAbortRow, proof: SetupAbortFlatObservation, now: () => number = Date.now): Promise<boolean> {
    return this.db.transaction(async tx => {
      const context = await this.context(tx, expected, true), { abort, setup, deposit, strategy } = context;
      const evidence = this.proof(abort, proof, now());
      if (evidence.amount || !await this.quiescent(tx, context) || ['prepared','unknown','accepted'].includes(deposit.status) ||
        !['paused','stopped'].includes(strategy.status)) return false;
      const refunds = await tx.select().from(copyFundingOperations).where(eq(copyFundingOperations.setupAbortId, abort.id));
      if (refunds.some(row => row.status !== 'credited') || (abort.returnOperationId && !refunds.some(row => row.id === abort.returnOperationId))) return false;
      const others = await tx.execute<{ busy: boolean }>(sql`select exists(select 1 from copy_live_setups where strategy_id = ${abort.strategyId}
        and id <> ${abort.setupId} and stage not in ('running','failed','expired','cancelled')) as busy`);
      if (others.rows[0]?.busy !== false) return false;
      const at = new Date(now());
      const [sealed] = await tx.update(copyLiveSetups).set({ stage: 'cancelled', issue: null, nextAttemptAt: null, leaseToken: null, leaseUntil: null, revision: setup.revision + 1, updatedAt: at })
        .where(and(eq(copyLiveSetups.id, setup.id), eq(copyLiveSetups.revision, setup.revision), setup.leaseToken ? eq(copyLiveSetups.leaseToken, setup.leaseToken) : sql`${copyLiveSetups.leaseToken} is null`)).returning({ id: copyLiveSetups.id });
      if (!sealed) return false;
      await tx.update(copyStrategies).set({ status: 'stopped', pauseNewRisk: true, stoppedAt: at }).where(and(eq(copyStrategies.id, abort.strategyId), eq(copyStrategies.userId, abort.userId)));
      await tx.update(copyLiveSetupAborts).set({ state: 'done', issue: null, nextAttemptAt: null, proofDigest: evidence.digest,
        proofReadAt: new Date(proof.snapshot.observedAt), revision: abort.revision + 1, updatedAt: at }).where(eq(copyLiveSetupAborts.id, abort.id));
      return true;
    });
  }
}
