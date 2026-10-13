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
import { UnitOfWork, type DbExecutor, type DbTransaction } from '../db/unit-of-work.js';
import { ATTEMPT_STEP_REST_WEIGHT, CopyAccountModeService } from './copy-account-mode.service.js';
import type { HyperliquidMeterComposition } from '../hyperliquid/hyperliquid-global-quota.js';
import { ACCOUNT_MODE_OBSERVE_WEIGHT } from './live/privy-account-mode-client.js';
import { HyperliquidBudgetWait, SHARED_CAPACITY_MIN_RETRY_MS, sharedCapacityWait } from '../hyperliquid/hyperliquid-budget-wait.js';
import { infoWeight } from '../hyperliquid/info-weights.js';
import { DEFAULT_LIVE_SETUP_TIMINGS, type LiveSetupTimings } from '../config/live-timings.js';
import { classify, exhausted, StepFail, StepWait } from './live/error-class.js';
import { LiveBoundaryError } from './live/wallet-authorization.js';
import { CopyAgentService } from './copy-agent.service.js';
import { AGENT_OBSERVE_WEIGHT } from './copy-agent-exchange.client.js';
import { CopyFundingExchangeClient } from './copy-funding-exchange.client.js';
import { CopyFundingRepository } from './copy-funding.repository.js';
import { CopyFundingService, wire as fundingWire } from './copy-funding.service.js';
import { liveCopySettingsDigest } from './copy-live-mandate-consent.js';
import { CopyLiveMandateRepository } from './copy-live-mandate.repository.js';
import { assertSetupAdmission } from './copy-live-setup-barrier.js';
import { CopyLiveSetupAbortService } from './copy-live-setup-abort.service.js';
import { builderOutcome, CopyLiveReturnRepository } from './copy-live-return.repository.js';
import { CopyLiveSetupRepository, DRIVEN_STAGES, type SetupRow, type SetupStage, type SetupWait } from './copy-live-setup.repository.js';
import { CopyWalletRepository } from './copy-wallet.repository.js';
import { CopyWalletService } from './copy-wallet.service.js';
import type { MasterAccount, MasterActionBound, MasterTypedData } from './live/master-action.js';
import { safeErrorText } from '../runtime/safe-error-text.js';
import { WORKER_MASTER_SIGNER, type WorkerMasterSigner } from './live/privy-policy-master-signer.js';
import { deploymentNetwork, liveExecutionEnabled } from './live-deployment.js';
import { LeaderActivityService } from '../traders/leader-activity.service.js';
import { explorerHealth } from './explorer-health.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** A start's consented builder fee (none at 0: testnet's decision 7). */
const builderFeeDue = (row: Pick<SetupRow, 'kind'>, intent: LiveCopySetupIntent) => Boolean(intent.builderAddress) && intent.builderMaxFeeTenthsOfBps > 0 && row.kind === 'start';
/** The deposit a setup reserves, as a UUID derived from the setup and the
 * deposit it replaces: every pass and every driver reserve the same deposit,
 * never an orphan beside it. Not the revision: a pass whose step CAS lost
 * (another driver moved the row) would mint a new key next pass and leave
 * the first `prepared` deposit orphaned (funding_pending until the setup
 * ended; money audit 2026-10-12). A cancelled deposit is replaced under a
 * new key (its id is part of it). */
export function setupFundingKey(row: Pick<SetupRow, 'id' | 'fundingOperationId'>): string {
  const h = createHash('sha256').update(`live-setup-funding:${row.id}:${row.fundingOperationId ?? ''}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(8 | (parseInt(h[16]!, 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
// The driver's lease, a step's budget inside it (reserve wait, signature,
// POST), the HTTP answer and confirm waits and the retries are
// AppConfig.copy.live.setup (config/live-timings.ts): startup refuses a step
// budget that does not fit the lease.
/** How long after its setup ended an approval left unknown is still looked at. */
const ABANDONED_APPROVAL_WINDOW_MS = 3 * 86_400_000;
const THROTTLED_STAGES: readonly SetupStage[] = ['funded', 'mode_set', 'agent_active'];
/** The shared per-IP meter's setup lane (the wallet network's
 * HyperliquidGlobalTransport): a setup step goes ahead of background, within
 * the setups' share (hyperliquid-global-quota.ts HYPERLIQUID_SETUP_REST_CAP). */
export const SETUP_REST_CAPACITY = Symbol('SETUP_REST_CAPACITY');
export interface SetupRestCapacity {
  /** Records the setup's demand and answers in how many ms `weight` fits
   * (0: now, and granted). `key`: the setup's id. */
  claimSetup(weight: number, key?: string, observe?: (meter: HyperliquidMeterComposition) => void): Promise<number>;
  /** Runs the step: its Hyperliquid charges are the setup lane's (`key`: as claimed). */
  runSetup<T>(work: () => Promise<T>, key?: string): Promise<T>;
  /** Runs work nobody waits for (abandoned approvals): its charges are background. */
  runBackground?<T>(work: () => Promise<T>): Promise<T>;
}
/** Longest a setup waits on the shared meter before it claims again: its
 * demand (the marker background yields to) is renewed well inside the
 * marker's 65 s, so background never gets the window back between two
 * claims. On 2026-10-13 a setup came back 65 s after its claim, its marker
 * had just expired, background had refilled the window, and the next claim
 * said ~63.5 s again: ten minutes at `funded`. */
export const SETUP_CLAIM_RENEW_MS = 20_000;
/** A setup's claim waits are logged with the meter's composition at most this often. */
export const SETUP_CLAIM_LOG_EVERY_MS = 5_000;
/** A throttled step's charges on the shared meter, claimed before it runs:
 * the account-mode attempt (its two preflights, the POST and the
 * observation after it, ATTEMPT_STEP_REST_WEIGHT; an operation in flight is
 * only observed, ACCOUNT_MODE_OBSERVE_WEIGHT), the agent's observation and
 * approval, the builder fee's read and approval (0: no builder fee, nothing
 * sent). */
const ACCOUNT_MODE_STEP_WEIGHT = ATTEMPT_STEP_REST_WEIGHT;
const AGENT_STEP_WEIGHT = AGENT_OBSERVE_WEIGHT + 1;
const BUILDER_STEP_WEIGHT = infoWeight({ type: 'maxBuilderFee' }) + 1;
/** Stages a confirmed start reaches after its deposit's credit: the copy is
 * starting and is stopped like a running one, not cancelled. */
const PAST_FUNDING_STAGES: readonly SetupStage[] = ['funded', 'mode_set', 'agent_active', 'builder_ready', 'running'];
/** Every step after confirm is signed by the worker under the owner's Privy
 * policy (the one signing model, 2026-10-07), with exactly the payload the
 * consent bound; the owner's browser signs nothing after confirm. */
export interface SetupSigner {
  sign(account: MasterAccount, data: MasterTypedData, bound: MasterActionBound, deadline: number): Promise<string>;
}
/** Why a start can't go on without the worker signer (the owner declined
 * Privy's addSigners, or it timed out): nothing was deposited. */
const WORKER_SIGNER_MISSING = 'Orbie needs to add its signer to run this copy. Nothing was deposited and the copy did not start.';
/** A setup waiting for its deposit's credit looks again after
 * pendingMs × 2^(waits − 1), at most this: an explorer or ledger that can't be
 * reached is not polled every pass (a local setup reached revision 12716 in
 * 14 h, 2026-10-12). Only the credit (the stage moving on) resets it. */
export const AWAITING_CREDIT_MAX_WAIT_MS = 60_000;
/** A setup awaiting its credit longer than this (since its confirm sent the
 * deposit) logs `ALERT funding awaiting_credit`… */
export const AWAITING_CREDIT_ALERT_AFTER_MS = 10 * 60_000;
/** …at most once per this, per setup (lastWait.alertedAt: across restarts). */
export const AWAITING_CREDIT_ALERT_EVERY_MS = 10 * 60_000;
/** Failures that are the deadline passing (the setup ends `expired`). */
const EXPIRED_ISSUES: readonly string[] = ['setup_expired', 'setup_deposit_uncredited'];
/** A step can't go on yet (a lookup is pending, or a signature is due): a
 * `budget` wait, never an attempt (live/error-class.ts). */
class Wait extends StepWait { constructor(issue: string, retryMs = DEFAULT_LIVE_SETUP_TIMINGS.retry.pendingMs) { super(issue, retryMs); } }
/** The setup cannot finish; the owner sees the code (`permanent`). */
class Fail extends StepFail {}

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
/** What an edit request asks for (its idempotency key's payload). */
const editPayloadDigest = (change: { kind: string; strategyId: number; budgetUsd: string; settings: unknown }) =>
  digest({ kind: change.kind, strategyId: change.strategyId, budgetUsd: change.budgetUsd, settingsDigest: liveCopySettingsDigest(change.settings) });
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
    @Optional() private readonly jobs: BackgroundJobs | null = null,
    @Optional() @Inject(CopyLiveSetupAbortService) private readonly aborts: CopyLiveSetupAbortService | null = null,
    @Optional() @Inject(LeaderActivityService) private readonly leaderActivity: Pick<LeaderActivityService, 'copyActivity'> | null = null,
    @Optional() @Inject(SETUP_REST_CAPACITY) private readonly capacity: SetupRestCapacity | null = null) {}

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
      if (request.sourceNetwork === 'mainnet') await this.assertLeaderFits(request.leader);
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
    const strategy = await this.repository.strategy(row.strategyId);
    if (!strategy || strategy.userId !== userId || strategy.network !== this.network) throw new NotFoundException('Setup not found');
    if (row.kind !== 'start' || row.leaderAddress !== request.leader || row.budgetUsd !== request.budgetUsd || row.sourceNetwork !== request.sourceNetwork ||
      liveCopySettingsDigest(row.settings) !== liveCopySettingsDigest(request.settings)) throw new ConflictException('Idempotency payload changed');
    if (row.stage === 'provisioning' || row.stage === 'awaiting_consent') return this.answer(row, () => this.provisionLeased(row!.id));
    return this.wire(row);
  }

  /** A mainnet leader trading faster than a copy can follow (shared
   * `leaderActivityVerdict`) is refused before anything is created; an
   * unreadable activity refuses too (fail closed). A retry of an admitted key
   * is not measured again. */
  private async assertLeaderFits(leader: string) {
    let activity;
    try {
      if (!this.leaderActivity) throw new Error('leader activity is not wired');
      activity = await this.leaderActivity.copyActivity(leader);
    } catch (error) {
      this.logger.warn(`leader ${leader} activity not read: ${safeErrorText(error)}`);
      return refuse(503, 'leader_activity_unavailable', 'This trader\'s recent activity could not be checked. Try again in a minute.');
    }
    if (!activity.fits) refuse(409, 'leader_too_active', activity.saturated
      ? 'This trader made more than 2,000 trades in the last 24 hours, too many for copying to keep up. Copying this trader is not available.'
      : `This trader trades too often for copying to keep up (${activity.orders} orders in the last 24 hours, up to ${activity.peakPerMinute} a minute). The limit is ${activity.limits.perDay} a day and ${activity.limits.perMinute} a minute.`);
  }

  /** Provider-only preparation, none of which needs a consent: the copy
   * wallet, the agent (policy + wallet, ready), the deposit reservation and
   * the worker's policy; then the consent challenge. No challenge without the
   * policy: the worker signs every step after confirm. */
  private async provisionLeased(id: string): Promise<SetupRow> {
    const row = await this.repository.lease(id, this.timings.leaseMs);
    if (!row) return (await this.repository.get(id))!;
    try {
      if (row.kind !== 'start' || !['provisioning', 'awaiting_consent'].includes(row.stage)) return row;
      return await this.provision(row);
    } finally { await this.repository.release(id, row.leaseToken); }
  }
  private async provision(original: SetupRow): Promise<SetupRow> {
    let row = original;
    const userId = row.userId;
    if (row.stage === 'awaiting_consent' && row.consentExpiresAt && row.consentExpiresAt.getTime() > this.now() + 30_000) return row;
    const step = async (changes: Partial<SetupRow>) => {
      const next = await this.repository.transition(row, changes);
      row = next ?? await this.repository.find(userId, row.id);
      // A cancelled/superseded revision is never adopted as authority to
      // prepare another child or renew its consent challenge.
      return Boolean(next);
    };
    try {
      // 1. The copy wallet (one per strategy).
      if (!row.accountId) {
        const account = await this.wallets.prepare(userId, row.strategyId, { network: this.network });
        if (!await step({ accountId: account.id })) return row;
      }
      const account = await this.wallets.reconcile(userId, row.accountId!);
      if (account.state === 'blocked') throw new Fail('setup_wallet_conflict');
      if (account.state !== 'ready' || !account.address) throw new Wait('wallet_verification_pending');
      // 2. The agent, ready to approve (no exchange call).
      if (!row.agentSetupId) {
        const agent = await this.agents.prepareForSetup(userId, row.accountId!, `setup:${row.id}`, row.id, LIVE_SETUP_VALID_DAYS);
        if (!await step({ agentSetupId: agent.id })) return row;
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
        const reserved = await this.funding.reserve(userId, row.accountId!, { idempotencyKey: setupFundingKey(row), amount: row.budgetUsd }, { liveSetupId: row.id });
        deposit = await this.fundingRows.find(userId, reserved.id);
        if (!await step({ fundingOperationId: deposit.id })) return row;
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
        if (!await step({ issue: code ?? 'setup_preparation_pending' })) return row;
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
    return prior.stage === 'awaiting_consent' ? this.rechallengeChange(prior) : prior;
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
    return inserted.prior ? this.replayChange(inserted.prior, payload) : this.rechallengeChange(inserted.row);
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
      return this.drive(row.id, await this.workerPolicySigner(row));
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
      if (row.fundingOperationId && row.stage === 'funding_submitted') {
        // Reconciliation can wait for provider budget too: it belongs to
        // the detached lifecycle, not the request's deadline.
        await this.funding.reconcile(userId, row.fundingOperationId).catch((error: unknown) => this.logger.warn(`setup ${row.id} deposit not reconciled: ${safeErrorText(error)}`));
      }
      if (THROTTLED_STAGES.includes(row.stage) && row.nextAttemptAt && row.nextAttemptAt.getTime() > this.now()) return row;
      return this.drive(row.id, await this.workerPolicySigner(row));
    });
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
    // Admission is quick; each persistent abort runs as a tracked worker
    // job so slow ledger/proof reads do not block unrelated copy execution.
    await this.aborts?.tick();
    let worked = 0;
    for (const row of await this.repository.open(new Date(this.now()), this.network)) {
      try { if (row.stage === 'provisioning') await this.provisionLeased(row.id); else await this.drive(row.id, await this.workerPolicySigner(row)); worked++; }
      catch (error) { this.logger.warn(`setup ${row.id} kept for the next pass: ${safeErrorText(error)}`); }
    }
    // Nobody waits on these: the shared meter's background lane.
    const capacity = this.capacity;
    await (capacity?.runBackground ? capacity.runBackground(() => this.reconcileAbandonedApprovals()) : this.reconcileAbandonedApprovals());
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
    const leased = await this.repository.lease(id, this.timings.leaseMs);
    if (!leased) return (await this.repository.get(id))!;
    let row = leased;
    try {
      for (let guard = 0; guard < 8 && DRIVEN_STAGES.includes(row.stage); guard++) {
        const before = row.stage;
        try { row = await this.step(row, signer); }
        catch (error) {
          // A step may have recorded a child id on the row: work on the latest.
          row = (await this.repository.get(id)) ?? row;
          // Another driver/cancellation may have ended it while I/O was in
          // flight. A late failure cannot overwrite that terminal outcome.
          if (!DRIVEN_STAGES.includes(row.stage)) break;
          row = await this.failed(row, error);
          break;
        }
        if (row.stage === before) break;
      }
      return row;
    } finally { await this.repository.release(id, leased.leaseToken); }
  }
  /**
   * Records why a step did not finish, by its class (live/error-class.ts):
   * - budget (Hyperliquid weight, or a step waiting on what it started):
   *   back at its time, never an attempt. A weight wait is logged and kept on
   *   the row (lastWait, with how many waits this stage had): a setup looping
   *   on hyperliquid_busy says which bucket and why.
   * - needs_owner: the code is shown; looked at again, never exhausted.
   * - permanent: the setup ends (failed, or expired for a deadline).
   * - transient: one attempt more, backed off; at `transientAttempts` in this
   *   stage it is permanent (an outcome still unknown never is).
   */
  private async failed(row: SetupRow, error: unknown): Promise<SetupRow> {
    const classified = classify(error), retry = this.timings.retry, now = this.now();
    const issue = classified.code ?? 'setup_step_pending';
    const end = async (code: string, changes: Partial<SetupRow> = {}) =>
      (await this.repository.transition(row, { stage: EXPIRED_ISSUES.includes(code) ? 'expired' : 'failed', issue: code, nextAttemptAt: null, ...changes })) ?? row;
    switch (classified.class) {
      case 'budget': {
        if (error instanceof StepWait && error.issue === 'awaiting_credit') return this.awaitCredit(row, now);
        const retryMs = classified.retryAfterMs ?? retry.pendingMs;
        if (!(error instanceof HyperliquidBudgetWait)) return (await this.repository.transition(row, { issue, nextAttemptAt: new Date(now + retryMs) })) ?? row;
        const waits = (row.lastWait?.step === row.stage ? row.lastWait.waits ?? 0 : 0) + 1;
        const lastWait: SetupWait = { at: new Date(now).toISOString(), step: row.stage, reason: error.reason, retryMs: Math.ceil(retryMs), waits, ...error.detail };
        this.logger.warn(`setup ${row.id} hyperliquid_busy ${JSON.stringify({ setupId: row.id, attempts: row.attempts, ...lastWait })}`);
        return (await this.repository.transition(row, { issue: 'hyperliquid_busy', lastWait, nextAttemptAt: new Date(now + retryMs) })) ?? row;
      }
      case 'needs_owner': return (await this.repository.transition(row, { issue, nextAttemptAt: new Date(now + retry.needsOwnerMs) })) ?? row;
      case 'permanent': return end(issue);
      case 'transient': {
        const attempts = row.attempts + 1;
        if (exhausted(classified, attempts, retry.transientAttempts)) {
          const code = classified.code ?? 'setup_step_failed';
          this.logger.warn(`setup ${row.id} ${code} after ${attempts} attempts at ${row.stage}: ${safeErrorText(error)}`);
          return end(code, { attempts });
        }
        const backoff = Math.min(retry.backoffMaxMs, retry.backoffBaseMs * 2 ** Math.min(row.attempts, 5));
        return (await this.repository.transition(row, { issue, attempts, nextAttemptAt: new Date(now + backoff) })) ?? row;
      }
    }
  }
  /**
   * The deposit is not credited yet: look again after a wait that doubles
   * each pass of this stage (AWAITING_CREDIT_MAX_WAIT_MS at most), counted
   * on the row (lastWait.waits) so a restart keeps it. Never an attempt. The
   * first wait sets the issue (a change: a new revision); every later one is
   * bookkeeping only (defer: no revision, no updatedAt). Past
   * AWAITING_CREDIT_ALERT_AFTER_MS since the confirm, an ALERT, rate-limited.
   */
  private async awaitCredit(row: SetupRow, now: number): Promise<SetupRow> {
    const prior = row.lastWait?.step === row.stage && row.lastWait.reason === 'awaiting_credit' ? row.lastWait : null;
    const waits = (prior?.waits ?? 0) + 1;
    const retryMs = Math.min(AWAITING_CREDIT_MAX_WAIT_MS, this.timings.retry.pendingMs * 2 ** Math.min(waits - 1, 16));
    let alertedAt = prior?.alertedAt;
    const since = row.confirmedAt?.getTime();
    if (since !== undefined && now - since > AWAITING_CREDIT_ALERT_AFTER_MS && (!alertedAt || !(now - Date.parse(alertedAt) < AWAITING_CREDIT_ALERT_EVERY_MS))) {
      alertedAt = new Date(now).toISOString();
      const explorer = explorerHealth.status();
      this.logger.error(`ALERT funding awaiting_credit ${JSON.stringify({ setupId: row.id, fundingOperationId: row.fundingOperationId, awaitingCreditSince: new Date(since).toISOString(),
        minutes: Math.floor((now - since) / 60_000), waits, explorerReachable: explorer.reachable, explorerFailingSince: explorer.failingSince?.toISOString() ?? null })}`);
    }
    const lastWait: SetupWait = { at: new Date(now).toISOString(), step: row.stage, reason: 'awaiting_credit', retryMs, waits, ...(alertedAt ? { alertedAt } : {}) };
    const nextAttemptAt = new Date(now + retryMs);
    if (row.issue !== 'awaiting_credit') return (await this.repository.transition(row, { issue: 'awaiting_credit', nextAttemptAt, lastWait })) ?? row;
    return (await this.repository.defer(row, { nextAttemptAt, lastWait })) ?? row;
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
    if (!signer) throw new Wait('worker_signer_unavailable', this.timings.retry.signerUnavailableMs);
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
        throw new Wait('awaiting_credit', this.timings.retry.pendingMs);
      }
      case 'funded': return this.modeStep(row, intent, signer);
      case 'mode_set': return this.withCapacity(row, AGENT_STEP_WEIGHT, () => this.agentStep(row, intent, signer));
      case 'agent_active': return this.withCapacity(row, builderFeeDue(row, intent) ? BUILDER_STEP_WEIGHT : 0, () => this.builderStep(row, intent, signer));
      case 'builder_ready': return this.mandateStep(row, intent);
      default: return row;
    }
  }

  /**
   * A throttled step's Hyperliquid weight, ahead of background: its demand
   * is recorded on the shared meter first (background then leaves the
   * setups' share free), and the step starts only once its weight fits;
   * until then it waits as long as the meter says (`shared_capacity`, at
   * least 1 s), never a whole 65 s window by default, and claims again at
   * least every SETUP_CLAIM_RENEW_MS. A granted claim keeps the step's
   * weight free while it runs. Its charges are the setup lane's (this
   * setup's: its own earlier charges never count against its share),
   * bounded so a burst of setups never takes live orders' room. A refusal
   * partway is waited out within SETUP_CLAIM_RENEW_MS too, then claimed
   * again. Without the meter (no transport), the step runs as it is.
   */
  private async withCapacity(row: SetupRow, weight: number, step: () => Promise<SetupRow>): Promise<SetupRow> {
    const capacity = this.capacity;
    if (!capacity || weight <= 0) return step();
    let waitMs: number, meter: HyperliquidMeterComposition | undefined;
    try { waitMs = await capacity.claimSetup(weight, row.id, observed => { meter = observed; }); }
    catch (error) {
      const wait = sharedCapacityWait(error);
      if (wait) throw wait;
      // A demand that could not be recorded: the step runs as before (its
      // own charges still go through the meter).
      this.logger.warn(`setup capacity not claimed: ${safeErrorText(error)}`);
      waitMs = 0;
    }
    if (waitMs > 0) {
      this.logClaimWait(row.id, weight, waitMs, meter);
      throw new HyperliquidBudgetWait(Math.min(SETUP_CLAIM_RENEW_MS, Math.max(SHARED_CAPACITY_MIN_RETRY_MS, waitMs + 250)), 'shared_capacity', { weight, bucket: 'shared:setup' });
    }
    try { return await capacity.runSetup(step, row.id); }
    catch (error) {
      const wait = sharedCapacityWait(error);
      if (wait && wait.retryMs > SETUP_CLAIM_RENEW_MS) throw new HyperliquidBudgetWait(SETUP_CLAIM_RENEW_MS, 'shared_capacity', { ...wait.detail, weight, bucket: 'shared:setup' });
      throw error;
    }
  }

  /** When each setup's claim wait was last logged (SETUP_CLAIM_LOG_EVERY_MS). */
  private readonly claimWaitLogged = new Map<string, number>();
  /**
   * A setup's claim that waits: its need and what the shared meter held at
   * that decision, by class (hyperliquidMeterComposition), so a gate run
   * shows who held the window. At most once per SETUP_CLAIM_LOG_EVERY_MS per
   * setup; the composition comes with the claim's own transaction (no read).
   */
  private logClaimWait(setupId: string, need: number, waitMs: number, meter: HyperliquidMeterComposition | undefined): void {
    const now = this.now(), last = this.claimWaitLogged.get(setupId);
    if (last !== undefined && now - last < SETUP_CLAIM_LOG_EVERY_MS) return;
    if (this.claimWaitLogged.size >= 256) this.claimWaitLogged.clear();
    this.claimWaitLogged.set(setupId, now);
    this.logger.warn(`setup ${setupId} claim waits ${JSON.stringify({ setupId, need, waitMs: Math.ceil(waitMs), ...(meter ? { meter } : {}) })}`);
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
    const inFlight = op.submissionState !== 'prepared' || Boolean(op.attemptedAt), operation = op;
    return this.withCapacity(row, inFlight ? ACCOUNT_MODE_OBSERVE_WEIGHT : ACCOUNT_MODE_STEP_WEIGHT, () => this.modeAttempt(row, intent, signer, operation, inFlight));
  }
  private async modeAttempt(row: SetupRow, intent: LiveCopySetupIntent, signer: SetupSigner | null, op: { id: string }, inFlight: boolean): Promise<SetupRow> {
    if (inFlight) {
      const observed = await this.modes.reconcile(row.userId, op.id, { busy: 'throw' });
      if (observed.targetState === 'supported') return this.move(row, 'mode_set');
      if (observed.targetState === 'unsupported' || observed.submissionState === 'rejected') throw new Fail('setup_account_mode_failed');
      if (observed.submissionState !== 'prepared') { this.assertBeforeDeadline(row); throw new Wait('account_mode_pending', this.timings.retry.pendingMs); }
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
    throw new Wait('account_mode_pending', this.timings.retry.pendingMs);
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
      if (agent.state !== 'ready') { this.assertBeforeDeadline(row); throw new Wait('agent_approval_pending', this.timings.retry.pendingMs); }
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
    throw new Wait('agent_approval_pending', this.timings.retry.pendingMs);
  }

  /** A fee of 0 (testnet's decision 7; a live deployment for now) is skipped. Otherwise the
   * consented builder and rate, once, then observed on the exchange. */
  private async builderStep(row: SetupRow, intent: LiveCopySetupIntent, signer: SetupSigner | null): Promise<SetupRow> {
    if (!builderFeeDue(row, intent) || !intent.builderAddress) return this.move(row, 'builder_ready');
    const network = WALLET_NETWORKS[intent.network];
    let approval = row.builderApprovalId ? await this.returns.builder(row.userId, row.builderApprovalId) : null;
    if (!approval) {
      this.assertBeforeDeadline(row);
      approval = await this.returns.reserveBuilder(row.userId, intent.accountId, { idempotencyKey: row.id, builderAddress: intent.builderAddress, maxFeeTenthsBps: intent.builderMaxFeeTenthsOfBps, now: this.now(), liveSetupId: row.id });
      row = (await this.repository.transition(row, { builderApprovalId: approval.id })) ?? await this.repository.find(row.userId, row.id);
    }
    if (approval.state === 'approved') return this.move(row, 'builder_ready');
    if (approval.state === 'rejected') throw new Fail('setup_builder_rejected');
    if (approval.state === 'unknown' || approval.state === 'accepted') {
      // Only a read: an unanswered one is looked at again on the next pass.
      const readAt = this.now();
      const cap = await this.exchange.maxBuilderFee(intent.network, intent.accountAddress, intent.builderAddress).catch((error: unknown) => {
        this.logger.warn(`setup ${row.id} builder fee not read: ${safeErrorText(error)}`); return null;
      });
      const outcome = cap === null ? null : builderOutcome(approval, cap, readAt);
      if (outcome === 'approved') { await this.returns.finishBuilder(row.userId, approval.id, 'approved', digest({ cap, checkedAt: this.now() })); return this.move(row, 'builder_ready'); }
      // Its nonce expired and the exchange shows no fee: it never executed.
      if (outcome === 'rejected') { await this.returns.finishBuilder(row.userId, approval.id, 'rejected', digest({ reason: 'not_executed', cap, checkedAt: readAt })); throw new Fail('setup_builder_rejected'); }
      throw new Wait('builder_approval_pending', this.timings.retry.pendingMs);
    }
    this.assertBeforeDeadline(row);
    const active = this.requireSigner(signer);
    const account = (await this.walletRows.account(intent.accountId, row.userId))!;
    const attempt = await this.returns.beginBuilder(row.userId, approval.id);
    if (!attempt) throw new Wait('builder_approval_pending', 1_000);
    const deadline = this.now() + this.timings.stepBudgetMs.signMs;
    let request: unknown;
    try {
      const signature = await active.sign({ walletId: account.privyWalletId!, address: intent.accountAddress, ownerQuorumId: account.ownerQuorumId! },
        approveBuilderFeeTypedData(network, attempt.builderAddress, attempt.maxFeeTenthsBps, attempt.nonce) as unknown as MasterTypedData, { network: intent.network, builder: intent.builderAddress }, deadline);
      request = approveBuilderFeeRequest(network, attempt.builderAddress, attempt.maxFeeTenthsBps, attempt.nonce, signature);
    } catch (error) {
      // Not signed (or no usable signature): the exchange cannot have it.
      // Back to prepared, signed again on a later pass: a transient failure
      // (live/error-class.ts), counted and backed off, the setup failing only
      // at the attempt limit.
      this.logger.warn(`setup ${row.id} builder fee not signed: ${safeErrorText(error)}`);
      await this.returns.restoreBuilderNotDispatched(row.userId, attempt);
      throw new LiveBoundaryError('builder_approval_not_signed');
    }
    // Dispatched only once every check passed, right before the POST: a
    // refusal before it (a stale proof, the meter) never reached the
    // exchange and is tried again like a failed signature. An unknown
    // outcome stays unknown (observed above on the next pass, never resent).
    let dispatched = false;
    const reply = await this.exchange.sendAction(intent.network, request, () => { if (this.now() >= deadline) throw new Error('stale'); }, () => { dispatched = true; }).catch(async (error: unknown) => {
      if (!dispatched) {
        this.logger.warn(`setup ${row.id} builder fee not sent: ${safeErrorText(error)}`);
        await this.returns.restoreBuilderNotDispatched(row.userId, attempt);
        throw new LiveBoundaryError('account_action_not_dispatched');
      }
      this.logger.warn(`setup ${row.id} builder fee outcome unknown: ${safeErrorText(error)}`); return null;
    });
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
