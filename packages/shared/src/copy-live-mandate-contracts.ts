import { z } from 'zod';
import { copyIdempotencyKeySchema, copyStrategySettingsSchema, copyStrategyStatusSchema, liveCopyBudgetSchema } from './schema/copy.js';
import { liveCopySetupIntentSchema } from './copy-live-setup-contracts.js';

export { liveCopyBudgetSchema } from './schema/copy.js';

const id = z.string().min(1).max(128);
const address = z.string().regex(/^0x[0-9a-f]{40}$/).refine(value => value !== `0x${'00'.repeat(20)}`, 'Nonzero address required');
const version = z.number().int().positive().max(2147483647);
const millis = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const settings = copyStrategySettingsSchema.strict().refine(value => value.sizingMode !== 'fixed' || value.perTradeUsd !== null, 'Fixed sizing requires a per-trade amount');

/** Create a dedicated paused strategy. No paper balance allocation or wallet operation. */
export const createLiveCopyStrategySchema = z.object({
  idempotencyKey: copyIdempotencyKeySchema, leader: address,
  sourceNetwork: z.enum(['testnet', 'mainnet']), budgetUsd: liveCopyBudgetSchema, settings,
}).strict();
export type CreateLiveCopyStrategy = z.infer<typeof createLiveCopyStrategySchema>;
export const liveCopyStrategySchema = z.object({
  id: version, mode: z.literal('actual'), network: z.enum(['testnet', 'mainnet']),
  sourceNetwork: z.enum(['testnet', 'mainnet']), leaderAddress: address, budgetUsd: liveCopyBudgetSchema,
  status: copyStrategyStatusSchema, version, settings,
  pauseNewRisk: z.boolean(), reduceOnly: z.boolean(), createdAt: z.string().datetime(),
}).strict();
export type LiveCopyStrategy = z.infer<typeof liveCopyStrategySchema>;
export const liveCopyMandateIntentSchema = z.object({
  mandateId: id, accountId: id, userId: version, strategyId: version, strategyVersion: version,
  network: z.enum(['testnet', 'mainnet']), sourceNetwork: z.enum(['testnet', 'mainnet']), leaderAddress: address,
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
  id: id, accountId: id, strategyId: version, mode: z.literal('actual'), network: z.enum(['testnet', 'mainnet']),
  accountAddress: address, sourceNetwork: z.enum(['testnet', 'mainnet']), leaderAddress: address,
  budgetUsd: liveCopyBudgetSchema, strategyVersion: version, state: liveCopyMandateStateSchema, revision: version,
  activationCursor: z.string().datetime().nullable(), expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export type LiveCopyMandate = z.infer<typeof liveCopyMandateSchema>;
export const liveCopyOverviewSchema = z.object({
  mode: z.literal('actual'), network: z.enum(['testnet', 'mainnet']),
  capabilities: z.object({ strategyPreparation: z.boolean(), automaticExecution: z.boolean(), sourceNetworks: z.array(z.enum(['testnet', 'mainnet'])),
    /** This owner may start an actual copy on this deployment (a live
     * deployment allows listed owners only: COPY_LIVE_ALLOWED_PRIVY_USER_IDS). */
    actualAllowed: z.boolean().optional(),
    /** Absent on older deployments: the client treats this as unavailable. */
    setupAbort: z.boolean().optional(),
    /** The deployment's caps on a new actual copy: fixed sizing within these
     * per-trade bounds (null: any sizing), the largest budget and leverage. */
    caps: z.object({ fixedPerTradeUsd: z.object({ min: z.number(), max: z.number() }).strict().nullable(), maxAllocationUsd: z.number().nullable(),
      maxLeverage: z.number().nullable(), maxStrategiesPerUser: z.number().int().positive() }).strict().optional() }).strict(),
  strategies: z.array(liveCopyStrategySchema), mandates: z.array(liveCopyMandateSchema),
}).strict();

/** Where a testnet copy stands, as CopyDog's portfolio shows it: setup →
 * needs_deposit → funding → awaiting_credit → starting → active (or paused);
 * a stop: stopping → sweeping (flat, returning funds) → stopped. */
export const liveCopyStageSchema = z.enum(['setup', 'needs_deposit', 'funding', 'awaiting_credit', 'starting', 'active', 'paused', 'stopping', 'sweeping', 'stopped']);
export type LiveCopyStage = z.infer<typeof liveCopyStageSchema>;
export const liveCopyPortfolioItemSchema = z.object({
  strategyId: version, leaderAddress: address, sourceNetwork: z.enum(['testnet', 'mainnet']), budgetUsd: liveCopyBudgetSchema,
  /** The network the copy executes on. One that isn't the deployment's
   * (`liveCopyPortfolioSchema.network`) is history here: shown, never worked. */
  network: z.enum(['testnet', 'mainnet']).optional(),
  status: copyStrategyStatusSchema, stage: liveCopyStageSchema, createdAt: z.string().datetime(),
  accountId: id.nullable(), accountAddress: address.nullable(),
  mandate: z.object({ id, state: liveCopyMandateStateSchema, revision: version }).strict().nullable(),
  stop: z.object({ id: z.string().uuid(), state: z.enum(['requested', 'cancelling', 'closing', 'blocked', 'flat', 'stopped']), issue: z.string().nullable(), revision: version }).strict().nullable(),
  pendingTransfer: z.object({ id: z.string().uuid(), direction: z.enum(['to_account', 'to_main']), status: z.enum(['prepared', 'unknown', 'accepted']), amount: z.string() }).strict().nullable(),
  /** The latest leg the worker refused, with its reason (e.g. a price deviation). */
  lastRefusal: z.object({ reason: z.string(), at: z.string().datetime() }).strict().nullable(),
  /** SQL observations of this consent generation. A filled exchange ACK is
   * still confirming until its reservation has a verified settlement release.
   * sourceThrough is source coverage, not a promise of execution latency. */
  executionSummary: z.object({ pending: z.number().int().nonnegative(), confirming: z.number().int().nonnegative(),
    oldestPendingAt: z.string().datetime().nullable(), lastCompletedAt: z.string().datetime().nullable(),
    sourceThrough: z.string().datetime().nullable(), observedAt: z.string().datetime() }).strict().nullable().optional(),
  /** The account's funds return to the main wallet by themselves after a
   * stop (the worker's policy-bound signer); idle withdrawals need no
   * signature. Optional while older APIs roll out. */
  automaticReturn: z.boolean().optional(),
  /** The latest stop's return to the main wallet (credited: the amount
   * that arrived). */
  sweep: z.object({ amount: z.string(), status: z.enum(['prepared', 'unknown', 'accepted', 'credited', 'rejected', 'cancelled']) }).strict().nullable().optional(),
  /** The copy's latest one-click setup (start, edit or renewal) while it is
   * unfinished, or when it ended without finishing (failed / expired). */
  setup: z.object({ id: z.string().uuid(), kind: z.enum(['start', 'edit', 'renewal']),
    stage: z.enum(['provisioning', 'awaiting_consent', 'consented', 'funding_submitted', 'funded', 'mode_set', 'agent_active', 'builder_ready', 'running', 'failed', 'expired', 'cancelled']),
    issue: z.string().nullable(),
    abortRequested: z.boolean().optional(),
    fundingStatus: z.enum(['prepared', 'unknown', 'accepted', 'credited', 'rejected', 'cancelled']).nullable().optional(),
    /** The consent to sign while it is due (awaiting_consent, not expired): 繼續設定 opens the confirm sheet with it. */
    consent: liveCopySetupIntentSchema.nullable().optional() }).strict().nullable().optional(),
  /** When the current generation ends (30 days); 續期 is offered in its last three days. */
  expiresAt: z.string().datetime().nullable().optional(),
  renewalDue: z.boolean().optional(),
  /** The generation came from a one-click setup consent: its stop cancels
   * its orders with no further consent. */
  oneClick: z.boolean().optional(),
}).strict();
export type LiveCopyPortfolioItem = z.infer<typeof liveCopyPortfolioItemSchema>;
export const liveCopyPortfolioSchema = z.object({ network: z.enum(['testnet', 'mainnet']), automaticExecution: z.boolean(), items: z.array(liveCopyPortfolioItemSchema).max(50) }).strict();

/** Close one position of a running testnet copy (CopyDog's close-position). */
export const requestLiveManualCloseSchema = z.object({
  idempotencyKey: z.string().uuid(), coin: z.string().min(1).max(129).regex(/^(?:[^:\s/@\p{Cc}\p{Cf}]{1,40}:)?[^:\s/@\p{Cc}\p{Cf}]{1,80}$/u),
}).strict();
export const liveManualCloseSchema = z.object({
  id: z.string().uuid(), accountId: id, strategyId: version, coin: z.string(), state: z.enum(['requested', 'done', 'refused']),
  reason: z.string().nullable(), orders: z.number().int().min(0).max(10), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export const liveManualClosesSchema = z.object({ items: z.array(liveManualCloseSchema).max(50) }).strict();
