import { z } from 'zod';
import { copyIdempotencyKeySchema } from './schema/copy.js';
import { copyMasterActionRequestSchema, copyMasterSignatureSchema } from './copy-master-action-contracts.js';

export const prepareCopyAccountModeSchema = z.object({ idempotencyKey: copyIdempotencyKeySchema }).strict();
/** The main wallet's consent, and the copy account's own signature of the
 * mode change (signed in the owner's browser: the challenge's `masterAction`). */
export const approveCopyAccountModeSchema = z.object({ consentSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/), masterSignature: copyMasterSignatureSchema }).strict();
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
export const copyAccountModeChallengeSchema = z.object({ operation: copyAccountModeOperationSchema, intent: accountModeIntentSchema, masterAction: copyMasterActionRequestSchema });
export function accountModeOwnerConsentTypedData(value: AccountModeIntent) {
  const input = accountModeIntentSchema.parse(value);
  return {
    domain: { name: 'Copy Trading Account Configuration', version: '1', chainId: 421614,
      verifyingContract: `0x${'00'.repeat(20)}` as `0x${string}` },
    types: { CopyAccountModeConsent: [
      { name: 'operationId', type: 'string' }, { name: 'accountId', type: 'string' },
      { name: 'strategyId', type: 'uint64' }, { name: 'account', type: 'address' },
      { name: 'network', type: 'string' }, { name: 'abstraction', type: 'string' },
      { name: 'nonce', type: 'uint64' }, { name: 'consentExpiresAt', type: 'uint64' },
    ] }, primaryType: 'CopyAccountModeConsent' as const,
    message: { operationId: input.operationId, accountId: input.accountId, strategyId: input.strategyId,
      account: input.accountAddress as `0x${string}`, network: input.network, abstraction: 'disabled',
      nonce: input.nonce, consentExpiresAt: input.consentExpiresAt },
  };
}
