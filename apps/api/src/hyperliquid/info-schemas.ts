import { z } from 'zod';

/**
 * What Hyperliquid may answer, one schema per info request that several
 * callers parse (they used to keep their own, and disagreed). These say only
 * what parses: which answer a copy may run on stays each caller's own rule.
 */

/** `userAbstraction`: every documented answer (info-endpoint docs, checked
 * 2026-10-12; the SDK's type leaves out "dexAbstraction", the docs list it).
 * Mainnet 2026-10-12, 40 active traders: disabled, unifiedAccount,
 * portfolioMargin and default all seen. */
export const USER_ABSTRACTIONS = ['unifiedAccount', 'portfolioMargin', 'disabled', 'default', 'dexAbstraction'] as const;
export const userAbstractionSchema = z.enum(USER_ABSTRACTIONS);
export type UserAbstraction = z.infer<typeof userAbstractionSchema>;

/** `extraAgents`: an account's named agents, at most 100 here. `validUntil`
 * is the expiry in ms, or null (the SDK's type; mainnet 2026-10-12: 116
 * agents, every one a positive time). */
export const extraAgentsSchema = z.array(z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), name: z.string().max(256),
  validUntil: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable() })).max(100);
export type ExtraAgents = z.infer<typeof extraAgentsSchema>;
