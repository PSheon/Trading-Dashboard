import { agentApprovalTypedData, approveBuilderFeeRequest, approveBuilderFeeTypedData, copyStrategySettingsSchema, liveSetupAgentName, userSetAbstractionTypedData, WALLET_NETWORKS,
  type LiveCopySetupIntent, type LiveCopySetupKind, type WalletNetwork } from '@trading-dashboard/shared/contracts';
import { UnitOfWork } from '../db/unit-of-work.js';
import { CopyAccountModeService } from './copy-account-mode.service.js';
import type { HyperliquidMeterComposition } from '../hyperliquid/hyperliquid-global-quota.js';

import { HyperliquidBudgetWait, sharedCapacityWait, type LiveBudget, type LiveBudgetReservation } from '../hyperliquid/hyperliquid-budget-wait.js';
import { LiveBoundaryError } from './live/wallet-authorization.js';
import { CopyAgentService } from './copy-agent.service.js';

import { CopyFundingExchangeClient } from './copy-funding-exchange.client.js';
import { CopyFundingRepository } from './copy-funding.repository.js';
import { CopyLiveMandateRepository } from './copy-live-mandate.repository.js';
import { builderOutcome, CopyLiveReturnRepository } from './copy-live-return.repository.js';
import type { SetupRow } from './copy-live-setup.repository.js';
import { CopyWalletRepository } from './copy-wallet.repository.js';
import type { MasterTypedData } from './live/master-action.js';
import { safeErrorText } from '../runtime/safe-error-text.js';
import { digest, Fail, SetupPart, Wait, type SetupContext, type SetupSigner } from './copy-live-setup-shared.js';
import { SETUP_CLAIM_RENEW_MS, SHARED_CAPACITY_MIN_RETRY_MS } from '../config/constants/hyperliquid.js';
import { SETUP_CLAIM_LOG_EVERY_MS } from '../config/constants/timings.js';
import { ACCOUNT_MODE_OBSERVE_WEIGHT, ACCOUNT_MODE_STEP_WEIGHT, AGENT_STEP_WEIGHT, ATTEMPT_SOCKET_CONNECTS, ATTEMPT_STEP_WEIGHT, BUILDER_FEE_READ_WEIGHT, BUILDER_STEP_WEIGHT } from '../config/constants/weights.js';

/**
 * The steps of a confirmed live copy setup (credit → account mode → agent →
 * builder fee → generation), each signed by the worker under the owner's
 * policy, and how a throttled step takes its Hyperliquid weight before it
 * runs (withCapacity: the setup bucket first, then the shared meter's setup
 * lane). Composed by CopyLiveSetupService; its driver calls `step`.
 */
/** A start's consented builder fee (none at 0: testnet's decision 7). */
const builderFeeDue = (row: Pick<SetupRow, 'kind'>, intent: LiveCopySetupIntent) => Boolean(intent.builderAddress) && intent.builderMaxFeeTenthsOfBps > 0 && row.kind === 'start';
/** The shared per-IP meter's setup lane (the wallet network's
 * HyperliquidGlobalTransport): a setup step goes ahead of background, within
 * the setups' share (hyperliquid-global-quota.ts HYPERLIQUID_SETUP_REST_CAP). */
export const SETUP_REST_CAPACITY = Symbol('SETUP_REST_CAPACITY');
export interface SetupRestCapacity {
  /** Records the setup's demand and answers in how many ms `weight` fits
   * (0: now, and granted: the weight, and `connects` socket connects, are
   * held for the step). `key`: the setup's id. */
  claimSetup(weight: number, key?: string, observe?: (meter: HyperliquidMeterComposition) => void, connects?: number, queue?: boolean): Promise<number>;
  /** The step is over: what its grant still holds goes back (`key`: as claimed). */
  releaseSetup?(key: string): Promise<void>;
  /** Runs the step: its Hyperliquid charges are the setup lane's (`key`: as claimed). */
  runSetup<T>(work: () => Promise<T>, key?: string): Promise<T>;
  /** Runs work nobody waits for (abandoned approvals): its charges are background. */
  runBackground?<T>(work: () => Promise<T>): Promise<T>;
}
/** The setup bucket (WalletNetworkHyperliquid.setupBudget, as the setup's
 * clients reserve it): a step whose weight its own client does not reserve
 * (the builder fee's read) takes it here before its shared claim. */
