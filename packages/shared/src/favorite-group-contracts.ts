import { z } from "zod";
export const favoriteGroupInputSchema = z
  .object({ name: z.string().trim().min(1).max(40) })
  .strict();
export const favoriteGroupSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  addresses: z.array(z.string()),
});
export const favoriteGroupsSchema = z.array(favoriteGroupSchema);
export type FavoriteGroup = z.infer<typeof favoriteGroupSchema>;
