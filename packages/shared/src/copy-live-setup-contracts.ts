import { z } from 'zod';
import { copyFundingSchema } from './copy-funding-contracts.js';
import { copyMasterActionRequestSchema } from './copy-master-action-contracts.js';
import { liveCopyBudgetSchema } from './copy-live-mandate-contracts.js';
import { copyIdempotencyKeySchema, copyStrategySettingsSchema } from './schema/copy.js';

/**
 * One-click testnet copy (docs/one-click-copy-plan-2026-10-05.md §2, §3a):
 * the owner signs ONE setup consent (this EIP-712 payload) and the funding
 * UsdSend; the server then runs fund → credit → account mode → agent →
 * (builder fee) → mandate → activation, each step bound to this consent's
 * exact values. With the worker policy (COPY_AUTOMATIC_RETURN) the steps
 * after confirm need no open tab; without it the owner's session signs them
 * while the progress dialog is open, and the setup resumes on return.
 */
const id = z.string().min(1).max(128);
const address = z.string().regex(/^0x[0-9a-f]{40}$/).refine(value => value !== `0x${'00'.repeat(20)}`, 'Nonzero address required');
const version = z.number().int().positive().max(2147483647);
const millis = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const settings = copyStrategySettingsSchema.strict().refine(value => value.sizingMode !== 'fixed' || value.perTradeUsd !== null, 'Fixed sizing requires a per-trade amount')
  .refine(value => value.copyStartMode === 'delta', 'Testnet copies start from new trades only');

/** The consent window to sign and submit, and how long the server keeps
 * running the remaining steps after it. */
export const LIVE_SETUP_CONSENT_WINDOW_MS = 300_000;
export const LIVE_SETUP_DEADLINE_MS = 24 * 3_600_000;
/** Copy generation lifetime (decision 4): 30 days, renewal offered at T-3 days. */
export const LIVE_SETUP_VALID_DAYS = 30;
export const LIVE_RENEWAL_WINDOW_MS = 3 * 86_400_000;

/** POST /me/copy/live/setups — the trader panel's 測試網 start. */
export const startLiveCopySchema = z.object({
  idempotencyKey: copyIdempotencyKeySchema, leader: address,
  sourceNetwork: z.enum(['testnet', 'mainnet']).default('mainnet'), budgetUsd: liveCopyBudgetSchema, settings,
}).strict();
export type StartLiveCopy = z.infer<typeof startLiveCopySchema>;

/** start: a new copy (deposit included); edit: new settings or budget for a
 * running copy (a new generation, no deposit); renewal: a new agent and
 * generation before the 30-day lifetime ends. */
export const liveCopySetupKindSchema = z.enum(['start', 'edit', 'renewal']);
export type LiveCopySetupKind = z.infer<typeof liveCopySetupKindSchema>;
export const liveCopySetupIntentSchema = z.object({
  kind: liveCopySetupKindSchema, setupId: id, userId: version, ownerAddress: address, ownerPrivyUserId: id,
  strategyId: version, leaderAddress: address, sourceNetwork: z.enum(['testnet', 'mainnet']), network: z.literal('testnet'),
  budgetUsd: liveCopyBudgetSchema, settingsDigest: hash,
  accountId: id, accountAddress: address, accountAbstraction: z.literal('disabled'),
  agentAddress: address, agentPolicyId: id, agentPolicyFingerprint: hash, workerQuorumId: id, agentValidUntil: millis,
  builderAddress: address.nullable(), builderMaxFeeTenthsOfBps: z.number().int().nonnegative().max(100),
  /** Where every return goes: the owner's main wallet. */
  sweepDestination: address,
  /** The owner-owned Privy policy that binds the worker's signatures (empty
   * when the worker policy is off: the owner's session signs instead). */
  masterPolicyId: z.string().max(128), masterPolicyFingerprint: z.union([hash, z.literal('')]),
  /** The deposit the main wallet signs with this consent (start only; empty otherwise). */
  fundingOperationId: z.union([z.string().uuid(), z.literal('')]), fundingNonce: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), fundingAmount: z.string().max(32),
  nonce: millis, consentExpiresAt: millis, setupDeadline: millis,
}).strict().superRefine((value, ctx) => {
  if (value.consentExpiresAt <= value.nonce || value.consentExpiresAt > value.nonce + LIVE_SETUP_CONSENT_WINDOW_MS ||
      value.setupDeadline <= value.consentExpiresAt || value.setupDeadline > value.nonce + LIVE_SETUP_DEADLINE_MS + LIVE_SETUP_CONSENT_WINDOW_MS ||
      value.agentValidUntil < value.setupDeadline || value.agentValidUntil > value.nonce + 31 * 86_400_000)
    ctx.addIssue({ code: 'custom', path: ['consentExpiresAt'], message: 'Invalid setup consent lifetime' });
  if (new Set([value.ownerAddress, value.accountAddress, value.agentAddress]).size !== 3 || value.sweepDestination !== value.ownerAddress)
    ctx.addIssue({ code: 'custom', path: ['accountAddress'], message: 'Separate owner, account and agent identities required' });
  if (value.builderAddress === null && value.builderMaxFeeTenthsOfBps !== 0)
    ctx.addIssue({ code: 'custom', path: ['builderMaxFeeTenthsOfBps'], message: 'Builder fee requires an exact builder identity' });
  if ((value.masterPolicyId === '') !== (value.masterPolicyFingerprint === ''))
    ctx.addIssue({ code: 'custom', path: ['masterPolicyId'], message: 'Policy and fingerprint go together' });
  if (value.kind === 'start' ? value.fundingOperationId === '' || value.fundingNonce === 0 || value.fundingAmount !== value.budgetUsd
      : value.fundingOperationId !== '' || value.fundingNonce !== 0 || value.fundingAmount !== '0')
    ctx.addIssue({ code: 'custom', path: ['fundingAmount'], message: 'A start deposits the budget; an edit or renewal deposits nothing' });
});
export type LiveCopySetupIntent = z.infer<typeof liveCopySetupIntentSchema>;

