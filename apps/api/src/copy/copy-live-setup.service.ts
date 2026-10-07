import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { verifyTypedData, type TypedDataDefinition } from 'viem';
import { z } from 'zod';
import { agentApprovalTypedData, approveBuilderFeeRequest, approveBuilderFeeTypedData, confirmLiveCopySetupSchema, copyIdempotencyKeySchema, liveCopyBudgetSchema, liveCopySetupConsentTypedData,
  liveCopySetupIntentSchema, liveCopySetupSchema, liveSetupAgentName, startLiveCopySchema, copyStrategySettingsSchema, userSetAbstractionTypedData, LIVE_SETUP_CONSENT_WINDOW_MS, LIVE_SETUP_DEADLINE_MS, LIVE_SETUP_VALID_DAYS,
  WALLET_NETWORKS, type LiveCopySetup, type WalletNetwork, type LiveCopySetupIntent, type LiveCopySetupKind, type StartLiveCopy } from '@trading-dashboard/shared/contracts';
import { AppConfig } from '../config/app-config.js';
import { BackgroundJobs } from '../runtime/background-jobs.service.js';
import { outsideRequest } from '../runtime/request-context.js';
import { UnitOfWork, type DbExecutor } from '../db/unit-of-work.js';
import { CopyAccountModeService } from './copy-account-mode.service.js';
import { HyperliquidBudgetWait, SHARED_CAPACITY_RETRY_MS } from '../hyperliquid/hyperliquid-budget-wait.js';
import { LiveBoundaryError } from './live/wallet-authorization.js';
import { CopyAgentService } from './copy-agent.service.js';
import { CopyFundingExchangeClient } from './copy-funding-exchange.client.js';
import { CopyFundingRepository } from './copy-funding.repository.js';
import { CopyFundingService, wire as fundingWire } from './copy-funding.service.js';
import { liveCopySettingsDigest } from './copy-live-mandate-consent.js';
import { CopyLiveMandateRepository } from './copy-live-mandate.repository.js';
import { CopyLiveReturnRepository } from './copy-live-return.repository.js';
import { CopyLiveSetupRepository, DRIVEN_STAGES, type SetupRow, type SetupStage } from './copy-live-setup.repository.js';
import { CopyWalletRepository } from './copy-wallet.repository.js';
import { CopyWalletService } from './copy-wallet.service.js';
import type { MasterAccount, MasterActionBound, MasterTypedData } from './live/master-action.js';
import { safeErrorText } from '../runtime/safe-error-text.js';
import { WORKER_MASTER_SIGNER, type WorkerMasterSigner } from './live/privy-policy-master-signer.js';
import { deploymentNetwork, liveExecutionEnabled } from './live-deployment.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const LEASE_MS = 60_000;
/** How long after its setup ended an approval left unknown is still looked at. */
const ABANDONED_APPROVAL_WINDOW_MS = 3 * 86_400_000;
/** How long /advance waits for its drive before answering with the row. */
const ADVANCE_ANSWER_MS = 10_000;
const THROTTLED_STAGES: readonly SetupStage[] = ['funded', 'mode_set', 'agent_active'];
/** Every step after confirm is signed by the worker under the owner's Privy
 * policy (the one signing model, 2026-10-07), with exactly the payload the
 * consent bound; the owner's browser signs nothing after confirm. */
export interface SetupSigner {
  sign(account: MasterAccount, data: MasterTypedData, bound: MasterActionBound, deadline: number): Promise<string>;
}
/** Why a start can't go on without the worker signer (the owner declined
 * Privy's addSigners, or it timed out): nothing was deposited. */
const WORKER_SIGNER_MISSING = 'Orbie needs to add its signer to run this copy. Nothing was deposited and the copy did not start.';
/** Failures that are the deadline passing (the setup ends `expired`). */
const EXPIRED_ISSUES: readonly string[] = ['setup_expired', 'setup_deposit_uncredited'];
/** A step can't go on yet (a lookup is pending, or a signature is due). */
class Wait extends Error { constructor(readonly issue: string, readonly retryMs = 3_000) { super(issue); } }
/** The setup cannot finish; the owner sees the code. */
class Fail extends Error { constructor(readonly issue: string) { super(issue); } }

const editSchema = z.object({ idempotencyKey: copyIdempotencyKeySchema, budgetUsd: liveCopyBudgetSchema,
  settings: copyStrategySettingsSchema.strict().refine(value => value.sizingMode !== 'fixed' || value.perTradeUsd !== null).refine(value => value.copyStartMode === 'delta') }).strict();
