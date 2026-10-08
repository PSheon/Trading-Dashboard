import { z } from 'zod';
import { copyIdempotencyKeySchema } from './schema/copy.js';
import { copyFundingSchema } from './copy-funding-contracts.js';

const identifier = z.string().min(1).max(128).regex(/^[^\s\p{Cc}\p{Cf}]+$/u);
const issue = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/).nullable();
export const requestLiveCopySetupAbortSchema = z.object({ idempotencyKey: copyIdempotencyKeySchema }).strict();
export type RequestLiveCopySetupAbort = z.infer<typeof requestLiveCopySetupAbortSchema>;
/** Progress of the original setup and its original money operations. The
 * request never supplies a destination, amount, consent or new signature. */
export const liveCopySetupAbortSchema = z.object({
  id: z.string().uuid(), setupId: identifier, kind: z.enum(['start', 'edit', 'renewal']),
  strategyId: z.number().int().positive(), accountId: identifier.nullable(), network: z.enum(['testnet', 'mainnet']),
  state: z.enum(['requested', 'reconciling', 'refunding', 'delegated', 'blocked', 'completed']), issue,
  deposit: copyFundingSchema.nullable(), refund: copyFundingSchema.nullable(),
  stop: z.object({ id: z.string().uuid(), state: z.enum(['requested', 'cancelling', 'closing', 'blocked', 'flat', 'stopped']), issue }).strict().nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  for (const [operation, direction] of [[value.deposit, 'to_account'], [value.refund, 'to_main']] as const) {
    if (operation && (operation.accountId !== value.accountId || operation.strategyId !== value.strategyId ||
      operation.network !== value.network || operation.direction !== direction)) invalid('Original funding identity required');
  }
  if (value.deposit && value.refund && (value.refund.address !== value.deposit.destination || value.refund.destination !== value.deposit.address))
    invalid('Refund must return to the original owner');
  if (value.refund && value.kind !== 'start') invalid('Pending edits do not return active strategy funds');
  if (value.state === 'delegated' && (!value.stop || value.kind !== 'start')) invalid('Original stop required for delegation');
  if (value.state === 'blocked' && !value.issue) invalid('Blocked setup abort requires a reason');
  if (value.state === 'completed' && (value.deposit && !['credited', 'rejected', 'cancelled'].includes(value.deposit.status) ||
    value.refund && value.refund.status !== 'credited' || value.stop && value.stop.state !== 'stopped')) invalid('Original operations must be resolved before completion');
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) invalid('Inconsistent setup abort progress times');
});
export type LiveCopySetupAbort = z.infer<typeof liveCopySetupAbortSchema>;
