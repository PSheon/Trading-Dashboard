import { z } from 'zod';
import { copyFollowerStatementSchema } from './copy-follower-contracts.js';

const decimal = z.string().max(80).regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/);
const id = z.string().regex(/^(?:0|[1-9]\d{0,19})$/).refine(v => BigInt(v) <= 18446744073709551615n);
const coin = z.string().min(1).max(80).regex(/^(?:[^:\s/@\p{Cc}\p{Cf}]{1,40}:)?[^:\s/@\p{Cc}\p{Cf}]{1,80}$/u);
function units(v: string): bigint { const neg = v.startsWith('-'), [whole, fraction = ''] = (neg ? v.slice(1) : v).split('.'); return BigInt(whole + fraction.padEnd(18, '0')) * (neg ? -1n : 1n); }
const common = { key: z.string().min(1).max(350), coin, time: z.string().datetime(), tradingCashDelta: decimal };
const fill = z.object({ ...common, kind: z.literal('fill'), attribution: z.enum(['execution', 'account']), executionKey: z.string().min(1).max(350).nullable(),
  oid: id, tid: id, side: z.enum(['B', 'A']), size: decimal.refine(v => units(v) > 0), price: decimal.refine(v => units(v) > 0),
  realizedPnl: decimal, exchangeFee: decimal, builderFee: decimal.refine(v => units(v) <= 0) }).strict();
const funding = z.object({ ...common, kind: z.literal('funding'), attribution: z.literal('account'), executionKey: z.null(),
  hash: z.string().regex(/^0x[0-9a-f]{64}$/), funding: decimal }).strict();
export const copyFollowerActivityItemSchema = z.discriminatedUnion('kind', [fill, funding]).superRefine((item, ctx) => {
  const sum = item.kind === 'fill' ? units(item.realizedPnl) + units(item.exchangeFee) + units(item.builderFee) : units(item.funding);
  if (sum !== units(item.tradingCashDelta)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent booked cash delta' });
  if (item.kind === 'fill' && (item.attribution === 'execution') !== (item.executionKey !== null)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid execution attribution' });
});
export const copyFollowerActivityQuerySchema = z.object({ before: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
export const copyFollowerActivitySchema = z.object({ mode: z.literal('actual'), accountId: z.string().min(1).max(128), strategyId: z.number().int().positive(),
  network: z.enum(['testnet', 'mainnet']), accountAddress: z.string().regex(/^0x[0-9a-f]{40}$/), token: z.literal('USDC'),
  items: z.array(copyFollowerActivityItemSchema).max(50), previousCursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).nullable(), hasMore: z.boolean(),
  quarantine: copyFollowerStatementSchema.shape.quarantine.strict().refine(v => v.blocked ? Boolean(v.reason) : v.reason === null),
  coverage: copyFollowerStatementSchema.shape.coverage.strict(),
}).strict().superRefine((page, ctx) => {
  const keys = new Set<string>();
  for (const item of page.items) {
    const key = item.kind === 'fill' ? `${page.network}:${page.accountAddress}:${item.tid}` : `${page.network}:${page.accountAddress}:${item.hash}:${item.coin}:${Date.parse(item.time)}`;
    if (item.key !== key || keys.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid receipt identity' });
    keys.add(key);
  }
  if (page.hasMore && (!page.items.length || !page.previousCursor) || !page.items.length && page.previousCursor !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid history cursor' });
});
export type CopyFollowerActivityQuery = z.infer<typeof copyFollowerActivityQuerySchema>;
export type CopyFollowerActivity = z.infer<typeof copyFollowerActivitySchema>;
export type CopyFollowerActivityItem = z.infer<typeof copyFollowerActivityItemSchema>;
