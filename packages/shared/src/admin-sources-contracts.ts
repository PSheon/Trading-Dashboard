import { z } from "zod";
export const adminSourcesSchema = z.object({
  sampledAt: z.string().datetime({ offset: true }),
  items: z.array(
    z.object({
      id: z.enum([
        "leaderboard",
        "discovery",
        "kol",
        "watched",
        "favorites",
        "imports",
      ]),
      count: z.number().int().nonnegative(),
      latestAt: z.string().datetime({ offset: true }).nullable(),
    }),
  ),
});
export type AdminSources = z.infer<typeof adminSourcesSchema>;
