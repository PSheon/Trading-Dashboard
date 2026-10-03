import { BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { copyAgentSetupSchema, prepareCopyAgentSchema, type CopyAgentSetup, type CopyAgentOverview } from "@trading-dashboard/shared/contracts";
import { verifyTypedData } from "viem";
import { AppConfig } from "../config/app-config.js";
import { UnitOfWork } from "../db/unit-of-work.js";
import { CopyWalletService } from "./copy-wallet.service.js";
import { CopyAgentRepository, type AgentSetupRow } from "./copy-agent.repository.js";
import { AGENT_APPROVAL_CLIENT, type AgentApprovalClient } from "./copy-agent-exchange.client.js";
import { agentApprovalTypedData, verifyAgentOwnerConsent, type AgentConsentIntent } from "./copy-agent-consent.js";
import { AgentProvisioningConflict, USER_AGENT_PROVISIONER, type UserAgentProvisioner } from "./live/privy-agent-provisioner.js";

function wire(row: AgentSetupRow): CopyAgentSetup {
  return copyAgentSetupSchema.parse({ id: row.id, strategyId: row.strategyId, accountId: row.accountId, network: row.network,
    state: row.state !== "revoked" && row.expiresAt.getTime() <= Date.now() ? "expired" : row.state,
    accountAddress: row.accountAddress, agentAddress: row.agentAddress, expiresAt: row.expiresAt.toISOString(),
    authorizationId: row.authorizationId, issue: row.issue, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
}
function consent(row: AgentSetupRow): AgentConsentIntent {
  if (!row.agentAddress || !row.policyId || !row.approvalNonce || !row.consentExpiresAt) throw new ConflictException("agent_consent_not_prepared");
  return { id: row.id, strategyId: row.strategyId, network: row.network, accountAddress: row.accountAddress,
    agentAddress: row.agentAddress, policyId: row.policyId, workerQuorumId: row.workerQuorumId,
    nonce: row.approvalNonce, expiresAt: row.expiresAt.getTime(), consentExpiresAt: row.consentExpiresAt.getTime() };
}

/** Separate explicit setup. An active grant alone never starts a strategy or
 * changes either its paper allocation or real execution capability. */
@Injectable()
export class CopyAgentService {
  constructor(private readonly repository: CopyAgentRepository, private readonly uow: UnitOfWork,
    private readonly config: AppConfig, private readonly wallets: CopyWalletService,
    @Inject(USER_AGENT_PROVISIONER) private readonly provider: UserAgentProvisioner,
    @Inject(AGENT_APPROVAL_CLIENT) private readonly exchange: AgentApprovalClient) {}
  get available() { return this.config.value.hyperliquid.wallet.network === "testnet" && this.config.value.copy.mode !== "disabled" && this.provider.available && this.exchange.available; }
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
    const row = await this.uow.run(tx => this.repository.ensure(tx, userId, accountId, parsed.data, this.provider.configuredWorkerQuorumId!));
    return this.reconcile(userId, row.id);
  }
  private async assertSetup(userId: number, row: AgentSetupRow) {
    const checkedAt = Date.now();
    if (row.network !== "testnet" || row.network !== this.config.value.hyperliquid.wallet.network || row.workerQuorumId !== this.provider.configuredWorkerQuorumId ||
      row.expiresAt.getTime() <= Date.now() || row.state === "revoked" || row.state === "blocked") throw new ConflictException("agent_setup_changed");
    const { owner } = await this.repository.assertCurrent(userId, row);
    const master = await this.wallets.reconcile(userId, row.accountId);
    if (master.state !== "ready" || master.address !== row.accountAddress) throw new ConflictException("agent_account_changed");
    await this.provider.verifyWorkerQuorum();
    if (!row.policyId || !row.agentWalletId || !row.agentAddress || !row.agentOwnerQuorumId) throw new ConflictException("agent_not_ready");
    const expected = { userId: owner.privyUserId, policyId: row.policyId, expiresAt: row.expiresAt.getTime(), externalId: row.externalId };
    const policy = await this.provider.verifyPolicy(expected);
    const agent = await this.provider.findOwned(expected);
    if (!agent || policy.id !== row.policyId || policy.fingerprint !== row.policyFingerprint || agent.id !== row.agentWalletId ||
      agent.address !== row.agentAddress || agent.externalId !== row.externalId || agent.ownerQuorumId !== row.agentOwnerQuorumId ||
      agent.policyId !== row.policyId || agent.workerQuorumId !== row.workerQuorumId) throw new ConflictException("agent_identity_changed");
    const current = await this.repository.assertCurrent(userId, row);
    this.assertFresh(checkedAt);
    return { ...current, checkedAt };
  }
  private assertFresh(checkedAt: number) {
    const now = Date.now();
    if (!Number.isSafeInteger(checkedAt) || checkedAt > now || now - checkedAt > 5_000) throw new ConflictException("agent_identity_evidence_expired");
  }
  async reconcile(userId: number, id: string): Promise<CopyAgentSetup> {
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
      if (row.state === "approval_unknown" && row.approvalAttemptedAt) return await this.observe(userId, row);
      if (row.state === "approval_signing" && !row.approvalAttemptedAt && row.consentExpiresAt && row.consentExpiresAt.getTime() <= Date.now()) {
        row = (await this.repository.transition(row, { state: "ready", consentDigest: null, issue: "agent_consent_expired" })) ?? await this.repository.find(userId, id);
      }
      return wire(row);
    } catch (error) {
      if (error instanceof AgentProvisioningConflict) await this.repository.transition(row, { state: "blocked", issue: "agent_identity_changed" });
      else await this.repository.transition(row, { issue: "agent_verification_pending" });
      return wire(await this.repository.find(userId, id));
    }
  }
  async challenge(userId: number, id: string) {
    this.enabled();
    const row = await this.repository.find(userId, id);
    await this.assertSetup(userId, row);
    const challenged = await this.uow.run(tx => this.repository.challenge(tx, userId, id));
    return { operation: wire(challenged), intent: consent(challenged) };
  }
  async approve(userId: number, id: string, consentSignature: string, userJwt: string): Promise<CopyAgentSetup> {
    this.enabled();
    let row = await this.repository.refreshGrant(await this.repository.find(userId, id));
    if (row.state === "active") return wire(row);
    if (row.state === "approval_unknown" || row.state === "approval_signing") return this.reconcile(userId, id);
    if (row.state !== "ready" || !userJwt) throw new ConflictException("agent_consent_required");
    const intent = consent(row);
    const { owner, account } = await this.assertSetup(userId, row);
    if (!owner.embeddedWalletAddress || !await verifyAgentOwnerConsent(owner.embeddedWalletAddress, intent, consentSignature)) throw new BadRequestException("invalid_agent_consent");
    const claimed = await this.uow.run(async tx => {
      await this.repository.assertCurrent(userId, row, tx);
      return this.repository.transition(row, { state: "approval_signing", consentDigest: createHash("sha256").update(JSON.stringify(intent)).digest("hex") }, tx);
    });
    if (!claimed) return this.reconcile(userId, id);
    row = claimed;
    let signature: string;
    let proofCheckedAt: number;
    try {
      signature = await this.exchange.signMaster({ walletId: account.privyWalletId!, address: account.address!, ownerQuorumId: account.ownerQuorumId! }, intent, userJwt);
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature) || !await verifyTypedData({ address: row.accountAddress as `0x${string}`, ...agentApprovalTypedData(intent), signature: signature as `0x${string}` })) throw new BadRequestException("agent_master_signature_invalid");
      await this.exchange.acquire();
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
    if (Date.now() >= intent.consentExpiresAt || proofCheckedAt > Date.now() || Date.now() - proofCheckedAt > 5_000) return wire(row);
    try {
      const response = await this.exchange.send(intent, signature);
      if (response && typeof response === "object" && "status" in response && response.status === "err") {
        await this.repository.transition(row, { state: "blocked", issue: "agent_approval_rejected" });
        return wire(await this.repository.find(userId, id));
      }
    } catch { return wire(row); }
    try { return await this.observe(userId, row); }
    catch { return wire(await this.repository.find(userId, id)); }
  }
  private async observe(userId: number, row: AgentSetupRow): Promise<CopyAgentSetup> {
    const identity = await this.assertSetup(userId, row);
    const intent = consent(row);
    const evidence = await this.exchange.observe(intent);
    if (!evidence || evidence.validUntil !== intent.expiresAt || !Number.isSafeInteger(evidence.checkedAt) || evidence.checkedAt > Date.now() || Date.now() - evidence.checkedAt > 5_000) return wire(row);
    // Exchange evidence cannot reset the age of the earlier provider identity
    // reads. Carry both proofs through the transaction and its SQL lock waits.
    this.assertFresh(identity.checkedAt);
    const active = await this.uow.run(tx => this.repository.activate(tx, userId, row, evidence.checkedAt, identity.checkedAt));
    return wire(active);
  }
}
