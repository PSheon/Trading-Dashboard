import { z } from "zod";
import { kolInputSchema, type KolInput } from "./schema/zod.js";
import { parseKolCsv } from "./kol-csv.js";
export const kolPreviewSchema = z.object({
  sampledAt: z.string().datetime({ offset: true }),
  replace: z.boolean(),
  canImport: z.boolean(),
  inserted: z.number().int(),
  changed: z.number().int(),
  unchanged: z.number().int(),
  removed: z.number().int(),
  duplicateRows: z.number().int(),
  errorCount: z.number().int(),
  deletionsSuppressed: z.boolean(),
  hasMore: z.boolean(),
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
  items: z.array(
    z.object({
      address: z.string(),
      kind: z.enum(["new", "update", "unchanged", "remove"]),
      before: kolInputSchema.nullable(),
      after: kolInputSchema.nullable(),
    }),
  ),
});
export type KolPreview = z.infer<typeof kolPreviewSchema>;
export function planKolImport(
  csv: string,
  replace: boolean,
  existing: KolInput[],
): KolPreview {
  const parsed = parseKolCsv(csv);
  const byAddress = new Map(existing.map((r) => [r.address, r]));
  const fields = [
    "displayName",
    "avatarUrl",
    "xHandle",
    "verified",
    "sortOrder",
  ] as const;
  const items: KolPreview["items"] = parsed.rows.map(({ value }) => {
    const before = byAddress.get(value.address) ?? null;
    return {
      address: value.address,
      kind: !before
        ? "new"
        : fields.some((k) => before[k] !== value[k])
          ? "update"
          : "unchanged",
      before,
      after: value,
    };
  });
  const kept = new Set(parsed.rows.map((r) => r.value.address));
  if (replace && !parsed.errors.length)
    for (const row of existing)
      if (!kept.has(row.address))
        items.push({
          address: row.address,
          kind: "remove",
          before: row,
          after: null,
        });
  const count = (kind: KolPreview["items"][number]["kind"]) =>
    items.filter((i) => i.kind === kind).length;
  return {
    sampledAt: new Date().toISOString(),
    replace,
    canImport: items.length > 0,
    inserted: count("new"),
    changed: count("update"),
    unchanged: count("unchanged"),
    removed: count("remove"),
    duplicateRows: parsed.duplicateRows,
    errorCount: parsed.errors.length,
    deletionsSuppressed: replace && parsed.errors.length > 0,
    hasMore: items.length > 100 || parsed.errors.length > 100,
    items: items.slice(0, 100),
    errors: parsed.errors.slice(0, 100),
  };
}
