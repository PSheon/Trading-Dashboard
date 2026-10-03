/** Provider metadata, normalized at the SDK boundary. This selects an identity,
 * never grants signing authority or changes a previously stored main account. */
export interface EmbeddedWalletIdentity {
  address: string;
  chainType: string;
  clientType: string;
  index?: number | null;
  imported?: boolean;
}

export function isPrivyWallet(clientType: string): boolean {
  return clientType === "privy" || clientType === "privy-v2";
}

/** HD index zero is the main account. Legacy metadata is accepted only when
 * there is exactly one native embedded Ethereum address and no explicit index.
 * Secondary, imported and ambiguous wallets must never become the main account. */
export function primaryEmbeddedWalletAddress(wallets: readonly EmbeddedWalletIdentity[]): string | null {
  const native = wallets.filter((wallet) => wallet.chainType === "ethereum" && isPrivyWallet(wallet.clientType) && !wallet.imported);
  const addresses = (items: readonly EmbeddedWalletIdentity[]) => [...new Set(items.map((wallet) => wallet.address.toLowerCase()))];
  const primary = addresses(native.filter((wallet) => wallet.index === 0));
  if (primary.length) return primary.length === 1 ? primary[0]! : null;
  const unique = addresses(native);
  return unique.length === 1 && native.every((wallet) => wallet.index == null) ? unique[0]! : null;
}
