import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import {
  CHAIN_DEFAULT,
  addressSchema,
  importLeaderListRequestSchema,
  leaderListItems,
  leaderLists,
  leaders,
  type ImportLeaderListRequest,
  type ImportLeaderListResponse,
} from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { BackfillService } from "../watcher/backfill.service.js";

/** No sample CopyDog export file exists yet (PRD §10 open question). These
 * are the plausible column-name variants for a rank-list export; matching
 * is case-insensitive. If Paul's real export uses something else, add it
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

interface ParsedRow {
  address: string;
  rank: number;
  statsJson: Record<string, unknown>;
}

interface RowError {
  index: number;
  reason: string;
}

function parseRows(rows: Record<string, unknown>[]): { parsed: ParsedRow[]; errors: RowError[] } {
  const parsed: ParsedRow[] = [];
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
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly backfill: BackfillService,
  ) {}

  async importLeaderList(request: ImportLeaderListRequest): Promise<ImportLeaderListResponse> {
    const validated = importLeaderListRequestSchema.safeParse(request);
    if (!validated.success) throw new BadRequestException({ message: "Invalid import", issues: validated.error.issues });
    request = validated.data;
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > 100 * 1024) {
      throw new BadRequestException("Import exceeds 100 KiB");
    }
    const { parsed, errors } = parseRows(request.rows);

    if (errors.length > 0) {
      // Reject the whole import rather than silently dropping bad rows
      // (task requirement) — a partially-imported "version" would be a
      // worse outcome than making Paul fix the export and re-upload.
      throw new BadRequestException({
        message: `${errors.length} invalid row(s)`,
        errors,
      });
    }

    // Dedupe by address within this one import (keep the first/lowest-rank
    // occurrence) — leader_list_items' PK is (list_id, address) and a
    // CopyDog export listing the same address twice would otherwise crash
    // the bulk insert.
    const byAddress = new Map<string, ParsedRow>();
    for (const row of parsed) {
      const existing = byAddress.get(row.address);
      if (!existing || row.rank < existing.rank) {
        byAddress.set(row.address, row);
      }
    }
    const dedupedRows = [...byAddress.values()];

    const newAddresses = await this.db.transaction(async (tx) => {
      const [list] = await tx
        .insert(leaderLists)
        .values({ source: request.source, fileName: request.fileName })
        .returning({ id: leaderLists.id });

      await tx.insert(leaderListItems).values(
        dedupedRows.map((row) => ({
          listId: list.id,
          address: row.address,
          rank: row.rank,
          statsJson: row.statsJson,
        })),
      );

      // A2: upsert into `leaders`. onConflictDoNothing means an existing
      // row's active/tier/label/notes are never touched by an import — A3
      // manual edits must survive re-imports (task requirement). §11: a
      // NEWLY-created leader with rank <= 20 in *this* import gets tier A.
      const inserted = await tx
        .insert(leaders)
        .values(
          dedupedRows.map((row) => ({
            chain: CHAIN_DEFAULT,
            address: row.address,
            active: true,
            tier: row.rank <= 20 ? ("A" as const) : ("B" as const),
          })),
        )
        .onConflictDoNothing({ target: [leaders.chain, leaders.address] })
        .returning({ address: leaders.address });

      // An address someone favorited before it was imported is now an
      // imported leader: admins get its alerts, and it stays watched when
      // the last favorite goes. Its favorite-managed `active` flag is reset
      // to true; imported rows (manual A3 edits) are still left alone.
      await tx
        .update(leaders)
        .set({ source: "import", active: true })
        .where(
          and(
            eq(leaders.chain, CHAIN_DEFAULT),
            eq(leaders.source, "favorite"),
            inArray(
              leaders.address,
              dedupedRows.map((row) => row.address),
            ),
          ),
        );

      return { listId: list.id, itemCount: dedupedRows.length, newAddresses: inserted.map((r) => r.address) };
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
