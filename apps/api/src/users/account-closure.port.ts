/**
 * What account deletion needs from the copy side that the database can't
 * answer (docs/account-deletion.md): the exchange's view of a copy account,
 * and Privy's, that the worker is no longer a wallet's signer. Provided by
 * CopyModule (copy/copy-account-closure.service.ts); tests pass fakes.
 */
export const COPY_ACCOUNT_CLOSURE = Symbol("COPY_ACCOUNT_CLOSURE");
/** Privy still lists a signer on the copy wallet. */
export class CopySignerAttached extends Error { constructor() { super("copy_signer_attached"); } }

export interface CopyAccountClosurePort {
  /** Whether the copy account holds nothing: no USDC (perp or spot), no open
   * position, no resting order. Throws when the exchange can't tell. */
  isEmpty(network: "testnet" | "mainnet", address: string): Promise<boolean>;
  /** Checks with Privy (app secret) that the wallet has no additional signer
   * left: the owner's browser removes the worker before deleting (only the
   * owner can). Throws `CopySignerAttached` when one is left, anything else
   * when Privy can't tell. */
  assertSignerDetached(walletId: string): Promise<void>;
}