const FIELDS: readonly [keyof LiveCopySetupIntent, string][] = [
  ['kind', 'string'], ['setupId', 'string'], ['userId', 'uint64'], ['ownerAddress', 'address'], ['ownerPrivyUserId', 'string'],
  ['strategyId', 'uint64'], ['leaderAddress', 'address'], ['sourceNetwork', 'string'], ['network', 'string'],
  ['budgetUsd', 'string'], ['settingsDigest', 'string'], ['accountId', 'string'], ['accountAddress', 'address'], ['accountAbstraction', 'string'],
  ['agentAddress', 'address'], ['agentPolicyId', 'string'], ['agentPolicyFingerprint', 'string'], ['workerQuorumId', 'string'], ['agentValidUntil', 'uint64'],
  ['builderAddress', 'address'], ['builderMaxFeeTenthsOfBps', 'uint64'], ['sweepDestination', 'address'],
  ['masterPolicyId', 'string'], ['masterPolicyFingerprint', 'string'],
  ['fundingOperationId', 'string'], ['fundingNonce', 'uint64'], ['fundingAmount', 'string'],
  ['nonce', 'uint64'], ['consentExpiresAt', 'uint64'], ['setupDeadline', 'uint64'],
];
/** The one owner consent: the main wallet signs every term the setup binds. */
export function liveCopySetupConsentTypedData(value: LiveCopySetupIntent) {
  const input = liveCopySetupIntentSchema.parse(value);
  return {
    domain: { name: 'Copy Trading Setup', version: '1', chainId: 421614, verifyingContract: `0x${'00'.repeat(20)}` as `0x${string}` },
    primaryType: 'CopyLiveSetupConsent' as const,
    types: { CopyLiveSetupConsent: FIELDS.map(([name, type]) => ({ name, type })) },
    message: { ...input, builderAddress: input.builderAddress ?? `0x${'00'.repeat(20)}` },
  };
}
/** The name Hyperliquid stores for the copy's agent (copy-agent-signing). */
export const liveSetupAgentName = (intent: Pick<LiveCopySetupIntent, 'strategyId' | 'agentValidUntil'>) => `copy${intent.strategyId} valid_until ${intent.agentValidUntil}`;

/** provisioning → awaiting_consent → consented → funding_submitted → funded →
 * mode_set → agent_active → builder_ready → running; failed, expired and
 * cancelled are terminal. */
export const liveCopySetupStageSchema = z.enum(['provisioning', 'awaiting_consent', 'consented', 'funding_submitted', 'funded', 'mode_set', 'agent_active', 'builder_ready', 'running',
  'failed', 'expired', 'cancelled']);
export type LiveCopySetupStage = z.infer<typeof liveCopySetupStageSchema>;
export const LIVE_SETUP_TERMINAL: readonly LiveCopySetupStage[] = ['running', 'failed', 'expired', 'cancelled'];
export const liveCopySetupSignerSchema = z.enum(['owner_session', 'worker_policy']);
export const liveCopySetupSchema = z.object({
  id: z.string().uuid(), kind: liveCopySetupKindSchema, strategyId: version, accountId: id.nullable(), leaderAddress: address,
  sourceNetwork: z.enum(['testnet', 'mainnet']), budgetUsd: liveCopyBudgetSchema, settings: copyStrategySettingsSchema,
  stage: liveCopySetupStageSchema, issue: z.string().max(80).nullable(),
  /** Who signs the steps after confirm: the worker (tab may close) or the owner's session (keep the dialog open, or come back). */
  signer: liveCopySetupSignerSchema.nullable(),
  /** Set while the owner's signature is due (awaiting_consent). */
  consent: liveCopySetupIntentSchema.nullable(),
  funding: copyFundingSchema.nullable(),
  /** The copy account's next signature, due from the owner's browser (an
   * owner-session setup): the progress dialog signs it silently and sends it
   * to /advance with its digest. Null when nothing is due. */
  pendingSignature: copyMasterActionRequestSchema.nullable(),
  mandateId: id.nullable(), setupDeadline: z.string().datetime().nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export type LiveCopySetup = z.infer<typeof liveCopySetupSchema>;
export const liveCopySetupsSchema = z.object({ items: z.array(liveCopySetupSchema).max(50) }).strict();
export const confirmLiveCopySetupSchema = z.object({
  consentSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  /** The main wallet's UsdSend to the copy account (a start only). */
  fundingSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).optional(),
}).strict();
export type ConfirmLiveCopySetup = z.infer<typeof confirmLiveCopySetupSchema>;
