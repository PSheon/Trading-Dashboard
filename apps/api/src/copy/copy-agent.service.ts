import { BadRequestException, ConflictException, Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { copyAgentSetupSchema, prepareCopyAgentSchema, type CopyAgentSetup, type CopyAgentOverview } from "@trading-dashboard/shared/contracts";
import { verifyTypedData } from "viem";
import { AppConfig } from "../config/app-config.js";
import { UnitOfWork } from "../db/unit-of-work.js";
import { CopyWalletService } from "./copy-wallet.service.js";
import { CopyAgentRepository, type AgentSetupRow } from "./copy-agent.repository.js";
import { AGENT_APPROVAL_CLIENT, AGENT_OBSERVE_WEIGHT, type AgentApprovalClient } from "./copy-agent-exchange.client.js";
import { agentApprovalTypedData, type AgentConsentIntent } from "./copy-agent-consent.js";
import { AgentProvisioningConflict, USER_AGENT_PROVISIONER, type UserAgentProvisioner } from "./live/privy-agent-provisioner.js";
import { LiveBoundaryError } from "./live/wallet-authorization.js";
import { errorLogFields, safeErrorText } from "../runtime/safe-error-text.js";
import { deploymentNetwork } from "./live-deployment.js";
import { FUNDING_NONCE_EXPIRY_MS } from "./copy-funding-scan.js";
import { takeReserved, type LiveBudgetReservation } from "../hyperliquid/hyperliquid-budget-wait.js";
import { allInOrder, IdentitySpans, privyIdentityFresh, type IdentitySpan } from "./live/privy-identity-freshness.js";

/** An identity proof slower than this is logged with its spans (the bound it
 * had before 2026-10-13, copied from the exchange's evidence checks). */
const SLOW_IDENTITY_PROOF_MS = 5_000;
/** The exchange lists an agent whose grant still isn't recorded: an ALERT
 * past this long, and again every AGENT_APPROVED_UNRECORDED_ALERT_EVERY_MS. */
export const AGENT_APPROVED_UNRECORDED_ALERT_MS = 5 * 60_000;
export const AGENT_APPROVED_UNRECORDED_ALERT_EVERY_MS = 10 * 60_000;
/** The agent's identity proof aged past PRIVY_IDENTITY_MAX_AGE_MS: a wait
 * (transient), never a block. Carries the proof's read spans. */
export class AgentIdentityEvidenceExpired extends ConflictException {
  readonly elapsedMs: number | null; readonly spans: readonly IdentitySpan[];
  constructor(timing?: IdentitySpans) {
    super({ statusCode: 409, code: "agent_identity_evidence_expired", message: "agent_identity_evidence_expired" });
    this.elapsedMs = timing ? timing.elapsed() : null; this.spans = timing ? [...timing.spans] : [];
  }
}

function wire(row: AgentSetupRow): CopyAgentSetup {
  return copyAgentSetupSchema.parse({ id: row.id, strategyId: row.strategyId, accountId: row.accountId, network: row.network,
    state: row.state !== "revoked" && row.expiresAt.getTime() <= Date.now() ? "expired" : row.state,
    accountAddress: row.accountAddress, agentAddress: row.agentAddress, expiresAt: row.expiresAt.toISOString(),
    authorizationId: row.authorizationId, issue: row.issue, revision: row.revision, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
}
function consent(row: AgentSetupRow): AgentConsentIntent {
  if (!row.agentAddress || !row.policyId || !row.approvalNonce || !row.consentExpiresAt) throw new ConflictException("agent_consent_not_prepared");
  return { id: row.id, strategyId: row.strategyId, network: row.network, accountAddress: row.accountAddress,
    agentAddress: row.agentAddress, policyId: row.policyId, workerQuorumId: row.workerQuorumId,
    nonce: row.approvalNonce, expiresAt: row.expiresAt.getTime(), consentExpiresAt: row.consentExpiresAt.getTime() };
}

/** Who authorises one agent approval: a one-click setup whose consent
 * (verified at its confirm) bound this agent and expiry, signed by the worker
 * under the owner's policy (the only signing model, 2026-10-07). */
export type AgentApprovalAuthority =
  { readonly kind: "setup"; readonly consentDigest: string; sign(account: { walletId: string; address: string; ownerQuorumId: string }, intent: AgentConsentIntent, assertFresh: () => void): Promise<string> };

/** Separate explicit setup. An active grant alone never starts a strategy or
 * changes either its paper allocation or real execution capability. */
@Injectable()
export class CopyAgentService {
  private readonly logger = new Logger(CopyAgentService.name);
  constructor(private readonly repository: CopyAgentRepository, private readonly uow: UnitOfWork,
    private readonly config: AppConfig, private readonly wallets: CopyWalletService,
    @Inject(USER_AGENT_PROVISIONER) private readonly provider: UserAgentProvisioner,
    @Inject(AGENT_APPROVAL_CLIENT) private readonly exchange: AgentApprovalClient) {}
  get available() { return this.config.value.copy.mode !== "disabled" && this.provider.available && this.exchange.available; }
  private enabled() { if (!this.available || !this.provider.configuredWorkerQuorumId) throw new ServiceUnavailableException("agent_setup_unavailable"); }
  async overview(userId: number): Promise<CopyAgentOverview> {
    await this.repository.owner(userId);
    const rows = await Promise.all((await this.repository.list(userId)).map(row => this.repository.refreshGrant(row)));
    return { available: this.available, network: this.config.value.hyperliquid.wallet.network, setups: rows.map(wire) };
  }
  async prepare(userId: number, accountId: string, input: unknown) {
    this.enabled();
    const parsed = prepareCopyAgentSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("invalid_agent_setup");
    const account = await this.repository.account(userId, accountId);
    if (account.state !== "ready") throw new ConflictException("agent_account_not_ready");
    const verified = await this.wallets.reconcile(userId, accountId);
    if (verified.state !== "ready") throw new ConflictException("agent_account_not_ready");
    const row = await this.uow.run(tx => this.repository.ensure(tx, userId, accountId, parsed.data, this.provider.configuredWorkerQuorumId!, null, deploymentNetwork(this.config)));
    return this.reconcile(userId, row.id);
  }
  /** A one-click setup's agent (30 days by default): prepared and made
   * ready (policy and wallet) with no exchange call. `renewal` lets a new
   * agent be prepared while the current one has under three days left. */
  async prepareForSetup(userId: number, accountId: string, idempotencyKey: string, liveSetupId: string, validForDays: number, renewal = false): Promise<AgentSetupRow> {
    this.enabled();
    const verified = await this.wallets.reconcile(userId, accountId);
    if (verified.state !== "ready") throw new ConflictException("agent_account_not_ready");
    const row = await this.uow.run(tx => this.repository.ensure(tx, userId, accountId, { idempotencyKey, validForDays }, this.provider.configuredWorkerQuorumId!, { liveSetupId, renewal }, deploymentNetwork(this.config)));
    await this.reconcile(userId, row.id);
    return this.repository.find(userId, row.id);
  }
  async row(userId: number, id: string) { return this.repository.refreshGrant(await this.repository.find(userId, id)); }
  /** The approval's nonce for a setup (its own five-minute window to sign and send). */
  async challengeRow(userId: number, id: string): Promise<AgentConsentIntent> {
    this.enabled();
    const row = await this.repository.find(userId, id);
    await this.assertSetup(userId, row);
    return consent(await this.uow.run(tx => this.repository.challenge(tx, userId, id)));
  }
  /**
   * The agent's identity proof: the copy account and the agent wallet, its
   * policy and the worker quorum as Privy holds them, matching the row, with
   * the database state read before and after. The Privy reads are
   * independent and run together (before 2026-10-13 they ran one after
   * another: about twelve Privy round trips, more than 5 s over a phone
   * hotspot, so the proof never passed). Its age runs from its first read
   * (`checkedAt`) and is bounded by PRIVY_IDENTITY_MAX_AGE_MS; each read is
   * timed, and the spans go with an expiry and into the log when slow.
   */
  private async assertSetup(userId: number, row: AgentSetupRow) {
    const checkedAt = Date.now(), timing = new IdentitySpans(checkedAt);
    if (row.network !== deploymentNetwork(this.config) || row.workerQuorumId !== this.provider.configuredWorkerQuorumId ||
      row.expiresAt.getTime() <= Date.now() || row.state === "revoked" || row.state === "blocked") throw new ConflictException("agent_setup_changed");
    if (!row.policyId || !row.agentWalletId || !row.agentAddress || !row.agentOwnerQuorumId) throw new ConflictException("agent_not_ready");
    const { owner } = await timing.time("db_current", () => this.repository.assertCurrent(userId, row));
    const expected = { userId: owner.privyUserId, policyId: row.policyId, expiresAt: row.expiresAt.getTime(), externalId: row.externalId };
    const [master, , policy, agent] = await allInOrder([
      timing.time("privy_master_account", () => this.wallets.reconcile(userId, row.accountId)),
      timing.time("privy_worker_quorum", () => this.provider.verifyWorkerQuorum()),
      timing.time("privy_policy", () => this.provider.verifyPolicy(expected)),
      timing.time("privy_agent_wallet", () => this.provider.findOwned(expected)),
    ] as const);
    if (master.state !== "ready" || master.address !== row.accountAddress) throw new ConflictException("agent_account_changed");
    if (!agent || policy.id !== row.policyId || policy.fingerprint !== row.policyFingerprint || agent.id !== row.agentWalletId ||
      agent.address !== row.agentAddress || agent.externalId !== row.externalId || agent.ownerQuorumId !== row.agentOwnerQuorumId ||
      agent.policyId !== row.policyId || agent.workerQuorumId !== row.workerQuorumId) throw new ConflictException("agent_identity_changed");
    const current = await timing.time("db_current_after", () => this.repository.assertCurrent(userId, row));
    // The old bound, for the log: how often a proof would have expired.
    if (timing.elapsed() > SLOW_IDENTITY_PROOF_MS) this.logger.warn(`agent ${row.id} identity proof slow ${JSON.stringify(timing)}`);
    this.assertFresh(checkedAt, timing);
    return { ...current, checkedAt };
  }
  private assertFresh(checkedAt: number, timing?: IdentitySpans) {
    if (!privyIdentityFresh(checkedAt)) throw new AgentIdentityEvidenceExpired(timing);
  }
  private assertConsentFresh(intent: AgentConsentIntent, checkedAt: number) {
    this.assertFresh(checkedAt);
    this.enabled();
    if (intent.network !== this.config.value.hyperliquid.wallet.network || intent.workerQuorumId !== this.provider.configuredWorkerQuorumId ||
      Date.now() >= intent.consentExpiresAt || Date.now() >= intent.expiresAt) throw new ConflictException("agent_consent_expired");
  }
  /** A copy setup's agent step weight (its approval's POST and the
   * observation after it), from the setup's bucket before its shared claim
   * (`key`: the setup's; kept in the bucket's queue across passes). The step
   * passes it to `submit`/`reconcile`, which take from it instead of
   * reserving after the claim was granted. */
  async reserveForSetup(weight: number, key: string): Promise<LiveBudgetReservation | void> {
    return this.exchange.reserveForSetup?.(weight, key);
  }
  async reconcile(userId: number, id: string, { reservation }: { reservation?: LiveBudgetReservation | void } = {}): Promise<CopyAgentSetup> {
    this.enabled();
    let row = await this.repository.refreshGrant(await this.repository.find(userId, id));
    if (row.state === "blocked" || row.state === "revoked" || row.expiresAt.getTime() <= Date.now()) return wire(row);
    await this.repository.assertCurrent(userId, row);
    const owner = await this.repository.owner(userId);
    try {
      if (row.state === "policy_prepared") {
        const claimed = await this.repository.transition(row, { state: "policy_unknown", policyStartedAt: new Date(), policyRequestExpiry: Date.now() + 60_000 });
        if (!claimed) return wire(await this.repository.find(userId, id));
        row = claimed;
        await this.repository.assertCurrent(userId, row);
        const result = await this.provider.createPolicy({ userId: owner.privyUserId, attemptId: row.policyAttemptId,
          expiresAt: row.expiresAt.getTime(), requestExpiry: row.policyRequestExpiry! });
        row = (await this.repository.transition(row, { policyId: result.id })) ?? await this.repository.find(userId, id);
      }
      if (row.state === "policy_unknown") {
        // Lost policy POST response has no durable provider lookup. Never create
        // another policy automatically or silently renew its idempotency window.
        if (!row.policyId) return wire(row);
        const verified = await this.provider.verifyPolicy({ userId: owner.privyUserId, policyId: row.policyId, expiresAt: row.expiresAt.getTime() });
        if (verified.id !== row.policyId || !/^[0-9a-f]{64}$/.test(verified.fingerprint)) throw new AgentProvisioningConflict();
        row = (await this.repository.transition(row, { state: "wallet_prepared", policyFingerprint: verified.fingerprint, issue: null })) ?? await this.repository.find(userId, id);
      }
      if (row.state === "wallet_prepared" || row.state === "wallet_unknown") {
        if (!row.policyId) throw new AgentProvisioningConflict();
        const expected = { userId: owner.privyUserId, externalId: row.externalId, policyId: row.policyId, expiresAt: row.expiresAt.getTime() };
        let found = await this.provider.findOwned(expected);
        if (!found && row.state === "wallet_prepared") {
          const claimed = await this.repository.transition(row, { state: "wallet_unknown" });
          if (!claimed) return wire(await this.repository.find(userId, id));
          row = claimed;
          await this.repository.assertCurrent(userId, row);
          await this.provider.createWallet(expected);
          found = await this.provider.findOwned(expected);
        }
        if (!found) return wire(row);
        if (found.externalId !== row.externalId || found.policyId !== row.policyId || found.workerQuorumId !== row.workerQuorumId ||
          !/^0x[0-9a-f]{40}$/.test(found.address) || found.address === row.accountAddress) throw new AgentProvisioningConflict();
        row = (await this.repository.transition(row, { state: "ready", agentWalletId: found.id, agentAddress: found.address, agentOwnerQuorumId: found.ownerQuorumId, issue: null })) ?? await this.repository.find(userId, id);
      }
      if (row.state === "approval_unknown" && row.approvalAttemptedAt) return await this.observe(userId, row, reservation);
      if (row.state === "approval_signing" && !row.approvalAttemptedAt && row.consentExpiresAt && row.consentExpiresAt.getTime() <= Date.now()) {
        row = (await this.repository.transition(row, { state: "ready", consentDigest: null, issue: "agent_consent_expired" })) ?? await this.repository.find(userId, id);
      }
      return wire(row);
    } catch (error) {
      if (error instanceof AgentProvisioningConflict) await this.repository.transition(row, { state: "blocked", issue: "agent_identity_changed" });
      // The first time only: a repeat changes nothing (no new revision every
      // pass; gate run 8 climbed one about every 10 s while nothing was sent).
      else if (row.issue !== "agent_verification_pending") {
        this.logger.warn(`agent ${id} verification pending ${JSON.stringify({ state: row.state, ...errorLogFields(error) })}`);
        await this.repository.transition(row, { issue: "agent_verification_pending" });
      }
      return wire(await this.repository.find(userId, id));
    }
  }
  /** One approval attempt of the exact prepared agent; durable before the
   * POST, and an attempted approval is only observed, never resent. */
  async submit(userId: number, id: string, authority: AgentApprovalAuthority, { reservation }: { reservation?: LiveBudgetReservation | void } = {}): Promise<CopyAgentSetup> {
    this.enabled();
    let row = await this.repository.refreshGrant(await this.repository.find(userId, id));
    if (row.state === "active") return wire(row);
    if (row.state === "approval_unknown" || row.state === "approval_signing") return this.reconcile(userId, id, { reservation });
    if (row.state !== "ready") throw new ConflictException("agent_consent_required");
    const intent = consent(row);
    const initialProof = await this.assertSetup(userId, row);
    const { account } = initialProof;
    if (!/^[0-9a-f]{64}$/.test(authority.consentDigest) || row.liveSetupId === null || Date.now() < intent.nonce || Date.now() >= intent.consentExpiresAt) throw new BadRequestException("invalid_agent_consent");
    const claimed = await this.uow.run(async tx => {
      await this.repository.assertCurrent(userId, row, tx);
      return this.repository.transition(row, { state: "approval_signing", consentDigest: authority.consentDigest }, tx);
    });
    if (!claimed) return this.reconcile(userId, id, { reservation });
    row = claimed;
    let signature: string;
    let proofCheckedAt: number;
    try {
      const master = { walletId: account.privyWalletId!, address: account.address!, ownerQuorumId: account.ownerQuorumId! };
      signature = await authority.sign(master, intent, () => this.assertConsentFresh(intent, initialProof.checkedAt));
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature) || !await verifyTypedData({ address: row.accountAddress as `0x${string}`, ...agentApprovalTypedData(intent), signature: signature as `0x${string}` })) throw new BadRequestException("agent_master_signature_invalid");
      if (!takeReserved(reservation, 1)) await this.exchange.acquire();
      const finalProof = await this.assertSetup(userId, row);
      proofCheckedAt = finalProof.checkedAt;
      row = await this.uow.run(async tx => {
        await this.repository.assertCurrent(userId, row, tx);
        this.assertFresh(finalProof.checkedAt);
        if (Date.now() >= intent.consentExpiresAt) throw new ConflictException("agent_consent_expired");
        const submitted = await this.repository.transition(row, { state: "approval_unknown", approvalAttemptedAt: new Date(), issue: null }, tx);
        if (!submitted) throw new ConflictException("agent_setup_changed");
        return submitted;
      });
    } catch (error) {
      await this.repository.transition(row, { state: "ready", issue: "agent_approval_not_submitted" });
      throw error;
    }
    // Persisted attempt precedes POST. A crash, timeout or rejected transport
    // never authorizes a new nonce or a second submission.
    if (Date.now() >= intent.consentExpiresAt || !privyIdentityFresh(proofCheckedAt)) return this.notDispatched(userId, row);
    try {
      const response = await this.exchange.send(intent, signature, () => this.assertConsentFresh(intent, proofCheckedAt));
      if (response && typeof response === "object" && "status" in response && response.status === "err") {
        await this.repository.transition(row, { state: "blocked", issue: "agent_approval_rejected" });
        return wire(await this.repository.find(userId, id));
      }
    } catch (error) {
      if (error instanceof LiveBoundaryError && error.code === "agent_approval_not_dispatched") return this.notDispatched(userId, row);
      // Sent, its answer lost: observed from the exchange, never resent.
      this.logger.warn(`agent ${id} approval outcome unknown: ${safeErrorText(error)}`);
      return wire(row);
    }
    try { return await this.observe(userId, row, reservation); }
    catch (error) {
      this.logger.warn(`agent ${id} approval not observed yet: ${safeErrorText(error)}`);
      return wire(await this.repository.find(userId, id));
    }
  }
  /** The attempt was persisted but its POST never reached the transport (a
   * refused meter permit, a stale proof, the clock): no signature left this
   * process, so the agent is ready again (a new nonce is challenged next
   * time) instead of waiting forever for an approval that was never sent. */
  private async notDispatched(userId: number, row: AgentSetupRow): Promise<CopyAgentSetup> {
    const reverted = await this.repository.transition(row, { state: "ready", approvalAttemptedAt: null, consentDigest: null, issue: "agent_approval_not_submitted" });
    return wire(reverted ?? await this.repository.find(userId, row.id));
  }
  /**
   * An attempted approval, observed on the exchange. The exchange listing the
   * agent (this address, this expiry) on the account is the fact on chain
   * that it was approved: it is recorded as such, with no Privy identity
   * read. The identity proof decided whether the approval might be sent
   * (submit, before its POST); after the POST it can't change what the
   * exchange did, and every order this grant signs proves the agent wallet
   * with Privy again (privy-order-signer). Gate run 8 (2026-10-13): the
   * exchange listed the agent from 12:51, but each observation first re-read
   * the identity, which expired every pass, so the approval was never recorded.
   */
  private async observe(userId: number, row: AgentSetupRow, reservation?: LiveBudgetReservation | void): Promise<CopyAgentSetup> {
    // A setup step's: from the weight it took before its shared claim.
    if (!takeReserved(reservation, AGENT_OBSERVE_WEIGHT) && this.exchange.reserve) await this.exchange.reserve(AGENT_OBSERVE_WEIGHT);
    const intent = consent(row);
    const readAt = Date.now();
    const evidence = await this.exchange.observe(intent, { prepaid: this.exchange.reserve !== undefined });
    // Read after its nonce could no longer land, and the account lists no
    // such agent: the approval never executed (it is not waited on forever).
    if (evidence === null && row.state === "approval_unknown" && readAt > intent.nonce + FUNDING_NONCE_EXPIRY_MS) {
      const ended = await this.repository.transition(row, { state: "blocked", issue: "agent_approval_not_executed" });
      return wire(ended ?? await this.repository.find(userId, row.id));
    }
    if (!evidence || evidence.validUntil !== intent.expiresAt || !Number.isSafeInteger(evidence.checkedAt) || evidence.checkedAt > Date.now() || Date.now() - evidence.checkedAt > 5_000) return wire(row);
    // The exchange's evidence is carried through the transaction and its SQL
    // lock waits (5 s); the database state (owner, account, strategy) is
    // checked again inside it.
    try {
      const active = await this.uow.run(tx => this.repository.activate(tx, userId, row, evidence.checkedAt));
      this.approvedUnrecorded.delete(row.id);
      return wire(active);
    } catch (error) {
      this.reportApprovedUnrecorded(row, evidence.checkedAt, error);
      throw error;
    }
  }
  /** Agents the exchange lists as approved whose grant wasn't recorded yet:
   * when that was first seen, and when it was last raised as an ALERT. */
  private readonly approvedUnrecorded = new Map<string, { since: number; alertedAt?: number }>();
  /** The exchange lists the agent but recording it failed: both facts in one
   * line, and an ALERT once that has lasted AGENT_APPROVED_UNRECORDED_ALERT_MS
   * (again every AGENT_APPROVED_UNRECORDED_ALERT_EVERY_MS). */
  private reportApprovedUnrecorded(row: AgentSetupRow, observedAt: number, error: unknown) {
    const now = Date.now();
    for (const [id, seen] of this.approvedUnrecorded) if (now - seen.since > 86_400_000) this.approvedUnrecorded.delete(id);
    const seen = this.approvedUnrecorded.get(row.id) ?? { since: now };
    this.approvedUnrecorded.set(row.id, seen);
    const fields = { agentSetupId: row.id, agentAddress: row.agentAddress, accountAddress: row.accountAddress, exchangeListsAgent: true,
      observedAt: new Date(observedAt).toISOString(), unrecordedSince: new Date(seen.since).toISOString(), state: row.state, issue: row.issue, ...errorLogFields(error) };
    if (now - seen.since >= AGENT_APPROVED_UNRECORDED_ALERT_MS && (seen.alertedAt === undefined || now - seen.alertedAt >= AGENT_APPROVED_UNRECORDED_ALERT_EVERY_MS)) {
      seen.alertedAt = now;
      this.logger.error(`ALERT agent approved on exchange but not recorded ${JSON.stringify({ ...fields, minutes: Math.floor((now - seen.since) / 60_000) })}`);
    } else this.logger.warn(`agent ${row.id} approved on exchange, not recorded yet ${JSON.stringify(fields)}`);
  }
}
