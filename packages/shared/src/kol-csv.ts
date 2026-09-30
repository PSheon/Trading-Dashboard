import { kolInputSchema, type KolInput } from "./schema/zod.js";

/** Columns of the KOL import file (header row required, any order).
 * `address` is required; the rest may be blank. */
export const KOL_CSV_COLUMNS = [
  "address",
  "display_name",
  "x_handle",
  "verified",
  "sort_order",
  "avatar_url",
] as const;

export interface ParsedKolCsv {
  duplicateRows: number;
  rows: Array<{ line: number; value: KolInput }>;
  errors: Array<{ line: number; message: string }>;
}

/** RFC 4180 fields of one line: commas, double-quoted fields, "" escapes. */
function fields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

/** "https://x.com/handle", "@handle" or "handle" → "handle"; anything else
 * is returned unchanged so validation reports it. */
export function normalizeXHandle(value: string): string {
  const v = value.trim();
  const url =
    /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#].*)?$/i.exec(
      v,
    );
  if (url) return url[1]!;
  return v.startsWith("@") ? v.slice(1) : v;
}

/**
 * Parses a KOL import file. Rows that fail validation are reported with
 * their line number and skipped; a later row for the same address replaces
 * an earlier one. Throws when the header lacks `address`.
 */
export function parseKolCsv(text: string): ParsedKolCsv {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = fields(lines[0] ?? "").map((h) => h.toLowerCase());
  if (!header.includes("address"))
    throw new Error("The header row must include an address column");
  const at = (name: string) => header.indexOf(name);
  const errors: ParsedKolCsv["errors"] = [];
  let duplicateRows = 0;
  const byAddress = new Map<string, { line: number; value: KolInput }>();
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "") continue;
    const line = i + 1;
    const f = fields(lines[i]!);
    const get = (name: string) => (at(name) >= 0 ? (f[at(name)] ?? "") : "");
    const verified = get("verified").toLowerCase();
    const order = get("sort_order");
    const handle = get("x_handle");
    const raw = {
      address: get("address").toLowerCase(),
      displayName: get("display_name") || null,
      xHandle: handle ? normalizeXHandle(handle) : null,
      avatarUrl: get("avatar_url") || null,
      verified: ["true", "1", "yes", "y"].includes(verified),
      sortOrder: order === "" ? i : Number(order),
    };
    const parsed = kolInputSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push({
        line,
        message: parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "row"}: ${issue.message}`)
          .join("; "),
      });
      continue;
    }
    if (byAddress.has(parsed.data.address)) duplicateRows++;
    byAddress.set(parsed.data.address, { line, value: parsed.data });
  }
  return { rows: [...byAddress.values()], errors, duplicateRows };
}
