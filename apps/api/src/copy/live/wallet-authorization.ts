export type LiveNetwork = "testnet" | "mainnet";
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
  if (grant.network !== request.network || !["testnet", "mainnet"].includes(request.network)) throw new LiveBoundaryError("wallet_network_mismatch");
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
  constructor(private readonly source: WalletAuthorizationSource, private readonly now = Date.now) {}
  async authorize(request: WalletRequest): Promise<WalletAuthorization> {
    return assertWalletAuthorization(await this.source.find(request.authorizationId), request, this.now());
  }
}
