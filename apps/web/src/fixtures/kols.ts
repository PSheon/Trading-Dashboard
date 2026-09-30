import {
  kolInputSchema,
  kolPatchSchema,
  kolImportRequestSchema,
  planKolImport,
  parseKolCsv,
  type Kol,
} from "@trading-dashboard/shared/contracts";
import { ApiError } from "@/lib/api";
export let fixtureKols: Kol[] = [
  {
    address: "0x" + "aa".repeat(20),
    displayName: "Manual name",
    xHandle: null,
    avatarUrl: null,
    verified: true,
    sortOrder: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    address: "0x" + "bb".repeat(20),
    displayName: "Retain watch",
    xHandle: null,
    avatarUrl: null,
    verified: false,
    sortOrder: 2,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];
export function previewKols(body: unknown) {
  const input = kolImportRequestSchema.parse(body);
  return planKolImport(
    input.csv,
    input.replace,
    fixtureKols.map(row=>({address:row.address,displayName:row.displayName,xHandle:row.xHandle,avatarUrl:row.avatarUrl,verified:row.verified,sortOrder:row.sortOrder})),
  );
}
export function importKols(body: unknown) {
  const input = kolImportRequestSchema.parse(body);
  const { rows, errors } = parseKolCsv(input.csv);
  const before = new Set(fixtureKols.map((r) => r.address));
  for (const { value } of rows) saveKol(value);
  const kept = new Set(rows.map((r) => r.value.address));
  const removed =
    input.replace && !errors.length
      ? fixtureKols.filter((r) => !kept.has(r.address)).length
      : 0;
  if (input.replace && !errors.length)
    fixtureKols = fixtureKols.filter((r) => kept.has(r.address));
  return {
    inserted: rows.filter((r) => !before.has(r.value.address)).length,
    updated: rows.filter((r) => before.has(r.value.address)).length,
    removed,
    errors,
  };
}
export function saveKol(body: unknown, address?: string) {
  const before = fixtureKols.find(
    (r) => r.address === (address ?? (body as { address: string }).address),
  );
  if (address && !before) throw new ApiError(404, "KOL not found");
  const value = address
    ? kolInputSchema.parse({
        address,
        displayName: before!.displayName,
        xHandle: before!.xHandle,
        avatarUrl: before!.avatarUrl,
        verified: before!.verified,
        sortOrder: before!.sortOrder,
        ...kolPatchSchema.parse(body),
      })
    : kolInputSchema.parse(body);
  const row = {
    ...value,
    createdAt: before?.createdAt ?? new Date(),
    updatedAt: new Date(),
  };
  fixtureKols = [...fixtureKols.filter((r) => r.address !== row.address), row];
  return row;
}
export function removeKol(address: string) {
  fixtureKols = fixtureKols.filter((r) => r.address !== address);
}