export const SETUP_LOCAL_BUDGET = Symbol('SETUP_LOCAL_BUDGET');
/** A setup's key in its bucket's queue (LiveReserveOptions.holdKey): one per setup, every step. */
const setupHoldKey = (row: Pick<SetupRow, 'id'>) => `setup:${row.id}`;
/** The UserSetAbstraction the copy account signs for this mode nonce. */
const modeTypedData = (intent: { network: WalletNetwork; accountAddress: string; nonce: number }) =>
  userSetAbstractionTypedData(WALLET_NETWORKS[intent.network], intent.accountAddress, intent.nonce) as unknown as MasterTypedData;


interface SetupStepDeps {
  readonly modes: CopyAccountModeService; readonly agents: CopyAgentService; readonly returns: CopyLiveReturnRepository; readonly exchange: CopyFundingExchangeClient;
  readonly walletRows: CopyWalletRepository; readonly mandates: CopyLiveMandateRepository; readonly uow: UnitOfWork; readonly fundingRows: CopyFundingRepository;
  readonly capacity: SetupRestCapacity | null; readonly setupBudget: LiveBudget | null;
}

export class SetupSteps extends SetupPart {
  private readonly modes: CopyAccountModeService; private readonly agents: CopyAgentService; private readonly returns: CopyLiveReturnRepository;
  private readonly exchange: CopyFundingExchangeClient; private readonly walletRows: CopyWalletRepository; private readonly mandates: CopyLiveMandateRepository;
  private readonly uow: UnitOfWork; private readonly fundingRows: CopyFundingRepository; private readonly capacity: SetupRestCapacity | null; private readonly setupBudget: LiveBudget | null;
  constructor(ctx: SetupContext, deps: SetupStepDeps) {
    super(ctx);
    this.modes = deps.modes; this.agents = deps.agents; this.returns = deps.returns; this.exchange = deps.exchange; this.walletRows = deps.walletRows;
    this.mandates = deps.mandates; this.uow = deps.uow; this.fundingRows = deps.fundingRows; this.capacity = deps.capacity; this.setupBudget = deps.setupBudget;
  }

