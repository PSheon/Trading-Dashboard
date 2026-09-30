import { z } from "zod";

/** Groups per user. */
export const FAVORITE_GROUPS_MAX = 20;
/** Longest group name (trimmed). */
export const FAVORITE_GROUP_NAME_MAX = 40;
/** CopyDog-like chip colours, assigned in turn when none is given. */
export const FAVORITE_GROUP_COLORS = ["#ff7a45", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ec4899", "#14b8a6", "#f97316"] as const;

const groupName = z.string().trim().min(1).max(FAVORITE_GROUP_NAME_MAX);
const groupColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** POST /me/favorite-groups. 409 `group_name_exists` (case-insensitive)
 * or `group_limit` past `FAVORITE_GROUPS_MAX`. */
export const favoriteGroupInputSchema = z
  .object({ name: groupName, color: groupColor.optional() })
  .strict();
export type FavoriteGroupInput = z.infer<typeof favoriteGroupInputSchema>;
/** PATCH /me/favorite-groups/:id: rename, recolour and/or reorder. */
export const favoriteGroupPatchSchema = z
  .object({
    name: groupName.optional(),
    color: groupColor.optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "Nothing to update" });
export type FavoriteGroupPatch = z.infer<typeof favoriteGroupPatchSchema>;
export const favoriteGroupSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  /** Member addresses (each one of the user's favorites). */
  addresses: z.array(z.string()),
  /** Chip colour, "#rrggbb". */
  color: z.string(),
  /** Ascending; ties by id. */
  sortOrder: z.number().int(),
});
export const favoriteGroupsSchema = z.array(favoriteGroupSchema);
export type FavoriteGroup = z.infer<typeof favoriteGroupSchema>;

/** The stored colour, else the palette colour for the id. */
export function favoriteGroupColor(group: { id: number; color: string | null }): string {
  return group.color ?? FAVORITE_GROUP_COLORS[(group.id - 1) % FAVORITE_GROUP_COLORS.length]!;
}
