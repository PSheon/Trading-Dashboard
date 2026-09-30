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
  /** EIP-712 signature (0x r‖s‖v) from the embedded wallet. */
  signTypedData(data: Eip712TypedData): Promise<`0x${string}`>;
  /** Sends a transaction from the embedded wallet; `sponsor` asks Privy to pay gas. */
  sendTransaction(tx: { to: `0x${string}`; data: `0x${string}`; chainId: number }, sponsor: boolean): Promise<`0x${string}`>;
}
