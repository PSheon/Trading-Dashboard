import { z } from 'zod';
import { copyIdempotencyKeySchema } from './schema/copy.js';

const id = z.string().min(1).max(128).regex(/^[^\s\p{Cc}\p{Cf}]+$/u);
const revision = z.number().int().positive().max(2147483647);
const date = z.string().datetime();
export const requestLiveCopyStopSchema = z.object({
  idempotencyKey: copyIdempotencyKeySchema,
  expectedMandateRevision: revision,
}).strict();
export type RequestLiveCopyStop = z.infer<typeof requestLiveCopyStopSchema>;
/** A durable local barrier is separate from cancelled orders, flat positions
 * and returned funds. Only the latter verified stages may report stopped. */
export const liveCopyStopSchema = z.object({
  id: z.string().uuid(), accountId: id, mandateId: id, strategyId: revision,
  network: z.literal('testnet'), accountAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
  originalMandateRevision: revision, revision,
  state: z.enum(['requested', 'cancelling', 'closing', 'blocked', 'flat', 'stopped']),
  desiredAction: z.literal('cancel_and_close'),
  trackedExecutionCount: z.number().int().nonnegative().max(1000),
  trackingComplete: z.boolean(), issue: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/).nullable(),
  flatVerifiedAt: date.nullable(), createdAt: date, updatedAt: date,
}).strict().superRefine((value, ctx) => {
  if ((value.state === 'flat' || value.state === 'stopped') !== (value.flatVerifiedAt !== null))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Flat evidence required for completed stop stages' });
  if (value.state === 'blocked' && value.issue === null)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Blocked stop requires a reason' });
  if (!value.trackingComplete && value.state !== 'blocked')
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Incomplete tracking blocks stop progression' });
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt) || value.flatVerifiedAt !== null &&
    (Date.parse(value.flatVerifiedAt) < Date.parse(value.createdAt) || Date.parse(value.flatVerifiedAt) > Date.parse(value.updatedAt)))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent stop evidence times' });
});
export type LiveCopyStop = z.infer<typeof liveCopyStopSchema>;
export const liveCopyStopsSchema = z.object({
  items: z.array(liveCopyStopSchema).max(100), truncated: z.boolean(),
}).strict();
