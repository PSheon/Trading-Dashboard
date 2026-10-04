import { z } from "zod";

export const copyPerformanceWindowSchema = z.enum(["1d", "7d", "30d", "all"]);
export type CopyPerformanceWindow = z.infer<typeof copyPerformanceWindowSchema>;
export const copyPerformanceQuerySchema = z.object({ window: copyPerformanceWindowSchema.default("7d") }).strict();
export const copyPerformancePointSchema = z.object({
  time: z.coerce.date(), equity: z.number().nullable(), totalPnl: z.number().nullable(),
  netDeposits: z.number(), exposureUsd: z.number().nullable(),
});
export const copyPerformanceResponseSchema = z.object({
  strategyId: z.number().int(), mode: z.literal("paper"), window: copyPerformanceWindowSchema,
  from: z.coerce.date(), to: z.coerce.date(), points: z.array(copyPerformancePointSchema), todayPnl: z.number().nullable(),
  coverage: z.object({ firstSnapshotAt: z.coerce.date().nullable(), lastSnapshotAt: z.coerce.date().nullable(), complete: z.boolean() }),
});
export type CopyPerformanceResponse = z.infer<typeof copyPerformanceResponseSchema>;
export const copyEventSchema = z.object({
  id: z.string().regex(/^\d+$/), strategyId: z.number().int().nullable(), type: z.string(),
  payload: z.record(z.unknown()), createdAt: z.coerce.date(),
});
export const copyEventsResponseSchema = z.object({
  items: z.array(copyEventSchema), nextCursor: z.string().regex(/^\d+$/),
  previousCursor: z.string().regex(/^\d+$/).nullable().optional(), hasMore: z.boolean().optional(),
});
export type CopyEventsResponse = z.infer<typeof copyEventsResponseSchema>;
export const copyEventsQuerySchema = z.object({
  after: z.string().regex(/^(0|[1-9]\d{0,18})$/).refine((v) => BigInt(v) <= 9223372036854775807n).default("0"),
  before: z.string().regex(/^[1-9]\d{0,18}$/).refine((v) => BigInt(v) <= 9223372036854775807n).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
}).strict().refine((q) => !q.before || q.after === "0", { message: "Use before or after, not both" });

/**
 * GET /me/copy/portfolio — the whole paper portfolio (every copy, stopped
 * ones included) as CopyDog's `hl-portfolio/chart` draws it: cumulative PnL
 * at evenly spaced times over the window. A point is null while any copy that
 * existed then has no fresh valuation (never a guess); `partial` says so.
 * `todayPnl` is the change since 00:00 UTC across every copy (a copy started
 * today counts from 0). `sparklines` is each copy's PnL since it started
 * (CopyDog's equity-curve column), at most 48 points.
 */
export const copyPortfolioQuerySchema = z.object({ window: copyPerformanceWindowSchema.default("all") }).strict();
export const copyPortfolioResponseSchema = z.object({
  mode: z.literal("paper"), window: copyPerformanceWindowSchema, from: z.coerce.date(), to: z.coerce.date(),
  points: z.array(z.object({ time: z.coerce.date(), pnl: z.number().nullable() })),
  partial: z.boolean(), todayPnl: z.number().nullable(),
  sparklines: z.array(z.object({ strategyId: z.number().int(), points: z.array(z.number().nullable()) })),
});
export type CopyPortfolioResponse = z.infer<typeof copyPortfolioResponseSchema>;

/**
 * GET /me/copy/trades — closed copy trades, rebuilt from the copies' own
 * fills: a trade opens when a copy's position in a coin leaves 0 and closes
 * when it is back at 0. `pnl` is after the trade's trading and builder fees
 * (funding is per position and not split per trade); `roiPct` is that over
 * the entry notional (CopyDog's realized ÷ entry value). `id` is the opening
 * fill, stable for sharing.
 */
export const copyTradesQuerySchema = z.object({
  sort: z.enum(["best", "worst", "recent"]).default("recent"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  strategyId: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
  /** One trade by its id (its opening fill), for a share card. */
  id: z.string().regex(/^[1-9]\d{0,18}$/).optional(),
}).strict();
export const copyClosedTradeSchema = z.object({
  id: z.string().regex(/^\d+$/), strategyId: z.number().int(), leaderAddress: z.string(), coin: z.string(),
  side: z.enum(["long", "short"]), size: z.number(), entryPx: z.number(), exitPx: z.number(), entryNotional: z.number(),
  pnl: z.number(), fees: z.number(), roiPct: z.number().nullable(), openedAt: z.coerce.date(), closedAt: z.coerce.date(),
});
export type CopyClosedTrade = z.infer<typeof copyClosedTradeSchema>;
export const copyTradesResponseSchema = z.object({ mode: z.literal("paper"), items: z.array(copyClosedTradeSchema) });
export type CopyTradesResponse = z.infer<typeof copyTradesResponseSchema>;
