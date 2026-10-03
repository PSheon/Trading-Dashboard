import { z } from "zod";

/** Exact USDC units. Amounts never pass through floating point arithmetic. */
export function withdrawalUnits(value: string): bigint {
  if (value.length > 32 || !/^\d+(?:\.\d{1,6})?$/.test(value)) throw new Error("Invalid USDC amount");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}
const amountSchema = z.string().max(32).regex(/^\d+(?:\.\d{1,6})?$/).refine((value) => {
  try { const units = withdrawalUnits(value); return units > 1_000_000n && units <= 1_000_000_000_000_000_000n; }
  catch { return false; }
}).transform((value) => {
  const units = withdrawalUnits(value);
  const fraction = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${units / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
});
export const walletWithdrawalInputSchema = z.object({ destination: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((address) => address.toLowerCase()), amount: amountSchema }).strict();
export const walletWithdrawalImportSchema = walletWithdrawalInputSchema.extend({ nonce: z.number().int().positive().safe() }).strict();
export const walletWithdrawalSchema = z.object({
  id: z.string().uuid(), network: z.enum(["testnet", "mainnet"]), address: z.string().regex(/^0x[0-9a-f]{40}$/),
  destination: z.string().regex(/^0x[0-9a-f]{40}$/), amount: z.string(), nonce: z.number().int().positive().safe(),
  status: z.enum(["prepared", "unknown", "accepted", "rejected", "cancelled"]), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  canCancel: z.boolean().optional(),
});
export const walletWithdrawalClaimSchema = z.object({ operation: walletWithdrawalSchema, claimed: z.boolean() });
export type WalletWithdrawal = z.infer<typeof walletWithdrawalSchema>;
export type WalletWithdrawalInput = z.infer<typeof walletWithdrawalInputSchema>;
export type WalletWithdrawalClaim = z.infer<typeof walletWithdrawalClaimSchema>;
