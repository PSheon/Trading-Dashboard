/**
 * What the wallet UI may ask of the user's own wallet. Only the Privy mode
 * provides one (the embedded wallet signs inside Privy's iframe); fixture and
 * disabled modes have none, and the UI shows why instead of signing.
 *
 * Nothing here ever returns key material: export opens Privy's own modal,
 * which Orbie's page cannot read.
 */
export interface Eip712TypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface WalletSigner {
  /** The Privy embedded wallet (the user's main account); null until it exists. */
  address: string | null;
  /** Opens Privy's export modal for the embedded wallet. */
  exportKey(): Promise<void>;
  /** Opens Privy's export modal for one of the user's own copy wallets
   * (created for a copy, owned by the user alone). Privy itself refuses an
   * address the signed-in user does not own; the key never reaches Orbie. */
  exportCopyKey(address: string): Promise<void>;
  /** EIP-712 signature (0x r‖s‖v) from the embedded wallet. `silent`: no
   * Privy modal (`showWalletUIs: false`), only right after Orbie's confirm
   * sheet has shown the exact terms (one-click copy, decision 1). A user who
   * enrolled MFA for wallet actions is still prompted by Privy. */
  signTypedData(data: Eip712TypedData, options?: { silent?: boolean }): Promise<`0x${string}`>;
  /** Adds signers to one of the user's own copy accounts (Privy's
   * `useSigners().addSigners`; only the owner can): exactly the worker
   * quorum under the owner's own policy. The worker then signs every
   * action of that copy account; the browser never signs as it. Refused
   * (`copy_wallet_unavailable`) unless that address is one of the signed-in
   * user's Privy wallets other than the main one. */
  addSigners(address: string, signers: { signerId: string; policyIds: string[] }[]): Promise<void>;
  /** Removes every signer from one of the user's own copy accounts (account
   * deletion takes the worker off first). */
  removeSigners(address: string): Promise<void>;
  /** Sends a transaction from the embedded wallet; `sponsor` asks Privy to pay gas. */
  sendTransaction(tx: { to: `0x${string}`; data: `0x${string}`; chainId: number }, sponsor: boolean): Promise<`0x${string}`>;
}
