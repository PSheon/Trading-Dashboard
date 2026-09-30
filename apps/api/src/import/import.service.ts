import type { AuditActor } from "../common/audit/admin-audit.js";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import {
  addressSchema,
  importLeaderListRequestSchema,
  type ImportLeaderListRequest,
  type ImportLeaderListResponse,
} from "@trading-dashboard/shared/contracts";

import { UnitOfWork } from "../db/unit-of-work.js";
import { ImportRepository, type ImportRow } from "./import.repository.js";
import { BackfillService } from "../watcher/backfill.service.js";

/** No sample CopyDog export file exists yet (PRD §10 open question). These
 * are the plausible column-name variants for a rank-list export; matching
 * is case-insensitive. If an export uses another supported alias, add it
 * here rather than assuming the exact column name up front. */
const ADDRESS_KEYS = ["address", "wallet", "wallet_address", "walletaddress", "account", "user"];
const RANK_KEYS = ["rank", "position", "no", "#"];

function findField(row: Record<string, unknown>, candidates: string[]): { key: string; value: unknown } | undefined {
  const byLower = new Map(Object.keys(row).map((k) => [k.toLowerCase(), k]));
  for (const candidate of candidates) {
    const actualKey = byLower.get(candidate.toLowerCase());
    if (actualKey === undefined) continue;
    const value = row[actualKey];
    if (value !== undefined && value !== null && value !== "") {
      return { key: actualKey, value };
    }
  }
  return undefined;
}

interface RowError {
  index: number;
  reason: string;
}

function parseRows(rows: Record<string, unknown>[]): { parsed: ImportRow[]; errors: RowError[] } {
  const parsed: ImportRow[] = [];
  const errors: RowError[] = [];

  rows.forEach((row, index) => {
    const addressField = findField(row, ADDRESS_KEYS);
    const rankField = findField(row, RANK_KEYS);

    if (!addressField) {
      errors.push({ index, reason: "missing address column" });
      return;
    }
    if (!rankField) {
      errors.push({ index, reason: "missing rank column" });
      return;
    }

    const address = typeof addressField.value === "string" ? addressField.value.trim().toLowerCase() : "";
    const rank = rankField.value;
    const rankNum = typeof rank === "number" ? rank
      : typeof rank === "string" && /^[1-9]\d*$/.test(rank.trim()) ? Number(rank.trim()) : NaN;
    if (!addressSchema.safeParse(address).success) {
      errors.push({ index, reason: "invalid Ethereum address" });
      return;
    }
    if (!Number.isInteger(rankNum) || rankNum < 1 || rankNum > 2147483647) {
      errors.push({ index, reason: "rank must be a positive 32-bit integer" });
      return;
    }

    const statsJson: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === addressField.key || k === rankField.key) continue;
      statsJson[k] = v;
    }

    parsed.push({ address, rank: rankNum, statsJson });
  });

  return { parsed, errors };
}

/** A1/A2/A5: import a CopyDog list version, dedupe against `leaders`, and
 * fire-and-track history backfill for every genuinely new address. */
@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    private readonly repository: ImportRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly backfill: BackfillService,
  ) {}

  async importLeaderList(request: ImportLeaderListRequest, actor: AuditActor = null): Promise<ImportLeaderListResponse> {
    const validated = importLeaderListRequestSchema.safeParse(request);
    if (!validated.success) throw new BadRequestException({ message: "Invalid import", issues: validated.error.issues });
    request = validated.data;
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > 100 * 1024) {
      throw new BadRequestException("Import exceeds 100 KiB");
    }
    const { parsed, errors } = parseRows(request.rows);

    if (errors.length > 0) {
      // A version is atomic: reject invalid rows before persisting any of it.
      throw new BadRequestException({
        message: `${errors.length} invalid row(s)`,
        errors,
      });
    }

    // Dedupe by address within this one import (keep the first/lowest-rank
    // occurrence) — leader_list_items' PK is (list_id, address) and a
    // CopyDog export listing the same address twice would otherwise crash
    // the bulk insert.
    const byAddress = new Map<string, ImportRow>();
    for (const row of parsed) {
      const existing = byAddress.get(row.address);
      if (!existing || row.rank < existing.rank) {
        byAddress.set(row.address, row);
      }
    }
    const dedupedRows = [...byAddress.values()];

    const newAddresses = await this.unitOfWork.run(async (tx) => {
      return this.repository.save(tx, request, dedupedRows.map((row) => ({
        ...row, tier: row.rank <= 20 ? "A" as const : "B" as const,
      })), actor);
    });

    // A5: fire-and-track backfill for every genuinely new address. Not
    // awaited — must not hold up this HTTP response (task requirement).
    for (const address of newAddresses.newAddresses) {
      this.logger.log(`New leader ${address} — starting A5 backfill`);
      this.backfill.trigger(address);
    }

    return newAddresses;
  }
}
