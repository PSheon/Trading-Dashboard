import { z } from 'zod';
import { copyIdempotencyKeySchema } from './schema/copy.js';

export const prepareCopyAccountModeSchema = z.object({ idempotencyKey: copyIdempotencyKeySchema }).strict();
const millis = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const accountModeIntentSchema = z.object({
  operationId: z.string().min(1).max(128), accountId: z.string().min(1).max(128),
  strategyId: z.number().int().positive().max(2147483647), network: z.literal('testnet'),
  accountAddress: z.string().regex(/^0x[0-9a-f]{40}$/), nonce: millis, consentExpiresAt: millis,
}).strict().refine(v => v.accountAddress !== `0x${'00'.repeat(20)}` && v.consentExpiresAt > v.nonce && v.consentExpiresAt <= v.nonce + 300000, 'Invalid mode consent bounds');
export type AccountModeIntent = z.infer<typeof accountModeIntentSchema>;
export const copyAccountModeOperationSchema = z.object({
  id: z.string(), accountId: z.string(), strategyId: z.number().int().positive(), network: z.literal('testnet'),
  accountAddress: z.string().regex(/^0x[0-9a-f]{40}$/), target: z.literal('disabled'), revision: z.number().int().positive(),
  submissionState: z.enum(['prepared', 'signing', 'unknown', 'accepted', 'rejected']),
  targetState: z.enum(['unknown', 'supported', 'unproven', 'unsupported']),
  issue: z.string().nullable(), observedAt: z.string().datetime().nullable(),
  attemptedAt: z.string().datetime().nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export type CopyAccountModeOperation = z.infer<typeof copyAccountModeOperationSchema>;
export const copyAccountModeOverviewSchema = z.object({ available: z.boolean(), network: z.literal('testnet'), operations: z.array(copyAccountModeOperationSchema) });
