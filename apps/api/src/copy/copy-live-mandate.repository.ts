import { WatchCapacityError, watchLeader } from '../watcher/leader-watch.js';
import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { ACTUAL_STRATEGY_MODE, liveSourceNetworks, adminSettingsSchema, generalSettingsSchema, copyRiskLimitsSchema, DEFAULT_COPY_RISK_LIMITS, type CopyErrorCode, liveCopyMandateIntentSchema, liveCopyMandateSchema, liveCopyStrategySchema, type CreateLiveCopyStrategy, type LiveCopyMandateIntent, type LiveCopySetupIntent } from '@trading-dashboard/shared/contracts';
import { appSettings, copyLiveActivations, copyLiveSetups, copyLiveBuilderApprovals, copyAgentSetups, copyControls, copyExecutionAccounts, copyExecutionWallets, copyLiveMandates, copyLiveStrategyConfigs, copyRiskPolicies, copyStrategies, copyStrategyVersions, copyWalletAuthorizations, users } from '@trading-dashboard/shared/database';
import { AppConfig } from '../config/app-config.js';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import type { DbExecutor, DbTransaction } from '../db/unit-of-work.js';
import { lockCopyUser } from './copy-user-lock.js';
import { liveCopySettingsDigest } from './copy-live-mandate-consent.js';
import { Dec } from '../common/decimal/dec.js';
import { assertLiveSettings, effectiveLiveLimits } from './copy-live-caps.js';
import { deploymentNetwork } from './live-deployment.js';

