import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { verifyTypedData, type TypedDataDefinition } from 'viem';
import { z } from 'zod';
import { confirmLiveCopySetupSchema, copyIdempotencyKeySchema, liveCopyBudgetSchema, liveCopySetupConsentTypedData, liveCopySetupIntentSchema, liveCopySetupSchema, liveSetupAgentName,
  startLiveCopySchema, copyStrategySettingsSchema, type LiveCopySetup, type LiveCopySetupIntent, type StartLiveCopy } from '@trading-dashboard/shared/contracts';
import { AppConfig } from '../config/app-config.js';
import { BackgroundJobs } from '../runtime/background-jobs.service.js';
import { outsideRequest } from '../runtime/request-context.js';
import { UnitOfWork, type DbTransaction } from '../db/unit-of-work.js';
import { CopyAccountModeService } from './copy-account-mode.service.js';
import { type LiveBudget } from '../hyperliquid/hyperliquid-budget-wait.js';
import { DEFAULT_LIVE_SETUP_TIMINGS, type LiveSetupTimings } from '../config/live-timings.js';
import { CopyAgentService } from './copy-agent.service.js';
import { CopyFundingExchangeClient } from './copy-funding-exchange.client.js';
import { CopyFundingRepository } from './copy-funding.repository.js';
import { CopyFundingService, wire as fundingWire } from './copy-funding.service.js';
import { liveCopySettingsDigest } from './copy-live-mandate-consent.js';
import { CopyLiveMandateRepository } from './copy-live-mandate.repository.js';
import { assertSetupAdmission } from './copy-live-setup-barrier.js';
import { CopyLiveSetupAbortService } from './copy-live-setup-abort.service.js';
import { CopyLiveReturnRepository } from './copy-live-return.repository.js';
import { CopyLiveSetupRepository, DRIVEN_STAGES, type SetupRow, type SetupStage } from './copy-live-setup.repository.js';
import { CopyWalletRepository } from './copy-wallet.repository.js';
import { CopyWalletService } from './copy-wallet.service.js';
import { safeErrorText } from '../runtime/safe-error-text.js';
import { WORKER_MASTER_SIGNER, type WorkerMasterSigner } from './live/privy-policy-master-signer.js';
import { deploymentNetwork, liveExecutionEnabled } from './live-deployment.js';
import { LeaderActivityService } from '../traders/leader-activity.service.js';
import { digest, input, refuse, type SetupContext, type SetupSigner } from './copy-live-setup-shared.js';
import { SetupDriver } from './copy-live-setup-driver.js';
import { SetupProvisioning } from './copy-live-setup-provisioning.js';
import { SETUP_LOCAL_BUDGET, SETUP_REST_CAPACITY, SetupSteps, type SetupRestCapacity } from './copy-live-setup-steps.js';

// What this file exported before it was split (2026-10-15): its callers' imports stay.
export { setupFundingKey, type SetupSigner } from './copy-live-setup-shared.js';
export { SETUP_CLAIM_LOG_EVERY_MS, SETUP_CLAIM_RENEW_MS, SETUP_LOCAL_BUDGET, SETUP_REST_CAPACITY, type SetupRestCapacity } from './copy-live-setup-steps.js';
export { AWAITING_CREDIT_ALERT_AFTER_MS, AWAITING_CREDIT_ALERT_EVERY_MS, AWAITING_CREDIT_MAX_WAIT_MS } from './copy-live-setup-driver.js';

const THROTTLED_STAGES: readonly SetupStage[] = ['funded', 'mode_set', 'agent_active'];
/** Stages a confirmed start reaches after its deposit's credit: the copy is
 * starting and is stopped like a running one, not cancelled. */
const PAST_FUNDING_STAGES: readonly SetupStage[] = ['funded', 'mode_set', 'agent_active', 'builder_ready', 'running'];
/** Why a start can't go on without the worker signer (the owner declined
 * Privy's addSigners, or it timed out): nothing was deposited. */
const WORKER_SIGNER_MISSING = 'Orbie needs to add its signer to run this copy. Nothing was deposited and the copy did not start.';
const editSchema = z.object({ idempotencyKey: copyIdempotencyKeySchema, budgetUsd: liveCopyBudgetSchema,
  settings: copyStrategySettingsSchema.strict().refine(value => value.sizingMode !== 'fixed' || value.perTradeUsd !== null).refine(value => value.copyStartMode === 'delta') }).strict();
