import { z } from "zod";

export const prepareCopyAgentSchema = z.object({ idempotencyKey: z.string().min(1).max(128), validForDays: z.number().int().min(1).max(30).default(7) }).strict();
export const copyAgentStateSchema = z.enum(["policy_prepared", "policy_unknown", "wallet_prepared", "wallet_unknown", "ready", "approval_signing", "approval_unknown", "active", "blocked", "revoked", "expired"]);
export const copyAgentSetupSchema = z.object({
  id: z.string(), strategyId: z.number().int().positive(), accountId: z.string(), network: z.enum(["testnet", "mainnet"]),
  state: copyAgentStateSchema, accountAddress: z.string(), agentAddress: z.string().nullable(),
  expiresAt: z.string().datetime(), issue: z.string().nullable(), authorizationId: z.string().nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  /** Optional while older deployed APIs roll out; the server binds exact consent. */
  revision: z.number().int().positive().optional(),
});
export const copyAgentOverviewSchema = z.object({ available: z.boolean(), network: z.enum(["testnet", "mainnet"]), setups: z.array(copyAgentSetupSchema) });
export const copyAgentApproveSchema = z.object({ consentSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).strict();
export const copyAgentConsentIntentSchema = z.object({
  id: z.string(), strategyId: z.number().int().positive(), network: z.literal("testnet"),
  accountAddress: z.string(), agentAddress: z.string(), policyId: z.string(), workerQuorumId: z.string(),
  nonce: z.number().int().positive().safe(), expiresAt: z.number().int().positive().safe(), consentExpiresAt: z.number().int().positive().safe(),
});
export const copyAgentChallengeSchema = z.object({ operation: copyAgentSetupSchema, intent: copyAgentConsentIntentSchema });
export type CopyAgentSetup = z.infer<typeof copyAgentSetupSchema>;
export type CopyAgentOverview = z.infer<typeof copyAgentOverviewSchema>;
export type CopyAgentChallenge = z.infer<typeof copyAgentChallengeSchema>;