import { decodeLiveCopyMandate, digest, type MandateRow } from './copy-live-mandate-evidence.js';
export { type MandateRow } from './copy-live-mandate-evidence.js';
function conflict(): never { throw new ConflictException('Live mandate binding changed'); }
/** A refusal the UI names (wire-contracts `copyErrorCodes`). */
function refuse(code: CopyErrorCode, message: string, details: Record<string, unknown> = {}): never { throw new ConflictException({ statusCode: 409, code, message, ...details }); }
@Injectable()
export class CopyLiveMandateRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, private readonly config: AppConfig) {}
  /** The deployment's network: new copies are made on it, and only its copies
   * are prepared or resumed here. */
  get network() { return deploymentNetwork(this.config); }
  private get caps() { return this.config.value.copy.live?.caps; }
  reader(): DrizzleDb { return this.db; }
  /** COPY_LIVE_ALLOWED_PRIVY_USER_IDS: on a live deployment only these owners
   * may start an actual copy (everyone keeps paper). */
  assertAllowed(privyUserId: string): void {
    const allowed = this.config.value.copy.live?.allowedPrivyUserIds;
    if (allowed && !allowed.has(privyUserId)) refuse('live_not_allowed', 'Real-fund copies are not open to your account yet; paper copies are');
  }
  /** Fixed sizing within the deployment's bounds, and leverage within its cap. */
  assertSettings(settings: CreateLiveCopyStrategy['settings']): void { assertLiveSettings(this.caps, settings); }
  /** `includeDisabled`: a stop the system starts (admin close-all, agent
   * expiry) also for an owner an admin disabled. */
  async owner(userId: number, db: DbExecutor = this.db, includeDisabled = false) {
    const [owner] = await db.select().from(users).where(and(eq(users.id, userId), includeDisabled ? undefined : isNull(users.disabledAt)));
    if (!owner) throw new NotFoundException('Owner not found');
    return owner;
  }
  async lock(tx: DbTransaction, userId: number, includeDisabled = false) {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(7403, 0)`);
    await tx.execute(sql`select pg_advisory_xact_lock_shared(7405, 0)`);
    await lockCopyUser(tx, userId);
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    return this.owner(userId, tx, includeDisabled);
  }
  async preparation(db: DbExecutor) {
    // The deployment's caps (COPY_LIVE_*) apply as the stricter of the two.
    return effectiveLiveLimits(this.caps, await this.policy(db));
  }
  /** The newest explicit risk policy, as stored (no deployment caps). */
  async policy(db: DbExecutor) {
    const [general] = await db.select().from(appSettings).where(eq(appSettings.key, 'general'));
    if (!general || (general.value as { copyTradingEnabled?: unknown }).copyTradingEnabled !== true) throw new ServiceUnavailableException({ statusCode: 503, code: 'copy_not_open', message: 'Copy trading is not open' });
    const [policy] = await db.select().from(copyRiskPolicies).orderBy(desc(copyRiskPolicies.version)).limit(1);
    if (!policy || !policy.limits || Object.keys(DEFAULT_COPY_RISK_LIMITS).some(key => !Object.hasOwn(policy.limits, key))) throw new ServiceUnavailableException('Explicit risk policy required');
    const parsed = copyRiskLimitsSchema.safeParse(policy.limits);
    if (!parsed.success) throw new ServiceUnavailableException('Invalid risk policy');
    return parsed.data;
  }
  async builder(db: DbExecutor) {
    // A live deployment charges no builder fee for now: its setups skip the
    // builder step and its generations bind none.
    if (this.config.value.copy.live?.builderFee === false) return { builderAddress: null, builderMaxFeeTenthsOfBps: 0 };
    const [row] = await db.select().from(appSettings).where(eq(appSettings.key, 'revenue'));
    if (!row) return { builderAddress: null, builderMaxFeeTenthsOfBps: 0 };
    // A saved section missing a key means that key's default (no builder, fee
    // 0), exactly as the risk authority reads it: refusing it here made every
    // preparation 503 while the orders' own check accepted the same row.
    const parsed = adminSettingsSchema.shape.revenue.safeParse(row.value);
    if (!parsed.success) throw new ServiceUnavailableException('Invalid builder settings');
    return { builderAddress: parsed.data.builderAddress?.toLowerCase() ?? null, builderMaxFeeTenthsOfBps: parsed.data.builderFeeTenthsBps };
  }
  checkBudget(budget: string, limits: typeof DEFAULT_COPY_RISK_LIMITS) {
    if (Dec.from(budget).lt(limits.minAllocationUsd)) refuse('below_min_allocation', 'Budget below the minimum allocation', { min: limits.minAllocationUsd });
    if (Dec.from(budget).gt(limits.maxAllocationUsd)) refuse('above_max_allocation', 'Budget above the maximum allocation', { max: limits.maxAllocationUsd });
  }
  async barriers(db: DbExecutor, userId: number) {
    const controls = await db.select().from(copyControls).where(sql`${copyControls.scope} = 'platform' or (${copyControls.scope} = 'user' and ${copyControls.scopeId} = ${userId})`);
    if (controls.length !== 2 || controls.filter(row => row.scope === 'platform' && row.scopeId === 0).length !== 1 || controls.filter(row => row.scope === 'user' && row.scopeId === userId).length !== 1) throw new ConflictException('Complete platform and user controls required');
    if (controls.some(row => row.pauseNewRisk || row.reduceOnly)) refuse('copy_paused', 'New risk is paused');
  }
  /** The owner's paused testnet copies whose start never ran a generation
   * and ended or never got its consent: what 取消設定 would end. */
  async unfinishedStarts(tx: DbExecutor, userId: number, strategyIds: number[]): Promise<Array<{ strategyId: number; leaderAddress: string; setupId: string }>> {
    if (!strategyIds.length) return [];
    const rows = await tx.select({ strategyId: copyLiveSetups.strategyId, leaderAddress: copyLiveSetups.leaderAddress, setupId: copyLiveSetups.id }).from(copyLiveSetups)
      .where(and(eq(copyLiveSetups.userId, userId), eq(copyLiveSetups.kind, 'start'), inArray(copyLiveSetups.strategyId, strategyIds),
        inArray(copyLiveSetups.stage, ['provisioning', 'awaiting_consent', 'failed', 'expired']),
        sql`not exists (select 1 from ${copyLiveMandates} m where m.strategy_id = ${copyLiveSetups.strategyId} and m.state in ('active', 'paused', 'stopping', 'stopped'))`))
      .orderBy(desc(copyLiveSetups.createdAt));
    // The latest start of each copy.
    return rows.filter((row, index) => rows.findIndex(other => other.strategyId === row.strategyId) === index);
  }
  async strategyWire(id: number, db: DbExecutor = this.db) {
    const [row] = await db.select({ strategy: copyStrategies, config: copyLiveStrategyConfigs, settings: copyStrategyVersions.settings }).from(copyStrategies)
      .innerJoin(copyLiveStrategyConfigs, and(eq(copyLiveStrategyConfigs.strategyId, copyStrategies.id), eq(copyLiveStrategyConfigs.userId, copyStrategies.userId)))
      .innerJoin(copyStrategyVersions, and(eq(copyStrategyVersions.strategyId, copyStrategies.id), eq(copyStrategyVersions.version, copyStrategies.version)))
      .where(and(eq(copyStrategies.id, id), eq(copyStrategies.mode, ACTUAL_STRATEGY_MODE)));
    if (!row) conflict();
    return liveCopyStrategySchema.parse({ id, mode: 'actual', network: row.strategy.network, sourceNetwork: row.config.sourceNetwork, leaderAddress: row.strategy.leaderAddress, budgetUsd: row.config.budgetUsd,
      status: row.strategy.status, version: row.strategy.version, settings: row.settings, pauseNewRisk: row.strategy.pauseNewRisk, reduceOnly: row.strategy.reduceOnly, createdAt: row.strategy.createdAt.toISOString() });
  }
  async create(tx: DbTransaction, userId: number, input: CreateLiveCopyStrategy, clock: () => number) {
    const owner = await this.lock(tx, userId); const now = clock(), network = this.network;
    const [existing] = await tx.select().from(copyLiveStrategyConfigs).where(and(eq(copyLiveStrategyConfigs.userId, userId), eq(copyLiveStrategyConfigs.idempotencyKey, input.idempotencyKey)));
    if (existing) {
      const result = await this.strategyWire(existing.strategyId, tx);
      if (result.leaderAddress !== input.leader || result.sourceNetwork !== input.sourceNetwork || result.budgetUsd !== input.budgetUsd || liveCopySettingsDigest(result.settings) !== liveCopySettingsDigest(input.settings)) conflict();
      return result;
    }
    this.assertAllowed(owner.privyUserId);
    if (!liveSourceNetworks(network).includes(input.sourceNetwork)) refuse('live_source_network_unsupported', `This deployment copies ${liveSourceNetworks(network).join(' and ')} traders only`);
    this.assertSettings(input.settings);
    const policy = await this.policy(tx), limits = effectiveLiveLimits(this.caps, policy); this.checkBudget(input.budgetUsd, limits);
    await tx.insert(copyControls).values({ scope: 'user', scopeId: userId, pauseNewRisk: false, reduceOnly: false }).onConflictDoNothing({ target: [copyControls.scope, copyControls.scopeId] });
    await this.barriers(tx, userId);
    const active = await tx.select().from(copyStrategies).where(and(eq(copyStrategies.userId, userId), ne(copyStrategies.status, 'stopped')));
    const actual = active.filter(row => row.mode === ACTUAL_STRATEGY_MODE && row.network === network);
    if (actual.some(row => row.leaderAddress === input.leader)) refuse('already_copying', 'You already copy this trader with real funds');
    // The policy's limit counts every copy (as paper's does); the stricter of
    // it and the deployment's cap (COPY_LIVE_MAX_STRATEGIES_PER_USER) counts
    // this network's actual copies, so another network's history neither
    // blocks nor widens it. Without a cap both are the policy's.
    if (active.length >= policy.maxStrategiesPerUser || actual.length >= limits.maxStrategiesPerUser) {
      // Starts left unfinished (their sheet closed, or they failed or expired
      // before a generation ran) still count: each holds a copy wallet and
      // an agent at Privy, so the limit also bounds those. The refusal names
      // them, for the owner to cancel the one they no longer want.
      const unfinished = await this.unfinishedStarts(tx, userId, actual.filter(row => row.status === 'paused').map(row => row.id));
      refuse('strategy_limit', 'Copy limit reached', { limit: actual.length >= limits.maxStrategiesPerUser ? limits.maxStrategiesPerUser : policy.maxStrategiesPerUser, unfinished });
    }
    if (input.settings.maxLeverage !== null && input.settings.maxLeverage > limits.maxLeverage) refuse('leverage_above_limit', 'Leverage above the platform limit', { limit: limits.maxLeverage });
    const [row] = await tx.insert(copyStrategies).values({ userId, leaderAddress: input.leader, mode: ACTUAL_STRATEGY_MODE, network, status: 'paused', pauseNewRisk: true, allocated: '0', cash: '0', activatedAt: new Date(now) }).returning();
    await tx.insert(copyStrategyVersions).values({ strategyId: row.id, version: 1, settings: input.settings, createdByUserId: userId });
    await tx.insert(copyLiveStrategyConfigs).values({ strategyId: row.id, userId, idempotencyKey: input.idempotencyKey, sourceNetwork: input.sourceNetwork, budgetUsd: input.budgetUsd, strategyVersion: 1 });
    // A mainnet leader's fills reach testnet copies through the market
    // watcher (REST-confirmed, with proven coverage): make sure it is watched.
    if (input.sourceNetwork === 'mainnet') {
      // Within the site-wide cap on watched addresses, serialised like paper
      // copies and favorites: at the cap a leader nobody watches yet is refused
      // and the whole preparation rolls back.
      const [general] = await tx.select().from(appSettings).where(eq(appSettings.key, 'general'));
      const limit = generalSettingsSchema.shape.maxWatchedAddresses.safeParse((general?.value as { maxWatchedAddresses?: unknown } | undefined)?.maxWatchedAddresses);
      if (!limit.success) throw new ServiceUnavailableException('Invalid watch capacity setting');
      try { await watchLeader(tx, input.leader, 'copy', limit.data); }
      catch (error) {
        if (error instanceof WatchCapacityError) throw new ConflictException({ statusCode: 409, code: 'watch_capacity', limit: error.limit, message: "The site can't watch more traders right now" });
        throw error;
      }
    }
    return this.strategyWire(row.id, tx);
  }
  async context(tx: DbTransaction, userId: number, accountId: string, now: number) {
    const owner = await this.owner(userId, tx);
    const [account] = await tx.select().from(copyExecutionAccounts).where(and(eq(copyExecutionAccounts.id, accountId), eq(copyExecutionAccounts.userId, userId))).for('update');
    if (!account) throw new NotFoundException('Account not found');
    const [strategy] = await tx.select().from(copyStrategies).where(and(eq(copyStrategies.id, account.strategyId), eq(copyStrategies.userId, userId))).for('update');
    if (!strategy || strategy.mode !== ACTUAL_STRATEGY_MODE || strategy.network !== this.network || strategy.status !== 'paused' || !strategy.pauseNewRisk || strategy.reduceOnly ||
      account.network !== this.network || account.state !== 'ready' || account.privyUserId !== owner.privyUserId) conflict();
    const wire = await this.strategyWire(strategy.id, tx);
    const [config] = await tx.select().from(copyLiveStrategyConfigs).where(eq(copyLiveStrategyConfigs.strategyId, strategy.id));
    if (config.strategyVersion !== strategy.version || !liveSourceNetworks(this.network).includes(config.sourceNetwork)) conflict();
    const limits = await this.preparation(tx); this.checkBudget(config.budgetUsd, limits); await this.barriers(tx, userId);
    this.assertAllowed(owner.privyUserId); this.assertSettings(wire.settings);
    if (wire.settings.maxLeverage !== null && wire.settings.maxLeverage > limits.maxLeverage) refuse('leverage_above_limit', 'Leverage above the platform limit', { limit: limits.maxLeverage });
    const rows = await tx.select({ setup: copyAgentSetups, wallet: copyExecutionWallets, grant: copyWalletAuthorizations }).from(copyAgentSetups)
      .innerJoin(copyWalletAuthorizations, eq(copyWalletAuthorizations.id, copyAgentSetups.authorizationId))
      .innerJoin(copyExecutionWallets, eq(copyExecutionWallets.id, copyWalletAuthorizations.walletId))
      .where(and(eq(copyAgentSetups.accountId, accountId), eq(copyAgentSetups.state, 'active')));
    if (rows.length !== 1) conflict();
    const { setup, wallet, grant } = rows[0];
    if (setup.userId !== userId || setup.strategyId !== strategy.id || setup.network !== account.network || setup.accountAddress !== account.address || setup.accountWalletId !== account.privyWalletId || setup.accountOwnerQuorumId !== account.ownerQuorumId ||
      wallet.userId !== userId || wallet.strategyId !== strategy.id || wallet.network !== account.network || wallet.accountAddress !== account.address || wallet.privyWalletId !== setup.agentWalletId || wallet.privyOwnerId !== setup.agentOwnerQuorumId || wallet.signerAddress !== setup.agentAddress || wallet.privyOwnerId !== account.ownerQuorumId || wallet.retiredAt !== null ||
      grant.revokedAt !== null || grant.revokeRequestedAt !== null || grant.validFrom.getTime() > now || grant.expiresAt.getTime() <= now || !grant.exchangeApprovedAt || grant.exchangeApprovedAt.getTime() > now || setup.expiresAt?.getTime() !== grant.expiresAt.getTime() || !grant.scopes.includes('copy:trade') || !grant.scopes.includes('copy:reduce')) conflict();
    const binding = {
      accountId, userId, strategyId: strategy.id, strategyVersion: strategy.version, network: account.network, sourceNetwork: config.sourceNetwork, leaderAddress: strategy.leaderAddress,
      accountAddress: account.address, accountRevision: account.revision, ownerAddress: owner.embeddedWalletAddress, ownerPrivyUserId: owner.privyUserId,
      setupId: setup.id, setupRevision: setup.revision, executionWalletId: wallet.id, agentWalletId: wallet.privyWalletId, agentAddress: wallet.signerAddress,
      authorizationId: grant.id, authorizationVersion: grant.version, policyId: setup.policyId, policyFingerprint: setup.policyFingerprint,
      workerQuorumId: setup.workerQuorumId, settingsDigest: liveCopySettingsDigest(wire.settings), budgetUsd: config.budgetUsd, ...await this.builder(tx), plannerVersion: 1 as const,
    };
    return { binding, grantExpiresAt: grant.expiresAt.getTime() };
  }
  decode(row: MandateRow): LiveCopyMandateIntent { return decodeLiveCopyMandate(row); }
  wire(row: MandateRow) {
    this.decode(row);
    return liveCopyMandateSchema.parse({ id: row.id, accountId: row.accountId, strategyId: row.strategyId, mode: 'actual', network: row.network, accountAddress: row.accountAddress,
      sourceNetwork: row.sourceNetwork, leaderAddress: row.leaderAddress, budgetUsd: row.budgetUsd, strategyVersion: row.strategyVersion, state: row.state, revision: row.revision,
      activationCursor: row.activationCursor?.toISOString() ?? null, expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
  }
  async find(userId: number, id: string, db: DbExecutor = this.db, locked = false) {
    const query = db.select().from(copyLiveMandates).where(and(eq(copyLiveMandates.userId, userId), eq(copyLiveMandates.id, id)));
    const [row] = await (locked ? query.for('update') : query);
    if (!row) throw new NotFoundException('Mandate not found');
    this.decode(row); return row;
  }
  async prepare(tx: DbTransaction, userId: number, accountId: string, key: string, clock: () => number) {
    await this.lock(tx, userId); const now = clock();
    const context = await this.context(tx, userId, accountId, now);
    const [existing] = await tx.select().from(copyLiveMandates).where(and(eq(copyLiveMandates.userId, userId), eq(copyLiveMandates.idempotencyKey, key)));
    if (existing) { if (existing.accountId !== accountId) conflict(); return existing; }
    // A configured builder fee is charged on every order: the account must
    // have approved at least that fee for that builder on the exchange.
    const fee = await this.builder(tx);
    if (fee.builderAddress && fee.builderMaxFeeTenthsOfBps > 0) {
      const [approved] = await tx.select({ id: copyLiveBuilderApprovals.id }).from(copyLiveBuilderApprovals).where(and(eq(copyLiveBuilderApprovals.accountId, accountId),
        eq(copyLiveBuilderApprovals.state, 'approved'), eq(copyLiveBuilderApprovals.builderAddress, fee.builderAddress), sql`${copyLiveBuilderApprovals.maxFeeTenthsBps} >= ${fee.builderMaxFeeTenthsOfBps}`)).limit(1);
      if (!approved) throw new ConflictException({ statusCode: 409, code: 'builder_fee_approval_required', message: 'Approve the builder fee from the copy account first' });
    }
    const current = await tx.select().from(copyLiveMandates).where(and(eq(copyLiveMandates.accountId, accountId), sql`${copyLiveMandates.state} not in ('stopped','revoked','expired')`));
    for (const row of current) {
      if (row.expiresAt.getTime() <= now || (row.state === 'prepared' && row.consentExpiresAt.getTime() <= now)) await tx.update(copyLiveMandates).set({ state: 'expired', revision: row.revision + 1, updatedAt: new Date(now) }).where(eq(copyLiveMandates.id, row.id));
      else conflict();
    }
    const [prior] = await tx.select().from(copyLiveMandates).where(eq(copyLiveMandates.userId, userId)).orderBy(desc(copyLiveMandates.nonce)).limit(1);
    const nonce = Math.max(now, (prior?.nonce ?? 0) + 1);
    // Millisecond generations must never grant future consent authority.
    if (nonce > now) throw new ConflictException('Retry challenge after clock advances');
    const parsed = liveCopyMandateIntentSchema.safeParse({ ...context.binding, mandateId: randomUUID(), nonce, consentExpiresAt: nonce + 300000, expiresAt: Math.min(context.grantExpiresAt, nonce + 30 * 86400000) });
    if (!parsed.success) conflict();
    const intent = parsed.data;
    const { mandateId, consentExpiresAt, expiresAt, ...columns } = intent;
    const [row] = await tx.insert(copyLiveMandates).values({ ...columns, id: mandateId, idempotencyKey: key, intent, intentDigest: digest(intent), consentExpiresAt: new Date(consentExpiresAt), expiresAt: new Date(expiresAt), createdAt: new Date(now), updatedAt: new Date(now) }).returning();
    return row;
  }
  /** `consent`: the one-click setup whose verified consent bound this
   * generation (its digest is kept). */
  async activate(tx: DbTransaction, row: MandateRow, consent: { readonly liveSetupId: string; readonly consentDigest: string }, now: number) {
    if (row.state === 'active') return row;
    if (row.state !== 'prepared') conflict();
    // A listed owner on this deployment's network only (security review).
    this.assertAllowed(row.ownerPrivyUserId);
    if (row.network !== this.network) conflict();
    await tx.update(copyStrategies).set({ status: 'paused', pauseNewRisk: true }).where(and(eq(copyStrategies.id, row.strategyId), eq(copyStrategies.userId, row.userId), eq(copyStrategies.mode, ACTUAL_STRATEGY_MODE)));
    const kind = { consentDigest: consent.consentDigest, consentKind: 'setup' as const, liveSetupId: consent.liveSetupId };
    // Never before the row's own created_at (the activation check): a caller
    // that read its clock before preparing would otherwise be milliseconds early.
    const at = Math.max(now, row.createdAt.getTime());
    const [updated] = await tx.update(copyLiveMandates).set({ state: 'active', ...kind, activationCursor: new Date(at), revision: row.revision + 1, updatedAt: new Date(at) }).where(and(eq(copyLiveMandates.id, row.id), eq(copyLiveMandates.revision, row.revision), eq(copyLiveMandates.state, 'prepared'))).returning();
    if (!updated) conflict();
    // Awaiting its start: the worker starts trading this generation once it
    // is funded, and only while the strategy keeps this control revision.
    const [strategy] = await tx.select({ controlRevision: copyStrategies.controlRevision }).from(copyStrategies).where(eq(copyStrategies.id, row.strategyId));
    if (!strategy) conflict();
    await tx.insert(copyLiveActivations).values({ mandateId: row.id, userId: row.userId, strategyId: row.strategyId, accountId: row.accountId,
      state: 'pending', controlRevision: strategy.controlRevision, requestedAt: new Date(now) }).onConflictDoNothing();
    return updated;
  }
  /**
   * A one-click setup's generation (plan §2 "Mandate"): the server fills the
   * unchanged mandate intent once the agent grant is active, checks that it
   * binds exactly what the setup consent bound, and activates it under that
   * consent in the same transaction. An edit or renewal first replaces the
   * copy's current generation (expired) and, for an edit, its settings and
   * budget become the strategy's next version. A paused copy stays paused.
   */
  async prepareFromSetup(tx: DbTransaction, userId: number, setup: { id: string; kind: 'start' | 'edit' | 'renewal'; consentDigest: string; intent: LiveCopySetupIntent; settings: CreateLiveCopyStrategy['settings'] }, clock: () => number) {
    const owner = await this.lock(tx, userId); const now = clock(), intent = setup.intent, key = `setup_${setup.id.replaceAll('-', '')}`;
    // A listed owner's own setup, on this deployment's network (security review).
    this.assertAllowed(owner.privyUserId);
    if (intent.network !== this.network || intent.ownerPrivyUserId !== owner.privyUserId) conflict();
    const [existing] = await tx.select().from(copyLiveMandates).where(and(eq(copyLiveMandates.userId, userId), eq(copyLiveMandates.idempotencyKey, key)));
    if (existing) return existing;
    if (intent.setupId !== setup.id || intent.userId !== userId) conflict();
    let wasPaused = false;
    if (setup.kind !== 'start') {
      const [strategy] = await tx.select().from(copyStrategies).where(and(eq(copyStrategies.id, intent.strategyId), eq(copyStrategies.userId, userId), eq(copyStrategies.mode, ACTUAL_STRATEGY_MODE))).for('update');
      if (!strategy || ['stopping', 'stopped'].includes(strategy.status) || strategy.reduceOnly) throw new ConflictException({ statusCode: 409, code: 'live_stop_in_progress', message: 'A stop is in progress for this copy' });
      const current = await tx.select().from(copyLiveMandates).where(and(eq(copyLiveMandates.accountId, intent.accountId), sql`${copyLiveMandates.state} not in ('stopped','revoked','expired')`)).for('update');
      if (current.some(row => row.state === 'stopping')) throw new ConflictException({ statusCode: 409, code: 'live_stop_in_progress', message: 'A stop is in progress for this copy' });
      wasPaused = strategy.status === 'paused' && current.some(row => row.state === 'paused');
      for (const row of current) await tx.update(copyLiveMandates).set({ state: 'expired', revision: row.revision + 1, updatedAt: new Date(now) }).where(eq(copyLiveMandates.id, row.id));
      await tx.update(copyStrategies).set({ status: 'paused', pauseNewRisk: true }).where(eq(copyStrategies.id, strategy.id));
      if (setup.kind === 'edit') {
        const version = strategy.version + 1;
        await tx.insert(copyStrategyVersions).values({ strategyId: strategy.id, version, settings: setup.settings, createdByUserId: userId });
        await tx.update(copyStrategies).set({ version }).where(eq(copyStrategies.id, strategy.id));
        await tx.update(copyLiveStrategyConfigs).set({ strategyVersion: version, budgetUsd: intent.budgetUsd }).where(eq(copyLiveStrategyConfigs.strategyId, strategy.id));
      }
    }
    const row = await this.prepare(tx, userId, intent.accountId, key, clock);
    // Everything the owner consented to, as the generation binds it.
    if (row.strategyId !== intent.strategyId || row.leaderAddress !== intent.leaderAddress || row.sourceNetwork !== intent.sourceNetwork || row.budgetUsd !== intent.budgetUsd ||
      row.settingsDigest !== intent.settingsDigest || row.accountAddress !== intent.accountAddress || row.ownerAddress !== intent.ownerAddress || row.ownerPrivyUserId !== intent.ownerPrivyUserId ||
      row.agentAddress !== intent.agentAddress || row.policyId !== intent.agentPolicyId || row.policyFingerprint !== intent.agentPolicyFingerprint || row.workerQuorumId !== intent.workerQuorumId ||
      row.builderAddress !== intent.builderAddress || row.builderMaxFeeTenthsOfBps !== intent.builderMaxFeeTenthsOfBps || row.expiresAt.getTime() > intent.agentValidUntil) conflict();
    const active = await this.activate(tx, row, { liveSetupId: setup.id, consentDigest: setup.consentDigest }, now);
    if (!wasPaused) return active;
    const [paused] = await tx.update(copyLiveMandates).set({ state: 'paused', revision: active.revision + 1, updatedAt: new Date(now) }).where(and(eq(copyLiveMandates.id, active.id), eq(copyLiveMandates.revision, active.revision))).returning();
    return paused ?? conflict();
  }
  async barrier(tx: DbTransaction, userId: number, id: string, state: 'paused' | 'revoked', clock: () => number) {
    const owner = await this.lock(tx, userId), row = await this.find(userId, id, tx, true);
    const now = clock();
    const [account] = await tx.select().from(copyExecutionAccounts).where(and(eq(copyExecutionAccounts.id, row.accountId), eq(copyExecutionAccounts.userId, userId)));
    const [strategy] = await tx.select().from(copyStrategies).where(and(eq(copyStrategies.id, row.strategyId), eq(copyStrategies.userId, userId), eq(copyStrategies.mode, ACTUAL_STRATEGY_MODE)));
    if (!account || !strategy || account.network !== row.network || account.strategyId !== row.strategyId || owner.privyUserId !== row.ownerPrivyUserId || account.privyUserId !== owner.privyUserId) conflict();
    if (row.state === state) return row;
    // A stop in progress owns the strategy: pausing or revoking consent must
    // never move a stopping (or stopped) strategy back to paused.
    if (row.state === 'stopping' || strategy.status === 'stopping' || strategy.status === 'stopped') throw new ConflictException({ statusCode: 409, code: 'live_stop_in_progress', message: 'A stop is in progress for this copy' });
    if (['revoked', 'expired', 'stopped'].includes(row.state) || (state === 'paused' && row.state !== 'active')) conflict();
    await tx.update(copyStrategies).set({ status: 'paused', pauseNewRisk: true }).where(eq(copyStrategies.id, row.strategyId));
    const [updated] = await tx.update(copyLiveMandates).set({ state, revision: row.revision + 1, updatedAt: new Date(now) }).where(and(eq(copyLiveMandates.id, id), eq(copyLiveMandates.revision, row.revision))).returning();
    if (!updated) conflict(); return updated;
  }
  /**
   * Resume (plan §4 parity): a paused generation becomes active again within
   * its unexpired lifetime, with no signature (its consent covers the whole
   * generation). Same gates as the funded start: controls clear, no stop, the
   * strategy exactly paused. A generation that never started stays waiting
   * for its deposit (activateFunded starts it).
   */
  async resume(tx: DbTransaction, userId: number, id: string, clock: () => number) {
    const owner = await this.lock(tx, userId), row = await this.find(userId, id, tx, true), now = clock();
    const [strategy] = await tx.select().from(copyStrategies).where(and(eq(copyStrategies.id, row.strategyId), eq(copyStrategies.userId, userId), eq(copyStrategies.mode, ACTUAL_STRATEGY_MODE))).for('update');
    // Another network's generation is history on this deployment: never resumed here.
    if (!strategy || owner.privyUserId !== row.ownerPrivyUserId || row.network !== this.network || strategy.network !== this.network) conflict();
    this.assertAllowed(owner.privyUserId);
    if (row.state === 'active') return row;
    if (row.state === 'stopping' || strategy.status === 'stopping' || strategy.status === 'stopped') throw new ConflictException({ statusCode: 409, code: 'live_stop_in_progress', message: 'A stop is in progress for this copy' });
    if (row.state !== 'paused' || row.expiresAt.getTime() <= now || strategy.status !== 'paused' || strategy.reduceOnly) conflict();
    await this.barriers(tx, userId);
    const [updated] = await tx.update(copyLiveMandates).set({ state: 'active', revision: row.revision + 1, updatedAt: new Date(now) }).where(and(eq(copyLiveMandates.id, id), eq(copyLiveMandates.revision, row.revision))).returning();
    if (!updated) conflict();
    const [activation] = await tx.select().from(copyLiveActivations).where(eq(copyLiveActivations.mandateId, id));
    if (activation?.state === 'activated') {
      await tx.update(copyStrategies).set({ status: 'active', pauseNewRisk: false, controlRevision: strategy.controlRevision + 1 }).where(and(eq(copyStrategies.id, strategy.id), eq(copyStrategies.status, 'paused')));
    } else if (activation?.state === 'pending' && activation.controlRevision !== strategy.controlRevision) {
      await tx.update(copyLiveActivations).set({ controlRevision: strategy.controlRevision }).where(and(eq(copyLiveActivations.mandateId, id), eq(copyLiveActivations.state, 'pending')));
    }
    return updated;
  }
  async overview(userId: number) {
    await this.owner(userId);
    const configs = await this.db.select().from(copyLiveStrategyConfigs).where(eq(copyLiveStrategyConfigs.userId, userId));
    const rows = await this.db.select().from(copyLiveMandates).where(eq(copyLiveMandates.userId, userId));
    return { strategies: await Promise.all(configs.map(row => this.strategyWire(row.strategyId))), mandates: rows.map(row => this.wire(row)) };
  }
}