  async step(row: SetupRow, signer: SetupSigner | null): Promise<SetupRow> {
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
      // Each step's local weight first (the setup bucket, its place kept
      // across passes), then its shared claim: no local wait comes after a
      // grant (the reviewer's 2026-10-13 item, as the mode step since 7076006b).
      case 'mode_set': return this.withCapacity(row, AGENT_STEP_WEIGHT, reservation => this.agentStep(row, intent, signer, reservation),
        { local: async () => this.agents.reserveForSetup?.(AGENT_STEP_WEIGHT, setupHoldKey(row)) });
      case 'agent_active': {
        const due = builderFeeDue(row, intent);
        return this.withCapacity(row, due ? BUILDER_STEP_WEIGHT : 0, reservation => this.builderStep(row, intent, signer, reservation),
          { local: due ? async () => this.setupBudget?.reserve?.(BUILDER_FEE_READ_WEIGHT, { holdKey: setupHoldKey(row) }) : undefined });
      }
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
   *
   * Admission happens before the step's first read, in this order:
   * - `local`: the step's weight from this process's bucket (cheap, one
   *   process; its place in the bucket's queue is kept across passes). Taken
   *   first, so the shared grant's hold is never spent waiting on it, and no
   *   local wait comes after the step started charging (gate 2026-10-13:
   *   `local_budget` 613 after a grant).
   * - the shared claim: `weight` and `connects` socket connects, held for the
   *   step once granted (its reads draw it; none of them is refused partway).
   *   While it waits, the local reservation is parked for the next pass.
   * A step that ends gives back what its grant still holds; one that waits
   * (a budget wait) keeps it for its next pass, whose claim continues it.
   * A wait keeps its own reason and bucket (a local bucket's wait inside the
   * step was logged as `shared_capacity`/`shared:setup`).
   */
  private async withCapacity(row: SetupRow, weight: number, step: (reservation?: LiveBudgetReservation) => Promise<SetupRow>,
    { local, connects }: { local?: () => Promise<LiveBudgetReservation | void>; connects?: number } = {}): Promise<SetupRow> {
    const capacity = this.capacity;
    if (!capacity || weight <= 0) return this.withLocal(local, step);
    let reservation: LiveBudgetReservation | undefined;
    try { reservation = (await local?.()) ?? undefined; }
    catch (error) {
      // Still gathering locally: its place in the shared queue meanwhile
      // (background starts to leave its need), never a grant.
      if (error instanceof HyperliquidBudgetWait) await capacity.claimSetup(weight, row.id, undefined, connects || undefined, true)
        .catch((queued: unknown) => this.logger.warn(`setup ${row.id} not queued: ${safeErrorText(queued)}`));
      throw error;
    }
    try {
      let waitMs: number, meter: HyperliquidMeterComposition | undefined;
      try { waitMs = await capacity.claimSetup(weight, row.id, observed => { meter = observed; }, connects || undefined); }
      catch (error) {
        const wait = sharedCapacityWait(error);
        if (wait) { reservation?.park?.(); reservation = undefined; throw wait; }
        // A demand that could not be recorded: the step runs as before (its
        // own charges still go through the meter).
        this.logger.warn(`setup capacity not claimed: ${safeErrorText(error)}`);
        waitMs = 0;
      }
      if (waitMs > 0) {
        this.logClaimWait(row.id, weight, waitMs, meter);
        reservation?.park?.(); reservation = undefined;
        throw new HyperliquidBudgetWait(Math.min(SETUP_CLAIM_RENEW_MS, Math.max(SHARED_CAPACITY_MIN_RETRY_MS, waitMs + 250)), 'shared_capacity', { weight, bucket: 'shared:setup' });
      }
      let ended = true;
      try { return await capacity.runSetup(() => step(reservation), row.id); }
      catch (error) {
        const wait = sharedCapacityWait(error);
        ended = !wait;
        if (wait && wait.retryMs > SETUP_CLAIM_RENEW_MS) throw new HyperliquidBudgetWait(SETUP_CLAIM_RENEW_MS, wait.reason, { weight, bucket: 'shared:setup', ...wait.detail });
        throw error;
      } finally {
        if (ended) await capacity.releaseSetup?.(row.id).catch((error: unknown) => this.logger.warn(`setup ${row.id} grant not released: ${safeErrorText(error)}`));
      }
    } finally { reservation?.release(); }
  }
  /** A step without the shared meter: its local weight first, then the step. */
  private async withLocal(local: (() => Promise<LiveBudgetReservation | void>) | undefined, step: (reservation?: LiveBudgetReservation) => Promise<SetupRow>): Promise<SetupRow> {
    const reservation = (await local?.()) ?? undefined;
    try { return await step(reservation); } finally { reservation?.release(); }
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
    // A signing claim never attempted may be recovered by that observation
    // (back to prepared) and then submitted in the same step: the whole
    // attempt is paid and claimed up front, as for a prepared one, so its
    // submit never reserves locally after the grant.
    const full = !inFlight || op.submissionState === 'signing' && !op.attemptedAt;
    // Its local weight first (kept in the bucket's queue across passes), then
    // its shared claim with the attempt's socket connects: nothing of the step
    // waits or is refused once its first read went out.
    const local = () => this.modes.reserveForSetup(full ? ATTEMPT_STEP_WEIGHT : ACCOUNT_MODE_OBSERVE_WEIGHT, setupHoldKey(row));
    return this.withCapacity(row, full ? ACCOUNT_MODE_STEP_WEIGHT : ACCOUNT_MODE_OBSERVE_WEIGHT,
      reservation => this.modeAttempt(row, intent, signer, operation, inFlight, full, reservation), { local, connects: full ? ATTEMPT_SOCKET_CONNECTS : 0 });
  }
  private async modeAttempt(row: SetupRow, intent: LiveCopySetupIntent, signer: SetupSigner | null, op: { id: string }, inFlight: boolean, full: boolean, reservation?: LiveBudgetReservation): Promise<SetupRow> {
    if (inFlight) {
      // Its observation is paid from the step's reservation; what is left of
      // it (a full step's: the attempt's) pays the submit below.
      const observed = await this.modes.reconcile(row.userId, op.id, { busy: 'throw', reservation });
      if (observed.targetState === 'supported') return this.move(row, 'mode_set');
      if (observed.targetState === 'unsupported' || observed.submissionState === 'rejected') throw new Fail('setup_account_mode_failed');
      if (observed.submissionState !== 'prepared') { this.assertBeforeDeadline(row); throw new Wait('account_mode_pending', this.timings.retry.pendingMs); }
      // Recovered, but this step claimed only an observation: the next pass
      // claims the whole attempt (local, then shared) before submitting it.
      if (!full) throw new Wait('account_mode_pending', SHARED_CAPACITY_MIN_RETRY_MS);
    }
    this.assertBeforeDeadline(row);
    const active = this.requireSigner(signer);
    const result = await this.modes.submit(row.userId, op.id, { kind: 'setup', consentDigest: row.consentDigest!, sign: async (master, modeIntent, assertFresh) => {
      assertFresh();
      if (master.address !== intent.accountAddress || modeIntent.accountAddress !== intent.accountAddress) throw new Fail('setup_binding_changed');
      return active.sign(master, modeTypedData(modeIntent), { network: intent.network, account: intent.accountAddress }, modeIntent.consentExpiresAt);
    } }, { reservation });
    if (result.targetState === 'supported') return this.move(row, 'mode_set');
    if (result.submissionState === 'rejected') throw new Fail('setup_account_mode_failed');
    throw new Wait('account_mode_pending', this.timings.retry.pendingMs);
  }

  private async agentStep(row: SetupRow, intent: LiveCopySetupIntent, signer: SetupSigner | null, reservation?: LiveBudgetReservation): Promise<SetupRow> {
    let agent = await this.agents.row(row.userId, row.agentSetupId!);
    if (agent.state === 'active') return this.move(row, 'agent_active');
    if (agent.state === 'blocked' || agent.state === 'revoked') throw new Fail('setup_agent_rejected');
    if (agent.state !== 'ready') {
      await this.agents.reconcile(row.userId, agent.id, { reservation }); agent = await this.agents.row(row.userId, agent.id);
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
    } }, { reservation });
    if (result.state === 'active') return this.move(row, 'agent_active');
    if (result.state === 'blocked') throw new Fail('setup_agent_rejected');
    throw new Wait('agent_approval_pending', this.timings.retry.pendingMs);
  }

  /** A fee of 0 (testnet's decision 7; a live deployment for now) is skipped. Otherwise the
   * consented builder and rate, once, then observed on the exchange. */
  private async builderStep(row: SetupRow, intent: LiveCopySetupIntent, signer: SetupSigner | null, reservation?: LiveBudgetReservation): Promise<SetupRow> {
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
      const cap = await this.exchange.maxBuilderFee(intent.network, intent.accountAddress, intent.builderAddress, reservation).catch((error: unknown) => {
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
