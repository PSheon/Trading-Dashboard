import { WatchCapacityError, watchLeader } from '../watcher/leader-watch.js';
import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { adminSettingsSchema, generalSettingsSchema, copyRiskLimitsSchema, DEFAULT_COPY_RISK_LIMITS, liveCopyMandateIntentSchema, liveCopyMandateSchema, liveCopyStrategySchema, type CreateLiveCopyStrategy, type LiveCopyMandateIntent } from '@trading-dashboard/shared/contracts';
import { appSettings, copyLiveActivations, copyAgentSetups, copyControls, copyExecutionAccounts, copyExecutionWallets, copyLiveMandates, copyLiveStrategyConfigs, copyRiskPolicies, copyStrategies, copyStrategyVersions, copyWalletAuthorizations, users } from '@trading-dashboard/shared/database';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import type { DbExecutor, DbTransaction } from '../db/unit-of-work.js';
import { lockCopyUser } from './copy-user-lock.js';
import { liveCopySettingsDigest } from './copy-live-mandate-consent.js';
import { Dec } from '../common/decimal/dec.js';

import { decodeLiveCopyMandate, digest, type MandateRow } from './copy-live-mandate-evidence.js';
export { type MandateRow } from './copy-live-mandate-evidence.js';
function conflict(): never { throw new ConflictException('Live mandate binding changed'); }
@Injectable()
export class CopyLiveMandateRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  async owner(userId: number, db: DbExecutor = this.db) {
    const [owner] = await db.select().from(users).where(and(eq(users.id, userId), isNull(users.disabledAt)));
    if (!owner) throw new NotFoundException('Owner not found');
    return owner;
  }
  async lock(tx: DbTransaction, userId: number) {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(7403, 0)`);
    await tx.execute(sql`select pg_advisory_xact_lock_shared(7405, 0)`);
    await lockCopyUser(tx, userId);
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    return this.owner(userId, tx);
  }
  async preparation(db: DbExecutor) {
    const [general] = await db.select().from(appSettings).where(eq(appSettings.key, 'general'));
    if (!general || (general.value as { copyTradingEnabled?: unknown }).copyTradingEnabled !== true) throw new ServiceUnavailableException('Copy preparation unavailable');
    const [policy] = await db.select().from(copyRiskPolicies).orderBy(desc(copyRiskPolicies.version)).limit(1);
    if (!policy || !policy.limits || Object.keys(DEFAULT_COPY_RISK_LIMITS).some(key => !Object.hasOwn(policy.limits, key))) throw new ServiceUnavailableException('Explicit risk policy required');
    const parsed = copyRiskLimitsSchema.safeParse(policy.limits);
    if (!parsed.success) throw new ServiceUnavailableException('Invalid risk policy');
    return parsed.data;
  }
  async builder(db: DbExecutor) {
    const [row] = await db.select().from(appSettings).where(eq(appSettings.key, 'revenue'));
    if (!row) return { builderAddress: null, builderMaxFeeTenthsOfBps: 0 };
    if (!Object.hasOwn(Object(row.value), 'builderAddress') || !Object.hasOwn(Object(row.value), 'builderFeeTenthsBps')) throw new ServiceUnavailableException('Explicit builder settings required');
    const parsed = adminSettingsSchema.shape.revenue.safeParse(row.value);
    if (!parsed.success) throw new ServiceUnavailableException('Invalid builder settings');
    return { builderAddress: parsed.data.builderAddress?.toLowerCase() ?? null, builderMaxFeeTenthsOfBps: parsed.data.builderFeeTenthsBps };
  }
  checkBudget(budget: string, limits: typeof DEFAULT_COPY_RISK_LIMITS) {
    if (Dec.from(budget).lt(limits.minAllocationUsd) || Dec.from(budget).gt(limits.maxAllocationUsd)) throw new ConflictException('Budget outside current allocation policy');
  }
  async barriers(db: DbExecutor, userId: number) {
    const controls = await db.select().from(copyControls).where(sql`${copyControls.scope} = 'platform' or (${copyControls.scope} = 'user' and ${copyControls.scopeId} = ${userId})`);
    if (controls.length !== 2 || controls.filter(row => row.scope === 'platform' && row.scopeId === 0).length !== 1 || controls.filter(row => row.scope === 'user' && row.scopeId === userId).length !== 1) throw new ConflictException('Complete platform and user controls required');
    if (controls.some(row => row.pauseNewRisk || row.reduceOnly)) throw new ConflictException('New risk is paused');
  }
  async strategyWire(id: number, db: DbExecutor = this.db) {
    const [row] = await db.select({ strategy: copyStrategies, config: copyLiveStrategyConfigs, settings: copyStrategyVersions.settings }).from(copyStrategies)
      .innerJoin(copyLiveStrategyConfigs, and(eq(copyLiveStrategyConfigs.strategyId, copyStrategies.id), eq(copyLiveStrategyConfigs.userId, copyStrategies.userId)))
      .innerJoin(copyStrategyVersions, and(eq(copyStrategyVersions.strategyId, copyStrategies.id), eq(copyStrategyVersions.version, copyStrategies.version)))
      .where(and(eq(copyStrategies.id, id), eq(copyStrategies.mode, 'testnet')));
    if (!row) conflict();
    return liveCopyStrategySchema.parse({ id, mode: 'actual', network: 'testnet', sourceNetwork: row.config.sourceNetwork, leaderAddress: row.strategy.leaderAddress, budgetUsd: row.config.budgetUsd,
      status: row.strategy.status, version: row.strategy.version, settings: row.settings, pauseNewRisk: row.strategy.pauseNewRisk, reduceOnly: row.strategy.reduceOnly, createdAt: row.strategy.createdAt.toISOString() });
  }
  async create(tx: DbTransaction, userId: number, input: CreateLiveCopyStrategy, clock: () => number) {
    await this.lock(tx, userId); const now = clock();
    const [existing] = await tx.select().from(copyLiveStrategyConfigs).where(and(eq(copyLiveStrategyConfigs.userId, userId), eq(copyLiveStrategyConfigs.idempotencyKey, input.idempotencyKey)));
    if (existing) {
      const result = await this.strategyWire(existing.strategyId, tx);
      if (result.leaderAddress !== input.leader || result.sourceNetwork !== input.sourceNetwork || result.budgetUsd !== input.budgetUsd || liveCopySettingsDigest(result.settings) !== liveCopySettingsDigest(input.settings)) conflict();
      return result;
    }
    const limits = await this.preparation(tx); this.checkBudget(input.budgetUsd, limits);
    await tx.insert(copyControls).values({ scope: 'user', scopeId: userId, pauseNewRisk: false, reduceOnly: false }).onConflictDoNothing({ target: [copyControls.scope, copyControls.scopeId] });
    await this.barriers(tx, userId);
    const active = await tx.select().from(copyStrategies).where(and(eq(copyStrategies.userId, userId), ne(copyStrategies.status, 'stopped')));
    if (active.length >= limits.maxStrategiesPerUser || active.some(row => row.mode === 'testnet' && row.leaderAddress === input.leader)) conflict();
    if (input.settings.maxLeverage !== null && input.settings.maxLeverage > limits.maxLeverage) conflict();
    const [row] = await tx.insert(copyStrategies).values({ userId, leaderAddress: input.leader, mode: 'testnet', status: 'paused', pauseNewRisk: true, allocated: '0', cash: '0', activatedAt: new Date(now) }).returning();
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
    if (!strategy || strategy.mode !== 'testnet' || strategy.status !== 'paused' || !strategy.pauseNewRisk || strategy.reduceOnly || account.network !== 'testnet' || account.state !== 'ready' || account.privyUserId !== owner.privyUserId) conflict();
    const wire = await this.strategyWire(strategy.id, tx);
    const [config] = await tx.select().from(copyLiveStrategyConfigs).where(eq(copyLiveStrategyConfigs.strategyId, strategy.id));
    if (config.strategyVersion !== strategy.version || !['testnet', 'mainnet'].includes(config.sourceNetwork)) conflict();
    const limits = await this.preparation(tx); this.checkBudget(config.budgetUsd, limits); await this.barriers(tx, userId);
    if (wire.settings.maxLeverage !== null && wire.settings.maxLeverage > limits.maxLeverage) conflict();
    const rows = await tx.select({ setup: copyAgentSetups, wallet: copyExecutionWallets, grant: copyWalletAuthorizations }).from(copyAgentSetups)
      .innerJoin(copyWalletAuthorizations, eq(copyWalletAuthorizations.id, copyAgentSetups.authorizationId))
      .innerJoin(copyExecutionWallets, eq(copyExecutionWallets.id, copyWalletAuthorizations.walletId))
      .where(and(eq(copyAgentSetups.accountId, accountId), eq(copyAgentSetups.state, 'active')));
    if (rows.length !== 1) conflict();
    const { setup, wallet, grant } = rows[0];
    if (setup.userId !== userId || setup.strategyId !== strategy.id || setup.network !== 'testnet' || setup.accountAddress !== account.address || setup.accountWalletId !== account.privyWalletId || setup.accountOwnerQuorumId !== account.ownerQuorumId ||
      wallet.userId !== userId || wallet.strategyId !== strategy.id || wallet.network !== 'testnet' || wallet.accountAddress !== account.address || wallet.privyWalletId !== setup.agentWalletId || wallet.privyOwnerId !== setup.agentOwnerQuorumId || wallet.signerAddress !== setup.agentAddress || wallet.privyOwnerId !== account.ownerQuorumId || wallet.retiredAt !== null ||
      grant.revokedAt !== null || grant.validFrom.getTime() > now || grant.expiresAt.getTime() <= now || !grant.exchangeApprovedAt || grant.exchangeApprovedAt.getTime() > now || setup.expiresAt?.getTime() !== grant.expiresAt.getTime() || !grant.scopes.includes('copy:trade') || !grant.scopes.includes('copy:reduce')) conflict();
    const binding = {
      accountId, userId, strategyId: strategy.id, strategyVersion: strategy.version, network: 'testnet' as const, sourceNetwork: config.sourceNetwork, leaderAddress: strategy.leaderAddress,
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
  async activate(tx: DbTransaction, row: MandateRow, signature: string, now: number) {
    if (row.state === 'active') return row;
    if (row.state !== 'prepared') conflict();
    await tx.update(copyStrategies).set({ status: 'paused', pauseNewRisk: true }).where(and(eq(copyStrategies.id, row.strategyId), eq(copyStrategies.userId, row.userId), eq(copyStrategies.mode, 'testnet')));
    const [updated] = await tx.update(copyLiveMandates).set({ state: 'active', consentDigest: digest(signature.toLowerCase()), activationCursor: new Date(now), revision: row.revision + 1, updatedAt: new Date(now) }).where(and(eq(copyLiveMandates.id, row.id), eq(copyLiveMandates.revision, row.revision), eq(copyLiveMandates.state, 'prepared'))).returning();
    if (!updated) conflict();
    // Awaiting its start: the worker starts trading this generation once it
    // is funded, and only while the strategy keeps this control revision.
    const [strategy] = await tx.select({ controlRevision: copyStrategies.controlRevision }).from(copyStrategies).where(eq(copyStrategies.id, row.strategyId));
    if (!strategy) conflict();
    await tx.insert(copyLiveActivations).values({ mandateId: row.id, userId: row.userId, strategyId: row.strategyId, accountId: row.accountId,
      state: 'pending', controlRevision: strategy.controlRevision, requestedAt: new Date(now) }).onConflictDoNothing();
    return updated;
  }
  async barrier(tx: DbTransaction, userId: number, id: string, state: 'paused' | 'revoked', clock: () => number) {
    const owner = await this.lock(tx, userId), row = await this.find(userId, id, tx, true);
    const now = clock();
    const [account] = await tx.select().from(copyExecutionAccounts).where(and(eq(copyExecutionAccounts.id, row.accountId), eq(copyExecutionAccounts.userId, userId)));
    const [strategy] = await tx.select().from(copyStrategies).where(and(eq(copyStrategies.id, row.strategyId), eq(copyStrategies.userId, userId), eq(copyStrategies.mode, 'testnet')));
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
  async recoverStrategy(tx: DbTransaction, userId: number, key: string) {
    const owner = await this.lock(tx, userId);
    const [config] = await tx.select().from(copyLiveStrategyConfigs).where(and(eq(copyLiveStrategyConfigs.userId, userId), eq(copyLiveStrategyConfigs.idempotencyKey, key)));
    if (!config) throw new NotFoundException('Strategy not found');
    const accounts = await tx.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.strategyId, config.strategyId));
    if (accounts.some(account => account.userId !== userId || account.network !== 'testnet' || account.privyUserId !== owner.privyUserId)) conflict();
    return this.strategyWire(config.strategyId, tx);
  }
  async recoverMandate(tx: DbTransaction, userId: number, lookup: { id: string } | { key: string }) {
    const owner = await this.lock(tx, userId);
    const [row] = await tx.select().from(copyLiveMandates).where(and(eq(copyLiveMandates.userId, userId), 'id' in lookup ? eq(copyLiveMandates.id, lookup.id) : eq(copyLiveMandates.idempotencyKey, lookup.key)));
    if (!row) throw new NotFoundException('Mandate not found');
    this.decode(row);
    const [account] = await tx.select().from(copyExecutionAccounts).where(and(eq(copyExecutionAccounts.id, row.accountId), eq(copyExecutionAccounts.userId, userId)));
    const [strategy] = await tx.select().from(copyStrategies).where(and(eq(copyStrategies.id, row.strategyId), eq(copyStrategies.userId, userId), eq(copyStrategies.mode, 'testnet')));
    if (!account || !strategy || account.strategyId !== row.strategyId || account.network !== row.network || account.address !== row.accountAddress ||
      account.privyUserId !== owner.privyUserId || row.ownerPrivyUserId !== owner.privyUserId || row.ownerAddress !== owner.embeddedWalletAddress) conflict();
    // Preserve original archived evidence. This read grants no authority and
    // deliberately does not demand an unexpired/current remote agent grant.
    return row;
  }
  async overview(userId: number) {
    await this.owner(userId);
    const configs = await this.db.select().from(copyLiveStrategyConfigs).where(eq(copyLiveStrategyConfigs.userId, userId));
    const rows = await this.db.select().from(copyLiveMandates).where(eq(copyLiveMandates.userId, userId));
    return { strategies: await Promise.all(configs.map(row => this.strategyWire(row.strategyId))), mandates: rows.map(row => this.wire(row)) };
  }
}
