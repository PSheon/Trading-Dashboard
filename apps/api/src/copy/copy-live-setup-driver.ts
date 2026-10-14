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
import { ALERT_EVERY_MS, AWAITING_CREDIT_ALERT_AFTER_MS } from '../config/constants/alerts.js';
import { ABANDONED_APPROVAL_WINDOW_MS, AWAITING_CREDIT_MAX_WAIT_MS } from '../config/constants/timings.js';

/**
 * The worker's side of a live copy setup: the pass (tick), one setup under a lease (drive), and what
 * an unfinished step does next (failed, awaitCredit). The pass goes through the service's own `drive`
 * (`hooks.drive`) so a spy on it sees every drive. Lease, step budget and retries:
 * AppConfig.copy.live.setup (startup refuses a step budget that does not fit the lease).
 */
/** Failures that are the deadline passing (the setup ends `expired`). */
const EXPIRED_ISSUES: readonly string[] = ['setup_expired', 'setup_deposit_uncredited'];
/** An expired identity proof's timing (AgentIdentityEvidenceExpired), for the log. */
function identityTiming(error: unknown): { elapsedMs?: number; spans?: unknown } {
  if (!error || typeof error !== 'object' || !('spans' in error) || !Array.isArray(error.spans)) return {};
  const elapsedMs = 'elapsedMs' in error && typeof error.elapsedMs === 'number' ? error.elapsedMs : undefined;
  return { ...(elapsedMs !== undefined ? { elapsedMs } : {}), spans: error.spans };
}


interface SetupDriverDeps {
  readonly steps: SetupSteps; readonly provisioning: SetupProvisioning; readonly agents: CopyAgentService; readonly aborts: CopyLiveSetupAbortService | null;
  readonly capacity: SetupRestCapacity | null; readonly workerSigner: WorkerMasterSigner | null; readonly walletRows: CopyWalletRepository;
}
/** The service's own public methods the pass goes through. */
interface SetupDriverHooks { drive(id: string, signer: SetupSigner | null): Promise<SetupRow> }

export class SetupDriver extends SetupPart {
  private readonly steps: SetupSteps; private readonly provisioning: SetupProvisioning; private readonly agents: CopyAgentService; private readonly aborts: CopyLiveSetupAbortService | null;
  private readonly capacity: SetupRestCapacity | null; private readonly workerSigner: WorkerMasterSigner | null; private readonly walletRows: CopyWalletRepository;
  constructor(ctx: SetupContext, deps: SetupDriverDeps, private readonly hooks: SetupDriverHooks) {
    super(ctx);
    this.steps = deps.steps; this.provisioning = deps.provisioning; this.agents = deps.agents; this.aborts = deps.aborts;
    this.capacity = deps.capacity; this.workerSigner = deps.workerSigner; this.walletRows = deps.walletRows;
  }

  /** The worker quorum under the owner's policy, recorded on the account at confirm; null when
   * absent, detached, or the worker can't sign here. */
  async workerPolicySigner(row: SetupRow): Promise<SetupSigner | null> {
    if (!this.workerSigner?.available || !row.accountId) return null;
    const account = await this.walletRows.account(row.accountId, row.userId);
    if (!account?.masterPolicyId || !account.masterSignerQuorumId || account.signerDetachedAt) return null;
    const signer = this.workerSigner;
    return { sign: (master, data, bound, deadline) => signer.sign({ ...master, workerQuorumId: account.masterSignerQuorumId!, policyId: account.masterPolicyId! }, data, bound, deadline) };
  }
  /** The worker's pass: every confirmed, unfinished setup that is due. */
  async tick(): Promise<number> {
    // Each abort runs as a tracked job so slow proof reads never block copy execution.
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
   * Approvals left in flight when their setup ended: reconciled here (a few a pass, each at most once a
   * minute, within ABANDONED_APPROVAL_WINDOW_MS, after which the nonce can't land). Read-only: nothing
   * is signed or sent.
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
  /** Advances one setup under a lease. Without the worker's signer it waits
   * (`worker_signer_unavailable`) until its deadline. */
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
          // A late failure never overwrites a terminal outcome reached meanwhile.
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
   * What an unfinished step does next, by decideRetry (live/error-class.ts) under setupRetryPolicy:
   * - wait: back at its time, never an attempt; a weight wait is logged and kept as lastWait.
   * - owner: code shown, retried; an exhausted identity proof becomes IDENTITY_UNVERIFIED_ISSUE (ALERT once).
   * - end: failed, or expired for a deadline.
   * - retry: one attempt more, backed off.
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
   * Deposit not credited yet: a doubling wait (at most AWAITING_CREDIT_MAX_WAIT_MS) counted in
   * lastWait.waits, never an attempt. Only the first wait is a revision; later ones defer. A
   * rate-limited ALERT past AWAITING_CREDIT_ALERT_AFTER_MS since confirm.
   */
  private async awaitCredit(row: SetupRow, now: number): Promise<SetupRow> {
    const prior = row.lastWait?.step === row.stage && row.lastWait.reason === 'awaiting_credit' ? row.lastWait : null;
    const waits = (prior?.waits ?? 0) + 1;
    const retryMs = Math.min(AWAITING_CREDIT_MAX_WAIT_MS, this.timings.retry.pendingMs * 2 ** Math.min(waits - 1, 16));
    let alertedAt = prior?.alertedAt;
    const since = row.confirmedAt?.getTime();
    if (since !== undefined && now - since > AWAITING_CREDIT_ALERT_AFTER_MS && (!alertedAt || !(now - Date.parse(alertedAt) < ALERT_EVERY_MS))) {
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
