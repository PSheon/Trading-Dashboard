import { DRIVEN_STAGES, type SetupRow, type SetupWait } from './copy-live-setup.repository.js';
import { decideRetry, IDENTITY_UNVERIFIED_ISSUE, StepWait } from './live/error-class.js';
import { setupRetryPolicy } from '../config/live-timings.js';
import { HyperliquidBudgetWait } from '../hyperliquid/hyperliquid-budget-wait.js';
import { CopyAgentService } from './copy-agent.service.js';
import { CopyLiveSetupAbortService } from './copy-live-setup-abort.service.js';
import { CopyWalletRepository } from './copy-wallet.repository.js';
import { safeErrorText } from '../runtime/safe-error-text.js';
import type { WorkerMasterSigner } from './live/privy-policy-master-signer.js';
import { explorerHealth } from './explorer-health.js';
import { SetupPart, type SetupContext, type SetupSigner } from './copy-live-setup-shared.js';
import type { SetupProvisioning } from './copy-live-setup-provisioning.js';
import type { SetupRestCapacity, SetupSteps } from './copy-live-setup-steps.js';

/**
 * The worker's side of a live copy setup: its pass over every due setup
 * (tick), one setup advanced as far as it can go under a lease (drive),
 * and what a step that did not finish does next (failed, awaitCredit).
 * Composed by CopyLiveSetupService, whose own `drive` the pass goes through
 * (`hooks.drive`), so a test's spy on the service sees every drive.
 */
// The driver's lease, a step's budget inside it (reserve wait, signature,
// POST), the HTTP answer and confirm waits and the retries are
// AppConfig.copy.live.setup (config/live-timings.ts): startup refuses a step
// budget that does not fit the lease.
/** How long after its setup ended an approval left unknown is still looked at. */
const ABANDONED_APPROVAL_WINDOW_MS = 3 * 86_400_000;
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
/** An expired identity proof's timing (AgentIdentityEvidenceExpired), for the log. */
function identityTiming(error: unknown): { elapsedMs?: number; spans?: unknown } {
  if (!error || typeof error !== 'object' || !('spans' in error) || !Array.isArray(error.spans)) return {};
  const elapsedMs = 'elapsedMs' in error && typeof error.elapsedMs === 'number' ? error.elapsedMs : undefined;
  return { ...(elapsedMs !== undefined ? { elapsedMs } : {}), spans: error.spans };
}


export interface SetupDriverDeps {
  readonly steps: SetupSteps; readonly provisioning: SetupProvisioning; readonly agents: CopyAgentService; readonly aborts: CopyLiveSetupAbortService | null;
  readonly capacity: SetupRestCapacity | null; readonly workerSigner: WorkerMasterSigner | null; readonly walletRows: CopyWalletRepository;
}
/** The service's own public methods the pass goes through. */
export interface SetupDriverHooks { drive(id: string, signer: SetupSigner | null): Promise<SetupRow> }

export class SetupDriver extends SetupPart {
  private readonly steps: SetupSteps; private readonly provisioning: SetupProvisioning; private readonly agents: CopyAgentService; private readonly aborts: CopyLiveSetupAbortService | null;
  private readonly capacity: SetupRestCapacity | null; private readonly workerSigner: WorkerMasterSigner | null; private readonly walletRows: CopyWalletRepository;
  constructor(ctx: SetupContext, deps: SetupDriverDeps, private readonly hooks: SetupDriverHooks) {
    super(ctx);
    this.steps = deps.steps; this.provisioning = deps.provisioning; this.agents = deps.agents; this.aborts = deps.aborts;
    this.capacity = deps.capacity; this.workerSigner = deps.workerSigner; this.walletRows = deps.walletRows;
  }

