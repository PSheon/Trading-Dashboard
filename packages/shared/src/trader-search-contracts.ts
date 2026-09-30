import { z } from "zod";
export const traderSearchQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .refine((value) => value.replace(/^@/, "").length >= 2),
  })
  .strict();
export const traderSearchResponseSchema = z.object({
  items: z.array(
    z.object({
      address: z.string(),
      displayName: z.string().nullable(),
      xHandle: z.string().nullable(),
      source: z.enum(["kol", "leaderboard"]),
      hasLeaderboardData: z.boolean(),
    }),
  ),
  hasMore: z.boolean(),
});
export type TraderSearchResponse = z.infer<typeof traderSearchResponseSchema>;
