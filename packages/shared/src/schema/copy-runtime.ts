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