const renewSchema = z.object({ idempotencyKey: copyIdempotencyKeySchema }).strict();
/** POST /advance takes no body: it only drives the setup now. */
const advanceSchema = z.object({}).strict();
/** What an edit request asks for (its idempotency key's payload). */
const editPayloadDigest = (change: { kind: string; strategyId: number; budgetUsd: string; settings: unknown }) =>
  digest({ kind: change.kind, strategyId: change.strategyId, budgetUsd: change.budgetUsd, settingsDigest: liveCopySettingsDigest(change.settings) });
/**
 * One-click copy on the deployment's network (docs/one-click-copy-plan-2026-10-05.md §2, §3a).
 *
 * start: a paused strategy, its copy wallet, a ready 30-day agent, the
 * reserved deposit and the owner-owned Privy policy, then ONE consent
 * challenge binding every term. confirm: the owner's browser has added the
 * worker as the account's policy-bound signer (Privy's addSigners: only the
 * owner can); the server checks that with Privy and records it, verifies the
 * consent once and submits the deposit. Without the signer nothing is
 * deposited (409 worker_signer_missing). The worker then signs every step,
 * credit → account mode → agent → (builder fee) → generation, resumable from
 * this row after a crash or a closed tab; each child operation keeps its own
 * never-resend state.
 */
@Injectable()
export class CopyLiveSetupService {
  private readonly logger = new Logger(CopyLiveSetupService.name);
  private readonly provisioning: SetupProvisioning;
  private readonly steps: SetupSteps;
  private readonly driver: SetupDriver;
  constructor(private readonly config: AppConfig, private readonly repository: CopyLiveSetupRepository, private readonly uow: UnitOfWork,
    private readonly mandates: CopyLiveMandateRepository, private readonly wallets: CopyWalletService, private readonly walletRows: CopyWalletRepository,
    private readonly agents: CopyAgentService, private readonly modes: CopyAccountModeService,
    private readonly funding: CopyFundingService, private readonly fundingRows: CopyFundingRepository,
    private readonly returns: CopyLiveReturnRepository, private readonly exchange: CopyFundingExchangeClient,
    @Optional() @Inject(WORKER_MASTER_SIGNER) private readonly workerSigner: WorkerMasterSigner | null = null,
    @Optional() private readonly now: () => number = Date.now,
    @Optional() @Inject(BackgroundJobs) private readonly jobs: BackgroundJobs | null = null,
    @Optional() @Inject(CopyLiveSetupAbortService) private readonly aborts: CopyLiveSetupAbortService | null = null,
    @Optional() @Inject(LeaderActivityService) private readonly leaderActivity: Pick<LeaderActivityService, 'copyActivity'> | null = null,
    @Optional() @Inject(SETUP_REST_CAPACITY) private readonly capacity: SetupRestCapacity | null = null,
    @Optional() @Inject(SETUP_LOCAL_BUDGET) private readonly setupBudget: LiveBudget | null = null)
  {
    // The parts share this service's repository, clock, network and logger
    // (copy-live-setup-shared.ts SetupContext); the pass drives through this
    // service's own `drive`, so a spy on it sees every drive.
    const ctx: SetupContext = { config, repository, now, network: () => this.network, logger: this.logger };
    this.provisioning = new SetupProvisioning(ctx, { wallets, agents, funding, fundingRows, mandates, walletRows, leaderActivity });
    this.steps = new SetupSteps(ctx, { modes, agents, returns, exchange, walletRows, mandates, uow, fundingRows, capacity, setupBudget });
    this.driver = new SetupDriver(ctx, { steps: this.steps, provisioning: this.provisioning, agents, aborts, capacity, workerSigner, walletRows }, { drive: (id, signer) => this.drive(id, signer) });
  }

  private available() {
    if (!liveExecutionEnabled(this.config) || !this.agents.available || !this.modes.available || !this.wallets.workerPolicyEnabled || !this.workerSigner?.available)
      refuse(503, 'setup_unavailable', 'Copying with real funds is not available right now');
  }
  private get network() { return deploymentNetwork(this.config); }
  /** The lease, step budget and retries (AppConfig.copy.live.setup). */
  private get timings(): LiveSetupTimings { return this.config.value.copy.live?.setup ?? DEFAULT_LIVE_SETUP_TIMINGS; }
  /** A live deployment's default leverage cap (COPY_LIVE_MAX_LEVERAGE) when the
   * owner set none, so the consent binds the leverage the copy really uses. */
  private liveSettings<T extends { maxLeverage: number | null }>(settings: T): T {
    const cap = this.config.value.copy.live?.caps.maxLeverage;
    return cap !== undefined && settings.maxLeverage === null ? { ...settings, maxLeverage: cap } : settings;
  }

