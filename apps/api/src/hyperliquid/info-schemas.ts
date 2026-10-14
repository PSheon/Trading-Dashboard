import { z } from 'zod';

/**
 * One schema per info request that several callers parse. These say only
 * what parses: which answer a copy may run on stays each caller's own rule.
 */

/** `userAbstraction`: every documented answer (info-endpoint docs, checked
 * 2026-10-12; the SDK's type leaves out "dexAbstraction"). */
export const USER_ABSTRACTIONS = ['unifiedAccount', 'portfolioMargin', 'disabled', 'default', 'dexAbstraction'] as const;
export const userAbstractionSchema = z.enum(USER_ABSTRACTIONS);
export type UserAbstraction = z.infer<typeof userAbstractionSchema>;

/** `extraAgents`: an account's named agents, at most 100 here. `validUntil`
 * is the expiry in ms, or null (the SDK's type). */
export const extraAgentsSchema = z.array(z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), name: z.string().max(256),
  validUntil: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable() })).max(100);
