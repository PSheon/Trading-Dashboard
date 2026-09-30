import { z } from "zod";
const date = z.string().datetime({ offset: true });
export const backfillJobStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
]);
export const backfillJobSchema = z.object({
  id: z.number().int().positive(),
  chain: z.literal("hyperliquid"),
  address: z.string(),
  source: z.enum(["import", "favorite"]),
  status: backfillJobStatusSchema,
  attempts: z.number().int().nonnegative(),
  runAttempts: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
  availableAt: date,
  createdAt: date,
  startedAt: date.nullable(),
  completedAt: date.nullable(),
  leaseExpiresAt: date.nullable(),
  fillsFetched: z.number().int().nonnegative().nullable(),
  lastErrorCode: z.enum(["backfill_failed", "lease_expired"]).nullable(),
});
export const backfillJobsQuerySchema = z.object({
  status: backfillJobStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  beforeId: z.coerce.number().int().positive().optional(),
});
export const backfillJobsResponseSchema = z.object({
  items: z.array(backfillJobSchema),
  nextCursor: z.number().int().positive().nullable(),
});
export const retryBackfillJobSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
});
export type BackfillJob = z.infer<typeof backfillJobSchema>;
export type BackfillJobsResponse = z.infer<typeof backfillJobsResponseSchema>;
export type BackfillJobsQuery = z.infer<typeof backfillJobsQuerySchema>;
