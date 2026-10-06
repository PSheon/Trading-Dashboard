import { z } from "zod";
import { withdrawalUnits } from "./wallet-withdrawal-contracts.js";

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
/** A prepared return: the worker signs it (the owner's policy allows only
 * the main wallet as the destination); the browser signs nothing. */
export const copyReturnChallengeSchema = z.object({ operation: copyFundingSchema }).strict();
/** A return's approval takes no body. */
export const approveCopyReturnSchema = z.object({}).strict();
/** A builder fee approval by the copy's account (signed by the setup driver's worker). */
export const copyBuilderApprovalSchema = z.object({
  id: z.string().uuid(), accountId: z.string(), state: z.enum(["prepared", "unknown", "accepted", "rejected", "approved"]),
  builderAddress: address, maxFeeTenthsBps: z.number().int(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
