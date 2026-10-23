import { z } from 'zod';
import { isoUtcSchema, lowercaseAddressSchema } from './primitives.js';

const iso = isoUtcSchema;
const addr = lowercaseAddressSchema;
/** B16: testnet execution wallets, their trading agent grant and copy stage. */
export const adminLiveAccountSchema = z.object({
  accountId: z.string(), userId: z.number().int(), userEmail: z.string().nullable(), strategyId: z.number().int(), leaderAddress: addr,
  sourceNetwork: z.enum(['testnet', 'mainnet']), accountAddress: addr.nullable(), accountState: z.string(), strategyStatus: z.string(),
  agent: z.object({ setupId: z.string(), state: z.string(), agentAddress: addr.nullable(), expiresAt: iso }).nullable(),
  grant: z.object({ id: z.string(), version: z.number().int(), scopes: z.array(z.string()), expiresAt: iso, revokedAt: iso.nullable(), revokeRequestedAt: iso.nullable() }).nullable(),
  mandate: z.object({ id: z.string(), state: z.string(), revision: z.number().int() }).nullable(),
  stop: z.object({ id: z.string(), state: z.string(), issue: z.string().nullable() }).nullable(),
  createdAt: iso,
}).strict();
export const adminLiveAccountsSchema = z.object({ items: z.array(adminLiveAccountSchema).max(200) }).strict();
/** Wallet transfers of copy accounts: deposits and returns to the main wallet.
 * `awaitingCreditSince`: a sent transfer (unknown or accepted) not yet
 * confirmed credited, since it was sent; `explorerFailingSince`: since when
 * its confirmation could not reach Hyperliquid's explorer (null otherwise). */
export const adminLiveTransferSchema = z.object({
  id: z.string().uuid(), userId: z.number().int(), accountId: z.string(), strategyId: z.number().int(), direction: z.enum(['to_account', 'to_main']),
  status: z.string(), amount: z.string(), source: addr, destination: addr, stopId: z.string().nullable(), transactionHash: z.string().nullable(),
  attemptedAt: iso.nullable(), createdAt: iso, updatedAt: iso,
  awaitingCreditSince: iso.nullable().optional(), explorerFailingSince: iso.nullable().optional(),
}).strict();
export const adminLiveTransfersSchema = z.object({ items: z.array(adminLiveTransferSchema).max(200) }).strict();
/** Why an order rejected as never placed (exchange_order_never_placed) was
 * not: its request never began (the journal's unsent marker; released at
 * once), or it expired unfound after the never-placed grace. */
export const adminLiveNeverPlacedSchema = z.enum(['request_never_began', 'expired_after_grace']);
/** Testnet orders by journal state; `unknown` is an order whose outcome the
 * exchange has not confirmed yet (reconciled each worker pass). */
export const adminLiveOrderSchema = z.object({
  key: z.string(), userId: z.number().int(), strategyId: z.number().int(), accountAddress: addr, coin: z.string().nullable(), side: z.enum(['B', 'A']),
  size: z.string(), limitPrice: z.string(), reduceOnly: z.boolean(), state: z.string(), errorCode: z.string().nullable(),
  /** Set only for an order rejected as never placed; null otherwise. */
  neverPlaced: adminLiveNeverPlacedSchema.nullable(),
  purpose: z.enum(['copy', 'stop', 'close', 'other']), leg: z.object({ leg: z.enum(['open', 'close']), state: z.string(), reason: z.string().nullable() }).nullable(),
  createdAt: iso, updatedAt: iso,
}).strict();
export const adminLiveOrdersQuerySchema = z.object({ state: z.enum(['open', 'unknown', 'all']).default('open') }).strict();
export const adminLiveOrdersSchema = z.object({ items: z.array(adminLiveOrderSchema).max(200) }).strict();
/** B18: leader fill → signal received → order sent → exchange answer.
 * The leader's fill time is the exchange's clock, every later step this
 * server's (so a skewed clock shifts every figure by the skew). n: how many
 * legs have that step; p95 needs at least 20 (below that it is the maximum). */
const percentiles = z.object({ p50: z.number().nullable(), p95: z.number().nullable(), n: z.number().int().optional() }).strict();
export const adminLiveLatencySchema = z.object({
  window: z.enum(['24h', '7d']), count: z.number().int(), signal: percentiles, sent: percentiles, ack: percentiles, settled: percentiles,
}).strict();
export const adminLiveLatencyQuerySchema = z.object({ window: z.enum(['24h', '7d']).default('24h') }).strict();
/** force: revoke now even while the copy's stop has not ended (positions may remain). */
export const adminRevokeLiveGrantSchema = z.object({ reason: z.string().trim().min(3).max(500), force: z.boolean().optional() }).strict();
/** revokedAt: revoked now (the copy holds nothing it needs the grant for).
 * Otherwise revokeRequestedAt and stopId: the copy is being stopped with the
 * grant and it is revoked when that stop ends. */
export const adminRevokedLiveGrantSchema = z.object({ id: z.string(), version: z.number().int(), revokedAt: iso.nullable(), revokeRequestedAt: iso.nullable(), stopId: z.string().nullable() }).strict();
/** An operator's resolution of a copy wallet transfer stuck unknown (or
 * accepted, never credited) after its nonce window: the evidence the operator
 * names, which the api proves from a fresh ledger read before it applies.
 * ledger_receipt: this transfer's own receipt (its hash) → credited.
 * ledger_absent_after_nonce_expiry: every transfer between the two accounts
 * is provably another one → rejected (never executed). */
export const adminResolveCopyFundingSchema = z.discriminatedUnion('evidence', [
  z.object({ evidence: z.literal('ledger_receipt'), transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/), reason: z.string().trim().min(3).max(500) }).strict(),
  z.object({ evidence: z.literal('ledger_absent_after_nonce_expiry'), reason: z.string().trim().min(3).max(500) }).strict(),
]);
export const adminResolvedCopyFundingSchema = z.object({
  id: z.string().uuid(), status: z.enum(['credited', 'rejected']), evidence: z.enum(['ledger_receipt', 'ledger_absent_after_nonce_expiry']),
}).strict();
export type AdminResolvedCopyFunding = z.infer<typeof adminResolvedCopyFundingSchema>;
export type AdminLiveAccount = z.infer<typeof adminLiveAccountSchema>;
export type AdminLiveAccounts = z.infer<typeof adminLiveAccountsSchema>;
export type AdminLiveTransfer = z.infer<typeof adminLiveTransferSchema>;
export type AdminLiveTransfers = z.infer<typeof adminLiveTransfersSchema>;
export type AdminLiveOrder = z.infer<typeof adminLiveOrderSchema>;
export type AdminLiveNeverPlaced = z.infer<typeof adminLiveNeverPlacedSchema>;
export type AdminLiveOrders = z.infer<typeof adminLiveOrdersSchema>;
export type AdminLiveLatency = z.infer<typeof adminLiveLatencySchema>;
export type AdminRevokedLiveGrant = z.infer<typeof adminRevokedLiveGrantSchema>;
