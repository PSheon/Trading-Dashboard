/** What account deletion needs from outside the DB (docs/account-deletion.md): the
 * exchange's and Privy's view of a copy account. Provided by CopyModule. */
export const COPY_ACCOUNT_CLOSURE = Symbol("COPY_ACCOUNT_CLOSURE");
/** Privy still lists a signer on the copy wallet. */
export class CopySignerAttached extends Error { constructor() { super("copy_signer_attached"); } }

export interface CopyAccountClosurePort {
  /** No USDC (perp or spot), position or resting order. Throws when the exchange can't tell. */
  isEmpty(network: "testnet" | "mainnet", address: string): Promise<boolean>;
  /** Privy shows no additional signer left (only the owner's browser can remove it).
   * Throws `CopySignerAttached` when one is left, anything else when Privy can't tell. */
  assertSignerDetached(walletId: string): Promise<void>;
}
