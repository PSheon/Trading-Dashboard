-- Drop the retired raw history fills (cost reduction 2026-10-22, docs/cost-reduction-proposal-2026-10-22.md §1 #1,
-- approved by Paul §5). `analysis_history_fills_retired` is the raw jsonb layout that the 0021 conversion
-- (apps/api/src/traders/convert-history-fills.ts `finish`) renamed after every row verified equal in `history_fills`;
-- nothing reads or writes it since (the typed store refuses only while the unconverted `analysis_history_fills`
-- exists). Stage, 2026-10-12: 4.4 GB of disk, backups and file cache.
-- The conversion's cursor (`analysis_history_fills_conversion`) goes with it, as `history:convert drop` does, but only
-- when the raw table is gone: a database still mid-conversion keeps its cursor (and has no retired table to drop).
-- Not in the Drizzle schema (neither table ever was), so the snapshot is unchanged.
-- DROP takes an ACCESS EXCLUSIVE lock on a table nobody opens: immediate, and the files are unlinked at commit.
-- Rollback: none in SQL. The rows exist only in backups taken before this release (restore the table from one);
-- every row is also in `history_fills`, which the conversion verified exactly before the rename.
DROP TABLE IF EXISTS "analysis_history_fills_retired";--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.analysis_history_fills') IS NULL THEN
    DROP TABLE IF EXISTS "analysis_history_fills_conversion";
  END IF;
END $$;
