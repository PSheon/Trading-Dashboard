import {
  importLeaderListRequestSchema,
  prepareImportRows,
  type ImportPreview,
} from "@/lib/contracts";
import { ApiError } from "@/lib/api";
const imported = new Map<string, "A" | "B">();
export function fixtureImportPreview(body: unknown): ImportPreview {
  const req = importLeaderListRequestSchema.parse(body);
  if (new TextEncoder().encode(JSON.stringify(req)).length > 100 * 1024)
    throw new ApiError(400, "Import exceeds 100 KiB");
  const parsed = prepareImportRows(req.rows);
  const items = parsed.rows.map((row) => ({
    address: row.address,
    rank: row.rank,
    action: imported.has(row.address)
      ? ("preserve" as const)
      : ("new" as const),
    activeAfter: true,
    tierAfter:
      imported.get(row.address) ??
      (row.rank <= 20 ? ("A" as const) : ("B" as const)),
  }));
  const fresh = items.filter((r) => r.action === "new").length;
  return {
    sampledAt: new Date().toISOString(),
    canImport: !parsed.errors.length,
    totalRows: req.rows.length,
    uniqueAddresses: items.length,
    duplicateRows: parsed.duplicateRows,
    newAddresses: fresh,
    promotedAddresses: 0,
    preservedAddresses: items.length - fresh,
    estimatedNewJobs: parsed.errors.length ? 0 : fresh,
    errors: parsed.errors,
    items,
  };
}
export function fixtureCommitImport(body: unknown) {
  const preview = fixtureImportPreview(body);
  if (!preview.canImport) throw new ApiError(400, "Invalid rows");
  for (const item of preview.items)
    imported.set(item.address, item.tierAfter === "A" ? "A" : "B");
  return {
    itemCount: preview.uniqueAddresses,
    newAddresses: preview.items
      .filter((i) => i.action === "new")
      .map((i) => i.address),
  };
}
