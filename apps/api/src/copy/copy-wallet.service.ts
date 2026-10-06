import { BadRequestException, ConflictException, HttpException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { createCopyExecutionWalletSchema, liveSetupAgentName, type CopyExecutionAccount, type CopyExecutionWallets, type CopyWalletGrant } from "@trading-dashboard/shared/contracts";
import { AppConfig } from "../config/app-config.js";
import { UnitOfWork } from "../db/unit-of-work.js";
import { ProvisioningVerificationPending, ProvisioningWalletConflict, USER_WALLET_PROVISIONER, type UserWalletProvisioner } from "./live/privy-wallet-provisioner.js";
import { CopyWalletRepository, type AccountRow, type GrantRow, type AgentRow } from "./copy-wallet.repository.js";
import { MASTER_POLICY, MasterPolicyConflict, type MasterPolicyPort } from "./live/privy-master-policy.js";

function account(row: AccountRow): CopyExecutionAccount {
  return { id: row.id, strategyId: row.strategyId, network: row.network, state: row.state,
    address: row.state === "ready" ? row.address : null, issue: row.issue, revision: row.revision, automaticReturn: row.masterPolicyId !== null && row.signerDetachedAt === null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
function authorization(grant: GrantRow, wallet: AgentRow): CopyWalletGrant {
  const now = Date.now();
  const status = grant.revokedAt ? "revoked" : grant.expiresAt.getTime() <= now ? "expired" :
    grant.validFrom.getTime() > now || !grant.exchangeApprovedAt || grant.exchangeApprovedAt.getTime() > now ? "pending" : "active";
  return { id: grant.id, strategyId: wallet.strategyId, network: wallet.network, accountAddress: wallet.accountAddress,
    signerAddress: wallet.signerAddress, status, scopes: grant.scopes, version: grant.version, expiresAt: grant.expiresAt.toISOString(), revokedAt: grant.revokedAt?.toISOString() ?? null };
}

/** Durable wallet preparation and local consent management. Does not activate
 * live trading, allocate paper cash, approve an exchange agent or move funds. */
@Injectable()
export class CopyWalletService {
  private readonly logger = new Logger(CopyWalletService.name);
  constructor(private readonly repository: CopyWalletRepository, private readonly uow: UnitOfWork,
    private readonly config: AppConfig, @Inject(USER_WALLET_PROVISIONER) private readonly provider: UserWalletProvisioner,
    @Optional() @Inject(MASTER_POLICY) private readonly masterPolicy: MasterPolicyPort | null = null) {}

  /**
   * The automatic return (one-click plan §2, §3b): the worker quorum as this
   * ready testnet account's only additional signer, bound by a new policy
   * the owner owns (UsdSend only to the owner's main wallet, standard
   * account mode only, no export). Only the owner's browser can add the
   * signer (Privy refuses the server's use of the owner's session): this
   * records it once Privy shows exactly that signer. Off unless
   * COPY_AUTOMATIC_RETURN. Repeatable: the policy is created idempotently
   * per account. Until the browser added it: 409
   * `automatic_return_signer_missing` with the `workerQuorumId` and
   * `policyId` to add (`useSigners().addSigners`), then call again.
   */
  async enableAutomaticReturn(userId: number, id: string): Promise<CopyExecutionAccount> {
    const { copy } = this.config.value;
    const quorum = copy.agent?.workerQuorumId;
    if (copy.mode !== "testnet" || !copy.live?.automaticReturn || !quorum || !this.masterPolicy?.available) {
      throw new ServiceUnavailableException({ statusCode: 503, code: "setup_unavailable", message: "Automatic return is not available" });
    }
    const user = await this.owner(userId);
    const row = await this.repository.account(id, userId);
    if (!row) throw new NotFoundException("Execution wallet not found");
    if (row.masterPolicyId) return account(row);
    const strategy = await this.repository.ownedStrategy(userId, row.strategyId);
    if (row.state !== "ready" || row.network !== "testnet" || !row.privyWalletId || !row.address || !row.ownerQuorumId || row.privyUserId !== user.privyUserId ||
      !user.embeddedWalletAddress || !strategy || strategy.status === "stopped" || strategy.status === "stopping") throw new ConflictException({ statusCode: 409, code: "setup_wallet_conflict", message: "This copy wallet can't take the automatic return" });
    const binding = { ownerMain: user.embeddedWalletAddress.toLowerCase(), account: row.address };
    try {
      const policy = await this.masterPolicy.create(user.privyUserId, binding, `master_${row.id.replaceAll("-", "")}`);
      const verified = await this.masterPolicy.verify(policy.id, user.privyUserId, binding);
      try { await this.masterPolicy.assertSigner(row.privyWalletId, { address: row.address, ownerQuorumId: row.ownerQuorumId, workerQuorumId: quorum, policyId: verified.id }); }
      catch (error) {
        if (!(error instanceof MasterPolicyConflict)) throw error;
        throw new ConflictException({ statusCode: 409, code: "automatic_return_signer_missing", message: "Add the worker signer from your browser, then try again", workerQuorumId: quorum, policyId: verified.id });
      }
      const recorded = await this.repository.recordMasterSigner(row.id, { masterPolicyId: verified.id, masterPolicyFingerprint: verified.fingerprint, masterSignerQuorumId: quorum,
        sweepDestination: binding.ownerMain, signerAttachedAt: new Date(), walletId: row.privyWalletId, address: row.address });
      return account(recorded ?? (await this.repository.account(id, userId))!);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // No provider detail, token or DID leaves the API.
      throw new ServiceUnavailableException({ statusCode: 503, code: "setup_unavailable", message: "Automatic return could not be set up; try again" });
    }
  }

  /** Whether new one-click setups get the worker as a policy-bound signer
   * (COPY_AUTOMATIC_RETURN and a configured worker quorum). Off: the
   * owner's session signs every step after confirm. */
  /** A ready account with no recorded signer whose wallet Privy shows with a
   * signer: the owner's browser added the worker for a setup whose confirm
   * never recorded it (a closed tab). Adopted when it is exactly the setup's
   * consented policy; anything else stays a conflict. */
  private async adoptSetupSigner(userId: number, row: AccountRow): Promise<boolean> {
    if (row.masterPolicyId || row.state !== "ready" || !this.workerPolicyEnabled) return false;
    const policy = await this.repository.setupPolicy(row.id, userId);
    if (!policy) return false;
    return this.attachSetupSigner(userId, row.id, policy, { address: policy.agentAddress, name: liveSetupAgentName(policy) });
  }
  get workerPolicyEnabled(): boolean {
    const { copy } = this.config.value;
    return copy.mode === "testnet" && Boolean(copy.live?.automaticReturn && copy.agent?.workerQuorumId && this.masterPolicy?.available);
  }

  /**
   * A one-click setup's policy (plan §2): created before the owner's consent
   * so the consent binds its id and fingerprint, owned by the owner, and
   * covering the return, the standard account mode and exactly the consented
   * agent. Null when the worker policy is off or Privy can't create it now
   * (the setup then runs with the owner's session).
   */
  async prepareSetupPolicy(userId: number, accountId: string, agent: { address: string; name: string }, attemptKey: string): Promise<{ id: string; fingerprint: string } | null> {
    if (!this.workerPolicyEnabled) return null;
    const user = await this.owner(userId), row = await this.repository.account(accountId, userId);
    if (!row || row.state !== "ready" || !row.address || !user.embeddedWalletAddress || row.privyUserId !== user.privyUserId) return null;
    if (row.masterPolicyId) return null; // an account that already has one keeps it (legacy binding)
    const binding = { ownerMain: user.embeddedWalletAddress.toLowerCase(), account: row.address, agent };
    try {
      const policy = await this.masterPolicy!.create(user.privyUserId, binding, attemptKey);
      const verified = await this.masterPolicy!.verify(policy.id, user.privyUserId, binding);
      return { id: verified.id, fingerprint: verified.fingerprint };
    } catch { return null; }
  }

  /**
   * At a setup's confirm: once the owner's browser added the worker as the
   * account's only additional signer under the consented policy, checks the
   * result with Privy and records it on the account. False when it isn't
   * there (the setup then continues with the owner's browser signing).
   */
  async attachSetupSigner(userId: number, accountId: string, policy: { id: string; fingerprint: string }, agent: { address: string; name: string }): Promise<boolean> {
    if (!this.workerPolicyEnabled) return false;
    const quorum = this.config.value.copy.agent!.workerQuorumId;
    const user = await this.owner(userId), row = await this.repository.account(accountId, userId);
    if (!row || !user.embeddedWalletAddress) return false;
    if (row.masterPolicyId) return row.masterPolicyId === policy.id && row.masterSignerQuorumId === quorum;
    if (row.state !== "ready" || row.network !== "testnet" || !row.privyWalletId || !row.address || !row.ownerQuorumId || row.privyUserId !== user.privyUserId) return false;
    const binding = { ownerMain: user.embeddedWalletAddress.toLowerCase(), account: row.address, agent };
    try {
      const verified = await this.masterPolicy!.verify(policy.id, user.privyUserId, binding);
      if (verified.fingerprint !== policy.fingerprint) return false;
      await this.masterPolicy!.assertSigner(row.privyWalletId, { address: row.address, ownerQuorumId: row.ownerQuorumId, workerQuorumId: quorum, policyId: verified.id });
      const recorded = await this.repository.recordMasterSigner(row.id, { masterPolicyId: verified.id, masterPolicyFingerprint: verified.fingerprint, masterSignerQuorumId: quorum,
        sweepDestination: binding.ownerMain, signerAttachedAt: new Date(), walletId: row.privyWalletId, address: row.address });
      return Boolean(recorded);
    } catch (error) {
      // No token or DID: why the signer wasn't recorded (the setup then signs in the owner's browser).
      this.logger.warn(`setup signer for account ${accountId} not recorded: ${error instanceof Error ? `${error.name} ${error.message}`.slice(0, 160) : "unknown"}`);
      return false;
    }
  }

  private async owner(userId: number) {
    const user = await this.repository.enabledOwner(userId);
    if (!user) throw new NotFoundException("User not found");
    return user;
  }
  async overview(userId: number): Promise<CopyExecutionWallets> {
    await this.owner(userId);
    const [accounts, grants] = await Promise.all([
      this.repository.accounts(userId), this.repository.grants(userId),
    ]);
    return { available: this.provider.available, network: this.config.value.hyperliquid.wallet.network,
      accounts: accounts.map(account), authorizations: grants.map(({ grant, wallet }) => authorization(grant, wallet)) };
  }
  async prepare(userId: number, strategyId: number, input: unknown): Promise<CopyExecutionAccount> {
    const parsed = createCopyExecutionWalletSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid execution wallet request");
    if (parsed.data.network !== this.config.value.hyperliquid.wallet.network) throw new ConflictException("wallet_network_mismatch");
    const user = await this.owner(userId);
    const strategy = await this.repository.ownedStrategy(userId, strategyId);
    if (!strategy) throw new NotFoundException("Copy strategy not found");
    if (strategy.status === "stopped" || strategy.status === "stopping") throw new ConflictException("copy_stopped");
    if (!this.provider.available) throw new ServiceUnavailableException("wallet_provider_unavailable");
    const id = randomUUID();
    const row = await this.repository.ensureAccount({ id, strategyId, userId, network: parsed.data.network,
      privyUserId: user.privyUserId, externalId: `copy_${id.replaceAll("-", "")}` });
    if (!row || row.userId !== userId) throw new ConflictException("wallet_owner_mismatch");
    return this.reconcile(userId, row.id);
  }
  async reconcile(userId: number, id: string): Promise<CopyExecutionAccount> {
    const user = await this.owner(userId);
    const original = await this.repository.account(id, userId);
    if (!original) throw new NotFoundException("Execution wallet not found");
    if (original.privyUserId !== user.privyUserId) throw new ConflictException("wallet_owner_mismatch");
    if (original.state === "blocked") return account(original);
    if (!this.provider.available) throw new ServiceUnavailableException("wallet_provider_unavailable");
    let submitted = original.state !== "requested";
    try {
      const expected = original.masterPolicyId && original.masterSignerQuorumId && !original.signerDetachedAt ? { workerQuorumId: original.masterSignerQuorumId, policyId: original.masterPolicyId } : null;
      let found = await this.provider.findOwned(original.privyUserId, original.externalId, expected);
      if (!found && original.state === "requested") {
        // Only one replica can claim creation. Unknown is committed BEFORE the
        // remote POST. Every recovery of an ambiguous outcome is lookup only.
        // A crash before POST is deliberately unresolved, never a second wallet.
        const claimed = await this.repository.claimCreation(id);
        if (claimed) {
          submitted = true;
          // Recheck user and strategy immediately before the provider mutation.
          await this.owner(userId);
          const strategy = await this.repository.ownedStrategy(userId, original.strategyId);
          if (!strategy || strategy.status === "stopped" || strategy.status === "stopping") return this.finish(id, "blocked", "wallet_conflict");
          await this.provider.create(original.privyUserId, original.externalId);
          found = await this.provider.findOwned(original.privyUserId, original.externalId, expected);
        }
      }
      if (!found) {
        if (original.state === "ready") throw new ProvisioningWalletConflict("wallet_conflict");
        return this.finish(id, "unknown", "verification_pending");
      }
      if (found.externalId !== original.externalId || !/^0x[0-9a-f]{40}$/.test(found.address) || !found.id || !found.ownerQuorumId ||
        (original.privyWalletId && (original.privyWalletId !== found.id || original.address !== found.address || original.ownerQuorumId !== found.ownerQuorumId))) {
        throw new ProvisioningWalletConflict("wallet_conflict");
      }
      await this.owner(userId);
      const row = await this.repository.confirmIdentity(id, found);
      if (row) return account(row);
      const current = await this.repository.account(id);
      if (current && current.state !== "blocked" && (current.privyWalletId !== found.id || current.address !== found.address || current.ownerQuorumId !== found.ownerQuorumId)) {
        return this.finish(id, "blocked", "wallet_conflict");
      }
      return this.read(id);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      if (error instanceof ProvisioningWalletConflict && await this.adoptSetupSigner(userId, original).catch(() => false)) return this.reconcile(userId, id);
      if (error instanceof ProvisioningWalletConflict || (error && typeof error === "object" && "code" in error && error.code === "23505")) {
        return this.finish(id, "blocked", "wallet_conflict");
      }
      const issue = error instanceof ProvisioningVerificationPending ? "verification_pending" : "provider_unavailable";
      if (original.state === "ready") {
        // Explicit re-verification failed. Hide the address and require fresh
        // ownership evidence; do not return an old positive result as success.
        // A stale failure must not overwrite a newer observer's verification.
        await this.repository.failReverification(id, original.revision, issue);
        return this.read(id);
      }
      // No provider error text, token, owner DID or SDK details escape the API.
      return this.finish(id, submitted || error instanceof ProvisioningVerificationPending ? "unknown" : "requested", issue);
    }
  }
  private async read(id: string): Promise<CopyExecutionAccount> {
    const row = await this.repository.account(id);
    if (!row) throw new NotFoundException("Execution wallet not found");
    return account(row);
  }
  private async finish(id: string, state: AccountRow["state"], issue: AccountRow["issue"]): Promise<CopyExecutionAccount> {
    // Do not overwrite a newer ready/blocked result from another observer, or
    // roll unknown back to requested after a POST exception.
    await this.repository.finish(id, state, issue);
    return this.read(id);
  }
  async revoke(userId: number, id: string): Promise<CopyWalletGrant> {
    await this.owner(userId);
    return this.uow.run(async (tx) => {
      const row = await this.repository.lockedGrant(tx, userId, id);
      if (!row) throw new NotFoundException("Wallet authorization not found");
      if (row.grant.revokedAt) return authorization(row.grant, row.wallet);
      if (row.grant.version === 2_147_483_647) throw new ConflictException("authorization_version_exhausted");
      const now = new Date();
      const grant = await this.repository.revokeGrant(tx, id, row.grant.version + 1, now);
      await this.repository.recordRevocation(tx, { id: randomUUID(), authorizationId: id, userId,
        version: grant.version, action: "revoked", createdAt: now });
      return authorization(grant, row.wallet);
    });
  }
}
