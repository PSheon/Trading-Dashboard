import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { verifyTypedData, type TypedDataDefinition } from 'viem';
import { z } from 'zod';
import { advanceLiveCopySetupSchema, agentApprovalTypedData, approveBuilderFeeRequest, approveBuilderFeeTypedData, confirmLiveCopySetupSchema, copyIdempotencyKeySchema, copyMasterActionRequestSchema, liveCopyBudgetSchema, liveCopySetupConsentTypedData,
  liveCopySetupIntentSchema, liveCopySetupSchema, liveSetupAgentName, startLiveCopySchema, copyStrategySettingsSchema, LIVE_SETUP_CONSENT_WINDOW_MS, LIVE_SETUP_DEADLINE_MS, LIVE_SETUP_VALID_DAYS,
  WALLET_NETWORKS, type LiveCopySetup, type LiveCopySetupIntent, type LiveCopySetupKind, type StartLiveCopy } from '@trading-dashboard/shared/contracts';
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
import { masterActionDigest, masterActionRequest, masterSignatureRefusal, type MasterAccount, type MasterActionBound, type MasterTypedData } from './live/master-action.js';
import { WORKER_MASTER_SIGNER, type WorkerMasterSigner } from './live/privy-policy-master-signer.js';
import { MASTER_POLICY_TYPES } from './live/privy-master-policy.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const NETWORK = WALLET_NETWORKS.testnet;
const ZERO = `0x${'00'.repeat(20)}` as const;
const LEASE_MS = 60_000;
/** How long after its setup ended an approval left unknown is still looked at. */
const ABANDONED_APPROVAL_WINDOW_MS = 3 * 86_400_000;
/** Stages whose step needs the signer and Hyperliquid evidence. */
/** How long /advance waits for its drive before answering with the row. */
const ADVANCE_ANSWER_MS = 10_000;
const THROTTLED_STAGES: readonly SetupStage[] = ['funded', 'mode_set', 'agent_active'];
/** A mode nonce parked for the owner's browser keeps this much of its
 * five-minute window, so its signature still meets the submission's minimum. */
const OWNER_MODE_NONCE_MIN_REMAINING_MS = 120_000;
/** How long before its nonce runs out the owner's signature is still taken
 * (the submission's own minimum, plus its preflight). */
const OWNER_MODE_SIGNATURE_MARGIN_MS = 65_000;
const OWNER_AGENT_SIGNATURE_MARGIN_MS = 15_000;
/** How a setup's steps after confirm are signed (plan §2): in the owner's
 * browser (the progress dialog signs the parked payload with the copy
 * account), or by the worker under the owner's policy. Either way the
 * payload is exactly what the consent bound. */
export interface SetupSigner {
  readonly kind: 'owner_session' | 'worker_policy';
  sign(account: MasterAccount, data: MasterTypedData, bound: MasterActionBound, deadline: number): Promise<string>;
}
/** Failures that are the deadline passing (the setup ends `expired`). */
const EXPIRED_ISSUES: readonly string[] = ['setup_expired', 'setup_deposit_uncredited'];
/** A step can't go on yet (a lookup is pending, or a signature is due). */
class Wait extends Error { constructor(readonly issue: string, readonly retryMs = 3_000) { super(issue); } }
/** The setup cannot finish; the owner sees the code. */
class Fail extends Error { constructor(readonly issue: string) { super(issue); } }

const editSchema = z.object({ idempotencyKey: copyIdempotencyKeySchema, budgetUsd: liveCopyBudgetSchema,
  settings: copyStrategySettingsSchema.strict().refine(value => value.sizingMode !== 'fixed' || value.perTradeUsd !== null).refine(value => value.copyStartMode === 'delta') }).strict();
const renewSchema = z.object({ idempotencyKey: copyIdempotencyKeySchema }).strict();
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Invalid setup request');
  return structuredClone(parsed.data);
}
const refuse = (status: 409 | 503, code: string, message: string): never => {
  throw status === 409 ? new ConflictException({ statusCode: 409, code, message }) : new ServiceUnavailableException({ statusCode: 503, code, message });
};
/** The UserSetAbstraction typed data with exactly its signed fields (the
 * policy and the signer's allow-list compare the message keys). */
