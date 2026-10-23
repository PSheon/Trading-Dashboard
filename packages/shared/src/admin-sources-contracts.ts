import { z } from "zod";
import { isoDatetimeOffsetSchema } from "./primitives.js";
export const adminSourcesSchema = z.object({
  sampledAt: isoDatetimeOffsetSchema,
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
      latestAt: isoDatetimeOffsetSchema.nullable(),
    }),
  ),
});
export type AdminSources = z.infer<typeof adminSourcesSchema>;
