import { Injectable } from "@nestjs/common";
import { PrivyClient } from "@privy-io/node";
import { AppConfig } from "../../config/app-config.js";

/** Deliberately exposes no signing, funding or server delegation method. */
export interface ProvisionedUserWallet {
  id: string; address: string; externalId: string; ownerQuorumId: string;
}
export interface UserWalletProvisioner {
  readonly available: boolean;
  create(userId: string, externalId: string): Promise<void>;
  findOwned(userId: string, externalId: string): Promise<ProvisionedUserWallet | null>;
}
export const USER_WALLET_PROVISIONER = Symbol("USER_WALLET_PROVISIONER");
export class ProvisioningWalletConflict extends Error {}
export class ProvisioningVerificationPending extends Error {}

@Injectable()
export class PrivyUserWalletProvisioner implements UserWalletProvisioner {
  private readonly client: PrivyClient | null;
  readonly available: boolean;
  constructor(config: AppConfig) {
    const { appId, appSecret } = config.value.auth;
    this.available = Boolean(appId && appSecret);
    this.client = appId && appSecret ? new PrivyClient({ appId, appSecret, timeout: 10_000, maxRetries: 0 }) : null;
  }
  async create(userId: string, externalId: string): Promise<void> {
    if (!this.client) throw new Error("provider_unavailable");
    // User is the sole owner. No additional signer, app owner or trading grant.
    // The durable external ID is unique forever; Privy's key alone lasts 24h.
    await this.client.wallets().create({ chain_type: "ethereum", owner: { user_id: userId },
      external_id: externalId, idempotency_key: externalId, display_name: "Copy execution account" });
  }
  async findOwned(userId: string, externalId: string): Promise<ProvisionedUserWallet | null> {
    if (!this.client) throw new Error("provider_unavailable");
    let wallet;
    try { wallet = await this.client.wallets().get(`ext_wal_${externalId}`); }
    catch (error) {
      if (error && typeof error === "object" && "status" in error && error.status === 404) return null;
      throw error;
    }
    // owner_id is a quorum, NOT a user DID. Verify user ownership via the
    // provider's user filter, then require identical authoritative identities.
    const owned = await this.client.wallets().list({ user_id: userId, external_id: externalId, chain_type: "ethereum" });
    const match = owned.data.find((candidate) => candidate.id === wallet.id);
    // User-filter indexing may lag a successful creation. Missing corroboration
    // is unresolved evidence, rather than a permanent ownership conflict.
    if (!match) throw new ProvisioningVerificationPending("verification_pending");
    if (wallet.external_id !== externalId || match.external_id !== externalId ||
      !wallet.owner_id || wallet.owner_id !== match.owner_id || wallet.address.toLowerCase() !== match.address.toLowerCase() ||
      wallet.chain_type !== "ethereum" || match.chain_type !== "ethereum" ||
      wallet.archived_at != null || match.archived_at != null ||
      !/^0x[0-9a-fA-F]{40}$/.test(wallet.address) ||
      wallet.additional_signers.length !== 0 || match.additional_signers.length !== 0 ||
      wallet.automations?.length || match.automations?.length) throw new ProvisioningWalletConflict("wallet_conflict");
    const quorum = await this.client.keyQuorums().get(wallet.owner_id);
    if (quorum.id !== wallet.owner_id || quorum.user_ids?.length !== 1 || quorum.user_ids[0] !== userId ||
      quorum.authorization_threshold !== 1 || quorum.authorization_keys.length !== 0 || quorum.key_quorum_ids?.length) {
      throw new ProvisioningWalletConflict("wallet_conflict");
    }
    return { id: wallet.id, address: wallet.address.toLowerCase(), externalId, ownerQuorumId: wallet.owner_id };
  }
}
