import { COPY_MASTER_ACTION_TYPES, WALLET_NETWORKS, type WalletNetwork } from '@trading-dashboard/shared/contracts';

export interface MasterAccount { readonly walletId: string; readonly address: string; readonly ownerQuorumId: string }
/** A Hyperliquid user-signed action's typed data (usdSend, approveBuilderFee). */
export interface MasterTypedData {
  readonly domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  readonly types: Record<string, readonly { name: string; type: string }[]>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
}

/** The only actions a copy account signs (COPY_MASTER_ACTION_TYPES, shared
 * with the owner's policy), each only with the values the caller bound.
 * Anything else (Withdraw3, …) is refused before Privy is asked. */
const SIGNABLE: Readonly<Record<string, readonly { name: string; type: string }[]>> = COPY_MASTER_ACTION_TYPES;
export function masterActionSignable(data: Pick<MasterTypedData, 'primaryType' | 'types' | 'message'>): boolean {
  const fields = Object.hasOwn(SIGNABLE, data.primaryType) ? SIGNABLE[data.primaryType]! : null;
  const declared = data.types[data.primaryType];
  return Boolean(fields && declared && Object.keys(data.types).length === 1 && JSON.stringify(declared) === JSON.stringify(fields) &&
    Object.keys(data.message).sort().join(',') === fields.map(f => f.name).sort().join(','));
}
/** The values the caller bound the action to, checked against the typed
 * data itself (gap audit 2026-10-05: only the shape was checked), on the
 * caller's network. */
export interface MasterActionBound {
  readonly network: WalletNetwork;
  /** UsdSend: the only destination (the owner's main wallet). */
  readonly destination?: string;
  /** ApproveBuilderFee: the configured builder. */
  readonly builder?: string;
  /** UserSetAbstraction: the copy account itself (only "disabled"). */
  readonly account?: string;
  /** ApproveAgent: exactly the consented agent and its name. */
  readonly agent?: { readonly address: string; readonly name: string };
}
export function masterActionBound(data: Pick<MasterTypedData, 'domain' | 'primaryType' | 'message'>, bound: MasterActionBound): boolean {
  if (!bound || !Object.hasOwn(WALLET_NETWORKS, bound.network)) return false;
  const network = WALLET_NETWORKS[bound.network], message = data.message;
  if (data.domain.chainId !== Number.parseInt(network.signatureChainId, 16) || message.hyperliquidChain !== network.hyperliquidChain) return false;
  const lower = (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value) ? value : null;
  if (data.primaryType === 'HyperliquidTransaction:UsdSend') return lower(message.destination) !== null && typeof bound.destination === 'string' && message.destination === bound.destination.toLowerCase();
  if (data.primaryType === 'HyperliquidTransaction:ApproveBuilderFee') return lower(message.builder) !== null && typeof bound.builder === 'string' && message.builder === bound.builder.toLowerCase();
  if (data.primaryType === 'HyperliquidTransaction:UserSetAbstraction') return lower(message.user) !== null && typeof bound.account === 'string' && message.user === bound.account.toLowerCase() && message.abstraction === 'disabled';
  if (data.primaryType === 'HyperliquidTransaction:ApproveAgent') return lower(message.agentAddress) !== null && typeof bound.agent?.address === 'string' && typeof bound.agent.name === 'string' &&
    message.agentAddress === bound.agent.address.toLowerCase() && message.agentName === bound.agent.name;
  return false;
}