  /** The worker's signer for this setup's account: the worker quorum under
   * the owner's policy, recorded on the account at confirm. Null when the
   * account has none (or it was taken off), or the worker can't sign here. */
  async workerPolicySigner(row: SetupRow): Promise<SetupSigner | null> {
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
      try { if (row.stage === 'provisioning') await this.provisioning.provisionLeased(row.id); else await this.hooks.drive(row.id, await this.workerPolicySigner(row)); worked++; }
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
        try { row = await this.steps.step(row, signer); }
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
   * Records what a step that did not finish does next: decideRetry
   * (live/error-class.ts, THE retry policy of every live step) under the
   * setup's policy (setupRetryPolicy):
   * - wait (a Hyperliquid weight, or a step waiting on what it started):
   *   back at its time, never an attempt. A weight wait is logged and kept
   *   on the row (lastWait, with how many waits this stage had): a setup
   *   looping on hyperliquid_busy says which bucket and why.
   * - owner: the code is shown; looked at again, never exhausted. A Privy
   *   identity proof that kept expiring arrives here exhausted
   *   (IDENTITY_UNVERIFIED_ISSUE) with an ALERT the first time.
   * - end: the setup ends (failed, or expired for a deadline).
   * - retry: one attempt more, backed off (a failed provider read at least
   *   PROVIDER_READ_RETRY_MS, as a leg's and a stop's).
   */
  private async failed(row: SetupRow, error: unknown): Promise<SetupRow> {
    const decision = decideRetry(error, row.attempts, setupRetryPolicy(this.timings)), now = this.now();
    const issue = decision.classified.code ?? 'setup_step_pending';
    const end = async (code: string, changes: Partial<SetupRow> = {}) =>
      (await this.repository.transition(row, { stage: EXPIRED_ISSUES.includes(code) ? 'expired' : 'failed', issue: code, nextAttemptAt: null, ...changes })) ?? row;
    switch (decision.kind) {
      case 'wait': {
        if (error instanceof StepWait && error.issue === 'awaiting_credit') return this.awaitCredit(row, now);
        const retryMs = decision.delayMs;
        if (!(error instanceof HyperliquidBudgetWait)) return (await this.repository.transition(row, { issue, nextAttemptAt: new Date(now + retryMs) })) ?? row;
        const waits = (row.lastWait?.step === row.stage ? row.lastWait.waits ?? 0 : 0) + 1;
        const lastWait: SetupWait = { at: new Date(now).toISOString(), step: row.stage, reason: error.reason, retryMs: Math.ceil(retryMs), waits, ...error.detail };
        this.logger.warn(`setup ${row.id} hyperliquid_busy ${JSON.stringify({ setupId: row.id, attempts: row.attempts, ...lastWait })}`);
        return (await this.repository.transition(row, { issue: 'hyperliquid_busy', lastWait, nextAttemptAt: new Date(now + retryMs) })) ?? row;
      }
      case 'owner': {
        if (!decision.exhausted) return (await this.repository.transition(row, { issue, nextAttemptAt: new Date(now + decision.delayMs) })) ?? row;
        const fields = { setupId: row.id, stage: row.stage, code: decision.classified.code, attempts: decision.attempts, ...identityTiming(error) };
        if (row.issue !== IDENTITY_UNVERIFIED_ISSUE) this.logger.error(`ALERT setup identity unverified ${JSON.stringify(fields)}`);
        else this.logger.warn(`setup ${row.id} identity still unverified ${JSON.stringify(fields)}`);
        return (await this.repository.transition(row, { issue: IDENTITY_UNVERIFIED_ISSUE, attempts: decision.attempts, nextAttemptAt: new Date(now + decision.delayMs) })) ?? row;
      }
      case 'end': {
        if (!decision.exhausted) return end(issue);
        const code = decision.classified.code ?? 'setup_step_failed';
        this.logger.warn(`setup ${row.id} ${code} after ${decision.attempts} attempts at ${row.stage}: ${safeErrorText(error)}`);
        return end(code, { attempts: decision.attempts });
      }
      case 'retry': return (await this.repository.transition(row, { issue, attempts: decision.attempts, nextAttemptAt: new Date(now + decision.delayMs) })) ?? row;
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
}
