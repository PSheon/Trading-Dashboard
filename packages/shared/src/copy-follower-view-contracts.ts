import { z } from 'zod';

const money = z.string().max(80).regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/);
const unsigned = money.refine(v => !v.startsWith('-') || /^-0(?:\.0+)?$/.test(v));
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const dex = z.string().max(40).regex(/^(?:[^:\s/@\p{Cc}\p{Cf}]{1,40})?$/u), coin = z.string().min(1).max(80).regex(/^(?:[^:\s/@\p{Cc}\p{Cf}]{1,40}:)?[^:\s/@\p{Cc}\p{Cf}]{1,80}$/u);
const identity = { mode: z.literal('actual'), network: z.literal('testnet'), accountId: z.string().min(1).max(128), strategyId: z.number().int().positive(), accountAddress: z.string().regex(/^0x[0-9a-f]{40}$/) };
export const copyFollowerSnapshotIssueSchema = z.enum(['not_observed', 'source_unavailable', 'unsupported_mode', 'unsupported_network', 'incomplete_coverage', 'invalid_evidence']);
const position = z.object({ coin, dex, asset: integer, sizeDecimals: integer.max(6), size: money, entryPrice: unsigned, positionValue: unsigned,
  unrealizedPnl: money, marginUsed: unsigned, leverage: integer.positive(), leverageType: z.enum(['cross', 'isolated']), maxLeverage: integer.positive(), fundingSinceOpen: money, fundingSinceChange: money }).strict();
const order = z.object({ coin, dex, asset: integer, oid: z.string().regex(/^(?:0|[1-9]\d{0,19})$/), side: z.enum(['B', 'A']),
  limitPrice: unsigned, remainingSize: unsigned, originalSize: unsigned, notionalUsd: unsigned, reduceOnly: z.boolean(), timestamp: integer, cloid: z.string().regex(/^0x[0-9a-f]{32}$/).nullable() }).strict();
const venue = z.object({ dex, perpDexIndex: integer.max(999), supported: z.boolean(), collateralToken: integer, collateralCoin: z.string().min(1).max(80), providerTime: integer,
  equity: unsigned, rawUsd: money, marginUsed: unsigned, withdrawable: unsigned, exposureUsd: unsigned, crossEquity: unsigned, crossMarginUsed: unsigned,
  crossExposureUsd: unsigned, crossMaintenanceMarginUsed: unsigned }).strict();
export const copyFollowerSnapshotSchema = z.object({ ...identity, status: z.literal('observed'), freshness: z.enum(['fresh', 'stale']),
  lastReadIssue: copyFollowerSnapshotIssueSchema.nullable(),
  asOf: z.object({ observedAt: integer, completedAt: integer, earliestProviderTime: integer, checkedAt: integer, freshUntil: integer }).strict(), sourceDigest: z.string().regex(/^[0-9a-f]{64}$/),
  role: z.literal('user'), accountMode: z.literal('standard'), accountAbstraction: z.literal('disabled'), collateral: z.object({ tokenIndex: integer, coin: z.literal('USDC') }).strict(),
  metrics: z.object({ perpEquity: unsigned, marginUsed: unsigned, withdrawable: unsigned, exposureUsd: unsigned, restingExposureUsd: unsigned, grossRestingExposureUsd: unsigned,
    unrealizedPnl: money, roi: z.null(), periodPnl: z.null(), netDeposits: z.null() }).strict(), positions: z.array(position).max(10000), restingOrders: z.array(order).max(5000), dexes: z.array(venue).min(1).max(1000),
  coverage: z.object({ complete: z.literal(true), balanceComplete: z.literal(true), orderComplete: z.literal(true), listedDexes: z.array(dex).min(1).max(1000),
    observedOrderDexes: z.array(dex).min(1).max(1000), unobservedOrderDexes: z.array(dex).max(0) }).strict(),
  quarantine: z.object({ blocked: z.boolean(), reason: z.string().min(1).max(200).nullable() }).strict().refine(v => v.blocked ? v.reason !== null : v.reason === null),
}).strict().refine(v => v.lastReadIssue === null || v.freshness === 'stale', 'Failed acquisitions cannot assert fresh observations');
export const copyFollowerSnapshotReadSchema = z.union([copyFollowerSnapshotSchema, z.object({ ...identity, status: z.literal('unavailable'), observation: z.null(),
  reason: copyFollowerSnapshotIssueSchema }).strict()]);
export type CopyFollowerSnapshot = z.infer<typeof copyFollowerSnapshotSchema>;
export type CopyFollowerSnapshotRead = z.infer<typeof copyFollowerSnapshotReadSchema>;
