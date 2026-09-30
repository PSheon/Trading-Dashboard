import { addressSchema } from "./schema/zod.js";
export interface ImportRow {
  address: string;
  rank: number;
  statsJson: Record<string, unknown>;
}
/** No sample CopyDog export file exists yet (PRD §10 open question). These
 * are the plausible column-name variants for a rank-list export; matching
 * is case-insensitive. If an export uses another supported alias, add it
 * here rather than assuming the exact column name up front. */
const ADDRESS_KEYS = [
  "address",
  "wallet",
  "wallet_address",
  "walletaddress",
  "account",
  "user",
];
const RANK_KEYS = ["rank", "position", "no", "#"];

function findField(
  row: Record<string, unknown>,
  candidates: string[],
): { key: string; value: unknown } | undefined {
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

function parseRows(rows: Record<string, unknown>[]): {
  parsed: ImportRow[];
  errors: RowError[];
} {
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

    const address =
      typeof addressField.value === "string"
        ? addressField.value.trim().toLowerCase()
        : "";
    const rank = rankField.value;
    const rankNum =
      typeof rank === "number"
        ? rank
        : typeof rank === "string" && /^[1-9]\d*$/.test(rank.trim())
          ? Number(rank.trim())
          : NaN;
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

export function prepareImportRows(rows: Record<string, unknown>[]) {
  const { parsed, errors } = parseRows(rows);
  const unique = new Map<string, ImportRow>();
  for (const row of parsed) {
    const existing = unique.get(row.address);
    if (!existing || row.rank < existing.rank) unique.set(row.address, row);
  }
  return {
    rows: [...unique.values()],
    errors,
    duplicateRows: parsed.length - unique.size,
  };
}
