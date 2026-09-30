import { z } from "zod";
const date = z.string().datetime({ offset: true });
const nullableDate = date.nullable();
export const adminTraderSchema = z.object({
  chain: z.literal("hyperliquid"),
  address: z.string(),
  sampledAt: date,
  identity: z.object({
    displayName: z.string().nullable(),
    xHandle: z.string().nullable(),
    kolRegistered: z.boolean(),
    leaderboardUpdatedAt: nullableDate,
  }),
  watch: z
    .object({ active: z.boolean(), source: z.string(), firstSeenAt: date })
    .nullable(),
  discovery: z
    .object({
      inPool: z.boolean(),
      poolRank: z.number().nullable(),
      portfolioAt: nullableDate,
      tradesAt: nullableDate,
      attemptedAt: nullableDate,
      refreshFailed: z.boolean(),
    })
    .nullable(),
  references: z.object({
    favorites: z.number().int().nonnegative(),
    alerts: z.number().int().nonnegative(),
  }),
  imports: z.object({
    items: z.array(
      z.object({
        id: z.number(),
        source: z.string(),
        importedAt: date,
        rank: z.number(),
      }),
    ),
    hasMore: z.boolean(),
  }),
  fills: z.object({ firstAt: nullableDate, lastAt: nullableDate }),
  analytics: z
    .object({
      source: z.string(),
      coverageFrom: nullableDate,
      historyThrough: nullableDate,
      computedAt: date,
      truncated: z.boolean(),
      fillsRead: z.number(),
      fundingFrom: nullableDate,
      fundingThrough: nullableDate,
    })
    .nullable(),
  history: z
    .object({
      status: z.enum(["pending", "caught_up", "blocked"]),
      publishedThrough: nullableDate,
      attemptedAt: nullableDate,
      failed: z.boolean(),
    })
    .nullable(),
  backfill: z
    .object({
      id: z.number(),
      status: z.enum(["pending", "running", "completed", "failed"]),
      attempts: z.number(),
      availableAt: date,
      completedAt: nullableDate,
    })
    .nullable(),
});
export type AdminTrader = z.infer<typeof adminTraderSchema>;
