import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { kolImportRequestSchema, planKolImport, kolInputSchema, kolPatchSchema, type Kol, type KolImportResponse } from "@trading-dashboard/shared/contracts";

import { recordAdminAudit, type AuditActor } from "../common/audit/admin-audit.js";
import { parseOr400 } from "../common/http/validation.js";
import { UnitOfWork } from "../db/unit-of-work.js";
import { parseKolCsv } from "./kol-csv.js";
import { KolRepository, type KolRow } from "./kol.repository.js";

const toKol = (row: KolRow): Kol => ({
  address: row.address,
  displayName: row.displayName,
  avatarUrl: row.avatarUrl,
  xHandle: row.xHandle,
  verified: row.verified,
  sortOrder: row.sortOrder,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * The KOL registry (admin): list, add or edit (upsert by address), remove,
 * and CSV import. Every mutation and its audit event commit in one
 * transaction. The discovery pool picks up changes on its next build (≤ 1
 * min); boards show a KOL's name and avatar at once, figures once computed.
 */
@Injectable()
export class KolService {
  constructor(
    private readonly repository: KolRepository,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async list(): Promise<Kol[]> {
    return (await this.repository.list()).map(toKol);
  }

  async previewImport(csv:string,replace:boolean){
    const input=parseOr400(kolImportRequestSchema,{csv,replace});
    const existing=await this.repository.previewSnapshot();
    if(existing.length>5000)throw new BadRequestException("Preview supports up to 5000 registered KOLs");
    try{return planKolImport(input.csv,input.replace,existing);}
    catch(error){throw new BadRequestException((error as Error).message);}
  }

  /** Adds or replaces the entry for `body.address` (lowercased); omitted
   * fields take their defaults. @throws BadRequestException when invalid. */
  async upsert(body: unknown, actor: AuditActor): Promise<Kol> {
    const input = parseOr400(kolInputSchema, body);
    const values = { ...input, address: input.address.toLowerCase() };
    return this.unitOfWork.run(async (tx) => {
      const [before] = await this.repository.lockExisting(tx, [values.address]);
      const row = await this.repository.upsert(tx, values);
      await recordAdminAudit(tx, actor, "kol.upsert", values.address, before ? toKol(before) : null, toKol(row));
      return toKol(row);
    });
  }

  /** Changes the given fields. @throws NotFoundException for an unknown address. */
  async patch(address: string, body: unknown, actor: AuditActor): Promise<Kol> {
    const patch = parseOr400(kolPatchSchema, body);
    return this.unitOfWork.run(async (tx) => {
      const [before] = await this.repository.lockExisting(tx, [address]);
      if (!before) throw new NotFoundException("KOL not found");
      const next = {
        address,
        displayName: patch.displayName === undefined ? before.displayName : patch.displayName,
        avatarUrl: patch.avatarUrl === undefined ? before.avatarUrl : patch.avatarUrl,
        xHandle: patch.xHandle === undefined ? before.xHandle : patch.xHandle,
        verified: patch.verified ?? before.verified,
        sortOrder: patch.sortOrder ?? before.sortOrder,
      };
      const row = await this.repository.upsert(tx, next);
      await recordAdminAudit(tx, actor, "kol.upsert", address, toKol(before), toKol(row));
      return toKol(row);
    });
  }

  /** @throws NotFoundException for an unknown address. */
  async remove(address: string, actor: AuditActor): Promise<void> {
    await this.unitOfWork.run(async (tx) => {
      const row = await this.repository.remove(tx, address);
      if (!row) throw new NotFoundException("KOL not found");
      await recordAdminAudit(tx, actor, "kol.delete", address, toKol(row), null);
    });
  }

  /**
   * Imports a CSV (see `parseKolCsv`): valid rows are upserted, invalid ones
   * reported and skipped; with `replace`, KOLs the file doesn't list are
   * removed (only when the file has no invalid rows, so a typo can't wipe
   * the registry). All in one transaction. The seed command
   * (`seed-kols.ts`) uses this same path.
   * @throws BadRequestException when the header is unusable.
   */
  async importCsv(csv: string, replace: boolean, actor: AuditActor): Promise<KolImportResponse> {
    let parsed: ReturnType<typeof parseKolCsv>;
    try {
      parsed = parseKolCsv(csv);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    const { rows, errors } = parsed;
    return this.unitOfWork.run(async (tx) => {
      const existing = new Set((await this.repository.lockExisting(tx, rows.map((r) => r.value.address))).map((r) => r.address));
      for (const { value } of rows) await this.repository.upsert(tx, value);
      const removed = replace && errors.length === 0 ? await this.repository.removeOthers(tx, rows.map((r) => r.value.address)) : 0;
      const result = { inserted: rows.filter((r) => !existing.has(r.value.address)).length, updated: rows.filter((r) => existing.has(r.value.address)).length, removed, errors };
      await recordAdminAudit(tx, actor, "kol.import", "kol_traders", null, { ...result, errors: errors.length, replace });
      return result;
    });
  }
}