const renewSchema = z.object({ idempotencyKey: copyIdempotencyKeySchema }).strict();
/** POST /advance takes no body: it only drives the setup now. */
const advanceSchema = z.object({}).strict();
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Invalid setup request');
  return structuredClone(parsed.data);
}
const refuse = (status: 409 | 503, code: string, message: string): never => {
  throw status === 409 ? new ConflictException({ statusCode: 409, code, message }) : new ServiceUnavailableException({ statusCode: 503, code, message });
};
/** The UserSetAbstraction the copy account signs for this mode nonce. */
const modeTypedData = (intent: { network: WalletNetwork; accountAddress: string; nonce: number }) =>
  userSetAbstractionTypedData(WALLET_NETWORKS[intent.network], intent.accountAddress, intent.nonce) as unknown as MasterTypedData;

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
  constructor(private readonly config: AppConfig, private readonly repository: CopyLiveSetupRepository, private readonly uow: UnitOfWork,
    private readonly mandates: CopyLiveMandateRepository, private readonly wallets: CopyWalletService, private readonly walletRows: CopyWalletRepository,
    private readonly agents: CopyAgentService, private readonly modes: CopyAccountModeService,
    private readonly funding: CopyFundingService, private readonly fundingRows: CopyFundingRepository,
    private readonly returns: CopyLiveReturnRepository, private readonly exchange: CopyFundingExchangeClient,
    @Optional() @Inject(WORKER_MASTER_SIGNER) private readonly workerSigner: WorkerMasterSigner | null = null,
    @Optional() private readonly now: () => number = Date.now,
    @Optional() private readonly jobs: BackgroundJobs | null = null) {}

  private available() {
    if (!liveExecutionEnabled(this.config) || !this.agents.available || !this.modes.available || !this.wallets.workerPolicyEnabled || !this.workerSigner?.available)
      refuse(503, 'setup_unavailable', 'Copying with real funds is not available right now');
  }
  private get network() { return deploymentNetwork(this.config); }
  /** A live deployment's default leverage cap (COPY_LIVE_MAX_LEVERAGE) when the
   * owner set none, so the consent binds the leverage the copy really uses. */
  private liveSettings<T extends { maxLeverage: number | null }>(settings: T): T {
    const cap = this.config.value.copy.live?.caps.maxLeverage;
    return cap !== undefined && settings.maxLeverage === null ? { ...settings, maxLeverage: cap } : settings;
  }

  // --- read -------------------------------------------------------------------
  async wire(row: SetupRow): Promise<LiveCopySetup> {
    const fundingRow = row.fundingOperationId ? await this.fundingRows.find(row.userId, row.fundingOperationId).catch((error: unknown) => {
      this.logger.warn(`setup ${row.id} deposit not read: ${safeErrorText(error)}`); return null;
    }) : null;
    const awaiting = row.stage === 'awaiting_consent' && row.intent && row.consentExpiresAt && row.consentExpiresAt.getTime() > this.now();
    return liveCopySetupSchema.parse({ id: row.id, kind: row.kind, strategyId: row.strategyId, accountId: row.accountId, leaderAddress: row.leaderAddress,
      sourceNetwork: row.sourceNetwork, budgetUsd: row.budgetUsd, settings: row.settings, stage: row.stage, issue: row.issue?.slice(0, 80) ?? null,
      consent: awaiting ? row.intent : null, funding: fundingRow ? fundingWire(fundingRow) : null, mandateId: row.mandateId,
      setupDeadline: row.setupDeadline?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
  }
  async get(userId: number, id: string) { await this.repository.owner(userId); return this.wire(await this.repository.find(userId, id)); }
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
      row = await this.uow.run(async tx => {
        await this.mandates.lock(tx, userId);
        const prior = await this.repository.byKey(userId, request.idempotencyKey, tx);
        if (prior) return prior;
        // A start for this leader that ended without a generation, or never
        // got its consent (the sheet closed, the page reloaded: its key is
        // gone), ends first instead of answering already_copying forever.
        for (const abandoned of await this.repository.abandonedStarts(tx, userId, request.leader, this.network)) await this.endAbandoned(tx, abandoned);
        const strategy = await this.mandates.create(tx, userId, { idempotencyKey: request.idempotencyKey, leader: request.leader, sourceNetwork: request.sourceNetwork,
          budgetUsd: request.budgetUsd, settings: request.settings }, this.now);
        return this.repository.insert(tx, { id: randomUUID(), userId, strategyId: strategy.id, kind: 'start', idempotencyKey: request.idempotencyKey,
          leaderAddress: request.leader, sourceNetwork: request.sourceNetwork, budgetUsd: request.budgetUsd, settings: request.settings });
      });
    }
    if (row.kind !== 'start' || row.leaderAddress !== request.leader || row.budgetUsd !== request.budgetUsd || row.sourceNetwork !== request.sourceNetwork ||
      liveCopySettingsDigest(row.settings) !== liveCopySettingsDigest(request.settings)) throw new ConflictException('Idempotency payload changed');
    if (row.stage === 'provisioning' || row.stage === 'awaiting_consent') row = await this.provision(row);
    return this.wire(row);
  }

  /** Provider-only preparation, none of which needs a consent: the copy
   * wallet, the agent (policy + wallet, ready), the deposit reservation and
   * the worker's policy; then the consent challenge. No challenge without the
   * policy: the worker signs every step after confirm. */
  private async provision(original: SetupRow): Promise<SetupRow> {
    let row = original;
    const userId = row.userId;
    if (row.stage === 'awaiting_consent' && row.consentExpiresAt && row.consentExpiresAt.getTime() > this.now() + 30_000) return row;
    const step = async (changes: Partial<SetupRow>) => { row = (await this.repository.transition(row, changes)) ?? await this.repository.find(userId, row.id); };
    try {
      // 1. The copy wallet (one per strategy).
      if (!row.accountId) {
        const account = await this.wallets.prepare(userId, row.strategyId, { network: this.network });
        await step({ accountId: account.id });
      }
      const account = await this.wallets.reconcile(userId, row.accountId!);
      if (account.state === 'blocked') throw new Fail('setup_wallet_conflict');
      if (account.state !== 'ready' || !account.address) throw new Wait('wallet_verification_pending');
      // 2. The agent, ready to approve (no exchange call).
      if (!row.agentSetupId) {
        const agent = await this.agents.prepareForSetup(userId, row.accountId!, `setup:${row.id}`, row.id, LIVE_SETUP_VALID_DAYS);
        await step({ agentSetupId: agent.id });
      }
      let agent = await this.agents.row(userId, row.agentSetupId!);
      if (agent.state !== 'ready') { await this.agents.reconcile(userId, agent.id); agent = await this.agents.row(userId, agent.id); }
      if (agent.state === 'blocked' || agent.state === 'revoked') throw new Fail('setup_agent_rejected');
      if (agent.state !== 'ready' || !agent.agentAddress || !agent.policyId || !agent.policyFingerprint) throw new Wait('agent_preparation_pending');
      // 3. The deposit, reserved (the main wallet signs it with the consent).
      let deposit = row.fundingOperationId ? await this.fundingRows.find(userId, row.fundingOperationId) : null;
      if (deposit && (deposit.status !== 'prepared' || deposit.attemptedAt)) {
        if (deposit.status === 'cancelled') deposit = null; else throw new Fail('setup_funding_rejected');
      }
      // A reserved deposit's nonce stays valid for two days: reserve a new one before that.
      if (deposit && this.now() - deposit.nonce > 86_400_000) { await this.fundingRows.cancel(userId, deposit.id); deposit = null; }
      if (!deposit) {
        const reserved = await this.funding.reserve(userId, row.accountId!, { idempotencyKey: randomUUID(), amount: row.budgetUsd });
        await this.repository.tagFunding(reserved.id, row.id);
        deposit = await this.fundingRows.find(userId, reserved.id);
        await step({ fundingOperationId: deposit.id });
      }
      // 4. The worker's policy (owned by the owner), bound into the consent.
      const agentBinding = { address: agent.agentAddress, name: liveSetupAgentName({ strategyId: row.strategyId, agentValidUntil: agent.expiresAt.getTime() }) };
      const previous = row.intent ? liveCopySetupIntentSchema.safeParse(row.intent) : null;
      const policy = previous?.success && previous.data.masterPolicyId ? { id: previous.data.masterPolicyId, fingerprint: previous.data.masterPolicyFingerprint }
        : await this.wallets.prepareSetupPolicy(userId, row.accountId!, agentBinding, `master_setup_${row.id.replaceAll('-', '')}`);
      if (!policy) throw new Wait('worker_policy_pending');
      // 5. The challenge.
      return await this.challenge(row, { accountAddress: account.address, agent: { address: agent.agentAddress, policyId: agent.policyId, fingerprint: agent.policyFingerprint, workerQuorumId: agent.workerQuorumId,
        validUntil: agent.expiresAt.getTime() }, policy, deposit: { id: deposit.id, nonce: deposit.nonce, amount: deposit.amount } });
    } catch (error) {
      if (error instanceof Wait) { await step({ issue: error.issue }); return row; }
      if (error instanceof Fail) { await step({ stage: 'failed', issue: error.issue }); return row; }
      if (error instanceof HttpException) {
        const response = error.getResponse(), code = typeof response === 'object' && response && 'code' in response && typeof response.code === 'string' ? response.code : null;
        await step({ issue: code ?? 'setup_preparation_pending' });
        throw error;
      }
      this.logger.warn(`setup ${row.id} preparation kept for a retry: ${safeErrorText(error)}`);
      await step({ issue: 'setup_preparation_pending' });
      return row;
    }
  }

  private async challenge(row: SetupRow, parts: { accountAddress: string; agent: { address: string; policyId: string; fingerprint: string; workerQuorumId: string; validUntil: number };
    policy: { id: string; fingerprint: string } | null; deposit: { id: string; nonce: number; amount: string } | null }): Promise<SetupRow> {
    const owner = await this.repository.owner(row.userId), builder = await this.mandates.builder(this.repository.reader());
    const nonce = this.now(), consentExpiresAt = nonce + LIVE_SETUP_CONSENT_WINDOW_MS;
    const setupDeadline = Math.min(nonce + LIVE_SETUP_DEADLINE_MS, parts.agent.validUntil);
    if (setupDeadline <= consentExpiresAt) throw new Fail('agent_expired');
    const intent = liveCopySetupIntentSchema.parse({ kind: row.kind, setupId: row.id, userId: row.userId, ownerAddress: owner.embeddedWalletAddress, ownerPrivyUserId: owner.privyUserId,
      strategyId: row.strategyId, leaderAddress: row.leaderAddress, sourceNetwork: row.sourceNetwork, network: this.network, budgetUsd: row.budgetUsd,
      settingsDigest: liveCopySettingsDigest(row.settings), accountId: row.accountId, accountAddress: parts.accountAddress, accountAbstraction: 'disabled',
      agentAddress: parts.agent.address, agentPolicyId: parts.agent.policyId, agentPolicyFingerprint: parts.agent.fingerprint, workerQuorumId: parts.agent.workerQuorumId,
      agentValidUntil: parts.agent.validUntil, builderAddress: builder.builderAddress, builderMaxFeeTenthsOfBps: builder.builderAddress ? builder.builderMaxFeeTenthsOfBps : 0,
      sweepDestination: owner.embeddedWalletAddress, masterPolicyId: parts.policy?.id ?? '', masterPolicyFingerprint: parts.policy?.fingerprint ?? '',
      fundingOperationId: parts.deposit?.id ?? '', fundingNonce: parts.deposit?.nonce ?? 0, fundingAmount: parts.deposit?.amount ?? '0',
      nonce, consentExpiresAt, setupDeadline });
    const next = await this.repository.transition(row, { stage: 'awaiting_consent', intent, intentDigest: digest(intent), consentExpiresAt: new Date(consentExpiresAt), issue: null });
    return next ?? this.repository.find(row.userId, row.id);
  }

  /** Ends a start whose consent never came or that ended without a
   * generation (one never-sent deposit cancelled, its strategy stopped). A
   * deposit already sent stays with its setup (that setup is still going). */
  private async endAbandoned(tx: DbExecutor, row: SetupRow): Promise<void> {
    if (['provisioning', 'awaiting_consent'].includes(row.stage) && row.fundingOperationId) {
      const deposit = await this.fundingRows.find(row.userId, row.fundingOperationId);
      if (deposit.attemptedAt) return;
    }
    const ended = await this.repository.transition(row, { stage: 'cancelled', nextAttemptAt: null, ...(['provisioning', 'awaiting_consent'].includes(row.stage) ? { issue: null } : {}) }, tx);
    if (ended) await this.repository.endStart(tx, row.userId, row);
  }

  // --- edit / renew -------------------------------------------------------------
  private async running(userId: number, strategyId: number) {
    const { found, mandate, agent } = await this.repository.runningCopy(userId, strategyId, this.network);
    if (!found) throw new NotFoundException('Copy not found');
    if (['stopping', 'stopped'].includes(found.strategy.status)) throw new ConflictException({ statusCode: 409, code: 'live_stop_in_progress', message: 'A stop is in progress for this copy' });
    if (!mandate) refuse(409, 'setup_unavailable', 'This copy has no running generation to change');
    if (!agent || !agent.agentAddress || !agent.policyId || !agent.policyFingerprint) refuse(409, 'setup_unavailable', 'This copy has no active agent');
    // An edit or renewal whose consent never came (the sheet closed, its key
    // is gone) gives way to the new one; a confirmed one still runs.
    let current = await this.repository.current(strategyId);
    if (current && current.kind !== 'start' && ['provisioning', 'awaiting_consent'].includes(current.stage)) {
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
    const prior = await this.repository.byKey(userId, request.idempotencyKey);
    if (prior) return this.wire(prior.stage === 'awaiting_consent' ? await this.rechallengeChange(prior) : prior);
    const state = await this.running(userId, strategyId);
    if (state.current) throw new ConflictException({ statusCode: 409, code: 'setup_unavailable', message: 'A setup for this copy is still running' });
    this.mandates.assertAllowed((await this.repository.owner(userId)).privyUserId);
    // The budget (a top-up included) within the deployment's and the policy's caps.
    const limits = await this.mandates.preparation(this.repository.reader());
    this.mandates.checkBudget(request.budgetUsd, limits);
    this.mandates.assertSettings(request.settings);
    if (request.settings.maxLeverage !== null && request.settings.maxLeverage > limits.maxLeverage) throw new ConflictException({ statusCode: 409, code: 'leverage_above_limit', message: 'Leverage above the platform limit', limit: limits.maxLeverage });
    return this.wire(await this.change(userId, 'edit', state, request.idempotencyKey, request.budgetUsd, request.settings));
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
  private async change(userId: number, kind: 'edit', state: Awaited<ReturnType<CopyLiveSetupService['running']>>, key: string, budgetUsd: string, settings: unknown): Promise<SetupRow> {
    const row = await this.repository.insert(this.repository.reader(), { id: randomUUID(), userId, strategyId: state.strategy.id, accountId: state.mandate.accountId, kind, idempotencyKey: key,
      leaderAddress: state.strategy.leaderAddress, sourceNetwork: state.config.sourceNetwork, budgetUsd, settings: settings as Record<string, unknown>, agentSetupId: state.agent.id });
    return this.rechallengeChange(row);
  }
  private async rechallengeChange(original: SetupRow): Promise<SetupRow> {
    let row = original;
    if (row.stage === 'awaiting_consent' && row.consentExpiresAt && row.consentExpiresAt.getTime() > this.now() + 30_000) return row;
    try {
      if (row.kind === 'renewal') throw new Fail('renewal_unavailable');
      const account = (await this.walletRows.account(row.accountId!, row.userId))!;
      let agent = await this.agents.row(row.userId, row.agentSetupId!);
      if (agent.state !== 'ready' && agent.state !== 'active') { await this.agents.reconcile(row.userId, agent.id); agent = await this.agents.row(row.userId, agent.id); }
      if (agent.state === 'blocked' || agent.state === 'revoked') throw new Fail('setup_agent_rejected');
      if (!['ready', 'active'].includes(agent.state) || !agent.agentAddress || !agent.policyId || !agent.policyFingerprint) throw new Wait('agent_preparation_pending');
      const policy = account.masterPolicyId && account.masterPolicyFingerprint ? { id: account.masterPolicyId, fingerprint: account.masterPolicyFingerprint } : null;
      return await this.challenge(row, { accountAddress: account.address!, agent: { address: agent.agentAddress, policyId: agent.policyId, fingerprint: agent.policyFingerprint,
        workerQuorumId: agent.workerQuorumId, validUntil: agent.expiresAt.getTime() }, policy, deposit: null });
    } catch (error) {
      if (error instanceof Wait) return (await this.repository.transition(row, { issue: error.issue })) ?? row;
      if (error instanceof Fail) return (await this.repository.transition(row, { stage: 'failed', issue: error.issue })) ?? row;
      throw error;
    }
  }

  // --- confirm -----------------------------------------------------------------
  /** Records the worker signer the owner's browser added, verifies the one
   * consent, submits the deposit, and runs what it can. A start whose
   * account has no worker signer (addSigners declined or timed out) is
   * refused before anything is deposited; it can be confirmed again while
   * its consent lasts. */
  async confirm(userId: number, id: string, body: unknown): Promise<LiveCopySetup> {
    const request = input(confirmLiveCopySetupSchema, body); this.available();
    // Only a listed owner confirms (and deposits into) an actual copy (security review).
    this.mandates.assertAllowed((await this.repository.owner(userId)).privyUserId);
    let row = await this.repository.find(userId, id);
    if (row.stage !== 'awaiting_consent') return this.wire(row);
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
      await this.funding.claim(userId, intent.fundingOperationId);
      const submitted = await this.funding.submit(userId, intent.fundingOperationId, request.fundingSignature);
      const deposit = await this.fundingRows.find(userId, submitted.id);
      if (!deposit.attemptedAt) {
        // Not sent (busy or refused before the POST): the consent stays due.
        return this.wire((await this.repository.transition(row, { issue: 'funding_not_submitted' })) ?? row);
      }
      row = (await this.repository.transition(row, { ...confirmed, stage: deposit.status === 'rejected' ? 'failed' : 'funding_submitted', ...(deposit.status === 'rejected' ? { issue: 'setup_funding_rejected' } : {}) }))
        ?? await this.repository.find(userId, id);
    } else {
      row = (await this.repository.transition(row, { ...confirmed, stage: 'consented' })) ?? await this.repository.find(userId, id);
    }
    return this.wire(await this.drive(row.id, await this.workerPolicySigner(row)));
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
    if (row.fundingOperationId && row.stage === 'funding_submitted') {
      // Only a read: a failed look leaves the deposit for the monitor's next one.
      await this.funding.reconcile(userId, row.fundingOperationId).catch((error: unknown) => this.logger.warn(`setup ${row.id} deposit not reconciled: ${safeErrorText(error)}`));
    }
    if (!DRIVEN_STAGES.includes(row.stage)) return this.wire(row);
    // A step that said when to come back (a pending observation, a busy
    // Hyperliquid budget) is not run sooner.
    if (THROTTLED_STAGES.includes(row.stage) && row.nextAttemptAt && row.nextAttemptAt.getTime() > this.now()) return this.wire(row);
    // The drive runs outside this request (its lease keeps it single): a
    // step can outlast the 20 s request deadline (budget waits, a POST and
    // its reconcile), and must neither be cut off by the deadline nor answer
    // with a 504 while it goes on. The caller gets the drive's result when
    // it is quick, else the row as it is, and polls.
    const driving = this.detached(async () => this.drive(row.id, await this.workerPolicySigner(row)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const driven = await Promise.race([driving.catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ADVANCE_ANSWER_MS); })]).finally(() => clearTimeout(timer));
    return this.wire(driven ?? await this.repository.find(userId, id));
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
   * to the main wallet from the portfolio. A confirmed setup still going
   * (the deposit sent, a step in flight) can't be cancelled.
   */
  async cancel(userId: number, id: string): Promise<LiveCopySetup> {
    const row = await this.repository.find(userId, id);
    if (row.stage === 'cancelled') return this.wire(row);
    const unconfirmed = ['provisioning', 'awaiting_consent'].includes(row.stage), ended = ['failed', 'expired'].includes(row.stage);
    if (!unconfirmed && !ended) throw new ConflictException({ statusCode: 409, code: 'funding_pending', message: 'The deposit was already sent' });
    if (unconfirmed && row.fundingOperationId) {
      const deposit = await this.fundingRows.find(userId, row.fundingOperationId);
      if (deposit.attemptedAt) throw new ConflictException({ statusCode: 409, code: 'funding_pending', message: 'The deposit was already sent' });
    }
    const next = await this.uow.run(async tx => {
      if (row.kind === 'start') await this.mandates.lock(tx, userId);
      const updated = await this.repository.transition(row, { stage: 'cancelled', nextAttemptAt: null, ...(unconfirmed ? { issue: null } : {}) }, tx);
      if (!updated) throw new ConflictException({ statusCode: 409, code: 'setup_changed', message: 'The setup changed; refresh it' });
      if (row.kind === 'start') await this.repository.endStart(tx, userId, row);
      return updated;
    });
    return this.wire(next);
  }

  // --- the driver ---------------------------------------------------------------
  /** The worker's signer for this setup's account: the worker quorum under
   * the owner's policy, recorded on the account at confirm. Null when the
   * account has none (or it was taken off), or the worker can't sign here. */
  private async workerPolicySigner(row: SetupRow): Promise<SetupSigner | null> {
    if (!this.workerSigner?.available || !row.accountId) return null;
    const account = await this.walletRows.account(row.accountId, row.userId);
    if (!account?.masterPolicyId || !account.masterSignerQuorumId || account.signerDetachedAt) return null;
    const signer = this.workerSigner;
    return { sign: (master, data, bound, deadline) => signer.sign({ ...master, workerQuorumId: account.masterSignerQuorumId!, policyId: account.masterPolicyId! }, data, bound, deadline) };
  }
  /** The worker's pass: every confirmed, unfinished setup that is due. */
  async tick(): Promise<number> {
    let worked = 0;
    for (const row of await this.repository.open(new Date(this.now()), this.network)) {
      try { await this.drive(row.id, await this.workerPolicySigner(row)); worked++; }
      catch (error) { this.logger.warn(`setup ${row.id} kept for the next pass: ${safeErrorText(error)}`); }
    }
    await this.reconcileAbandonedApprovals();
    return worked;
  }
  /** When each abandoned approval was last looked at (one look a minute). */
  private readonly approvalChecks = new Map<string, number>();
  /**
   * An agent whose approval was being signed or sent when its setup ended
   * (the deadline passed with the approval unknown): no setup drives it any
   * more, so the worker reconciles it here, a few a pass, each at most once
   * a minute, for three days (an approval's nonce can't land later than
   * that). An approval that landed shows the agent active; one never sent
   * goes back to ready. Nothing is signed or sent.
   */
  private async reconcileAbandonedApprovals(): Promise<number> {
    if (!this.agents.available) return 0;
    const now = this.now();
    for (const [id, at] of this.approvalChecks) if (now - at > 600_000) this.approvalChecks.delete(id);
    let checked = 0;
    for (const agent of await this.repository.abandonedApprovals(new Date(now - ABANDONED_APPROVAL_WINDOW_MS), this.network)) {
      if (checked >= 3) break;
      if (now - (this.approvalChecks.get(agent.id) ?? 0) < 60_000) continue;
      this.approvalChecks.set(agent.id, now); checked++;
      try { await this.agents.reconcile(agent.userId, agent.id); }
      catch (error) { this.logger.warn(`agent ${agent.id} approval kept for the next look: ${safeErrorText(error)}`); }
    }
    return checked;
  }
  /**
   * Advances one setup as far as it can go now, under a lease. Steps that
   * need a signature run only with the worker's signer; without one the
   * setup waits (`worker_signer_unavailable`) until its deadline.
   */
  async drive(id: string, signer: SetupSigner | null): Promise<SetupRow> {
    const leased = await this.repository.lease(id, LEASE_MS);
    if (!leased) return (await this.repository.get(id))!;
    let row = leased;
    try {
      for (let guard = 0; guard < 8 && DRIVEN_STAGES.includes(row.stage); guard++) {
        const before = row.stage;
        try { row = await this.step(row, signer); }
        catch (error) {
          // A step may have recorded a child id on the row: work on the latest.
          row = (await this.repository.get(id)) ?? row;
          if (error instanceof Wait) { row = (await this.repository.transition(row, { issue: error.issue, nextAttemptAt: new Date(this.now() + error.retryMs) })) ?? row; break; }
          // Hyperliquid weight not available yet: nothing was read or sent.
          // Come back when it is (the shared per-IP window: no sooner than 65 s).
          if (error instanceof HyperliquidBudgetWait) {
            const retryMs = error.reason === 'shared_capacity' ? Math.max(SHARED_CAPACITY_RETRY_MS, error.retryMs) : Math.max(1_000, error.retryMs);
            row = (await this.repository.transition(row, { issue: 'hyperliquid_busy', nextAttemptAt: new Date(this.now() + retryMs) })) ?? row; break;
          }
          if (error instanceof Fail) { row = (await this.repository.transition(row, { stage: EXPIRED_ISSUES.includes(error.issue) ? 'expired' : 'failed', issue: error.issue, nextAttemptAt: null })) ?? row; break; }
          const code = error instanceof HttpException && typeof error.getResponse() === 'object' && (error.getResponse() as { code?: unknown }).code;
          const issue = typeof code === 'string' ? code : error instanceof Error && /^[a-z][a-z0-9_]{2,79}$/.test(error.message) ? error.message : 'setup_step_pending';
          const capacity = error instanceof LiveBoundaryError && error.code === 'hyperliquid_quota_exhausted';
          const backoff = capacity ? SHARED_CAPACITY_RETRY_MS : Math.min(60_000, 3_000 * 2 ** Math.min(row.attempts, 5));
          row = (await this.repository.transition(row, { issue, attempts: row.attempts + 1, nextAttemptAt: new Date(this.now() + backoff) })) ?? row;
          break;
        }
        if (row.stage === before) break;
      }
      return row;
    } finally { await this.repository.release(id, leased.leaseToken); }
  }
  private async move(row: SetupRow, stage: SetupStage, changes: Partial<SetupRow> = {}): Promise<SetupRow> {
    const next = await this.repository.transition(row, { stage, issue: null, attempts: 0, nextAttemptAt: null, ...changes });
    if (!next) throw new Wait('setup_changed', 0);
    return next;
  }
  private intent(row: SetupRow): LiveCopySetupIntent {
    const parsed = liveCopySetupIntentSchema.safeParse(row.intent);
    if (!parsed.success || digest(parsed.data) !== row.intentDigest || !row.consentDigest) throw new Fail('setup_binding_changed');
    return parsed.data;
  }
  /** Past the deadline nothing new is signed; a step already in flight is
   * still reconciled, and money already sent is still confirmed. */
  private assertBeforeDeadline(row: SetupRow) {
    if (row.setupDeadline && this.now() >= row.setupDeadline.getTime()) throw new Fail('setup_expired');
  }
  private requireSigner(signer: SetupSigner | null): SetupSigner {
    if (!signer) throw new Wait('worker_signer_unavailable', 15_000);
    return signer;
  }

  private async step(row: SetupRow, signer: SetupSigner | null): Promise<SetupRow> {
    const intent = this.intent(row);
    // Another network's setup is history on this deployment: left exactly as
    // it is, nothing signed or sent (the driver's pass never picks one).
    if (intent.network !== this.network) return row;
    // A renewal confirmed before renewals were refused: its agent isn't one
    // the worker's policy allows (2026-10-07).
    if (row.kind === 'renewal') throw new Fail('renewal_unavailable');
    switch (row.stage) {
      case 'consented': return this.move(row, row.kind === 'edit' ? 'builder_ready' : 'funding_submitted');
      case 'funding_submitted': {
        const deposit = await this.fundingRows.find(row.userId, intent.fundingOperationId);
        if (deposit.status === 'credited') return this.move(row, 'funded');
        if (deposit.status === 'rejected' || deposit.status === 'cancelled') throw new Fail('setup_funding_rejected');
        // Hyperliquid took the deposit but its credit was never seen: at the
        // deadline the setup ends (expired) with the deposit's whereabouts on
        // it (its funding: sent to the copy wallet), so cancel, a new start, a
        // return and account deletion are no longer held by it. A credit seen
        // later lands in the copy wallet and is returned from the portfolio.
        if (row.setupDeadline && this.now() >= row.setupDeadline.getTime()) throw new Fail('setup_deposit_uncredited');
        throw new Wait('awaiting_credit', 3_000);
      }
      case 'funded': return this.modeStep(row, intent, signer);
      case 'mode_set': return this.agentStep(row, intent, signer);
      case 'agent_active': return this.builderStep(row, intent, signer);
      case 'builder_ready': return this.mandateStep(row, intent);
      default: return row;
    }
  }

  private async modeStep(row: SetupRow, intent: LiveCopySetupIntent, signer: SetupSigner | null): Promise<SetupRow> {
    let op = row.modeOperationId ? await this.modes.row(row.userId, row.modeOperationId) : null;
    if (!op) {
      op = await this.modes.ensureForSetup(row.userId, intent.accountId, `setup_${row.id.replaceAll('-', '')}`, row.id);
      row = (await this.repository.transition(row, { modeOperationId: op.id })) ?? await this.repository.find(row.userId, row.id);
    }
    if (op.targetState === 'supported') return this.move(row, 'mode_set');
    if (op.submissionState === 'rejected' || op.targetState === 'unsupported') throw new Fail('setup_account_mode_failed');
    // Only an operation in flight (or a signing claim to recover) needs its
    // own observation; a prepared one is observed by submit's first preflight.
    if (op.submissionState !== 'prepared' || op.attemptedAt) {
      const observed = await this.modes.reconcile(row.userId, op.id, { busy: 'throw' });
      if (observed.targetState === 'supported') return this.move(row, 'mode_set');
      if (observed.targetState === 'unsupported' || observed.submissionState === 'rejected') throw new Fail('setup_account_mode_failed');
      if (observed.submissionState !== 'prepared') { this.assertBeforeDeadline(row); throw new Wait('account_mode_pending', 3_000); }
    }
    this.assertBeforeDeadline(row);
    const active = this.requireSigner(signer);
    const result = await this.modes.submit(row.userId, op.id, { kind: 'setup', consentDigest: row.consentDigest!, sign: async (master, modeIntent, assertFresh) => {
      assertFresh();
      if (master.address !== intent.accountAddress || modeIntent.accountAddress !== intent.accountAddress) throw new Fail('setup_binding_changed');
      return active.sign(master, modeTypedData(modeIntent), { network: intent.network, account: intent.accountAddress }, modeIntent.consentExpiresAt);
    } });
    if (result.targetState === 'supported') return this.move(row, 'mode_set');
    if (result.submissionState === 'rejected') throw new Fail('setup_account_mode_failed');
    throw new Wait('account_mode_pending', 3_000);
  }

  private async agentStep(row: SetupRow, intent: LiveCopySetupIntent, signer: SetupSigner | null): Promise<SetupRow> {
    let agent = await this.agents.row(row.userId, row.agentSetupId!);
    if (agent.state === 'active') return this.move(row, 'agent_active');
    if (agent.state === 'blocked' || agent.state === 'revoked') throw new Fail('setup_agent_rejected');
    if (agent.state !== 'ready') {
      await this.agents.reconcile(row.userId, agent.id); agent = await this.agents.row(row.userId, agent.id);
      if (agent.state === 'active') return this.move(row, 'agent_active');
      if (agent.state === 'blocked' || agent.state === 'revoked') throw new Fail('setup_agent_rejected');
      // A reverted (never sent) approval is ready again: signed below.
      if (agent.state !== 'ready') { this.assertBeforeDeadline(row); throw new Wait('agent_approval_pending', 3_000); }
    }
    if (agent.agentAddress !== intent.agentAddress || agent.expiresAt.getTime() !== intent.agentValidUntil || agent.policyId !== intent.agentPolicyId) throw new Fail('setup_binding_changed');
    this.assertBeforeDeadline(row);
    const active = this.requireSigner(signer);
    // Allocates the approval nonce (its own five-minute window to sign and send).
    await this.agents.challengeRow(row.userId, agent.id);
    const name = liveSetupAgentName(intent);
    const result = await this.agents.submit(row.userId, agent.id, { kind: 'setup', consentDigest: row.consentDigest!, sign: async (master, consent, assertFresh) => {
      assertFresh();
      if (master.address !== intent.accountAddress || consent.agentAddress.toLowerCase() !== intent.agentAddress || consent.expiresAt !== intent.agentValidUntil) throw new Fail('setup_binding_changed');
      return active.sign(master, agentApprovalTypedData(consent) as unknown as MasterTypedData, { network: intent.network, agent: { address: intent.agentAddress, name } }, consent.consentExpiresAt);
    } });
    if (result.state === 'active') return this.move(row, 'agent_active');
    if (result.state === 'blocked') throw new Fail('setup_agent_rejected');
    throw new Wait('agent_approval_pending', 3_000);
  }

  /** A fee of 0 (testnet's decision 7; a live deployment for now) is skipped. Otherwise the
   * consented builder and rate, once, then observed on the exchange. */
  private async builderStep(row: SetupRow, intent: LiveCopySetupIntent, signer: SetupSigner | null): Promise<SetupRow> {
    if (!intent.builderAddress || intent.builderMaxFeeTenthsOfBps <= 0 || row.kind !== 'start') return this.move(row, 'builder_ready');
    const network = WALLET_NETWORKS[intent.network];
    let approval = row.builderApprovalId ? await this.returns.builder(row.userId, row.builderApprovalId) : null;
    if (!approval) {
      this.assertBeforeDeadline(row);
      approval = await this.returns.reserveBuilder(row.userId, intent.accountId, { idempotencyKey: row.id, builderAddress: intent.builderAddress, maxFeeTenthsBps: intent.builderMaxFeeTenthsOfBps, now: this.now() });
      row = (await this.repository.transition(row, { builderApprovalId: approval.id })) ?? await this.repository.find(row.userId, row.id);
    }
    if (approval.state === 'approved') return this.move(row, 'builder_ready');
    if (approval.state === 'rejected') throw new Fail('setup_builder_rejected');
    if (approval.state === 'unknown' || approval.state === 'accepted') {
      // Only a read: an unanswered one is looked at again on the next pass.
      const cap = await this.exchange.maxBuilderFee(intent.network, intent.accountAddress, intent.builderAddress).catch((error: unknown) => {
        this.logger.warn(`setup ${row.id} builder fee not read: ${safeErrorText(error)}`); return null;
      });
      if (cap !== null && cap >= intent.builderMaxFeeTenthsOfBps) { await this.returns.finishBuilder(row.userId, approval.id, 'approved', digest({ cap, checkedAt: this.now() })); return this.move(row, 'builder_ready'); }
      throw new Wait('builder_approval_pending', 3_000);
    }
    this.assertBeforeDeadline(row);
    const active = this.requireSigner(signer);
    const account = (await this.walletRows.account(intent.accountId, row.userId))!;
    const attempt = await this.returns.beginBuilder(row.userId, approval.id);
    if (!attempt) throw new Wait('builder_approval_pending', 1_000);
    const deadline = this.now() + 30_000;
    let signature: string;
    try {
      signature = await active.sign({ walletId: account.privyWalletId!, address: intent.accountAddress, ownerQuorumId: account.ownerQuorumId! },
        approveBuilderFeeTypedData(network, attempt.builderAddress, attempt.maxFeeTenthsBps, attempt.nonce) as unknown as MasterTypedData, { network: intent.network, builder: intent.builderAddress }, deadline);
    } catch (error) {
      // Not signed: the exchange cannot have it, so the attempt ends refused (never resent).
      this.logger.warn(`setup ${row.id} builder fee not signed: ${safeErrorText(error)}`);
      await this.returns.finishBuilder(row.userId, approval.id, 'rejected', digest({ reason: 'master_signature_unavailable', id: approval.id }));
      throw new Fail('setup_builder_rejected');
    }
    // An unknown outcome stays unknown (observed above on the next pass, never resent).
    const reply = await this.exchange.sendAction(intent.network, approveBuilderFeeRequest(network, attempt.builderAddress, attempt.maxFeeTenthsBps, attempt.nonce, signature),
      () => { if (this.now() >= deadline) throw new Error('stale'); }).catch((error: unknown) => { this.logger.warn(`setup ${row.id} builder fee outcome unknown: ${safeErrorText(error)}`); return null; });
    if (reply && typeof reply === 'object' && 'status' in reply && reply.status === 'err') { await this.returns.finishBuilder(row.userId, approval.id, 'rejected', digest(reply)); throw new Fail('setup_builder_rejected'); }
    if (reply && typeof reply === 'object' && 'status' in reply && reply.status === 'ok') await this.returns.finishBuilder(row.userId, approval.id, 'accepted', digest(reply));
    throw new Wait('builder_approval_pending', 2_000);
  }

  /** The generation from the setup consent, activated in one transaction;
   * the worker starts it once funded (activateFunded, right after). */
  private async mandateStep(row: SetupRow, intent: LiveCopySetupIntent): Promise<SetupRow> {
    if (!row.mandateId) this.assertBeforeDeadline(row);
    const settings = copyStrategySettingsSchema.parse(row.settings);
    const mandate = await this.uow.run(tx => this.mandates.prepareFromSetup(tx, row.userId, { id: row.id, kind: row.kind as LiveCopySetupKind, consentDigest: row.consentDigest!, intent, settings }, this.now));
    return this.move(row, 'running', { mandateId: mandate.id });
  }
}
