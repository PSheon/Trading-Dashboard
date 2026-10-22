import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * The `WHERE` of an `ON CONFLICT … DO UPDATE` that skips a row whose values
 * would not change, so a periodic re-import writes no new row version (no
 * dead tuple, no index entry, no WAL) for an unchanged row. True when any of
 * `columns` differs from the proposed (`excluded`) value. Compared as text:
 * a numeric equal in value but written differently ("1.0" / "1.00") is still
 * rewritten, so what is stored stays exactly what the last import sent.
 * A skipped row is not returned by `RETURNING`.
 */
export function upsertChanged(columns: readonly PgColumn[]): SQL {
  const stored = sql.join(columns.map((column) => sql`${column}::text`), sql`, `);
  const proposed = sql.join(columns.map((column) => sql.raw(`excluded."${column.name}"::text`)), sql`, `);
  return sql`(${stored}) is distinct from (${proposed})`;
}
