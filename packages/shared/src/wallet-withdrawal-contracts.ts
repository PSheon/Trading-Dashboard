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
  // not_executed: an operator confirmed, after Hyperliquid's nonce window,
  // that the ledger has no such withdrawal (it can never execute).
  status: z.enum(["prepared", "unknown", "accepted", "rejected", "cancelled", "not_executed"]), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  canCancel: z.boolean().optional(),
});
export const walletWithdrawalClaimSchema = z.object({ operation: walletWithdrawalSchema, claimed: z.boolean() });
export type WalletWithdrawal = z.infer<typeof walletWithdrawalSchema>;
export type WalletWithdrawalInput = z.infer<typeof walletWithdrawalInputSchema>;
export type WalletWithdrawalClaim = z.infer<typeof walletWithdrawalClaimSchema>;

/** Hyperliquid accepts an action only while its nonce is within
 * (T - 2 days, T + 1 day) of the block time T (docs: "Nonces and API
 * wallets"): a withdrawal signed with an older nonce can never execute. An
 * hour of margin on top. */
export const WITHDRAWAL_NONCE_WINDOW_MS = 2 * 86_400_000 + 3_600_000;

/** A main-wallet withdrawal whose outcome is not known (admin). */
export const adminUnresolvedWithdrawalSchema = z.object({
  id: z.string().uuid(), userId: z.number().int(), email: z.string().nullable(), network: z.enum(["testnet", "mainnet"]),
  address: z.string(), destination: z.string(), amount: z.string(), nonce: z.number().int(),
  attempted: z.boolean(), createdAt: z.string().datetime(),
  /** When an operator may resolve it (the nonce window has passed). */
  resolvableAt: z.string().datetime(),
}).strict();
export const adminUnresolvedWithdrawalsSchema = z.object({ items: z.array(adminUnresolvedWithdrawalSchema) }).strict();
export const adminResolveWithdrawalSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export const adminResolvedWithdrawalSchema = z.object({
  id: z.string().uuid(), status: z.enum(["accepted", "not_executed"]), evidence: z.enum(["ledger_match", "ledger_absent_after_nonce_window"]),
}).strict();
export type AdminUnresolvedWithdrawals = z.infer<typeof adminUnresolvedWithdrawalsSchema>;
export type AdminResolvedWithdrawal = z.infer<typeof adminResolvedWithdrawalSchema>;
