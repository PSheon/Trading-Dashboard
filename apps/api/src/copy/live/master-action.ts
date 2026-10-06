import { COPY_MASTER_ACTION_PRIMARY_TYPES, WALLET_NETWORKS, type CopyMasterActionKind, type CopyMasterActionRequest } from '@trading-dashboard/shared/contracts';
import { hashTypedData, verifyTypedData, type TypedDataDefinition } from 'viem';

export interface MasterAccount { readonly walletId: string; readonly address: string; readonly ownerQuorumId: string }
/** A Hyperliquid user-signed action's typed data (usdSend, approveBuilderFee). */
export interface MasterTypedData {
  readonly domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  readonly types: Record<string, readonly { name: string; type: string }[]>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
}

/** The only actions a copy account signs here (in the owner's browser, or
 * by the worker under the owner's policy), with their exact fields: a
 * USDC transfer (the return to the owner's main wallet), the builder fee
 * approval, and for a one-click setup the standard account mode and the
 * consented agent's approval (each only with the values the caller bound).
 * Anything else (Withdraw3, …) is refused before Privy is asked. */
const SIGNABLE: Readonly<Record<string, readonly { name: string; type: string }[]>> = {
  'HyperliquidTransaction:UsdSend': [{ name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'time', type: 'uint64' }],
  'HyperliquidTransaction:ApproveBuilderFee': [{ name: 'hyperliquidChain', type: 'string' }, { name: 'maxFeeRate', type: 'string' }, { name: 'builder', type: 'address' }, { name: 'nonce', type: 'uint64' }],
  'HyperliquidTransaction:UserSetAbstraction': [{ name: 'hyperliquidChain', type: 'string' }, { name: 'user', type: 'address' }, { name: 'abstraction', type: 'string' }, { name: 'nonce', type: 'uint64' }],
  'HyperliquidTransaction:ApproveAgent': [{ name: 'hyperliquidChain', type: 'string' }, { name: 'agentAddress', type: 'address' }, { name: 'agentName', type: 'string' }, { name: 'nonce', type: 'uint64' }],
};
export function masterActionSignable(data: Pick<MasterTypedData, 'primaryType' | 'types' | 'message'>): boolean {
  const fields = Object.hasOwn(SIGNABLE, data.primaryType) ? SIGNABLE[data.primaryType]! : null;
  const declared = data.types[data.primaryType];
  return Boolean(fields && declared && Object.keys(data.types).length === 1 && JSON.stringify(declared) === JSON.stringify(fields) &&
    Object.keys(data.message).sort().join(',') === fields.map(f => f.name).sort().join(','));
}
/** The values the caller bound the action to, checked against the typed
 * data itself (gap audit 2026-10-05: only the shape was checked). Testnet
 * only: a copy account never signs for mainnet here. */
export interface MasterActionBound {
  readonly network: 'testnet';
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
  if (bound?.network !== 'testnet') return false;
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

/** The kind of a signable action, from its primary type. */
export function masterActionKind(data: Pick<MasterTypedData, 'primaryType'>): CopyMasterActionKind | null {
  return (Object.entries(COPY_MASTER_ACTION_PRIMARY_TYPES) as [CopyMasterActionKind, string][]).find(([, primary]) => primary === data.primaryType)?.[0] ?? null;
}
const typed = (data: MasterTypedData) => data as unknown as TypedDataDefinition;
/** The EIP-712 hash of the exact typed data (what the owner's browser signs). */
export function masterActionDigest(data: MasterTypedData): `0x${string}` { return hashTypedData(typed(data)); }

/**
 * One action for the owner's browser to sign with the copy account (Privy's
 * `signTypedData` with that wallet's address: the copy account is a Privy
 * wallet the owner alone owns, and Privy refuses a server-side signature
 * with the owner's session for this app). Only an action this module can
 * sign at all, bound to the caller's values, is ever prepared.
 */
export function masterActionRequest(account: string, data: MasterTypedData, bound: MasterActionBound, expiresAt: number): CopyMasterActionRequest {
  const kind = masterActionKind(data);
  if (!kind || !hyperliquidDomain(data) || !masterActionSignable(data) || !masterActionBound(data, bound) || !/^0x[0-9a-fA-F]{40}$/.test(account) || !Number.isSafeInteger(expiresAt)) throw new Error('master_action_not_signable');
  const typedData = structuredClone(data) as unknown as CopyMasterActionRequest['typedData'];
  return { kind, account: account.toLowerCase(), typedData, digest: masterActionDigest(data), expiresAt };
}
function hyperliquidDomain(data: Pick<MasterTypedData, 'domain'>) {
  return data.domain.name === 'HyperliquidSignTransaction' && data.domain.version === '1' && data.domain.verifyingContract === `0x${'00'.repeat(20)}`;
}
/** Why the owner's signature of `data` can't be used, or null when it can:
 * `master_action_not_signable` (not one of the allowed actions with the
 * caller's values) or `master_signature_invalid` (it doesn't recover to the
 * copy account for exactly this payload). */
export async function masterSignatureRefusal(account: string, data: MasterTypedData, bound: MasterActionBound, signature: unknown): Promise<'master_action_not_signable' | 'master_signature_invalid' | null> {
  if (!hyperliquidDomain(data) || !masterActionSignable(data) || !masterActionBound(data, bound)) return 'master_action_not_signable';
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/i.test(signature) || !/^0x[0-9a-fA-F]{40}$/.test(account)) return 'master_signature_invalid';
  try { return await verifyTypedData({ address: account as `0x${string}`, ...typed(data), signature: signature as `0x${string}` }) ? null : 'master_signature_invalid'; }
  catch { return 'master_signature_invalid'; }
}
