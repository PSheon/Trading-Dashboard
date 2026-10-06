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

/** Owner consent for the worker to cancel the exact orders a stop barrier
 * tracked. It authorizes cancellation only: never new risk, closing orders,
 * transfers or a different stop, account, agent, grant or network. */
const MAX_TIME = 8640000000000000;
const consentId = z.string().min(1).max(128).regex(/^[^\s\p{Cc}\p{Cf}]+$/u);
const consentAddress = z.string().regex(/^0x[0-9a-f]{40}$/).refine(value => value !== `0x${'00'.repeat(20)}`, 'Nonzero address required');
const consentTime = z.number().int().positive().max(MAX_TIME);
const consentHash = z.string().regex(/^[0-9a-f]{64}$/);
export const liveStopCancellationIntentSchema = z.object({
  authorizationId: consentId, stopId: consentId, accountId: consentId, strategyId: revision, userId: revision,
  network: z.literal('testnet'), purpose: z.literal('cancel_tracked_orders'), schemaVersion: z.literal(1),
  capturedStopRevision: revision, targetDigest: consentHash, accountAddress: consentAddress,
  accountRevision: revision, accountWalletId: consentId, accountOwnerQuorumId: consentId,
  ownerPrivyUserId: consentId, ownerAddress: consentAddress,
  setupId: consentId, setupRevision: revision, executionWalletId: consentId, agentWalletId: consentId,
  agentAddress: consentAddress, agentOwnerQuorumId: consentId, workerQuorumId: consentId,
  grantId: consentId, grantVersion: revision, grantValidFrom: consentTime, grantExpiresAt: consentTime,
  policyId: consentId, policyFingerprint: consentHash,
  nonce: consentTime, consentExpiresAt: consentTime, expiresAt: consentTime,
}).strict().superRefine((value, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (value.consentExpiresAt <= value.nonce || value.consentExpiresAt > value.nonce + 300000) issue('consentExpiresAt', 'Invalid approval window');
  if (value.expiresAt <= value.consentExpiresAt || value.expiresAt > value.nonce + 1800000) issue('expiresAt', 'Invalid cancellation lifetime');
  if (value.grantValidFrom > value.nonce || value.grantExpiresAt < value.expiresAt) issue('grantExpiresAt', 'Grant must cover the cancellation lifetime');
  if (value.accountAddress === value.ownerAddress || value.agentAddress === value.accountAddress || value.agentAddress === value.ownerAddress)
    issue('agentAddress', 'Separate owner, master and agent identities required');
});
export type LiveStopCancellationIntent = z.infer<typeof liveStopCancellationIntentSchema>;