  // --- read -------------------------------------------------------------------
  async wire(row: SetupRow): Promise<LiveCopySetup> {
    const abortRequested = await this.repository.aborted(row.userId, row.id);
    const fundingRow = row.fundingOperationId ? await this.fundingRows.find(row.userId, row.fundingOperationId).catch((error: unknown) => {
      this.logger.warn(`setup ${row.id} deposit not read: ${safeErrorText(error)}`); return null;
    }) : null;
    const awaiting = !abortRequested && row.stage === 'awaiting_consent' && row.intent && row.consentExpiresAt && row.consentExpiresAt.getTime() > this.now();
    return liveCopySetupSchema.parse({ id: row.id, kind: row.kind, strategyId: row.strategyId, accountId: row.accountId, leaderAddress: row.leaderAddress,
      sourceNetwork: row.sourceNetwork, budgetUsd: row.budgetUsd, settings: row.settings, stage: row.stage, issue: row.issue?.slice(0, 80) ?? null, abortRequested,
      consent: awaiting ? row.intent : null, funding: fundingRow ? fundingWire(fundingRow) : null, mandateId: row.mandateId,
      setupDeadline: row.setupDeadline?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
  }
  async get(userId: number, id: string) { await this.repository.owner(userId); return this.wire(await this.repository.find(userId, id)); }
  /** Read the original admission only: never provisions, renews consent or signs. */
  async recover(userId: number, key: string) {
    input(copyIdempotencyKeySchema, key);
    await this.repository.owner(userId);
    const row = await this.repository.byKey(userId, key);
    const strategy = row ? await this.repository.strategy(row.strategyId) : null;
    if (!row || !strategy || strategy.userId !== userId || strategy.network !== this.network) throw new NotFoundException('Setup not found');
    return this.wire(row);
  }
  async list(userId: number) {
    await this.repository.owner(userId);
    return { items: await Promise.all((await this.repository.list(userId)).map(row => this.wire(row))) };
  }

  // --- start ------------------------------------------------------------------
  /** Idempotent by key: a retry continues provisioning, and an expired
   * challenge is issued again (with a fresh deposit nonce if needed). */
  async start(userId: number, body: unknown): Promise<LiveCopySetup> {
    const parsed = input(startLiveCopySchema, body) as StartLiveCopy; this.available();
    const request = { ...parsed, settings: this.liveSettings(parsed.settings) };
    const owner = await this.repository.owner(userId);
    // Refused before anything is prepared; paper stays open to everyone.
    this.mandates.assertAllowed(owner.privyUserId);
    if (!owner.embeddedWalletAddress) refuse(409, 'setup_wallet_conflict', 'Your main wallet is not ready');
    let row = await this.repository.byKey(userId, request.idempotencyKey);
    if (!row) {
      if (request.sourceNetwork === 'mainnet') await this.provisioning.assertLeaderFits(request.leader);
      row = await this.uow.run(async tx => {
        await this.mandates.lock(tx, userId);
        const prior = await this.repository.byKey(userId, request.idempotencyKey, tx);
        if (prior) return prior;
        // A start for this leader that ended without a generation, or never
        // got its consent (the sheet closed, the page reloaded: its key is
        // gone), ends first instead of answering already_copying forever.
        for (const abandoned of await this.repository.abandonedStarts(tx, userId, request.leader, this.network)) await this.provisioning.endAbandoned(tx, abandoned);
        const strategy = await this.mandates.create(tx, userId, { idempotencyKey: request.idempotencyKey, leader: request.leader, sourceNetwork: request.sourceNetwork,
          budgetUsd: request.budgetUsd, settings: request.settings }, this.now);
        return this.repository.insert(tx, { id: randomUUID(), userId, strategyId: strategy.id, kind: 'start', idempotencyKey: request.idempotencyKey,
          leaderAddress: request.leader, sourceNetwork: request.sourceNetwork, budgetUsd: request.budgetUsd, settings: request.settings });
      });
    }
    const strategy = await this.repository.strategy(row.strategyId);
    if (!strategy || strategy.userId !== userId || strategy.network !== this.network) throw new NotFoundException('Setup not found');
    if (row.kind !== 'start' || row.leaderAddress !== request.leader || row.budgetUsd !== request.budgetUsd || row.sourceNetwork !== request.sourceNetwork ||
      liveCopySettingsDigest(row.settings) !== liveCopySettingsDigest(request.settings)) throw new ConflictException('Idempotency payload changed');
    if (row.stage === 'provisioning' || row.stage === 'awaiting_consent') return this.answer(row, () => this.provisioning.provisionLeased(row!.id));
    return this.wire(row);
  }

  // --- edit / renew -------------------------------------------------------------
  private async running(userId: number, strategyId: number, key: string) {
    const { found, mandate, agent } = await this.repository.runningCopy(userId, strategyId, this.network);
    if (!found) throw new NotFoundException('Copy not found');
    if (['stopping', 'stopped'].includes(found.strategy.status)) throw new ConflictException({ statusCode: 409, code: 'live_stop_in_progress', message: 'A stop is in progress for this copy' });
    if (!mandate) refuse(409, 'setup_unavailable', 'This copy has no running generation to change');
    if (!agent || !agent.agentAddress || !agent.policyId || !agent.policyFingerprint) refuse(409, 'setup_unavailable', 'This copy has no active agent');
    // An edit or renewal whose consent never came (the sheet closed, its key
    // is gone) gives way to the new one; a confirmed one still runs. One
    // made with this request's own key is this request's (a concurrent retry).
    let current = await this.repository.current(strategyId);
    if (current && current.kind !== 'start' && current.idempotencyKey !== key && ['provisioning', 'awaiting_consent'].includes(current.stage)) {
      const superseded = await this.repository.transition(current, { stage: 'cancelled', issue: null, nextAttemptAt: null });
      current = superseded ? null : await this.repository.current(strategyId);
    }
    return { ...found, mandate: mandate!, agent: agent!, current };
  }
  /** A new generation with new settings or budget, one silent signature (plan §4). */
  async startEdit(userId: number, strategyId: number, body: unknown): Promise<LiveCopySetup> {
    const parsed = input(editSchema, body); this.available();
    // Refused on mainnet (2026-10-07): an edit's new generation needs a
    // position baseline, and one is only taken on an account that never
    // traded (postgres-live-preparation assertFirstAccount), so it could
    // never trade and the copy would stop following. Stop and start again.
    if (this.network === 'mainnet') refuse(409, 'edit_unavailable', 'Editing a copy with real funds is not available yet. To change its settings or budget, stop this copy and start a new one.');
    const request = { ...parsed, settings: this.liveSettings(parsed.settings) };
    const payload = editPayloadDigest({ kind: 'edit', strategyId, budgetUsd: request.budgetUsd, settings: request.settings });
    const prior = await this.repository.byKey(userId, request.idempotencyKey);
    if (prior) return this.wire(await this.replayChange(prior, payload));
    const state = await this.running(userId, strategyId, request.idempotencyKey);
    if (state.current?.userId === userId && state.current.idempotencyKey === request.idempotencyKey) return this.wire(await this.replayChange(state.current, payload));
    if (state.current) throw new ConflictException({ statusCode: 409, code: 'setup_unavailable', message: 'A setup for this copy is still running' });
    this.mandates.assertAllowed((await this.repository.owner(userId)).privyUserId);
    // The budget (a top-up included) within the deployment's and the policy's caps.
    const limits = await this.mandates.preparation(this.repository.reader());
    this.mandates.checkBudget(request.budgetUsd, limits);
    this.mandates.assertSettings(request.settings);
    if (request.settings.maxLeverage !== null && request.settings.maxLeverage > limits.maxLeverage) throw new ConflictException({ statusCode: 409, code: 'leverage_above_limit', message: 'Leverage above the platform limit', limit: limits.maxLeverage });
    return this.wire(await this.change(userId, 'edit', state, request.idempotencyKey, request.budgetUsd, request.settings, payload));
  }
  /** The setup an earlier request with this key made: only for the same
   * payload (409 idempotency_conflict otherwise). */
  private async replayChange(prior: SetupRow, payload: string): Promise<SetupRow> {
    if (editPayloadDigest(prior) !== payload) refuse(409, 'idempotency_conflict', 'This request key was already used for a different change');
    return prior.stage === 'awaiting_consent' ? this.provisioning.rechallengeChange(prior) : prior;
  }
  /**
   * Renewal is refused for now (2026-10-07): the worker's policy binds the
   * exact agent the start consented to, so a new agent needs a new policy
   * added by the owner's browser (addSigners), which renewal doesn't do yet.
   */
  async startRenewal(_userId: number, _strategyId: number, body: unknown): Promise<LiveCopySetup> {
    input(renewSchema, body);
    return refuse(409, 'renewal_unavailable', 'Renewing a copy is not available yet. Stop this copy and start a new one before it ends.');
  }
  /** Inserted under the owner's lock: a concurrent request with the same
   * key replays (or conflicts) instead of failing on the unique index, and
   * a setup started meanwhile refuses this one. */
  private async change(userId: number, kind: 'edit', state: Awaited<ReturnType<CopyLiveSetupService['running']>>, key: string, budgetUsd: string, settings: unknown, payload: string): Promise<SetupRow> {
    const inserted = await this.uow.run(async tx => {
      await this.mandates.lock(tx, userId);
      const prior = await this.repository.byKey(userId, key, tx);
      if (prior) return { prior };
      if (await this.repository.current(state.strategy.id, tx)) refuse(409, 'setup_unavailable', 'A setup for this copy is still running');
      return { row: await this.repository.insert(tx, { id: randomUUID(), userId, strategyId: state.strategy.id, accountId: state.mandate.accountId, kind, idempotencyKey: key,
        leaderAddress: state.strategy.leaderAddress, sourceNetwork: state.config.sourceNetwork, budgetUsd, settings: settings as Record<string, unknown>, agentSetupId: state.agent.id }) };
    });
    return inserted.prior ? this.replayChange(inserted.prior, payload) : this.provisioning.rechallengeChange(inserted.row);
  }
  // --- confirm -----------------------------------------------------------------
  /** Records the worker signer the owner's browser added, verifies the one
   * consent, submits the deposit, and runs what it can. A start whose
   * account has no worker signer (addSigners declined or timed out) is
   * refused before anything is deposited; it can be confirmed again while
   * its consent lasts. */
  async confirm(userId: number, id: string, body: unknown): Promise<LiveCopySetup> {
    const request = input(confirmLiveCopySetupSchema, body); this.available();
    // Admission stays authenticated; only provider work leaves the request.
    this.mandates.assertAllowed((await this.repository.owner(userId)).privyUserId);
    const original = await this.repository.find(userId, id);
    if (original.stage !== 'awaiting_consent') return this.wire(original);
    return this.answer(original, async () => {
      // The worker's driver may hold the row for a moment: wait for it
      // rather than drop the owner's signatures (each dropped confirm cost
      // the owner another press and signature, Stage 2026-10-11).
      // Only a held lease is waited for (an abort's hold is final).
      let leased = await this.repository.lease(id, this.timings.leaseMs);
      for (const until = Date.now() + this.timings.confirmLeaseWaitMs; !leased && Date.now() < until;) {
        const current = await this.repository.find(userId, id);
        if (current.stage !== 'awaiting_consent' || !current.leaseToken) return current;
        await new Promise(resolve => setTimeout(resolve, 500));
        leased = await this.repository.lease(id, this.timings.leaseMs);
      }
      if (!leased) return this.repository.find(userId, id);
      let row: SetupRow;
      try { row = leased.stage === 'awaiting_consent' ? await this.confirmLeased(leased, request) : leased; }
      finally { await this.repository.release(id, leased.leaseToken); }
      return this.handOff(row);
    });
  }
  private async confirmLeased(original: SetupRow, request: z.infer<typeof confirmLiveCopySetupSchema>): Promise<SetupRow> {
    const userId = original.userId, id = original.id;
    let row = original;
    // A new explicit confirmation has its own uncertain outcome. Previous
    // evidence that nothing was sent must not describe this in-flight attempt.
    if (row.issue === 'funding_not_submitted') {
      const admitted = await this.repository.transition(row, { issue: null });
      if (!admitted) return this.repository.find(userId, id);
      row = admitted;
    }
    const parsed = liveCopySetupIntentSchema.safeParse(row.intent);
    if (!parsed.success || digest(parsed.data) !== row.intentDigest) throw new ConflictException('Setup binding changed');
    const intent = parsed.data, now = this.now();
    // The owner's browser added the worker as the copy account's signer
    // under the consented policy just before this request (Privy's
    // addSigners: only the owner can). Checked with Privy (exactly that
    // signer and policy) and recorded first, before any refusal below, so a
    // signer Privy shows is never left unrecorded on the account.
    const attached = row.kind === 'start' && intent.masterPolicyId !== '' && await this.wallets.attachSetupSigner(userId, intent.accountId,
      { id: intent.masterPolicyId, fingerprint: intent.masterPolicyFingerprint }, { address: intent.agentAddress, name: liveSetupAgentName(intent) });
    if (now < intent.nonce || now >= intent.consentExpiresAt) refuse(409, 'consent_expired', 'The setup consent expired; start again');
    const owner = await this.repository.owner(userId);
    if (owner.embeddedWalletAddress !== intent.ownerAddress || owner.privyUserId !== intent.ownerPrivyUserId) throw new ConflictException({ statusCode: 409, code: 'setup_wallet_conflict', message: 'Your main wallet changed' });
    let valid = false;
    try { valid = await verifyTypedData({ address: intent.ownerAddress as `0x${string}`, ...(liveCopySetupConsentTypedData(intent) as unknown as TypedDataDefinition), signature: request.consentSignature as `0x${string}` }); }
    catch (error) { this.logger.warn(`setup ${row.id} consent not verified: ${safeErrorText(error)}`); }
    if (!valid) throw new ForbiddenException({ statusCode: 403, code: 'invalid_consent', message: 'Invalid owner consent' });
    const consentDigest = digest(request.consentSignature.toLowerCase());
    await this.assertBinding(row, intent);
    const confirmed = { consentDigest, confirmedAt: new Date(now), setupDeadline: new Date(intent.setupDeadline), issue: null } as const;
    if (row.kind === 'start') {
      // No worker signer, no deposit: the copy could never run its steps.
      if (!attached) refuse(409, 'worker_signer_missing', WORKER_SIGNER_MISSING);
      if (!request.fundingSignature) throw new BadRequestException('The deposit signature is required');
      // Preserve the genuine owner's consent before any deposit attempt.
      // This records evidence only: confirmation/stage still follow the
      // original child outcome, and abort shares this admission's user lock.
      const evidenced = await this.uow.run(async tx => {
        await this.mandates.lock(tx, userId);
        await assertSetupAdmission(tx, userId, id);
        return this.repository.transition(row, { consentDigest }, tx);
      });
      if (!evidenced) return this.repository.find(userId, id);
      row = evidenced;
      await this.funding.claim(userId, intent.fundingOperationId, { liveSetupId: id });
      const submitted = await this.funding.submit(userId, intent.fundingOperationId, request.fundingSignature, { liveSetupId: id });
      const deposit = await this.fundingRows.find(userId, submitted.id);
      if (!deposit.attemptedAt) {
        // Not sent (busy or refused before the POST): the consent stays due.
        return (await this.repository.transition(row, { issue: 'funding_not_submitted' })) ?? row;
      }
      row = (await this.repository.transition(row, { ...confirmed, stage: deposit.status === 'rejected' ? 'failed' : 'funding_submitted', ...(deposit.status === 'rejected' ? { issue: 'setup_funding_rejected' } : {}) }))
        ?? await this.repository.find(userId, id);
    } else {
      row = (await this.repository.transition(row, { ...confirmed, stage: 'consented' })) ?? await this.repository.find(userId, id);
    }
    return row;
  }
  /** Everything the consent bound is still what the rows say. */
  private async assertBinding(row: SetupRow, intent: LiveCopySetupIntent) {
    const account = await this.walletRows.account(intent.accountId, row.userId);
    const agent = row.agentSetupId ? await this.agents.row(row.userId, row.agentSetupId) : null;
    const strategy = await this.repository.strategy(row.strategyId);
    if (!account || account.state !== 'ready' || account.address !== intent.accountAddress || row.accountId !== intent.accountId || !agent || agent.agentAddress !== intent.agentAddress ||
      agent.policyId !== intent.agentPolicyId || agent.policyFingerprint !== intent.agentPolicyFingerprint || agent.expiresAt.getTime() !== intent.agentValidUntil ||
      !strategy || ['stopping', 'stopped'].includes(strategy.status) || intent.strategyId !== row.strategyId) throw new ConflictException({ statusCode: 409, code: 'setup_wallet_conflict', message: 'The setup changed; start again' });
    if (row.kind === 'start') {
      const deposit = await this.fundingRows.find(row.userId, intent.fundingOperationId);
      if (deposit.id !== row.fundingOperationId || deposit.nonce !== intent.fundingNonce || deposit.amount !== intent.fundingAmount || deposit.destination !== intent.accountAddress ||
        deposit.address !== intent.ownerAddress) throw new ConflictException({ statusCode: 409, code: 'setup_wallet_conflict', message: 'The deposit changed; start again' });
    }
    const builder = await this.mandates.builder(this.repository.reader());
    if ((builder.builderAddress ?? null) !== intent.builderAddress || (builder.builderAddress ? builder.builderMaxFeeTenthsOfBps : 0) !== intent.builderMaxFeeTenthsOfBps)
      throw new ConflictException({ statusCode: 409, code: 'setup_builder_rejected', message: 'The builder fee changed; start again' });
  }

  /**
   * Drives a confirmed setup now (the worker's pass does the same on its
   * own): the next steps run with the worker's signer. Takes no body; a body
   * (the browser-signed path's `{ digest, signature }`) is refused 400.
   */
  async advance(userId: number, id: string, body: unknown = {}): Promise<LiveCopySetup> {
    if (!advanceSchema.safeParse(body ?? {}).success) throw new BadRequestException({ statusCode: 400, code: 'setup_advance_takes_no_signature', message: 'The worker signs every step; send no body' });
    const row = await this.repository.find(userId, id);
    if (!DRIVEN_STAGES.includes(row.stage)) return this.wire(row);
    return this.answer(row, async () => {
      // Reconciliation can wait for provider budget too: it belongs to
      // the detached lifecycle, not the request's deadline. It reads
      // Hyperliquid, so with API_SETUP_DRIVE=worker it is the copy worker's
      // (driveDue), on its egress, not the api's.
      if (this.config.value.app?.setupDrive !== 'worker') await this.reconcileDeposit(row);
      if (THROTTLED_STAGES.includes(row.stage) && row.nextAttemptAt && row.nextAttemptAt.getTime() > this.now()) return row;
      return this.handOff(row);
    });
  }
  /**
   * What confirm and advance do once the request's own work is recorded.
   * API_SETUP_DRIVE=local (default): drive the setup here, as before.
   * API_SETUP_DRIVE=worker: never drive in the api (its steps' Hyperliquid
   * calls and signatures belong to the copy worker's egress, and the
   * worker's read cache is then warm for the copy's first order, design
   * I-13): mark the setup due now and wake the copy worker
   * (NOTIFY copy_setup_due), which drives it at once (CopySetupDueListener);
   * its regular pass is the fallback. The answer is the current row, as
   * after `answerMs` today.
   */
  private async handOff(row: SetupRow): Promise<SetupRow> {
    if (this.config.value.app?.setupDrive !== 'worker') return this.drive(row.id, await this.driver.workerPolicySigner(row));
    if (!DRIVEN_STAGES.includes(row.stage)) return row;
    const due = await this.repository.markDue(row.id);
    try { await this.repository.notifyDue(row.id); }
    catch (error) { this.logger.warn(`setup ${row.id} wake-up not sent; the worker's pass drives it: ${safeErrorText(error)}`); }
    return due ?? row;
  }
  /**
   * The copy worker's wake-up for one setup (CopySetupDueListener): drives
   * it now if it is still a confirmed, unfinished setup on this deployment's
   * network. The setup's lease keeps this and the regular pass from driving
   * it at once; an aborted setup is never leased.
   */
  async driveDue(id: string): Promise<SetupRow | null> {
    const row = await this.repository.get(id);
    if (!row || !DRIVEN_STAGES.includes(row.stage)) return row;
    // The deposit reconcile advance did in the api before (API_SETUP_DRIVE=local).
    await this.reconcileDeposit(row);
    return this.drive(row.id, await this.driver.workerPolicySigner(row));
  }
  /** A setup awaiting its deposit's credit looks for it now (a Hyperliquid read). */
  private async reconcileDeposit(row: SetupRow): Promise<void> {
    if (!row.fundingOperationId || row.stage !== 'funding_submitted') return;
    await this.funding.reconcile(row.userId, row.fundingOperationId).catch((error: unknown) => this.logger.warn(`setup ${row.id} deposit not reconciled: ${safeErrorText(error)}`));
  }
  /** Quick work returns its result; slow work keeps the same id outside the
   * request and answers once with its current row. Fast validation errors
   * retain their existing HTTP contract. */
  private async answer(row: SetupRow, work: () => Promise<SetupRow>): Promise<LiveCopySetup> {
    const running = this.detached(work);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([running,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), this.timings.answerMs); })]).finally(() => clearTimeout(timer));
    return this.wire(result ?? await this.repository.find(row.userId, row.id));
  }
  /** Work that outlives the request that started it (drained on shutdown). */
  private detached<T>(work: () => Promise<T>): Promise<T> {
    const running = this.jobs ? this.jobs.run(work) : outsideRequest(() => Promise.resolve().then(work));
    void running.catch((error: unknown) => this.logger.warn(`setup drive kept for a retry: ${safeErrorText(error)}`));
    return running;
  }
  /**
   * Ends a setup that is not running a step: before its consent (the
   * reserved deposit is cancelled), or once it failed or expired. A start
   * ends with its paused strategy stopped when no generation ever ran; a
   * deposit that already arrived stays in the copy account and is returned
   * to the main wallet from the portfolio.
   *
   * A confirmed start whose deposit was sent and is awaiting its credit
   * (funding_submitted) is cancelled and refunded: the setup enters the
   * setup abort (its durable barrier: no step, mandate or activation after
   * it), whose worker returns everything the copy account holds to the
   * owner's main wallet (the consent's sweepDestination), proven from the
   * account's own state, never from the explorer. A CAS on the setup's
   * revision under the owner's lock: a driver that already moved it past
   * funding wins, and the cancel is refused 409 setup_past_funding (stop
   * the copy instead). Any other confirmed setup still going can't be
   * cancelled (409 funding_pending).
   */
  async cancel(userId: number, id: string): Promise<LiveCopySetup> {
    const next = await this.uow.run(async tx => {
      // The same fence as funding.beginSubmit: check attempt admission after
      // acquiring it, not on a stale row before waiting for the lock.
      await this.mandates.lock(tx, userId);
      const row = await this.repository.find(userId, id, tx);
      if (row.stage === 'cancelled') return row;
      if (await this.repository.aborted(userId, id, tx)) return row;
      if (PAST_FUNDING_STAGES.includes(row.stage) || row.mandateId || await this.repository.hasMandate(id, tx))
        throw new ConflictException({ statusCode: 409, code: 'setup_past_funding', message: 'This copy is already starting: stop it once it runs to get your funds back' });
      if (row.stage === 'funding_submitted' && row.kind === 'start') return this.cancelFunding(tx, row);
      const unconfirmed = ['provisioning', 'awaiting_consent'].includes(row.stage), ended = ['failed', 'expired'].includes(row.stage);
      if (!unconfirmed && !ended || unconfirmed && row.fundingOperationId && await this.repository.fundingAttempted(userId, row.fundingOperationId, tx))
        throw new ConflictException({ statusCode: 409, code: 'funding_pending', message: 'The deposit was already sent' });
      const updated = await this.repository.transition(row, { stage: 'cancelled', nextAttemptAt: null, ...(unconfirmed ? { issue: null } : {}) }, tx);
      if (!updated) throw new ConflictException({ statusCode: 409, code: 'setup_changed', message: 'The setup changed; refresh it' });
      if (row.kind === 'start') await this.repository.endStart(tx, userId, row);
      return updated;
    });
    return this.wire(next);
  }
  /** cancel's funding_submitted branch, under the owner's lock with the
   * setup row locked: the revision CAS fences every driver (its own
   * transitions are CAS on the revision and refused once the abort exists),
   * then the abort is admitted in the same transaction. */
  private async cancelFunding(tx: DbTransaction, row: SetupRow): Promise<SetupRow> {
    if (!this.aborts) throw new ServiceUnavailableException({ statusCode: 503, code: 'setup_abort_unavailable', message: 'Cancelling a confirmed setup is not available right now' });
    const fenced = await this.repository.transition(row, { nextAttemptAt: null }, tx);
    if (!fenced) throw new ConflictException({ statusCode: 409, code: 'setup_changed', message: 'The setup changed; refresh it' });
    await this.aborts.requestIn(tx, row.userId, row.id, `cancel-${row.id}`);
    return this.repository.find(row.userId, row.id, tx);
  }

  // --- the driver (copy-live-setup-driver.ts) --------------------------------------
  /** The worker's pass: every confirmed, unfinished setup that is due. */
  async tick(): Promise<number> { return this.driver.tick(); }
  /**
   * Advances one setup as far as it can go now, under a lease. Steps that
   * need a signature run only with the worker's signer; without one the
   * setup waits (`worker_signer_unavailable`) until its deadline.
   */
  async drive(id: string, signer: SetupSigner | null): Promise<SetupRow> { return this.driver.drive(id, signer); }
}
