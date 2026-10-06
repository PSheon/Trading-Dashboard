import { isHyperliquidNetwork, type HyperliquidNetwork } from "@trading-dashboard/shared/contracts";

export type LiveNetwork = HyperliquidNetwork;
export type WalletScope = "copy:trade" | "copy:reduce";
export type EthereumAddress = `0x${string}`;

export interface WalletAuthorization {
  id: string;
  version: number;
  userId: number;
  strategyId: number;
  walletId: string;
  /** Privy owner quorum, deliberately distinct from the application's user ID. */
  privyOwnerId: string;
  signerAddress: EthereumAddress;
  /** Master/subaccount queried for orders; never query an agent's address. */
  accountAddress: EthereumAddress;
  network: LiveNetwork;
  scopes: readonly WalletScope[];
  validFrom: number;
  expiresAt: number;
  revokedAt: number | null;
  /** Verified exchange approval, not merely a local user consent. */
  exchangeApprovedAt: number | null;
}

export interface WalletRequest {
  authorizationId: string;
  userId: number;
  strategyId: number;
  walletId: string;
  network: LiveNetwork;
  accountAddress: EthereumAddress;
  reduceOnly: boolean;
}

export interface WalletAuthorizationSource {
  /** Authoritative read on every signing/submission boundary; no positive cache. */
  find(id: string): Promise<WalletAuthorization | null>;
}

export interface ExchangeApprovalEvidence {
  network: LiveNetwork;
  accountAddress: EthereumAddress;
  signerAddress: EthereumAddress;
  checkedAt: number;
  expiresAt: number | null;
}

export interface ExchangeApprovalVerifier {
  /** Read the exchange on every call. A persisted approval or positive cache
   * cannot prove that an owner has not revoked an agent outside this app. */
  verify(grant: WalletAuthorization): Promise<ExchangeApprovalEvidence>;
}

export interface VerifiedWalletAuthorization {
  grant: WalletAuthorization;
  evidence: ExchangeApprovalEvidence;
}

/** Pure final check: there must be no await between this and initiating the
 * signing/submission request. A delayed lease check must not consume expiry. */
export function assertVerifiedAuthorizationFresh(verified: VerifiedWalletAuthorization, request: WalletRequest, now: number): void {
  const grant = assertWalletAuthorization(verified.grant, request, now);
  const proof = verified.evidence;
  if (!proof || proof.network !== grant.network || address(proof.accountAddress) !== grant.accountAddress ||
      address(proof.signerAddress) !== grant.signerAddress || !Number.isSafeInteger(proof.checkedAt) ||
      proof.checkedAt > now || now - proof.checkedAt > 5_000 ||
      (proof.expiresAt !== null && (!Number.isSafeInteger(proof.expiresAt) || proof.expiresAt <= now))) {
    throw new LiveBoundaryError("exchange_approval_evidence_invalid");
  }
}

export class LiveBoundaryError extends Error {
  constructor(readonly code: string) { super(code); this.name = "LiveBoundaryError"; }
}

export function address(value: string): EthereumAddress {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new LiveBoundaryError("invalid_wallet_address");
  return value.toLowerCase() as EthereumAddress;
}

export function assertWalletAuthorization(grant: WalletAuthorization | null, request: WalletRequest, now: number): WalletAuthorization {
  if (!grant) throw new LiveBoundaryError("wallet_authorization_missing");
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(grant.version) || grant.version < 1 ||
      !Number.isSafeInteger(grant.validFrom) || !Number.isSafeInteger(grant.expiresAt) ||
      grant.validFrom > now || grant.expiresAt <= now) throw new LiveBoundaryError("wallet_authorization_expired");
  if (grant.revokedAt !== null) throw new LiveBoundaryError("wallet_authorization_revoked");
  if (grant.id !== request.authorizationId || grant.userId !== request.userId ||
      grant.strategyId !== request.strategyId || grant.walletId !== request.walletId || !grant.privyOwnerId) {
    throw new LiveBoundaryError("wallet_owner_or_strategy_mismatch");
  }
  if (grant.network !== request.network || !isHyperliquidNetwork(request.network)) throw new LiveBoundaryError("wallet_network_mismatch");
  if (address(grant.accountAddress) !== address(request.accountAddress)) throw new LiveBoundaryError("wallet_account_mismatch");
  address(grant.signerAddress);
  const scope: WalletScope = request.reduceOnly ? "copy:reduce" : "copy:trade";
  if (!grant.scopes.includes(scope)) throw new LiveBoundaryError("wallet_scope_denied");
  if (!Number.isSafeInteger(grant.exchangeApprovedAt) || grant.exchangeApprovedAt! > now) throw new LiveBoundaryError("exchange_approval_missing");
  return { ...grant, signerAddress: address(grant.signerAddress), accountAddress: address(grant.accountAddress), scopes: [...grant.scopes] };
}

export function assertSameAuthorization(snapshot: WalletAuthorization, current: WalletAuthorization): void {
  const identity = (grant: WalletAuthorization) => JSON.stringify({ id: grant.id, version: grant.version, userId: grant.userId,
    strategyId: grant.strategyId, walletId: grant.walletId, privyOwnerId: grant.privyOwnerId,
    signerAddress: address(grant.signerAddress), accountAddress: address(grant.accountAddress), network: grant.network,
    scopes: [...grant.scopes].sort(), validFrom: grant.validFrom, expiresAt: grant.expiresAt,
    revokedAt: grant.revokedAt, exchangeApprovedAt: grant.exchangeApprovedAt });
  if (identity(snapshot) !== identity(current)) throw new LiveBoundaryError("wallet_authorization_changed");
}

export class WalletAuthorizationService {
  constructor(private readonly source: WalletAuthorizationSource, private readonly exchange: ExchangeApprovalVerifier,
    private readonly now = Date.now) {}
  /** For intermediate preparation/consent checks only. Financial boundaries
   * must use authorizeWithEvidence and its pure final freshness check. */
  async authorizeLocal(request: WalletRequest): Promise<WalletAuthorization> {
    if (!this.exchange || typeof this.exchange.verify !== "function") throw new LiveBoundaryError("exchange_approval_verifier_missing");
    return assertWalletAuthorization(await this.source.find(request.authorizationId), request, this.now());
  }
  async authorize(request: WalletRequest): Promise<WalletAuthorization> {
    return (await this.authorizeWithEvidence(request)).grant;
  }
  async authorizeWithEvidence(request: WalletRequest): Promise<VerifiedWalletAuthorization> {
    request = structuredClone(request);
    const grant = await this.authorizeLocal(request);
    const evidence = structuredClone(await this.exchange.verify(structuredClone(grant)));
    assertVerifiedAuthorizationFresh({ grant, evidence }, request, this.now());
    // Provider reads may block. Local revocation, expiry, owner disabling and
    // rotation must win over an approval observed before those reads.
    const fresh = await this.authorizeLocal(request);
    assertSameAuthorization(grant, fresh);
    const verified = { grant: fresh, evidence };
    assertVerifiedAuthorizationFresh(verified, request, this.now());
    return verified;
  }
}