function modeTypedData(intent: { accountAddress: string; nonce: number }): MasterTypedData {
  const primary = 'HyperliquidTransaction:UserSetAbstraction';
  return { domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: Number.parseInt(NETWORK.signatureChainId, 16), verifyingContract: ZERO },
    types: { [primary]: MASTER_POLICY_TYPES[primary].map(field => ({ ...field })) }, primaryType: primary,
    message: { hyperliquidChain: NETWORK.hyperliquidChain, user: intent.accountAddress.toLowerCase(), abstraction: 'disabled', nonce: intent.nonce } };
}

/**
 * One-click testnet copy (docs/one-click-copy-plan-2026-10-05.md §2, §3a).
 *
 * start: a paused strategy, its copy wallet, a ready 30-day agent and the
 * reserved deposit, then ONE consent challenge binding every term (and, with
 * the worker policy on, the owner-owned Privy policy). confirm: the consent
 * is verified once, the worker becomes the account's policy-bound signer with
 * the owner's session (COPY_AUTOMATIC_RETURN), and the deposit is submitted.
 * The driver then runs credit → account mode → agent → (builder fee) →
 * generation, resumable from this row after a crash or a closed tab; each
 * child operation keeps its own never-resend state.
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
    const { copy, hyperliquid } = this.config.value;
    if (copy.mode !== 'testnet' || hyperliquid.wallet.network !== 'testnet' || !this.agents.available || !this.modes.available)
      refuse(503, 'setup_unavailable', 'Testnet copy is not available right now');
  }

  // --- read -------------------------------------------------------------------
  async wire(row: SetupRow): Promise<LiveCopySetup> {
    const fundingRow = row.fundingOperationId ? await this.fundingRows.find(row.userId, row.fundingOperationId).catch(() => null) : null;
    const awaiting = row.stage === 'awaiting_consent' && row.intent && row.consentExpiresAt && row.consentExpiresAt.getTime() > this.now();
    return liveCopySetupSchema.parse({ id: row.id, kind: row.kind, strategyId: row.strategyId, accountId: row.accountId, leaderAddress: row.leaderAddress,
      sourceNetwork: row.sourceNetwork, budgetUsd: row.budgetUsd, settings: row.settings, stage: row.stage, issue: row.issue?.slice(0, 80) ?? null,
      signer: row.signerKind, consent: awaiting ? row.intent : null, funding: fundingRow ? fundingWire(fundingRow) : null, pendingSignature: this.pending(row), mandateId: row.mandateId,
      setupDeadline: row.setupDeadline?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
  }
  /** The copy account's signature due from the owner's browser, while it is. */
  private pending(row: SetupRow) {
    const pending = row.pendingSignature;
    if (!pending || row.signerKind !== 'owner_session' || !DRIVEN_STAGES.includes(row.stage) || pending.expiresAt <= this.now() || row.ownerSignature?.digest === pending.digest) return null;
    const parsed = copyMasterActionRequestSchema.safeParse(pending);
    return parsed.success ? parsed.data : null;
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
    const request = input(startLiveCopySchema, body) as StartLiveCopy; this.available();
    const owner = await this.repository.owner(userId);
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
        for (const abandoned of await this.repository.abandonedStarts(tx, userId, request.leader)) await this.endAbandoned(tx, abandoned);
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
   * the worker policy; then the consent challenge. */
  private async provision(original: SetupRow): Promise<SetupRow> {
    let row = original;
    const userId = row.userId;
    if (row.stage === 'awaiting_consent' && row.consentExpiresAt && row.consentExpiresAt.getTime() > this.now() + 30_000) return row;
    const step = async (changes: Partial<SetupRow>) => { row = (await this.repository.transition(row, changes)) ?? await this.repository.find(userId, row.id); };
    try {
      // 1. The copy wallet (one per strategy).
      if (!row.accountId) {
        const account = await this.wallets.prepare(userId, row.strategyId, { network: 'testnet' });
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
      // 4. The worker policy (COPY_AUTOMATIC_RETURN), bound into the consent.
      const agentBinding = { address: agent.agentAddress, name: liveSetupAgentName({ strategyId: row.strategyId, agentValidUntil: agent.expiresAt.getTime() }) };
      const previous = row.intent ? liveCopySetupIntentSchema.safeParse(row.intent) : null;
      const policy = previous?.success && previous.data.masterPolicyId ? { id: previous.data.masterPolicyId, fingerprint: previous.data.masterPolicyFingerprint }
        : await this.wallets.prepareSetupPolicy(userId, row.accountId!, agentBinding, `master_setup_${row.id.replaceAll('-', '')}`);
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
      this.logger.warn(`setup ${row.id} preparation kept for a retry: ${error instanceof Error ? error.message.slice(0, 80) : 'unknown'}`);
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
      strategyId: row.strategyId, leaderAddress: row.leaderAddress, sourceNetwork: row.sourceNetwork, network: 'testnet', budgetUsd: row.budgetUsd,
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
    const ended = await this.repository.transition(row, { stage: 'cancelled', nextAttemptAt: null, pendingSignature: null, ...(['provisioning', 'awaiting_consent'].includes(row.stage) ? { issue: null } : {}) }, tx);
    if (ended) await this.repository.endStart(tx, row.userId, row);
  }

  // --- edit / renew -------------------------------------------------------------
  private async running(userId: number, strategyId: number) {
    const { found, mandate, agent } = await this.repository.runningCopy(userId, strategyId);
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
    const request = input(editSchema, body); this.available();
    const prior = await this.repository.byKey(userId, request.idempotencyKey);
    if (prior) return this.wire(prior.stage === 'awaiting_consent' ? await this.rechallengeChange(prior) : prior);
    const state = await this.running(userId, strategyId);
    if (state.current) throw new ConflictException({ statusCode: 409, code: 'setup_unavailable', message: 'A setup for this copy is still running' });
    const limits = await this.mandates.preparation(this.repository.reader());
    this.mandates.checkBudget(request.budgetUsd, limits);
    if (request.settings.maxLeverage !== null && request.settings.maxLeverage > limits.maxLeverage) throw new ConflictException({ statusCode: 409, code: 'leverage_above_limit', message: 'Leverage above the platform limit', limit: limits.maxLeverage });
    return this.wire(await this.change(userId, 'edit', state, request.idempotencyKey, request.budgetUsd, request.settings));
  }
  /** A new 30-day agent and generation in the current one's last three days (decision 4). */
  async startRenewal(userId: number, strategyId: number, body: unknown): Promise<LiveCopySetup> {
    const request = input(renewSchema, body); this.available();
    const prior = await this.repository.byKey(userId, request.idempotencyKey);
    if (prior) return this.wire(prior.stage === 'awaiting_consent' ? await this.rechallengeChange(prior) : prior);
    const state = await this.running(userId, strategyId);
    if (state.current) throw new ConflictException({ statusCode: 409, code: 'setup_unavailable', message: 'A setup for this copy is still running' });
    const settings = await this.repository.strategySettings(strategyId, state.strategy.version);
    return this.wire(await this.change(userId, 'renewal', state, request.idempotencyKey, state.config.budgetUsd, settings));
  }
  private async change(userId: number, kind: 'edit' | 'renewal', state: Awaited<ReturnType<CopyLiveSetupService['running']>>, key: string, budgetUsd: string, settings: unknown): Promise<SetupRow> {
    const row = await this.repository.insert(this.repository.reader(), { id: randomUUID(), userId, strategyId: state.strategy.id, accountId: state.mandate.accountId, kind, idempotencyKey: key,
      leaderAddress: state.strategy.leaderAddress, sourceNetwork: state.config.sourceNetwork, budgetUsd, settings: settings as Record<string, unknown>, agentSetupId: kind === 'edit' ? state.agent.id : null });
    return this.rechallengeChange(row);
  }
  private async rechallengeChange(original: SetupRow): Promise<SetupRow> {
    let row = original;
    if (row.stage === 'awaiting_consent' && row.consentExpiresAt && row.consentExpiresAt.getTime() > this.now() + 30_000) return row;
    try {
      const account = (await this.walletRows.account(row.accountId!, row.userId))!;
      if (row.kind === 'renewal' && !row.agentSetupId) {
        const agent = await this.agents.prepareForSetup(row.userId, row.accountId!, `setup:${row.id}`, row.id, LIVE_SETUP_VALID_DAYS, true);
        row = (await this.repository.transition(row, { agentSetupId: agent.id })) ?? await this.repository.find(row.userId, row.id);
      }
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
  /** Verifies the one consent, records the worker signer the owner's browser
   * attached (worker policy on), submits the deposit, and runs what it can. */
  async confirm(userId: number, id: string, body: unknown): Promise<LiveCopySetup> {
    const request = input(confirmLiveCopySetupSchema, body); this.available();
    let row = await this.repository.find(userId, id);
    if (row.stage !== 'awaiting_consent') return this.wire(row);
    const parsed = liveCopySetupIntentSchema.safeParse(row.intent);
    if (!parsed.success || digest(parsed.data) !== row.intentDigest) throw new ConflictException('Setup binding changed');
    const intent = parsed.data, now = this.now();
    // COPY_AUTOMATIC_RETURN: the owner's browser added the worker as the copy
    // account's signer under the consented policy just before this request
    // (Privy's addSigners: only the owner can). Checked with Privy (exactly
    // that signer and policy) and recorded first, before any refusal below,
    // so a signer Privy shows is never left unrecorded on the account. Not
    // there (declined, failed, off): the owner's browser signs the steps.
    const attached = row.kind === 'start' && intent.masterPolicyId !== '' && await this.wallets.attachSetupSigner(userId, intent.accountId,
      { id: intent.masterPolicyId, fingerprint: intent.masterPolicyFingerprint }, { address: intent.agentAddress, name: liveSetupAgentName(intent) });
    if (now < intent.nonce || now >= intent.consentExpiresAt) refuse(409, 'consent_expired', 'The setup consent expired; start again');
    const owner = await this.repository.owner(userId);
    if (owner.embeddedWalletAddress !== intent.ownerAddress || owner.privyUserId !== intent.ownerPrivyUserId) throw new ConflictException({ statusCode: 409, code: 'setup_wallet_conflict', message: 'Your main wallet changed' });
    let valid = false;
    try { valid = await verifyTypedData({ address: intent.ownerAddress as `0x${string}`, ...(liveCopySetupConsentTypedData(intent) as unknown as TypedDataDefinition), signature: request.consentSignature as `0x${string}` }); } catch { /* invalid */ }
    if (!valid) throw new ForbiddenException({ statusCode: 403, code: 'invalid_consent', message: 'Invalid owner consent' });
    const consentDigest = digest(request.consentSignature.toLowerCase());
    await this.assertBinding(row, intent);
    // The worker signs under the owner's policy when it is the account's
    // signer; otherwise the owner's browser signs the remaining steps (the
    // progress dialog). An edit of an account the worker signs for keeps it.
    let signerKind: 'owner_session' | 'worker_policy' = attached ? 'worker_policy' : 'owner_session';
    if (row.kind === 'edit') {
      const account = await this.walletRows.account(intent.accountId, userId);
      if (account?.masterPolicyId) signerKind = 'worker_policy';
    }
    const confirmed = { consentDigest, signerKind, confirmedAt: new Date(now), setupDeadline: new Date(intent.setupDeadline), issue: null } as const;
    if (row.kind === 'start') {
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
    return this.wire(await this.drive(row.id, row.signerKind === 'worker_policy' ? await this.workerPolicySigner(row) : this.ownerBrowserSigner(row.id)));
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
   * The owner's open dialog continues a setup their browser signs: with no
   * body it runs the next step (which parks the copy account's next
   * signature on the row, `pendingSignature`); with `{ digest, signature }`
   * it first takes the browser's signature of that pending action, once it
   * recovers to the copy account for exactly that payload, then runs it.
   * Sending the same signature again changes nothing.
   */
  async advance(userId: number, id: string, body: unknown = {}): Promise<LiveCopySetup> {
    const parsed = advanceLiveCopySetupSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException({ statusCode: 400, code: 'owner_signature_malformed', message: 'Send the pending digest with its signature' });
    let row = await this.repository.find(userId, id);
    if ('signature' in parsed.data) row = await this.acceptOwnerSignature(row, parsed.data.digest, parsed.data.signature);
    if (row.fundingOperationId && row.stage === 'funding_submitted') await this.funding.reconcile(userId, row.fundingOperationId).catch(() => undefined);
    if (!DRIVEN_STAGES.includes(row.stage)) return this.wire(row);
    // A signature is due from the browser: nothing to run until it comes
    // (the agent step's identity reads would only be repeated).
    if (this.pending(row)) return this.wire(row);
    // The dialog asks every few seconds; a step that said when to come back
    // (a pending observation, a busy Hyperliquid budget) is not run sooner.
    if (THROTTLED_STAGES.includes(row.stage) && row.issue !== 'awaiting_owner_session' && row.nextAttemptAt && row.nextAttemptAt.getTime() > this.now()) return this.wire(row);
    // The drive runs outside this request (its lease keeps it single): a
    // step can outlast the 20 s request deadline (budget waits, a POST and
    // its reconcile), and must neither be cut off by the deadline nor answer
    // the dialog with a 504 while it goes on. The dialog gets the drive's
    // result when it is quick, else the row as it is, and polls.
    const signer = row.signerKind === 'owner_session' ? this.ownerBrowserSigner(row.id) : null;
    const driving = this.detached(() => this.drive(row.id, signer));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const driven = await Promise.race([driving.catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ADVANCE_ANSWER_MS); })]).finally(() => clearTimeout(timer));
    return this.wire(driven ?? await this.repository.find(userId, id));
  }
  /** The browser's signature of the pending action, checked before anything
   * uses it: it is the action still due (same digest, not expired, nothing
   * changed since), still bound to what the consent bound, and recovers to
   * the copy account. Every refusal has its own code. */
  private async acceptOwnerSignature(original: SetupRow, signed: string, signature: string): Promise<SetupRow> {
    let row = original;
    for (let attempt = 0; ; attempt++) {
      if (row.ownerSignature?.digest === signed && row.ownerSignature.signature.toLowerCase() === signature.toLowerCase()) return row;
      const pending = row.signerKind === 'owner_session' && DRIVEN_STAGES.includes(row.stage) ? row.pendingSignature : null;
      if (!pending) refuse(409, 'owner_signature_not_requested', 'No signature is due for this setup');
      if (pending!.digest !== signed) refuse(409, 'owner_signature_stale', 'The action changed; sign the current one');
      if (this.now() >= pending!.expiresAt) refuse(409, 'owner_signature_expired', 'The action expired; a new one follows');
      const request = copyMasterActionRequestSchema.safeParse(pending), intent = liveCopySetupIntentSchema.safeParse(row.intent);
      if (!request.success || !intent.success || digest(intent.data) !== row.intentDigest || request.data.account !== intent.data.accountAddress ||
        masterActionDigest(request.data.typedData as MasterTypedData) !== signed) refuse(409, 'owner_signature_stale', 'The action changed; sign the current one');
      const bound = this.boundFor(request.data!.kind, intent.data!);
      if (!bound || await masterSignatureRefusal(intent.data!.accountAddress, request.data!.typedData as MasterTypedData, bound, signature))
        throw new ForbiddenException({ statusCode: 403, code: 'owner_signature_invalid', message: "The signature is not the copy account's for this action" });
      const next = await this.repository.transition(row, { ownerSignature: { digest: signed, signature }, nextAttemptAt: null, issue: null });
      if (next) return next;
      // A drive moved the row meanwhile: check again against what it is now.
      if (attempt >= 3) refuse(409, 'owner_signature_stale', 'The action changed; sign the current one');
      row = await this.repository.find(row.userId, row.id);
    }
  }
  /** The values an action of this kind must carry, from the consent. */
  private boundFor(kind: string, intent: LiveCopySetupIntent): MasterActionBound | null {
    if (kind === 'account_mode') return { network: 'testnet', account: intent.accountAddress };
    if (kind === 'agent_approval') return { network: 'testnet', agent: { address: intent.agentAddress, name: liveSetupAgentName(intent) } };
    if (kind === 'builder_fee' && intent.builderAddress) return { network: 'testnet', builder: intent.builderAddress };
    return null;
  }
  /** Work that outlives the request that started it (drained on shutdown). */
  private detached<T>(work: () => Promise<T>): Promise<T> {
    const running = this.jobs ? this.jobs.run(work) : outsideRequest(() => Promise.resolve().then(work));
    void running.catch((error: unknown) => this.logger.warn(`setup drive kept for a retry: ${error instanceof Error ? error.message.slice(0, 80) : 'unknown'}`));
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
      const updated = await this.repository.transition(row, { stage: 'cancelled', nextAttemptAt: null, pendingSignature: null, ...(unconfirmed ? { issue: null } : {}) }, tx);
      if (!updated) throw new ConflictException({ statusCode: 409, code: 'setup_changed', message: 'The setup changed; refresh it' });
      if (row.kind === 'start') await this.repository.endStart(tx, userId, row);
      return updated;
    });
    return this.wire(next);
  }

  // --- the driver ---------------------------------------------------------------
  /** The owner's browser signs (owner_session): the step's exact payload is
   * parked on the row for the progress dialog, and the step goes on only
   * with the browser's signature of exactly it (taken by /advance). */
  ownerBrowserSigner(id: string): SetupSigner {
    return { kind: 'owner_session', sign: (account, data, bound, expiresAt) => this.ownerSigned(id, account, data, bound, expiresAt) };
  }
  private async ownerSigned(id: string, account: MasterAccount, data: MasterTypedData, bound: MasterActionBound, expiresAt: number): Promise<string> {
    let request: ReturnType<typeof masterActionRequest>;
    try { request = masterActionRequest(account.address, data, bound, expiresAt); } catch { throw new Fail('setup_binding_changed'); }
    const row = await this.repository.get(id);
    if (!row) throw new Wait('setup_changed', 0);
    // Taken by /advance after the same checks; checked again against the
    // payload this step signs now (a new nonce is a new digest).
    if (row.ownerSignature?.digest === request.digest && !await masterSignatureRefusal(account.address, data, bound, row.ownerSignature.signature)) return row.ownerSignature.signature;
    if (this.now() >= expiresAt) throw new Wait('owner_signature_expired', 1_000);
    if (row.pendingSignature?.digest !== request.digest || row.pendingSignature.expiresAt !== request.expiresAt) {
      const parked = await this.repository.transition(row, { pendingSignature: request });
      if (!parked) throw new Wait('setup_changed', 0);
    }
    throw new Wait('awaiting_owner_signature', 15_000);
  }
  private async workerPolicySigner(row: SetupRow): Promise<SetupSigner | null> {
    if (row.signerKind !== 'worker_policy' || !this.workerSigner?.available || !row.accountId) return null;
    const account = await this.walletRows.account(row.accountId, row.userId);
    if (!account?.masterPolicyId || !account.masterSignerQuorumId || account.signerDetachedAt) return null;
    const signer = this.workerSigner;
    return { kind: 'worker_policy', sign: (master, data, bound, deadline) => signer.sign({ ...master, workerQuorumId: account.masterSignerQuorumId!, policyId: account.masterPolicyId! }, data, bound, deadline) };
  }
  /** The worker's pass: every confirmed, unfinished setup that is due. */
  async tick(): Promise<number> {
    let worked = 0;
    for (const row of await this.repository.open(new Date(this.now()))) {
      // A setup the owner's session signs is driven by their open dialog at
      // the stages that need a signature: the worker's pass there only spent
      // the Hyperliquid budget the dialog needs, overwrote its issue and held
      // its lease. The worker still ends it once its deadline has passed.
      if (row.signerKind === 'owner_session' && THROTTLED_STAGES.includes(row.stage) && !(row.setupDeadline && this.now() >= row.setupDeadline.getTime())) continue;
      try { await this.drive(row.id, await this.workerPolicySigner(row)); worked++; }
      catch (error) { this.logger.warn(`setup ${row.id} kept for the next pass: ${error instanceof Error ? error.message.slice(0, 80) : 'unknown'}`); }
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
    for (const agent of await this.repository.abandonedApprovals(new Date(now - ABANDONED_APPROVAL_WINDOW_MS))) {
      if (checked >= 3) break;
      if (now - (this.approvalChecks.get(agent.id) ?? 0) < 60_000) continue;
      this.approvalChecks.set(agent.id, now); checked++;
      try { await this.agents.reconcile(agent.userId, agent.id); }
      catch (error) { this.logger.warn(`agent ${agent.id} approval kept for the next look: ${error instanceof Error ? error.message.slice(0, 80) : 'unknown'}`); }
    }
    return checked;
  }
  /**
   * Advances one setup as far as it can go now, under a lease. Steps that
   * need a signature run only with a signer; without one the setup waits
   * (`awaiting_owner_session`) for the owner's dialog or the worker policy.
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
    const next = await this.repository.transition(row, { stage, issue: null, attempts: 0, nextAttemptAt: null, pendingSignature: null, ...changes });
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
  private requireSigner(signer: SetupSigner | null, kind?: 'owner_session'): SetupSigner {
    if (!signer || (kind && signer.kind !== kind)) throw new Wait('awaiting_owner_session', 15_000);
    return signer;
  }

  private async step(row: SetupRow, signer: SetupSigner | null): Promise<SetupRow> {
    const intent = this.intent(row);
    switch (row.stage) {
      case 'consented': return this.move(row, row.kind === 'edit' ? 'builder_ready' : row.kind === 'renewal' ? 'mode_set' : 'funding_submitted');
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
    if (active.kind === 'owner_session') {
      // The browser signs before any Hyperliquid weight is spent: a nonce
      // with time left in its window (no exchange call), then its exact
      // payload parked for the dialog until the signature is here.
      const prepared = await this.modes.setupNonce(row.userId, op.id, OWNER_MODE_NONCE_MIN_REMAINING_MS);
      if (prepared.accountAddress !== intent.accountAddress) throw new Fail('setup_binding_changed');
      await active.sign({ walletId: '', address: intent.accountAddress, ownerQuorumId: '' }, modeTypedData(prepared), { network: 'testnet', account: intent.accountAddress },
        prepared.consentExpiresAt - OWNER_MODE_SIGNATURE_MARGIN_MS);
    }
    const result = await this.modes.submit(row.userId, op.id, { kind: 'setup', consentDigest: row.consentDigest!, sign: async (master, modeIntent, assertFresh) => {
      assertFresh();
      if (master.address !== intent.accountAddress || modeIntent.accountAddress !== intent.accountAddress) throw new Fail('setup_binding_changed');
      return active.sign(master, modeTypedData(modeIntent), { network: 'testnet', account: intent.accountAddress },
        active.kind === 'owner_session' ? modeIntent.consentExpiresAt - OWNER_MODE_SIGNATURE_MARGIN_MS : modeIntent.consentExpiresAt);
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
    // The worker policy binds the start's agent only; a renewal's new agent is
    // approved with the owner's session.
    const active = this.requireSigner(signer, row.kind === 'renewal' ? 'owner_session' : undefined);
    // Allocates the approval nonce (its own five-minute window to sign and send).
    const challenged = await this.agents.challengeRow(row.userId, agent.id);
    const name = liveSetupAgentName(intent);
    const agentExpiry = (consentExpiresAt: number) => active.kind === 'owner_session' ? consentExpiresAt - OWNER_AGENT_SIGNATURE_MARGIN_MS : consentExpiresAt;
    if (active.kind === 'owner_session') {
      // A nonce too close to its end can't be signed and sent in time: the
      // next one is allocated once it has run out.
      if (challenged.consentExpiresAt - this.now() < 60_000) throw new Wait('awaiting_owner_signature', Math.max(1_000, challenged.consentExpiresAt - this.now() + 100));
      if (challenged.accountAddress.toLowerCase() !== intent.accountAddress || challenged.agentAddress.toLowerCase() !== intent.agentAddress || challenged.expiresAt !== intent.agentValidUntil) throw new Fail('setup_binding_changed');
      // The browser signs before the submission spends anything.
      await active.sign({ walletId: '', address: intent.accountAddress, ownerQuorumId: '' }, agentApprovalTypedData(challenged) as unknown as MasterTypedData,
        { network: 'testnet', agent: { address: intent.agentAddress, name } }, agentExpiry(challenged.consentExpiresAt));
    }
    const result = await this.agents.submit(row.userId, agent.id, { kind: 'setup', consentDigest: row.consentDigest!, sign: async (master, consent, assertFresh) => {
      assertFresh();
      if (master.address !== intent.accountAddress || consent.agentAddress.toLowerCase() !== intent.agentAddress || consent.expiresAt !== intent.agentValidUntil) throw new Fail('setup_binding_changed');
      return active.sign(master, agentApprovalTypedData(consent) as unknown as MasterTypedData, { network: 'testnet', agent: { address: intent.agentAddress, name } }, agentExpiry(consent.consentExpiresAt));
    } });
    if (result.state === 'active') return this.move(row, 'agent_active');
    if (result.state === 'blocked') throw new Fail('setup_agent_rejected');
    throw new Wait('agent_approval_pending', 3_000);
  }

  /** Testnet keeps the fee at 0 (decision 7): skipped. Otherwise the
   * consented builder and rate, once, then observed on the exchange. */
  private async builderStep(row: SetupRow, intent: LiveCopySetupIntent, signer: SetupSigner | null): Promise<SetupRow> {
    if (!intent.builderAddress || intent.builderMaxFeeTenthsOfBps <= 0 || row.kind !== 'start') return this.move(row, 'builder_ready');
    let approval = row.builderApprovalId ? await this.returns.builder(row.userId, row.builderApprovalId) : null;
    if (!approval) {
      this.assertBeforeDeadline(row);
      approval = await this.returns.reserveBuilder(row.userId, intent.accountId, { idempotencyKey: row.id, builderAddress: intent.builderAddress, maxFeeTenthsBps: intent.builderMaxFeeTenthsOfBps, now: this.now() });
      row = (await this.repository.transition(row, { builderApprovalId: approval.id })) ?? await this.repository.find(row.userId, row.id);
    }
    if (approval.state === 'approved') return this.move(row, 'builder_ready');
    if (approval.state === 'rejected') throw new Fail('setup_builder_rejected');
    if (approval.state === 'unknown' || approval.state === 'accepted') {
      const cap = await this.exchange.maxBuilderFee('testnet', intent.accountAddress, intent.builderAddress).catch(() => -1);
      if (cap >= intent.builderMaxFeeTenthsOfBps) { await this.returns.finishBuilder(row.userId, approval.id, 'approved', digest({ cap, checkedAt: this.now() })); return this.move(row, 'builder_ready'); }
      throw new Wait('builder_approval_pending', 3_000);
    }
    this.assertBeforeDeadline(row);
    const active = this.requireSigner(signer);
    const account = (await this.walletRows.account(intent.accountId, row.userId))!;
    const builderData = approveBuilderFeeTypedData(NETWORK, approval.builderAddress, approval.maxFeeTenthsBps, approval.nonce) as unknown as MasterTypedData;
    // The browser signs before the attempt is claimed (its nonce is the approval's own).
    if (active.kind === 'owner_session') await active.sign({ walletId: '', address: intent.accountAddress, ownerQuorumId: '' }, builderData, { network: 'testnet', builder: intent.builderAddress }, row.setupDeadline!.getTime());
    const attempt = await this.returns.beginBuilder(row.userId, approval.id);
    if (!attempt) throw new Wait('builder_approval_pending', 1_000);
    const deadline = this.now() + 30_000;
    let signature: string;
    try {
      signature = await active.sign({ walletId: account.privyWalletId!, address: intent.accountAddress, ownerQuorumId: account.ownerQuorumId! },
        approveBuilderFeeTypedData(NETWORK, attempt.builderAddress, attempt.maxFeeTenthsBps, attempt.nonce) as unknown as MasterTypedData, { network: 'testnet', builder: intent.builderAddress },
        active.kind === 'owner_session' ? row.setupDeadline!.getTime() : deadline);
    } catch { await this.returns.finishBuilder(row.userId, approval.id, 'rejected', digest({ reason: 'master_signature_unavailable', id: approval.id })); throw new Fail('setup_builder_rejected'); }
    const reply = await this.exchange.sendAction('testnet', approveBuilderFeeRequest(NETWORK, attempt.builderAddress, attempt.maxFeeTenthsBps, attempt.nonce, signature),
      () => { if (this.now() >= deadline) throw new Error('stale'); }).catch(() => null);
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
