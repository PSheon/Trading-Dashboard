import { HttpException } from '@nestjs/common';
import { liveCopySetupIntentSchema, liveSetupAgentName, LIVE_SETUP_CONSENT_WINDOW_MS, LIVE_SETUP_DEADLINE_MS, LIVE_SETUP_VALID_DAYS } from '@trading-dashboard/shared/contracts';
import type { DbExecutor } from '../db/unit-of-work.js';
import { CopyAgentService } from './copy-agent.service.js';
import { CopyFundingRepository } from './copy-funding.repository.js';
import { CopyFundingService } from './copy-funding.service.js';
import { liveCopySettingsDigest } from './copy-live-mandate-consent.js';
import { CopyLiveMandateRepository } from './copy-live-mandate.repository.js';
import type { SetupRow } from './copy-live-setup.repository.js';
import { CopyWalletRepository } from './copy-wallet.repository.js';
import { CopyWalletService } from './copy-wallet.service.js';
import { safeErrorText } from '../runtime/safe-error-text.js';
import { LeaderActivityService } from '../traders/leader-activity.service.js';
import { digest, Fail, refuse, SetupPart, setupFundingKey, Wait, type SetupContext } from './copy-live-setup-shared.js';
import { SETUP_DEPOSIT_NONCE_REFRESH_MS } from '../config/constants/timings.js';

/** What a setup prepares before consent (wallet, agent, deposit reservation, worker policy) and the
 * consent challenge itself, for a start or an edit. */
interface SetupProvisioningDeps {
  readonly wallets: CopyWalletService; readonly agents: CopyAgentService; readonly funding: CopyFundingService; readonly fundingRows: CopyFundingRepository;
  readonly mandates: CopyLiveMandateRepository; readonly walletRows: CopyWalletRepository; readonly leaderActivity: Pick<LeaderActivityService, 'copyActivity'> | null;
}

export class SetupProvisioning extends SetupPart {
  private readonly wallets: CopyWalletService; private readonly agents: CopyAgentService; private readonly funding: CopyFundingService; private readonly fundingRows: CopyFundingRepository;
  private readonly mandates: CopyLiveMandateRepository; private readonly walletRows: CopyWalletRepository; private readonly leaderActivity: Pick<LeaderActivityService, 'copyActivity'> | null;
  constructor(ctx: SetupContext, deps: SetupProvisioningDeps) {
    super(ctx);
    this.wallets = deps.wallets; this.agents = deps.agents; this.funding = deps.funding; this.fundingRows = deps.fundingRows;
    this.mandates = deps.mandates; this.walletRows = deps.walletRows; this.leaderActivity = deps.leaderActivity;
  }

  /** A mainnet leader trading faster than a copy can follow (`leaderActivityVerdict`) is refused
   * before anything is created; unreadable activity refuses too (fail closed). */
  async assertLeaderFits(leader: string) {
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

  /** Provider-only preparation, then the consent challenge. No challenge without the worker's
   * policy: the worker signs every step after confirm. */
  async provisionLeased(id: string): Promise<SetupRow> {
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
      // A cancelled/superseded revision never authorizes another child or a renewed challenge.
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
      // A reserved deposit's nonce executes for FUNDING_NONCE_EXPIRY_MS (two days): a day in,
      // reserve a new one, so what the owner signs always has a day left (the margin is intentional).
      if (deposit && this.now() - deposit.nonce > SETUP_DEPOSIT_NONCE_REFRESH_MS) { await this.fundingRows.cancel(userId, deposit.id); deposit = null; }
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

  /** Ends an abandoned start (never-sent deposit cancelled, strategy stopped); a sent deposit stays
   * with its still-going setup. */
  async endAbandoned(tx: DbExecutor, row: SetupRow): Promise<void> {
    if (['provisioning', 'awaiting_consent'].includes(row.stage) && row.fundingOperationId) {
      const deposit = await this.fundingRows.find(row.userId, row.fundingOperationId);
      if (deposit.attemptedAt) return;
    }
    const ended = await this.repository.transition(row, { stage: 'cancelled', nextAttemptAt: null, ...(['provisioning', 'awaiting_consent'].includes(row.stage) ? { issue: null } : {}) }, tx);
    if (ended) await this.repository.endStart(tx, row.userId, row);
  }

  async rechallengeChange(original: SetupRow): Promise<SetupRow> {
    const row = original;
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

}
