import { z } from "zod";
import { withdrawalUnits } from "./wallet-withdrawal-contracts.js";
import { copyMasterActionRequestSchema, copyMasterSignatureSchema } from "./copy-master-action-contracts.js";

export function canonicalUsdc(units: bigint): string {
  const fraction = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${units / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}
export const copyFundingInputSchema = z.object({
  idempotencyKey: z.string().uuid(),
  amount: z.string().max(32).regex(/^\d+(?:\.\d{1,6})?$/).refine((value) => {
    try { const units = withdrawalUnits(value); return units > 0n && units <= 1_000_000_000_000_000_000n; } catch { return false; }
  }).transform((value) => canonicalUsdc(withdrawalUnits(value))),
}).strict();
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
export const copyFundingSchema = z.object({
  id: z.string().uuid(), accountId: z.string(), strategyId: z.number().int().positive(),
  network: z.enum(["testnet", "mainnet"]), address, destination: address,
  amount: z.string(), nonce: z.number().int().positive().safe(),
  status: z.enum(["prepared", "unknown", "accepted", "credited", "rejected", "cancelled"]),
  canCancel: z.boolean(), transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/).nullable(),
  creditedAmount: z.string().nullable(), fee: z.string().nullable(),
  /** to_main: a return from the copy's account to the main wallet. */
  direction: z.enum(["to_account", "to_main"]).optional(),
  stopId: z.string().uuid().nullable().optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export const copyFundingOverviewSchema = z.object({ available: z.boolean(), network: z.enum(["testnet", "mainnet"]), operations: z.array(copyFundingSchema) });
export const copyFundingClaimSchema = z.object({ operation: copyFundingSchema, claimed: z.boolean() });
export type CopyFundingInput = z.infer<typeof copyFundingInputSchema>;
export type CopyFunding = z.infer<typeof copyFundingSchema>;
export type CopyFundingOverview = z.infer<typeof copyFundingOverviewSchema>;
export type CopyFundingClaim = z.infer<typeof copyFundingClaimSchema>;

/** Return USDC from a copy's account to the main wallet: an amount of idle
 * funds while copying, or everything (`all`) once its stop is flat. */
export const copyReturnInputSchema = z.object({
  idempotencyKey: z.string().uuid(),
  amount: z.union([z.literal("all"), copyFundingInputSchema.shape.amount]),
}).strict();
export type CopyReturnInput = z.infer<typeof copyReturnInputSchema>;
export const copyReturnConsentSchema = z.object({
  operationId: z.string().uuid(), network: z.literal("testnet"), account: address, destination: address,
  amount: z.string(), nonce: z.number().int().positive().safe(), consentExpiresAt: z.number().int().positive().safe(),
}).strict();
export type CopyReturnConsent = z.infer<typeof copyReturnConsentSchema>;
/** `masterAction`: the copy account's UsdSend, signed in the owner's browser
 * (null once the return is no longer prepared). */
export const copyReturnChallengeSchema = z.object({ operation: copyFundingSchema, consent: copyReturnConsentSchema, masterAction: copyMasterActionRequestSchema.nullable() }).strict();
/** The main wallet's consent and the copy account's own signature of the
 * exact action (signed in the owner's browser). */
export const approveCopyMasterActionSchema = z.object({ consentSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/), masterSignature: copyMasterSignatureSchema }).strict();
/** A return's approval: the main wallet's consent, or none for an account
 * with the automatic return (the worker signs it, and its policy allows only
 * the owner's main wallet as the destination). */
export const approveCopyReturnSchema = z.object({ consentSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).optional(), masterSignature: copyMasterSignatureSchema.optional() }).strict()
  .refine(value => (value.consentSignature === undefined) === (value.masterSignature === undefined), "The consent and the copy account's signature go together");
/** The owner's main wallet signs this next to the copy account's own UsdSend
 * (a wallet the owner owns, signed in their browser). */
export function copyReturnConsentTypedData(value: CopyReturnConsent) {
  const input = copyReturnConsentSchema.parse(value);
  return {
    domain: { name: "Copy Account Return", version: "1", chainId: 421614, verifyingContract: `0x${"00".repeat(20)}` as `0x${string}` },
    primaryType: "CopyAccountReturn" as const,
    types: { CopyAccountReturn: [
      { name: "operationId", type: "string" }, { name: "network", type: "string" }, { name: "account", type: "address" },
      { name: "destination", type: "address" }, { name: "amount", type: "string" }, { name: "nonce", type: "uint64" }, { name: "consentExpiresAt", type: "uint64" },
    ] },
    message: { ...input },
  };
}
/** Builder fee approval by the copy's account, prepared for the owner. */
export const copyBuilderConsentSchema = z.object({
  operationId: z.string().uuid(), network: z.literal("testnet"), account: address, builder: address,
  maxFeeTenthsBps: z.number().int().min(1).max(100), nonce: z.number().int().positive().safe(), consentExpiresAt: z.number().int().positive().safe(),
}).strict();
export type CopyBuilderConsent = z.infer<typeof copyBuilderConsentSchema>;
export const copyBuilderApprovalSchema = z.object({
  id: z.string().uuid(), accountId: z.string(), state: z.enum(["prepared", "unknown", "accepted", "rejected", "approved"]),
  builderAddress: address, maxFeeTenthsBps: z.number().int(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export const copyBuilderChallengeSchema = z.object({ approval: copyBuilderApprovalSchema, consent: copyBuilderConsentSchema, masterAction: copyMasterActionRequestSchema.nullable() }).strict();
export function copyBuilderConsentTypedData(value: CopyBuilderConsent) {
  const input = copyBuilderConsentSchema.parse(value);
  return {
    domain: { name: "Copy Builder Fee Approval", version: "1", chainId: 421614, verifyingContract: `0x${"00".repeat(20)}` as `0x${string}` },
    primaryType: "CopyBuilderFeeApproval" as const,
    types: { CopyBuilderFeeApproval: [
      { name: "operationId", type: "string" }, { name: "network", type: "string" }, { name: "account", type: "address" },
      { name: "builder", type: "address" }, { name: "maxFeeTenthsBps", type: "uint64" }, { name: "nonce", type: "uint64" }, { name: "consentExpiresAt", type: "uint64" },
    ] },
    message: { ...input },
  };
}
