import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNotNull, sql, or, isNull, lte } from 'drizzle-orm';
import { liveCopySetupIntentSchema } from '@trading-dashboard/shared/contracts';
import { copyExecutionAccounts, copyLiveMandates, copyLiveSetupAborts, copyLiveSetups, copyStrategies, copyFundingOperations,
  copyAccountModeOperations, copyAgentSetups, copyLiveBuilderApprovals, copyLiveStopOperations, copyLiveStrategyConfigs, copyStrategyVersions } from '@trading-dashboard/shared/database';
import { AppConfig } from '../config/app-config.js';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DbTransaction } from '../db/unit-of-work.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import { CopyLiveMandateRepository } from './copy-live-mandate.repository.js';
import { CopyLiveStopRepository } from './copy-live-stop.repository.js';
import { deploymentNetwork } from './live-deployment.js';

export type SetupAbortRow = typeof copyLiveSetupAborts.$inferSelect;
const conflict = (code: string) => new ConflictException({ statusCode: 409, code, message: 'The setup changed; check its saved progress' });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Creates durable authority and the permanent barrier in the same user lock
 * as child attempts and genuine generation activation. No provider calls. */
@Injectable()
export class CopyLiveSetupAbortRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, private readonly config: AppConfig,
    private readonly mandates: CopyLiveMandateRepository, private readonly stops: CopyLiveStopRepository) {}

  async find(userId: number, id: string): Promise<SetupAbortRow> {
    const [result] = await this.db.select({ abort: copyLiveSetupAborts }).from(copyLiveSetupAborts)
      .innerJoin(copyStrategies, eq(copyStrategies.id, copyLiveSetupAborts.strategyId))
      .where(and(eq(copyLiveSetupAborts.id, id), eq(copyLiveSetupAborts.userId, userId), eq(copyLiveSetupAborts.network, deploymentNetwork(this.config)), eq(copyStrategies.network, deploymentNetwork(this.config))));
    if (!result) throw new NotFoundException('Setup abort not found');
    return result.abort;
  }

  async forSetup(userId: number, setupId: string): Promise<SetupAbortRow> {
    const [row] = await this.db.select({ id: copyLiveSetupAborts.id }).from(copyLiveSetupAborts)
      .where(and(eq(copyLiveSetupAborts.userId, userId), eq(copyLiveSetupAborts.setupId, setupId)));
    if (!row) throw new NotFoundException('Setup abort not found');
    return this.find(userId, row.id);
  }
  open() {
    return this.db.select().from(copyLiveSetupAborts).where(and(eq(copyLiveSetupAborts.network, deploymentNetwork(this.config)),
      sql`${copyLiveSetupAborts.state} <> 'done'`, or(isNull(copyLiveSetupAborts.nextAttemptAt), lte(copyLiveSetupAborts.nextAttemptAt, sql`now()`))))
      .orderBy(copyLiveSetupAborts.updatedAt).limit(5);
  }
  async lease(id: string): Promise<SetupAbortRow | null> {
    const [row] = await this.db.update(copyLiveSetupAborts).set({ leaseToken: randomUUID(), leaseUntil: sql`now() + interval '120 seconds'` })
      .where(and(eq(copyLiveSetupAborts.id, id), eq(copyLiveSetupAborts.network, deploymentNetwork(this.config)), sql`${copyLiveSetupAborts.state} <> 'done'`,
        or(isNull(copyLiveSetupAborts.leaseUntil), lte(copyLiveSetupAborts.leaseUntil, sql`now()`)))).returning();
    return row ?? null;
  }
  async release(row: SetupAbortRow) {
    if (!row.leaseToken) return;
    await this.db.update(copyLiveSetupAborts).set({ leaseToken: null, leaseUntil: null })
      .where(and(eq(copyLiveSetupAborts.id, row.id), eq(copyLiveSetupAborts.leaseToken, row.leaseToken)));
  }
  async transition(row: SetupAbortRow, changes: Pick<Partial<typeof copyLiveSetupAborts.$inferInsert>, 'state' | 'issue' | 'nextAttemptAt'>): Promise<SetupAbortRow | null> {
    if (!row.leaseToken) return null;
    const [next] = await this.db.update(copyLiveSetupAborts).set({ ...changes, revision: row.revision + 1, updatedAt: sql`greatest(clock_timestamp(), ${copyLiveSetupAborts.createdAt})` })
      .where(and(eq(copyLiveSetupAborts.id, row.id), eq(copyLiveSetupAborts.revision, row.revision), eq(copyLiveSetupAborts.leaseToken, row.leaseToken),
        sql`${copyLiveSetupAborts.leaseUntil} > clock_timestamp()`)).returning();
    return next ?? null;
  }
  /** Original children remain discoverable even if an old parent's final CAS
   * lost to abort. Reads never create an operation or grant signing rights. */
  async children(row: SetupAbortRow) {
    const [setup] = await this.db.select().from(copyLiveSetups).where(and(eq(copyLiveSetups.id, row.setupId), eq(copyLiveSetups.userId, row.userId)));
    if (!setup) throw new NotFoundException('Setup not found');
    const funding = await this.db.select().from(copyFundingOperations).where(and(eq(copyFundingOperations.userId, row.userId),
      or(eq(copyFundingOperations.liveSetupId, row.setupId), row.fundingOperationId ? eq(copyFundingOperations.id, row.fundingOperationId) : undefined,
        eq(copyFundingOperations.setupAbortId, row.id))));
    const otherFunding = row.kind === 'start' && row.accountId ? await this.db.select().from(copyFundingOperations)
      .where(and(eq(copyFundingOperations.userId, row.userId), eq(copyFundingOperations.accountId, row.accountId), eq(copyFundingOperations.network, row.network),
        sql`${copyFundingOperations.status} in ('prepared','unknown','accepted')`, sql`${copyFundingOperations.setupAbortId} is distinct from ${row.id}`,
        sql`${copyFundingOperations.liveSetupId} is distinct from ${row.setupId}`,
        row.fundingOperationId ? sql`${copyFundingOperations.id} <> ${row.fundingOperationId}` : undefined)) : [];
    const modes = await this.db.select().from(copyAccountModeOperations).where(and(eq(copyAccountModeOperations.userId, row.userId),
      or(eq(copyAccountModeOperations.liveSetupId, row.setupId), setup.modeOperationId ? eq(copyAccountModeOperations.id, setup.modeOperationId) : undefined)));
    const agents = await this.db.select().from(copyAgentSetups).where(and(eq(copyAgentSetups.userId, row.userId),
      or(eq(copyAgentSetups.liveSetupId, row.setupId), setup.agentSetupId ? eq(copyAgentSetups.id, setup.agentSetupId) : undefined)));
    const builders = await this.db.select().from(copyLiveBuilderApprovals).where(and(eq(copyLiveBuilderApprovals.userId, row.userId),
      or(eq(copyLiveBuilderApprovals.liveSetupId, row.setupId), setup.builderApprovalId ? eq(copyLiveBuilderApprovals.id, setup.builderApprovalId) : undefined)));
    const [stop] = row.stopId ? await this.db.select().from(copyLiveStopOperations).where(and(eq(copyLiveStopOperations.id, row.stopId), eq(copyLiveStopOperations.userId, row.userId))) : [];
    return { setup, funding, otherFunding, modes, agents, builders, stop: stop ?? null };
  }

  /** Seal an ordinary reservation admitted before the permanent account
   * barrier. attemptedAt is the durable SDK boundary; a claim alone never
   * grants an attempt. The same user lock serializes late beginSubmit calls. */
  async sealOrdinaryFunding(expected: SetupAbortRow, operation: typeof copyFundingOperations.$inferSelect): Promise<boolean> {
    return this.db.transaction(async tx => {
      const owner = await this.mandates.lock(tx, expected.userId, true);
      const [abort] = await tx.select().from(copyLiveSetupAborts).where(and(eq(copyLiveSetupAborts.id, expected.id), eq(copyLiveSetupAborts.userId, expected.userId))).for('update');
      if (!abort || !expected.leaseToken || abort.leaseToken !== expected.leaseToken || abort.revision !== expected.revision ||
        !abort.leaseUntil || abort.leaseUntil.getTime() <= Date.now() || abort.kind !== 'start' || abort.state === 'done' || abort.stopId || abort.mandateId ||
        abort.network !== deploymentNetwork(this.config) || owner.privyUserId !== abort.ownerPrivyUserId || owner.embeddedWalletAddress !== abort.destination || !abort.accountId || !abort.accountAddress) return false;
      if (operation.userId !== abort.userId || operation.accountId !== abort.accountId || operation.strategyId !== abort.strategyId || operation.network !== abort.network ||
        operation.liveSetupId || operation.setupAbortId || operation.stopId || operation.attemptedAt || !['prepared', 'unknown'].includes(operation.status)) return false;
      const source = operation.direction === 'to_account' ? abort.destination : abort.accountAddress;
      const destination = operation.direction === 'to_account' ? abort.accountAddress : abort.destination;
      if (operation.address !== source || operation.destination !== destination) return false;
      const [sealed] = await tx.update(copyFundingOperations).set({ status: 'cancelled', updatedAt: new Date() })
        .where(and(eq(copyFundingOperations.id, operation.id), eq(copyFundingOperations.userId, abort.userId), eq(copyFundingOperations.accountId, abort.accountId),
          eq(copyFundingOperations.strategyId, abort.strategyId), eq(copyFundingOperations.network, abort.network), eq(copyFundingOperations.status, operation.status),
          eq(copyFundingOperations.direction, operation.direction), eq(copyFundingOperations.address, source), eq(copyFundingOperations.destination, destination),
          eq(copyFundingOperations.nonce, operation.nonce), eq(copyFundingOperations.amount, operation.amount), eq(copyFundingOperations.scanRevision, operation.scanRevision),
          isNull(copyFundingOperations.attemptedAt), isNull(copyFundingOperations.liveSetupId), isNull(copyFundingOperations.setupAbortId), isNull(copyFundingOperations.stopId),
          operation.claimedAt ? eq(copyFundingOperations.claimedAt, operation.claimedAt) : isNull(copyFundingOperations.claimedAt))).returning({ id: copyFundingOperations.id });
      return Boolean(sealed);
    });
  }

  /** Pin only authorization and generation configuration, not evolving fills
   * or balances: an old edit must never cancel or mutate its running parent. */
  private async generationDigest(tx: DbTransaction, strategy: typeof copyStrategies.$inferSelect, accountId: string | null) {
    if (!accountId) return null;
    const [account] = await tx.select({ id: copyExecutionAccounts.id,
      address: copyExecutionAccounts.address, network: copyExecutionAccounts.network, privyUserId: copyExecutionAccounts.privyUserId,
      privyWalletId: copyExecutionAccounts.privyWalletId, ownerQuorumId: copyExecutionAccounts.ownerQuorumId,
      masterPolicyId: copyExecutionAccounts.masterPolicyId, masterPolicyFingerprint: copyExecutionAccounts.masterPolicyFingerprint,
      masterSignerQuorumId: copyExecutionAccounts.masterSignerQuorumId, sweepDestination: copyExecutionAccounts.sweepDestination,
      signerDetachedAt: copyExecutionAccounts.signerDetachedAt }).from(copyExecutionAccounts)
      .where(and(eq(copyExecutionAccounts.id, accountId), eq(copyExecutionAccounts.userId, strategy.userId), eq(copyExecutionAccounts.strategyId, strategy.id))).for('update');
    if (!account || account.network !== strategy.network) return null;
    const generations = await tx.select({ id: copyLiveMandates.id,
      activationCursor: copyLiveMandates.activationCursor, intentDigest: copyLiveMandates.intentDigest, consentDigest: copyLiveMandates.consentDigest,
      accountId: copyLiveMandates.accountId, network: copyLiveMandates.network }).from(copyLiveMandates)
      .where(and(eq(copyLiveMandates.accountId, accountId), eq(copyLiveMandates.userId, strategy.userId), isNotNull(copyLiveMandates.activationCursor)))
      .orderBy(copyLiveMandates.id).for('update');
    const [financial] = await tx.select({ strategyVersion: copyLiveStrategyConfigs.strategyVersion, sourceNetwork: copyLiveStrategyConfigs.sourceNetwork,
      budgetUsd: copyLiveStrategyConfigs.budgetUsd, settings: copyStrategyVersions.settings }).from(copyLiveStrategyConfigs)
      .innerJoin(copyStrategyVersions, and(eq(copyStrategyVersions.strategyId, copyLiveStrategyConfigs.strategyId), eq(copyStrategyVersions.version, copyLiveStrategyConfigs.strategyVersion)))
      .where(and(eq(copyLiveStrategyConfigs.strategyId, strategy.id), eq(copyLiveStrategyConfigs.userId, strategy.userId)));
    if (!financial || financial.strategyVersion !== strategy.version) return null;
    return digest({ strategyId: strategy.id, network: strategy.network, leaderAddress: strategy.leaderAddress, chain: strategy.chain,
      version: strategy.version, financial, account, generations });
  }

  async finishPending(expected: SetupAbortRow): Promise<boolean> {
    return this.db.transaction(async tx => {
      const owner = await this.mandates.lock(tx, expected.userId, true);
      const [abort] = await tx.select().from(copyLiveSetupAborts).where(and(eq(copyLiveSetupAborts.id, expected.id), eq(copyLiveSetupAborts.userId, expected.userId))).for('update');
      if (!abort || !expected.leaseToken || abort.leaseToken !== expected.leaseToken || !abort.leaseUntil || abort.leaseUntil.getTime() <= Date.now() || abort.kind === 'start' || abort.stopId || abort.returnOperationId) return false;
      const [setup] = await tx.select().from(copyLiveSetups).where(and(eq(copyLiveSetups.id, abort.setupId), eq(copyLiveSetups.userId, abort.userId))).for('update');
      if (!setup || (setup.leaseToken && (!setup.leaseUntil || setup.leaseUntil.getTime() > Date.now())) ||
        owner.privyUserId !== abort.ownerPrivyUserId || owner.embeddedWalletAddress !== abort.destination) return false;
      const [strategy] = await tx.select().from(copyStrategies).where(and(eq(copyStrategies.id, abort.strategyId), eq(copyStrategies.userId, abort.userId))).for('update');
      if (!strategy || strategy.network !== abort.network || !abort.generationDigest ||
        await this.generationDigest(tx, strategy, abort.accountId) !== abort.generationDigest) return false;
      const pending = await tx.execute<{ busy: boolean }>(sql`select (
        exists(select 1 from copy_live_mandates where live_setup_id = ${abort.setupId} and activation_cursor is not null)
        or exists(select 1 from copy_funding_operations where live_setup_id = ${abort.setupId} and (attempted_at is not null or status in ('prepared','unknown','accepted')))
        or exists(select 1 from copy_account_mode_operations where live_setup_id = ${abort.setupId} and (submission_state = 'signing' or (attempted_at is not null and target_state <> 'supported' and submission_state <> 'rejected')))
        or exists(select 1 from copy_agent_setups where live_setup_id = ${abort.setupId} and (state in ('policy_prepared','policy_unknown','wallet_prepared','wallet_unknown','approval_unknown','approval_signing') or (approval_attempted_at is not null and state <> 'active')))
        or exists(select 1 from copy_live_builder_approvals where live_setup_id = ${abort.setupId} and (state in ('unknown','accepted') or (attempted_at is not null and state not in ('approved','rejected'))))
      ) as busy`);
      if (pending.rows[0]?.busy !== false) return false;
      const [sealed] = await tx.update(copyLiveSetups).set({ stage: 'cancelled', issue: null, nextAttemptAt: null, leaseToken: null, leaseUntil: null, revision: setup.revision + 1, updatedAt: new Date() }).where(and(eq(copyLiveSetups.id, setup.id), eq(copyLiveSetups.revision, setup.revision), setup.leaseToken ? eq(copyLiveSetups.leaseToken, setup.leaseToken) : sql`${copyLiveSetups.leaseToken} is null`)).returning({ id: copyLiveSetups.id });
      if (!sealed) return false;
      await tx.update(copyLiveSetupAborts).set({ state: 'done', issue: null, nextAttemptAt: null, revision: abort.revision + 1, updatedAt: sql`greatest(clock_timestamp(), ${copyLiveSetupAborts.createdAt})` }).where(eq(copyLiveSetupAborts.id, abort.id));
      return true;
    });
  }

  async request(userId: number, setupId: string, key: string, now: () => number = Date.now): Promise<SetupAbortRow> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw conflict('setup_abort_key_invalid');
    return this.db.transaction(async tx => {
      const owner = await this.mandates.lock(tx, userId);
      const [setup] = await tx.select().from(copyLiveSetups).where(and(eq(copyLiveSetups.id, setupId), eq(copyLiveSetups.userId, userId))).for('update');
      if (!setup) throw new NotFoundException('Setup not found');
      const [strategy] = await tx.select().from(copyStrategies).where(and(eq(copyStrategies.id, setup.strategyId), eq(copyStrategies.userId, userId))).for('update');
      const network = deploymentNetwork(this.config);
      if (!strategy || strategy.network !== network || strategy.mode !== 'testnet' || network !== 'testnet') throw new NotFoundException('Setup not found');
      if (!owner.embeddedWalletAddress) throw conflict('setup_abort_wallet_conflict');
      const [byKey] = await tx.select().from(copyLiveSetupAborts).where(and(eq(copyLiveSetupAborts.userId, userId), eq(copyLiveSetupAborts.idempotencyKey, key)));
      if (byKey && byKey.setupId !== setupId) throw conflict('setup_abort_key_conflict');
      const [existing] = await tx.select().from(copyLiveSetupAborts).where(eq(copyLiveSetupAborts.setupId, setupId));
      if (existing) return existing;
      const [account] = setup.accountId ? await tx.select().from(copyExecutionAccounts).where(and(eq(copyExecutionAccounts.id, setup.accountId), eq(copyExecutionAccounts.userId, userId))).for('update') : [];
      if (setup.accountId && (!account || account.strategyId !== setup.strategyId || account.network !== network || account.privyUserId !== owner.privyUserId)) throw conflict('setup_abort_wallet_conflict');
      // Only the generation this exact setup actually activated can delegate
      // to a stop. A pending edit/renewal never stops its previous generation.
      const generations = await tx.select().from(copyLiveMandates).where(and(eq(copyLiveMandates.userId, userId), eq(copyLiveMandates.liveSetupId, setupId), isNotNull(copyLiveMandates.activationCursor))).for('update');
      const generation = generations[0];
      if (setup.kind !== 'start' && generation) throw conflict('setup_already_applied');
      const parsed = liveCopySetupIntentSchema.safeParse(setup.intent);
      const bound = parsed.success && digest(parsed.data) === setup.intentDigest && parsed.data.setupId === setupId && parsed.data.userId === userId &&
        parsed.data.network === network && parsed.data.ownerPrivyUserId === owner.privyUserId && parsed.data.strategyId === setup.strategyId &&
        parsed.data.accountId === setup.accountId && parsed.data.accountAddress === account?.address;
      const ownerAddress = bound ? parsed.data.ownerAddress : owner.embeddedWalletAddress;
      const bindingIssue = setup.intent && !bound ? 'setup_abort_binding_unknown' : bound && ownerAddress !== owner.embeddedWalletAddress ? 'setup_abort_wallet_conflict' : null;
      const at = new Date(now()), id = randomUUID();
      let stopId: string | null = null;
      if (generation) {
        if (!bound || !setup.consentDigest || generation.consentDigest !== setup.consentDigest || generation.network !== network || generation.accountId !== setup.accountId)
          throw conflict('setup_abort_generation_conflict');
        const others = await tx.select({ id: copyLiveMandates.id }).from(copyLiveMandates).where(and(eq(copyLiveMandates.accountId, generation.accountId),
          sql`${copyLiveMandates.state} not in ('stopped','expired','revoked')`, sql`${copyLiveMandates.id} <> ${generation.id}`));
        if (others.length) throw conflict('setup_abort_generation_conflict');
        const stop = await this.stops.request(tx, userId, generation.id, { idempotencyKey: `setup-abort-${id}`, expectedMandateRevision: generation.revision }, now);
        stopId = stop.id;
      }
      const [abort] = await tx.insert(copyLiveSetupAborts).values({ id, userId, setupId, strategyId: setup.strategyId, accountId: setup.accountId,
        network, kind: setup.kind, idempotencyKey: key, ownerPrivyUserId: owner.privyUserId, ownerAddress, destination: ownerAddress, accountAddress: account?.address ?? null,
        intentDigest: bound ? setup.intentDigest : null, consentDigest: bound ? setup.consentDigest : null, fundingOperationId: setup.fundingOperationId,
        generationDigest: setup.kind === 'start' ? null : await this.generationDigest(tx, strategy, setup.accountId),
        mandateId: generation?.id ?? null, stopId, state: bindingIssue ? 'blocked' : stopId ? 'delegated' : 'requested', issue: bindingIssue, createdAt: at, updatedAt: at }).returning();
      await tx.update(copyLiveSetups).set({ revision: setup.revision + 1, updatedAt: at }).where(and(eq(copyLiveSetups.id, setupId), eq(copyLiveSetups.revision, setup.revision)));
      return abort!;
    });
  }
}
