import type { AuditActor } from "../common/audit/admin-audit.js";
import { BadRequestException, Injectable } from "@nestjs/common";
import {
  importLeaderListRequestSchema,
  prepareImportRows,
  type ImportLeaderListRequest,
  type ImportLeaderListResponse,
  type ImportPreview,
} from "@trading-dashboard/shared/contracts";
import { UnitOfWork } from "../db/unit-of-work.js";
import { ImportRepository } from "./import.repository.js";
function prepare(request: ImportLeaderListRequest) {
  const validated = importLeaderListRequestSchema.safeParse(request);
  if (!validated.success)
    throw new BadRequestException({
      message: "Invalid import",
      issues: validated.error.issues,
    });
  if (Buffer.byteLength(JSON.stringify(validated.data), "utf8") > 100 * 1024)
    throw new BadRequestException("Import exceeds 100 KiB");
  return { request: validated.data, ...prepareImportRows(validated.data.rows) };
}
@Injectable()
export class ImportService {
  constructor(
    private readonly repository: ImportRepository,
    private readonly unitOfWork: UnitOfWork,
  ) {}
  /** Advisory snapshot; all validation and admission still occur on actual import. */
  async previewLeaderList(
    request: ImportLeaderListRequest,
  ): Promise<ImportPreview> {
    const prepared = prepare(request);
    return this.unitOfWork.run(async (tx) => {
      const { existing, jobs } = await this.repository.inspect(
        tx,
        prepared.rows.map((r) => r.address),
      );
      const byAddress = new Map(existing.map((r) => [r.address, r]));
      const queued = new Set(jobs.map((r) => r.address));
      const items = prepared.rows.map((row) => {
        const found = byAddress.get(row.address);
        return {
          address: row.address,
          rank: row.rank,
          action: !found
            ? ("new" as const)
            : found.source === "favorite"
              ? ("promote" as const)
              : ("preserve" as const),
          activeAfter:
            !found || found.source === "favorite" ? true : found.active,
          tierAfter:
            found?.tier ?? (row.rank <= 20 ? ("A" as const) : ("B" as const)),
        };
      });
      return {
        sampledAt: new Date().toISOString(),
        canImport: prepared.errors.length === 0,
        totalRows: prepared.request.rows.length,
        uniqueAddresses: items.length,
        duplicateRows: prepared.duplicateRows,
        newAddresses: items.filter((r) => r.action === "new").length,
        promotedAddresses: items.filter((r) => r.action === "promote").length,
        preservedAddresses: items.filter((r) => r.action === "preserve").length,
        estimatedNewJobs: prepared.errors.length
          ? 0
          : items.filter((r) => r.action === "new" && !queued.has(r.address))
              .length,
        errors: prepared.errors,
        items,
      };
    });
  }
  async importLeaderList(
    request: ImportLeaderListRequest,
    actor: AuditActor = null,
  ): Promise<ImportLeaderListResponse> {
    const prepared = prepare(request);
    if (prepared.errors.length)
      throw new BadRequestException({
        message: `${prepared.errors.length} invalid row(s)`,
        errors: prepared.errors,
      });
    return this.unitOfWork.run((tx) =>
      this.repository.save(
        tx,
        prepared.request,
        prepared.rows.map((row) => ({
          ...row,
          tier: row.rank <= 20 ? ("A" as const) : ("B" as const),
        })),
        actor,
      ),
    );
  }
}
