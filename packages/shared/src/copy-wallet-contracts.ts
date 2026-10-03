import { z } from "zod";

export const copyWalletNetworkSchema = z.enum(["testnet", "mainnet"]);
export const createCopyExecutionWalletSchema = z.object({ network: copyWalletNetworkSchema }).strict();
export const copyExecutionAccountSchema = z.object({
  id: z.string(), strategyId: z.number().int().positive(), network: copyWalletNetworkSchema,
  state: z.enum(["requested", "unknown", "ready", "blocked"]), address: z.string().regex(/^0x[0-9a-f]{40}$/).nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  /** Optional while older deployed APIs roll out; never synthesize it. */
  revision: z.number().int().positive().optional(),
  issue: z.enum(["verification_pending", "provider_unavailable", "wallet_conflict"]).nullable(),
});
export const copyWalletGrantSchema = z.object({
  id: z.string(), strategyId: z.number().int().positive(), network: copyWalletNetworkSchema,
  accountAddress: z.string(), signerAddress: z.string(), status: z.enum(["pending", "active", "expired", "revoked"]),
  scopes: z.array(z.enum(["copy:trade", "copy:reduce"])), expiresAt: z.string().datetime(), revokedAt: z.string().datetime().nullable(),
  version: z.number().int().positive().optional(),
});
export const copyExecutionWalletsSchema = z.object({
  available: z.boolean(), network: copyWalletNetworkSchema,
  accounts: z.array(copyExecutionAccountSchema), authorizations: z.array(copyWalletGrantSchema),
});
export type CopyExecutionAccount = z.infer<typeof copyExecutionAccountSchema>;
export type CopyWalletGrant = z.infer<typeof copyWalletGrantSchema>;
export type CopyExecutionWallets = z.infer<typeof copyExecutionWalletsSchema>;
