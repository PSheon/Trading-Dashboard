import { z } from 'zod';
import { copyIdempotencyKeySchema, copyStrategySettingsSchema, copyStrategyStatusSchema } from './schema/copy.js';

const id = z.string().min(1).max(128);
const address = z.string().regex(/^0x[0-9a-f]{40}$/).refine(value => value !== `0x${'00'.repeat(20)}`, 'Nonzero address required');
const version = z.number().int().positive().max(2147483647);
const millis = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const liveCopyBudgetSchema = z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/).max(32)
  .refine(value => /[1-9]/.test(value), 'Positive budget required');
const settings = copyStrategySettingsSchema.strict().refine(value => value.sizingMode !== 'fixed' || value.perTradeUsd !== null, 'Fixed sizing requires a per-trade amount');

/** Create a dedicated paused strategy. No paper balance allocation or wallet operation. */
export const createLiveCopyStrategySchema = z.object({
  idempotencyKey: copyIdempotencyKeySchema, leader: address,
  sourceNetwork: z.enum(['testnet', 'mainnet']), budgetUsd: liveCopyBudgetSchema, settings,
}).strict();
export type CreateLiveCopyStrategy = z.infer<typeof createLiveCopyStrategySchema>;
export const liveCopyStrategySchema = z.object({
  id: version, mode: z.literal('actual'), network: z.literal('testnet'),
  sourceNetwork: z.enum(['testnet', 'mainnet']), leaderAddress: address, budgetUsd: liveCopyBudgetSchema,
  status: copyStrategyStatusSchema, version, settings,
  pauseNewRisk: z.boolean(), reduceOnly: z.boolean(), createdAt: z.string().datetime(),
}).strict();
export type LiveCopyStrategy = z.infer<typeof liveCopyStrategySchema>;
export const prepareLiveCopyMandateSchema = z.object({ idempotencyKey: copyIdempotencyKeySchema }).strict();
export const approveLiveCopyMandateSchema = z.object({ consentSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).strict();
export const liveCopyMandateIntentSchema = z.object({
  mandateId: id, accountId: id, userId: version, strategyId: version, strategyVersion: version,
  network: z.literal('testnet'), sourceNetwork: z.enum(['testnet', 'mainnet']), leaderAddress: address,
  accountAddress: address, accountRevision: version, ownerAddress: address, ownerPrivyUserId: id,
  setupId: id, setupRevision: version, executionWalletId: id, agentWalletId: id, agentAddress: address,
  authorizationId: id, authorizationVersion: version, policyId: id, policyFingerprint: hash,
  workerQuorumId: id, settingsDigest: hash, budgetUsd: liveCopyBudgetSchema,
  builderAddress: address.nullable(), builderMaxFeeTenthsOfBps: z.number().int().nonnegative().max(100),
  plannerVersion: z.literal(1), nonce: millis, consentExpiresAt: millis, expiresAt: millis,
}).strict().superRefine((value, ctx) => {
  if (value.consentExpiresAt <= value.nonce || value.consentExpiresAt > value.nonce + 300000 ||
      value.expiresAt <= value.consentExpiresAt || value.expiresAt > value.nonce + 30 * 86400000)
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Invalid consent lifetime' });
  if (value.accountAddress === value.ownerAddress || value.accountAddress === value.agentAddress || value.ownerAddress === value.agentAddress)
    ctx.addIssue({ code: 'custom', path: ['accountAddress'], message: 'Separate owner, master and agent identities required' });
  if (value.builderAddress === null && value.builderMaxFeeTenthsOfBps !== 0)
    ctx.addIssue({ code: 'custom', path: ['builderMaxFeeTenthsOfBps'], message: 'Builder fee requires an exact builder identity' });
});
export type LiveCopyMandateIntent = z.infer<typeof liveCopyMandateIntentSchema>;
export const liveCopyMandateStateSchema = z.enum(['prepared', 'active', 'paused', 'stopping', 'stopped', 'revoked', 'expired']);
export const liveCopyMandateSchema = z.object({
  id: id, accountId: id, strategyId: version, mode: z.literal('actual'), network: z.literal('testnet'),
  accountAddress: address, sourceNetwork: z.enum(['testnet', 'mainnet']), leaderAddress: address,
  budgetUsd: liveCopyBudgetSchema, strategyVersion: version, state: liveCopyMandateStateSchema, revision: version,
  activationCursor: z.string().datetime().nullable(), expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export type LiveCopyMandate = z.infer<typeof liveCopyMandateSchema>;
export const liveCopyMandateRenewalSchema = z.object({ checkedAt: z.string().datetime(), eligible: z.boolean(),
  reason: z.enum(['prepared_consent_expired', 'generation_expired', 'revoked']).nullable(), mandateId: z.string().min(1).max(128), revision: z.number().int().positive(), nonce: millis,
}).strict().refine(v => v.eligible === (v.reason !== null));
export const liveCopyMandateChallengeSchema = z.object({ mandate: liveCopyMandateSchema, intent: liveCopyMandateIntentSchema, renewal: liveCopyMandateRenewalSchema.optional() }).strict().superRefine((v, ctx) => {
  if (v.renewal && (v.renewal.mandateId !== v.mandate.id || v.renewal.revision !== v.mandate.revision || v.renewal.nonce !== v.intent.nonce))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Renewal evidence must refer to the original consent generation' });
});
export const liveCopyOverviewSchema = z.object({
  mode: z.literal('actual'), network: z.literal('testnet'),
  capabilities: z.object({ strategyPreparation: z.boolean(), automaticExecution: z.boolean(), sourceNetworks: z.array(z.enum(['testnet', 'mainnet'])) }).strict(),
  strategies: z.array(liveCopyStrategySchema), mandates: z.array(liveCopyMandateSchema),
}).strict();

/** Local owner consent. This payload does not itself invoke the exchange. */
export function liveCopyMandateOwnerTypedData(value: LiveCopyMandateIntent) {
  const input = liveCopyMandateIntentSchema.parse(value);
  const fields: [string, string][] = [
    ['mandateId', 'string'], ['accountId', 'string'], ['userId', 'uint64'], ['strategyId', 'uint64'], ['strategyVersion', 'uint64'],
    ['network', 'string'], ['sourceNetwork', 'string'], ['leaderAddress', 'address'], ['accountAddress', 'address'],
    ['accountRevision', 'uint64'], ['ownerAddress', 'address'], ['ownerPrivyUserId', 'string'],
    ['setupId', 'string'], ['setupRevision', 'uint64'], ['executionWalletId', 'string'], ['agentWalletId', 'string'], ['agentAddress', 'address'],
    ['authorizationId', 'string'], ['authorizationVersion', 'uint64'], ['policyId', 'string'], ['policyFingerprint', 'string'],
    ['workerQuorumId', 'string'], ['settingsDigest', 'string'], ['budgetUsd', 'string'], ['builderAddress', 'address'],
    ['builderMaxFeeTenthsOfBps', 'uint64'], ['plannerVersion', 'uint64'], ['nonce', 'uint64'], ['consentExpiresAt', 'uint64'], ['expiresAt', 'uint64'],
  ];
  return {
    domain: { name: 'Copy Trading Mandate', version: '1', chainId: 421614, verifyingContract: `0x${'00'.repeat(20)}` as `0x${string}` },
    primaryType: 'CopyTradingMandate' as const,
    types: { CopyTradingMandate: fields.map(([name, type]) => ({ name, type })) },
    message: { ...input, builderAddress: input.builderAddress ?? `0x${'00'.repeat(20)}` },
  };
}
