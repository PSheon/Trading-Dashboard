/**
 * What account deletion needs from the copy side that the database can't
 * answer (docs/account-deletion.md): the exchange's view of a copy account,
 * and Privy, to take the worker back off a wallet's signers. Provided by
 * CopyModule (copy/copy-account-closure.service.ts); tests pass fakes.
 */
export const COPY_ACCOUNT_CLOSURE = Symbol("COPY_ACCOUNT_CLOSURE");

export interface CopyAccountClosurePort {
  /** Whether the copy account holds nothing: no USDC (perp or spot), no open
   * position, no resting order. Throws when the exchange can't tell. */
  isEmpty(network: "testnet" | "mainnet", address: string): Promise<boolean>;
  /** Removes the worker quorum from the wallet's additional signers with the
   * owner's own session, and checks it is gone. Throws when it can't. */
  detachSigner(walletId: string, userJwt: string): Promise<void>;
}
