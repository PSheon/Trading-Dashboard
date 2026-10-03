import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { createCopyExecutionWalletSchema, type CopyExecutionAccount, type CopyExecutionWallets, type CopyWalletGrant } from "@trading-dashboard/shared/contracts";
import { AppConfig } from "../config/app-config.js";
import { UnitOfWork } from "../db/unit-of-work.js";
import { ProvisioningVerificationPending, ProvisioningWalletConflict, USER_WALLET_PROVISIONER, type UserWalletProvisioner } from "./live/privy-wallet-provisioner.js";
import { CopyWalletRepository, type AccountRow, type GrantRow, type AgentRow } from "./copy-wallet.repository.js";

function account(row: AccountRow): CopyExecutionAccount {
  return { id: row.id, strategyId: row.strategyId, network: row.network, state: row.state,
    address: row.state === "ready" ? row.address : null, issue: row.issue, revision: row.revision,
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
  constructor(private readonly repository: CopyWalletRepository, private readonly uow: UnitOfWork,
    private readonly config: AppConfig, @Inject(USER_WALLET_PROVISIONER) private readonly provider: UserWalletProvisioner) {}

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
      let found = await this.provider.findOwned(original.privyUserId, original.externalId);
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
          found = await this.provider.findOwned(original.privyUserId, original.externalId);
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
