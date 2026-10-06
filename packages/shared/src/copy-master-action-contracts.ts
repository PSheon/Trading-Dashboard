import { z } from "zod";
import type { WalletNetworkConfig } from "./wallet-networks.js";

/**
 * The Hyperliquid user-signed actions a copy account signs, with their exact
 * EIP-712 fields, in one table: the worker's signer allows only these shapes
 * (apps/api live/master-action.ts), the owner's Privy policy binds the same
 * fields (live/privy-master-policy.ts), and every builder below takes its
 * types from here. A copy account is signed for by the worker under the
 * owner's policy only (the one signing model, 2026-10-07): a UsdSend to the
 * owner's main wallet, the standard account mode, the consented agent's
 * approval and (when the fee is above 0) the consented builder fee.
 */
export const COPY_MASTER_ACTION_TYPES = {
  "HyperliquidTransaction:UsdSend": [{ name: "hyperliquidChain", type: "string" }, { name: "destination", type: "string" }, { name: "amount", type: "string" }, { name: "time", type: "uint64" }],
  "HyperliquidTransaction:UserSetAbstraction": [{ name: "hyperliquidChain", type: "string" }, { name: "user", type: "address" }, { name: "abstraction", type: "string" }, { name: "nonce", type: "uint64" }],
  "HyperliquidTransaction:ApproveAgent": [{ name: "hyperliquidChain", type: "string" }, { name: "agentAddress", type: "address" }, { name: "agentName", type: "string" }, { name: "nonce", type: "uint64" }],
  "HyperliquidTransaction:ApproveBuilderFee": [{ name: "hyperliquidChain", type: "string" }, { name: "maxFeeRate", type: "string" }, { name: "builder", type: "address" }, { name: "nonce", type: "uint64" }],
} as const satisfies Record<string, readonly { name: string; type: string }[]>;
export type CopyMasterPrimaryType = keyof typeof COPY_MASTER_ACTION_TYPES;
/** A fresh, mutable copy of one action's `types` entry. */
export function copyMasterTypes<P extends CopyMasterPrimaryType>(primary: P): { [K in P]: { name: string; type: string }[] } {
  return { [primary]: COPY_MASTER_ACTION_TYPES[primary].map(field => ({ ...field })) } as { [K in P]: { name: string; type: string }[] };
}
const ZERO = `0x${"00".repeat(20)}` as `0x${string}`;
/** Hyperliquid's domain for user-signed actions on `network`. */
export function hyperliquidUserSignedDomain(network: WalletNetworkConfig) {
  return { name: "HyperliquidSignTransaction", version: "1", chainId: Number.parseInt(network.signatureChainId, 16), verifyingContract: ZERO };
}

export const COPY_MASTER_ACTION_KINDS = ["account_mode", "agent_approval", "builder_fee", "usd_send"] as const;
export type CopyMasterActionKind = (typeof COPY_MASTER_ACTION_KINDS)[number];
export const COPY_MASTER_ACTION_PRIMARY_TYPES: Readonly<Record<CopyMasterActionKind, string>> = {
  account_mode: "HyperliquidTransaction:UserSetAbstraction",
  agent_approval: "HyperliquidTransaction:ApproveAgent",
  builder_fee: "HyperliquidTransaction:ApproveBuilderFee",
  usd_send: "HyperliquidTransaction:UsdSend",
};
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const millis = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const copyMasterSignatureSchema = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
export const copyMasterDigestSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
export const copyMasterTypedDataSchema = z.object({
  domain: z.object({ name: z.literal("HyperliquidSignTransaction"), version: z.literal("1"), chainId: z.number().int().positive(), verifyingContract: z.literal(ZERO) }).strict(),
  types: z.record(z.array(z.object({ name: z.string().min(1).max(64), type: z.string().min(1).max(32) }).strict()).min(1).max(8)),
  primaryType: z.string().min(1).max(64),
  message: z.record(z.union([z.string().max(160), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])),
}).strict();
export type CopyMasterTypedData = z.infer<typeof copyMasterTypedDataSchema>;
/** One action the owner's browser signs with the copy account. */
export const copyMasterActionRequestSchema = z.object({
  kind: z.enum(COPY_MASTER_ACTION_KINDS),
  /** The copy account (the signing wallet), never the main wallet. */
  account: address,
  typedData: copyMasterTypedDataSchema,
  /** The typed data's EIP-712 hash; sent back with the signature. */
  digest: copyMasterDigestSchema,
  /** Past this the server no longer takes the signature. */
  expiresAt: millis,
}).strict().refine(value => value.typedData.primaryType === COPY_MASTER_ACTION_PRIMARY_TYPES[value.kind] &&
  Object.keys(value.typedData.types).length === 1 && Object.keys(value.typedData.types)[0] === value.typedData.primaryType, "Typed data does not match its kind");
export type CopyMasterActionRequest = z.infer<typeof copyMasterActionRequestSchema>;

/** POST /me/copy/live/setups/:id/advance: empty to continue, or the owner's
 * signature of the setup's pending action. */
export const advanceLiveCopySetupSchema = z.union([
  z.object({}).strict(),
  z.object({ digest: copyMasterDigestSchema, signature: copyMasterSignatureSchema }).strict(),
]);
export type AdvanceLiveCopySetup = z.infer<typeof advanceLiveCopySetupSchema>;

/** The standard account mode (`userSetAbstraction` to "disabled"), with
 * exactly its signed fields. */
export function userSetAbstractionTypedData(network: WalletNetworkConfig, user: string, nonce: number) {
  return {
    domain: hyperliquidUserSignedDomain(network), types: copyMasterTypes("HyperliquidTransaction:UserSetAbstraction"),
    primaryType: "HyperliquidTransaction:UserSetAbstraction" as const,
    message: { hyperliquidChain: network.hyperliquidChain, user: user.toLowerCase() as `0x${string}`, abstraction: "disabled", nonce },
  };
}

/** Whether a request's typed data is exactly `expected` (the web derives the
 * action from the consent it signs and refuses a request that differs). */
export function sameMasterTypedData(request: Pick<CopyMasterActionRequest, "typedData">, expected: unknown): boolean {
  const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value);
  return canonical(request.typedData) === canonical(expected);
}
